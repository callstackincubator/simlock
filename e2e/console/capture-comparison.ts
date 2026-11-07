import type { Page } from "@playwright/test";

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

export async function compareCaptures(
  page: Page,
  first: Buffer,
  second: Buffer,
  firstState: VisibleState,
  secondState: VisibleState,
): Promise<{
  matches: boolean;
  changedPixels: number;
  maxRgbDelta: number;
  alphaChanged: boolean;
  dimensionsMatch: boolean;
  stateMatches: boolean;
}> {
  const stateMatches = JSON.stringify(firstState) === JSON.stringify(secondState);
  const pixels = await page.evaluate(
    async ([a, b]: [string, string]) => {
      const decode = async (encoded: string) => {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: canvas.width,
          height: canvas.height,
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const [left, right] = await Promise.all([decode(a), decode(b)]);
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
      return { dimensionsMatch, changedPixels, maxRgbDelta, alphaChanged };
    },
    [first.toString("base64"), second.toString("base64")],
  );
  return {
    ...pixels,
    matches:
      stateMatches &&
      pixels.dimensionsMatch &&
      !pixels.alphaChanged &&
      pixels.changedPixels <= 32 &&
      pixels.maxRgbDelta <= 1,
    stateMatches,
  };
}
