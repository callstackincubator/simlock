import type { Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type VisibleState = unknown;

export async function visibleState(page: Page): Promise<VisibleState> {
  return page.evaluate(() => {
    const styles = (style: CSSStyleDeclaration) =>
      Array.from(style)
        .sort()
        .map((name) => [name, style.getPropertyValue(name)]);
    return Array.from(document.querySelectorAll("body, body *"))
      .filter((element) => {
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
      })
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
