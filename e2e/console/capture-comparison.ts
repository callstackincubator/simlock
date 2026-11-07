import type { Page } from "@playwright/test";
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
  let alphaChanged = false;
  if (dimensionsMatch) {
    for (let offset = 0; offset < left.data.length; offset += 4) {
      let changed = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(left.data[offset + channel]! - right.data[offset + channel]!);
        maxRgbDelta = Math.max(maxRgbDelta, delta);
        changed ||= delta !== 0;
      }
      if (left.data[offset + 3] !== right.data[offset + 3]) {
        alphaChanged = true;
        changed = true;
      }
      if (changed) changedPixels += 1;
    }
  }
  return {
    dimensionsMatch,
    changedPixels,
    recognizedEdgePixels: 0,
    matcherPixels: 0,
    maxRgbDelta,
    alphaChanged,
    matches:
      stateMatches && dimensionsMatch && !alphaChanged && changedPixels <= 32 && maxRgbDelta <= 1,
    stateMatches,
  };
}
