import type { Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type VisibleState = unknown;

export async function visibleState(page: Page): Promise<VisibleState> {
  return page.evaluate(() => {
    const generatedIds = new Map<string, string>();
    for (const path of document.querySelectorAll("svg path.recharts-area-area[id]")) {
      const id = path.id;
      if (/^recharts-area-_r_[a-z0-9]+_$/.test(id) && !generatedIds.has(id)) {
        generatedIds.set(id, `capture-generated-area-${generatedIds.size}`);
      }
    }
    const sameDocumentId = (value: string): string | null => {
      let url: URL;
      try {
        url = new URL(value, document.baseURI);
      } catch {
        return null;
      }
      const current = new URL(location.href);
      if (
        !url.hash ||
        url.origin !== current.origin ||
        url.pathname !== current.pathname ||
        url.search !== current.search
      )
        return null;
      let id = url.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // why: malformed escapes still name a literal DOM id.
      }
      return id;
    };
    const reference = (value: string) => {
      const id = sameDocumentId(value);
      const canonical = id === null ? undefined : generatedIds.get(id);
      return canonical === undefined
        ? value
        : `${value.slice(0, value.lastIndexOf("#") + 1)}${canonical}`;
    };
    const cssReferences = (value: string) =>
      value.replace(
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi,
        (
          whole,
          double: string | undefined,
          single: string | undefined,
          bare: string | undefined,
        ) => {
          const url = double ?? single ?? bare!;
          return whole.replace(url, reference(url));
        },
      );
    const markup = (element: Element) => {
      const clone = element.cloneNode(true) as Element;
      for (const node of [clone, ...clone.querySelectorAll("*")]) {
        for (const attribute of Array.from(node.attributes)) {
          let value = attribute.value;
          if (attribute.name === "id") value = generatedIds.get(value) ?? value;
          else if (attribute.localName === "href") value = reference(value);
          else value = cssReferences(value);
          if (value !== attribute.value)
            node.setAttributeNS(attribute.namespaceURI, attribute.name, value);
        }
      }
      return clone.outerHTML;
    };
    const styles = (style: CSSStyleDeclaration) =>
      Array.from(style)
        .sort()
        .map((name) => [name, cssReferences(style.getPropertyValue(name))]);
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight &&
        style.visibility === "visible" &&
        style.display !== "none"
      );
    };
    const valueReferences = (value: string) => {
      const references = [
        ...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi),
      ].map((match) => match[1] ?? match[2] ?? match[3]!);
      if (value.startsWith("#")) references.push(value);
      return references;
    };
    const nodeValues = (node: Element, computed: CSSStyleDeclaration) => {
      const values = [
        ...Array.from(node.attributes, (attribute) => attribute.value),
        ...Array.from(computed, (name) => computed.getPropertyValue(name)),
      ];
      const href =
        node.getAttribute("href") ?? node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (href !== null) values.push(`url("${href}")`);
      return values;
    };
    const paintRecord = (node: Element, computed: CSSStyleDeclaration) => {
      const matrix = node instanceof SVGGraphicsElement ? node.getScreenCTM() : null;
      return {
        markup: markup(node),
        style: styles(computed),
        matrix:
          matrix === null ? null : [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
      };
    };
    const svgPaintOf = (svg: Element) => {
      const roots: Element[] = [svg];
      const seen = new Set<Element>();
      const nodes: unknown[] = [];
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index]!;
        const members = [root, ...root.querySelectorAll("*")].filter((node) => !seen.has(node));
        for (const node of members) {
          seen.add(node);
          const computed = getComputedStyle(node);
          nodes.push(paintRecord(node, computed));
          const references = nodeValues(node, computed).flatMap(valueReferences);
          for (const id of references.map(sameDocumentId)) {
            const target = id === null ? null : document.getElementById(id);
            if (target !== null && !seen.has(target) && !root.contains(target)) roots.push(target);
          }
        }
      }
      return nodes;
    };
    const svgPaint = Array.from(document.querySelectorAll("svg")).filter(visible).map(svgPaintOf);
    const elements = Array.from(document.querySelectorAll("body, body *"))
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        const pseudo = (name: "::before" | "::after") => {
          const style = getComputedStyle(element, name);
          return style.content === "none" || style.content === "normal" ? null : styles(style);
        };
        return {
          tag: element.tagName,
          text: Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent),
          value: input ? element.value : null,
          title: element.getAttribute("title"),
          label: element.getAttribute("aria-label"),
          rect: [rect.x, rect.y, rect.width, rect.height],
          style: styles(getComputedStyle(element)),
          before: pseudo("::before"),
          after: pseudo("::after"),
        };
      });
    return { elements, svgPaint };
  });
}

