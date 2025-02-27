import {
  invertTransform,
  multiplyTransformMatrices,
  qrDecompose,
} from '../util/misc/matrix';
import { removeTransformMatrixForSvgParsing } from '../util/transform_matrix_removal';
import { CENTER } from '../constants';
import { getGradientDefs } from './getGradientDefs';
import { getCSSRules } from './getCSSRules';
import type { CSSRules, TSvgReviverCallback } from './typedefs';
import type { ParsedViewboxTransform } from './applyViewboxTransform';
import type { SVGOptions, Object as FabricObject } from 'fabric';
import type { LoadImageOptions } from '../util/misc/objectEnlive';
import { Gradient, Group, classRegistry, Point } from 'fabric';
import { Image } from '../object/Image';
import { IText } from '../object/IText';
import { Textbox } from '../object/Textbox';
import { nanoid } from 'nanoid';

const findTag = (el: Element) => {
  const tag = el.tagName.toLowerCase().replace('svg:', '')
  if (tag === 'image') return Image
  if (tag === 'text') return IText
  return classRegistry.getSVGClass(el.tagName.toLowerCase().replace('svg:', ''));
}

type StorageType = {
  fill: SVGGradientElement;
  stroke: SVGGradientElement;
  clipPath: Element[];
  mask: Element[];
};

type NotParsedFabricObject = FabricObject & {
  fill: string;
  stroke: string;
  clipPath?: string;
  mask?: string;
  clipRule?: CanvasFillRule;
};

export class ElementsParser {
  declare elements: Element[];
  declare options: LoadImageOptions & ParsedViewboxTransform;
  declare reviver: TSvgReviverCallback | undefined;
  declare regexUrl: RegExp;
  declare doc: Document;
  declare clipPaths: Record<string, Element[]>;
  declare masks: Record<string, Element[]>;
  declare gradientDefs: Record<string, SVGGradientElement>;
  declare cssRules: CSSRules;

  constructor(
    elements: Element[],
    options: LoadImageOptions & ParsedViewboxTransform,
    reviver: TSvgReviverCallback | undefined,
    doc: Document,
    clipPaths: Record<string, Element[]>,
    masks: Record<string, Element[]>
  ) {
    this.elements = elements;
    this.options = options;
    this.reviver = reviver;
    this.regexUrl = /^url\(['"]?#([^'"]+)['"]?\)/g;
    this.doc = doc;
    this.clipPaths = clipPaths;
    this.masks = masks;
    this.gradientDefs = getGradientDefs(doc);
    this.cssRules = getCSSRules(doc);
  }

  parse(): Promise<Array<FabricObject | null>> {
    return Promise.all(
      this.elements.map((element) => this.createObject(element))
    );
  }

  async createObject(el: Element): Promise<FabricObject | null> {
    const klass = findTag(el);
    if (klass) {
      const obj: NotParsedFabricObject = await klass.fromElement(
        el,
        this.options,
        this.cssRules
      );
      obj.set({id: nanoid(10)})
      this.resolveGradient(obj, el, 'fill');
      this.resolveGradient(obj, el, 'stroke');
      if (obj instanceof Image && obj._originalElement) {
        removeTransformMatrixForSvgParsing(
          obj,
          obj.parsePreserveAspectRatioAttribute()
        );
      } else {
        removeTransformMatrixForSvgParsing(obj);
      }
      await this.resolveClipPath(obj, el);
      await this.resolveMask(obj, el);
      this.reviver && this.reviver(el, obj as any);
      return obj;
    }
    return null;
  }

  extractPropertyDefinition(
    obj: NotParsedFabricObject,
    property: 'fill' | 'stroke' | 'clipPath' | 'mask',
    storage: Record<string, StorageType[typeof property]>
  ): StorageType[typeof property] | undefined {
    const value = obj[property]!,
      regex = this.regexUrl;
    if (!regex.test(value)) {
      return undefined;
    }
    // verify: can we remove the 'g' flag? and remove lastIndex changes?
    regex.lastIndex = 0;
    // we passed the regex test, so we know is not null;
    const id = regex.exec(value)![1];
    regex.lastIndex = 0;
    // @todo fix this
    return storage[id];
  }

  resolveGradient(
    obj: NotParsedFabricObject,
    el: Element,
    property: 'fill' | 'stroke'
  ) {
    const gradientDef = this.extractPropertyDefinition(
      obj,
      property,
      this.gradientDefs
    ) as SVGGradientElement;
    if (gradientDef) {
      const opacityAttr = el.getAttribute(property + '-opacity');
      const gradient = Gradient.fromElement(gradientDef, obj, {
        ...this.options,
        opacity: opacityAttr,
      } as SVGOptions);
      obj.set(property, gradient);
    }
  }

  async resolveClipPath(obj: NotParsedFabricObject, usingElement: Element) {
    const clipPathElements = this.extractPropertyDefinition(
      obj,
      'clipPath',
      this.clipPaths
    ) as Element[];
    if (clipPathElements) {
      const objTransformInv = invertTransform(obj.calcTransformMatrix());
      // move the clipPath tag as sibling to the real element that is using it
      const clipPathTag = clipPathElements[0].parentElement;
      let clipPathOwner = usingElement;
      while (
        clipPathOwner.parentElement &&
        clipPathOwner.getAttribute('clip-path') !== obj.clipPath
      ) {
        clipPathOwner = clipPathOwner.parentElement;
      }
      clipPathOwner.parentElement!.appendChild(clipPathTag!);
      const container = await Promise.all(
        clipPathElements.map((clipPathElement) => {
          return findTag(clipPathElement)
            .fromElement(clipPathElement, this.options, this.cssRules)
            .then((enlivedClippath: NotParsedFabricObject) => {
              removeTransformMatrixForSvgParsing(enlivedClippath);
              enlivedClippath.fillRule = enlivedClippath.clipRule!;
              delete enlivedClippath.clipRule;
              return enlivedClippath;
            });
        })
      );
      const clipPath = container.length === 1 ? container[0] : new Group(container);
      const gTransform = multiplyTransformMatrices(
        objTransformInv,
        clipPath.calcTransformMatrix()
      );
      if (clipPath.clipPath) {
        await this.resolveClipPath(clipPath, clipPathOwner);
      }
      const { scaleX, scaleY, angle, skewX, translateX, translateY } = qrDecompose(gTransform);
      clipPath.set({
        flipX: false,
        flipY: false,
      });
      clipPath.set({
        scaleX,
        scaleY,
        angle,
        skewX,
        skewY: 0,
      });
      clipPath.setPositionByOrigin(
        new Point(translateX, translateY),
        CENTER,
        CENTER
      );
      obj.clipPath = clipPath;
    } else {
      // if clip-path does not resolve to any element, delete the property.
      delete obj.clipPath;
      return;
    }
  }

  async resolveMask(obj: NotParsedFabricObject, usingElement: Element) {
    const maskElements = this.extractPropertyDefinition(
      obj,
      'mask',
      this.masks
    ) as Element[];
    if (maskElements) {
      const maskElement = maskElements[0] as HTMLElement
      const maskImage = await Image.fromElement(maskElement)
      let src = maskImage?.getSrc()
      if (maskElement.tagName.toLowerCase() === 'text') {
        const text = await IText.fromElement(maskElement)
        src = text.toDataURL()
      }
      obj.set({mask: {
        src: src,
        left: obj.left,
        top: obj.top,
        width: obj.width,
        height: obj.height
      }})
    }
  }
}
