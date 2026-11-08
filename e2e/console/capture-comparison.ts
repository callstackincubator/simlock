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
    const reference = (value: string) => {
      let url: URL;
      try {
        url = new URL(value, document.baseURI);
      } catch {
        return value;
      }
      const current = new URL(location.href);
      if (
        !url.hash ||
        url.origin !== current.origin ||
        url.pathname !== current.pathname ||
        url.search !== current.search
      )
        return value;
      let id = url.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // why: malformed escapes still name a literal DOM id.
      }
      const canonical = generatedIds.get(id);
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
    const svgPaint = Array.from(document.querySelectorAll("svg"))
      .filter(visible)
      .map((svg) => {
        const roots: Element[] = [svg];
        const seen = new Set<Element>();
        const nodes: unknown[] = [];
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index]!;
          const members = [root, ...root.querySelectorAll("*")].filter((node) => !seen.has(node));
          for (const node of members) {
            seen.add(node);
            const computed = getComputedStyle(node);
            const style = styles(computed);
            const matrix = node instanceof SVGGraphicsElement ? node.getScreenCTM() : null;
            nodes.push({
              markup: markup(node),
              style,
              matrix:
                matrix === null
                  ? null
                  : [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
            });
            const values = [
              ...Array.from(node.attributes, (attribute) => attribute.value),
              ...Array.from(computed, (name) => computed.getPropertyValue(name)),
            ];
            const href =
              node.getAttribute("href") ??
              node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
            if (href !== null) values.push(`url("${href}")`);
            for (const value of values) {
              const references = [
                ...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi),
              ].map((match) => match[1] ?? match[2] ?? match[3]!);
              if (value.startsWith("#")) references.push(value);
              for (const reference of references) {
                let url: URL;
                try {
                  url = new URL(reference, document.baseURI);
                } catch {
                  continue;
                }
                const current = new URL(location.href);
                if (
                  !url.hash ||
                  url.origin !== current.origin ||
                  url.pathname !== current.pathname ||
                  url.search !== current.search
                )
                  continue;
                let id = url.hash.slice(1);
                try {
                  id = decodeURIComponent(id);
                } catch {
                  // why: malformed escapes still name a literal DOM id.
                }
                const target = document.getElementById(id);
                if (target !== null && !seen.has(target) && !root.contains(target))
                  roots.push(target);
              }
            }
          }
        }
        return nodes;
      });
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

export function compareCaptures(
  first: Buffer,
  second: Buffer,
  firstState: VisibleState,
  secondState: VisibleState,
): {
  matches: boolean;
  changedPixels: number;
  recognizedEdgePixels: number;
  matcherPixels: number;
  edgeMaxRgbDelta: number;
  matcherMaxRgbDelta: number;
  maxRgbDelta: number;
  alphaChanged: boolean;
  dimensionsMatch: boolean;
  stateMatches: boolean;
} {
  const stateMatches = JSON.stringify(firstState) === JSON.stringify(secondState);
  const left = PNG.sync.read(first);
  const right = PNG.sync.read(second);
  const dimensionsMatch = left.width === right.width && left.height === right.height;
  let changedPixels = 0;
  let maxRgbDelta = 0;
  let recognizedEdgePixels = 0;
  let matcherPixels = 0;
  let edgeMaxRgbDelta = 0;
  let matcherMaxRgbDelta = 0;
  let alphaChanged = false;
  if (dimensionsMatch) {
    const diff = Buffer.alloc(left.data.length);
    matcherPixels = pixelmatch(left.data, right.data, diff, left.width, left.height, {
      threshold: 0.1,
      includeAA: false,
      alpha: 0,
      aaColor: [17, 33, 65],
      diffColor: [201, 21, 99],
    });
    for (let offset = 0; offset < left.data.length; offset += 4) {
      let changed = false;
      let pixelDelta = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(left.data[offset + channel]! - right.data[offset + channel]!);
        maxRgbDelta = Math.max(maxRgbDelta, delta);
        pixelDelta = Math.max(pixelDelta, delta);
        changed ||= delta !== 0;
      }
      if (left.data[offset + 3] !== right.data[offset + 3]) {
        alphaChanged = true;
        changed = true;
      }
      if (changed) changedPixels += 1;
      if (diff[offset] === 17 && diff[offset + 1] === 33 && diff[offset + 2] === 65) {
        recognizedEdgePixels += 1;
        edgeMaxRgbDelta = Math.max(edgeMaxRgbDelta, pixelDelta);
      } else if (diff[offset] === 201 && diff[offset + 1] === 21 && diff[offset + 2] === 99) {
        matcherMaxRgbDelta = Math.max(matcherMaxRgbDelta, pixelDelta);
      }
    }
  }
  return {
    dimensionsMatch,
    changedPixels,
    recognizedEdgePixels,
    matcherPixels,
    edgeMaxRgbDelta,
    matcherMaxRgbDelta,
    maxRgbDelta,
    alphaChanged,
    matches: stateMatches && dimensionsMatch && !alphaChanged && matcherPixels === 0,
    stateMatches,
  };
}