const EDGE_COLOR = [17, 33, 65] as const;
const MATCHER_COLOR = [201, 21, 99] as const;

interface PixelStats {
  alphaChanged: boolean;
  changedPixels: number;
  edgeMaxRgbDelta: number;
  matcherMaxRgbDelta: number;
  matcherPixels: number;
  maxRgbDelta: number;
  recognizedEdgePixels: number;
}

function hasColor(diff: Buffer, offset: number, color: readonly [number, number, number]): boolean {
  return (
    diff[offset] === color[0] && diff[offset + 1] === color[1] && diff[offset + 2] === color[2]
  );
}

function pixelChange(left: PNG, right: PNG, offset: number): { alpha: boolean; delta: number } {
  let delta = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    delta = Math.max(delta, Math.abs(left.data[offset + channel]! - right.data[offset + channel]!));
  }
  return { alpha: left.data[offset + 3] !== right.data[offset + 3], delta };
}

function comparePixels(left: PNG, right: PNG): PixelStats {
  const diff = Buffer.alloc(left.data.length);
  const stats: PixelStats = {
    alphaChanged: false,
    changedPixels: 0,
    edgeMaxRgbDelta: 0,
    matcherMaxRgbDelta: 0,
    matcherPixels: pixelmatch(left.data, right.data, diff, left.width, left.height, {
      threshold: 0.1,
      includeAA: false,
      alpha: 0,
      aaColor: [...EDGE_COLOR],
      diffColor: [...MATCHER_COLOR],
    }),
    maxRgbDelta: 0,
    recognizedEdgePixels: 0,
  };
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const { alpha, delta } = pixelChange(left, right, offset);
    stats.maxRgbDelta = Math.max(stats.maxRgbDelta, delta);
    if (alpha) stats.alphaChanged = true;
    if (alpha || delta !== 0) stats.changedPixels += 1;
    if (hasColor(diff, offset, EDGE_COLOR)) {
      stats.recognizedEdgePixels += 1;
      stats.edgeMaxRgbDelta = Math.max(stats.edgeMaxRgbDelta, delta);
    } else if (hasColor(diff, offset, MATCHER_COLOR)) {
      stats.matcherMaxRgbDelta = Math.max(stats.matcherMaxRgbDelta, delta);
    }
  }
  return stats;
}

export function compareCaptures(
  first: Buffer,
  second: Buffer,
  firstState: VisibleState,
  secondState: VisibleState,
): PixelStats & { matches: boolean; dimensionsMatch: boolean; stateMatches: boolean } {
  const stateMatches = JSON.stringify(firstState) === JSON.stringify(secondState);
  const left = PNG.sync.read(first);
  const right = PNG.sync.read(second);
  const dimensionsMatch = left.width === right.width && left.height === right.height;
  const stats: PixelStats = dimensionsMatch
    ? comparePixels(left, right)
    : {
        alphaChanged: false,
        changedPixels: 0,
        edgeMaxRgbDelta: 0,
        matcherMaxRgbDelta: 0,
        matcherPixels: 0,
        maxRgbDelta: 0,
        recognizedEdgePixels: 0,
      };
  return {
    ...stats,
    dimensionsMatch,
    matches: stateMatches && dimensionsMatch && !stats.alphaChanged && stats.matcherPixels === 0,
    stateMatches,
  };
}
