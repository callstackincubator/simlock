import { compareCaptures, visibleState } from "./capture-comparison.js";
import { expect, startDaemon, test } from "./fixtures.js";
import { captureRun, expectCaseList } from "./render-checks.js";
import type { Capture } from "./render-checks.js";
import { renderCases } from "./render-fixtures.js";

test.use({ locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce" });

const cases = await renderCases();
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("same-source captures use fixed perceptual matching and exact visible state", async ({
  page,
}) => {
  const images = await page.evaluate(() => {
    const make = (changed: number, delta: number, alpha = 255, width = 40) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(width, 1);
      for (let i = 0; i < width; i += 1) {
        image.data.set([100 + (i < changed ? delta : 0), 100, 100, i === 0 ? alpha : 255], i * 4);
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    };
    return [make(0, 0), make(33, 1), make(1, 100), make(0, 0, 254), make(0, 0, 255, 39)];
  });
  const [base, below, above, alpha, dimensions] = images.map((image) =>
    Buffer.from(image, "base64"),
  );
  for (const [label, image, expected] of [
    ["identical", base, true],
    ["33 below-threshold flat pixels", below, true],
    ["one above-threshold flat pixel", above, false],
    ["alpha change", alpha, false],
    ["dimensions", dimensions, false],
  ] as const) {
    expect(compareCaptures(base!, image!, "visible", "visible").matches, label).toBe(expected);
  }
  expect(
    compareCaptures(base!, above!, "visible", "visible").matcherPixels,
    "one flagged pixel",
  ).toBe(1);
  const edges = await page.evaluate(() => {
    const make = (center: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 7;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(7, 7);
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const value = x < 3 ? 0 : x > 3 ? 255 : y === 3 ? center : 60 + y * 10;
          image.data.set([value, value, value, 255], (y * 7 + x) * 4);
        }
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    };
    return [make(100), make(180)];
  });
  const edge = compareCaptures(
    Buffer.from(edges[0]!, "base64"),
    Buffer.from(edges[1]!, "base64"),
    "visible",
    "visible",
  );
  expect(edge.changedPixels, "AA raw changed pixels").toBe(1);
  expect(edge.recognizedEdgePixels, "recognized AA edge").toBe(1);
  expect(edge.matcherPixels, "AA is not matcher-flagged").toBe(0);
  expect(edge.matches, "AA edge accepted").toBe(true);
  for (const [label, left, right, changedPixels, maxRgbDelta, matches] of [
    [
      "half-transparent one-level RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNIEfnQAAAEMQHp56QzagAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNIFfnQAAAENQHqJEibAAAAAABJRU5ErkJggg==",
      1,
      1,
      true,
    ],
    [
      "nearly transparent ten-level RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPgSjnBCAAC6gE4rxOTiwAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWMQSTnBCAADEgFCNWn++AAAAABJRU5ErkJggg==",
      1,
      10,
      true,
    ],
    [
      "transparent RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWMQ0bBhAAABRQB5yEL59wAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPQsAlgAAAB+QC1yr0tZgAAAABJRU5ErkJggg==",
      1,
      20,
      true,
    ],
  ] as const) {
    const result = compareCaptures(
      Buffer.from(left, "base64"),
      Buffer.from(right, "base64"),
      "visible",
      "visible",
    );
    expect(result.changedPixels, `${label} changed pixels`).toBe(changedPixels);
    expect(result.maxRgbDelta, `${label} raw RGB delta`).toBe(maxRgbDelta);
    expect(result.alphaChanged, `${label} alpha`).toBe(false);
    expect(result.matches, `${label} fixed matcher`).toBe(matches);
  }
  expect(compareCaptures(base!, base!, "visible", "changed").matches, "visible state").toBe(false);
  await page.setContent(
    '<main><h1>Overview</h1><p style="color: black; width: 100px">8 workers</p><svg width="40" height="40"><path d="M0 0 L40 0 L40 40 L0 40 Z" /></svg></main>',
  );
  const original = await visibleState(page);
  for (const [label, change] of [
    ["visible heading", "heading"],
    ["visible data", "data"],
    ["computed presentation", "style"],
    ["geometry", "geometry"],
    ["chart path", "path"],
  ] as const) {
    await page.evaluate((kind) => {
      const heading = document.querySelector("h1")!;
      const paragraph = document.querySelector("p")!;
      heading.textContent = kind === "heading" ? "Different" : "Overview";
      paragraph.textContent = kind === "data" ? "9 workers" : "8 workers";
      paragraph.style.color = kind === "style" ? "red" : "black";
      paragraph.style.width = kind === "geometry" ? "101px" : "100px";
      document
        .querySelector("path")!
        .setAttribute(
          "d",
          kind === "path" ? "M0 0 L40 0 L40 40 L20 20 L0 40 Z" : "M0 0 L40 0 L40 40 L0 40 Z",
        );
    }, change);
    const changed = await visibleState(page);
    const result = compareCaptures(base!, base!, original, changed);
    expect(result.changedPixels, `${label} uses identical pixels`).toBe(0);
    expect(result.stateMatches, `${label} exact state`).toBe(false);
    expect(result.matches, `${label} cannot use raster allowance`).toBe(false);
  }
  await page.setContent('<main style="height: 2000px"><p>Visible geometry</p></main>');
  const beforeScroll = await visibleState(page);
  await page.evaluate(() => window.scrollBy(0, 1));
  const afterScroll = await visibleState(page);
  const moved = compareCaptures(base!, base!, beforeScroll, afterScroll);
  expect(moved.changedPixels, "scroll-only geometry uses identical pixels").toBe(0);
  expect(moved.stateMatches, "scroll-only HTML geometry exact state").toBe(false);
  expect(moved.matches, "scroll-only geometry cannot use raster allowance").toBe(false);
});

for (const entry of cases) {
  for (const viewport of viewports) {
    test(`a reviewer opens the render harness and receives stable named screenshots from signed-in fixture pages: ${entry.name} ${viewport.width}x${viewport.height}`, async ({
      browser,
    }, testInfo) => {
      test.setTimeout(180_000);
      expectCaseList(cases);
      const captures = new Map<string, Capture>();
      for (const run of ["first", "fresh"] as const) {
        const gateway = await startDaemon("gateway");
        try {
          const context = await browser.newContext({
            viewport,
            locale: "en-US",
            timezoneId: "UTC",
            colorScheme: "dark",
            reducedMotion: "reduce",
          });
          try {
            await captureRun({ captures, context, entry, gateway, run, testInfo, viewport });
          } finally {
            await context.close();
          }
        } finally {
          await gateway.dispose();
        }
      }
    });
  }
}
