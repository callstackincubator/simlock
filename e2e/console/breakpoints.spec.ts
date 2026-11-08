import { mkdir } from "node:fs/promises";

import type { Page } from "@playwright/test";

import { expect, signIn, startDaemon, test } from "./fixtures.js";
import { renderCases, renderFixture } from "./render-fixtures.js";

const LIGHT_DIRECTORY = "docs/internal/console-redesign/current/light";
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1279, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 767, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];

// why: sideways page scroll, and anything drawn past the right edge of the card that holds it, are the
// two ways a narrow window breaks a page; a list that scrolls inside its card is meant to.
async function problemsOf(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) {
      found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    }
    const scrolls = (element: Element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll|hidden|clip)/.test(`${style.overflowX}`) && style.display !== "inline";
    };
    for (const card of document.querySelectorAll("#main .card, #main .panel, #main section")) {
      const edge = card.getBoundingClientRect();
      if (edge.width === 0) continue;
      for (const child of card.querySelectorAll("*")) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (box.right <= edge.right + 1 && box.left >= edge.left - 1) continue;
        let clipped = false;
        for (let up = child.parentElement; up !== null && up !== card; up = up.parentElement) {
          if (scrolls(up)) clipped = true;
        }
        if (!clipped && !scrolls(card)) {
          found.push(
            `${child.tagName.toLowerCase()}.${String(child.className).slice(0, 40)} leaves its card`,
          );
          break;
        }
      }
    }
    return found;
  });
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`every page fits the window from 1440 to 360 pixels wide with no sideways scroll (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(540_000);
    const cases = await renderCases();
    const gateway = await startDaemon("gateway");
    try {
      const context = await browser.newContext({
        viewport: SIZES[0]!,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await renderFixture(page);
      await page.goto(gateway.url);
      await signIn(page, gateway.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await mkdir(LIGHT_DIRECTORY, { recursive: true });
      const problems: string[] = [];
      for (const entry of cases) {
        for (const size of SIZES) {
          await page.setViewportSize(size);
          await page.goto(new URL(entry.path, gateway.url).href);
          await expect(page.locator("#main")).not.toContainText("Loading…");
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(150);
          const label = `${colorScheme} ${entry.name} ${size.width}x${size.height}`;
          for (const problem of await problemsOf(page)) problems.push(`${label}: ${problem}`);
          if (size.width === 1440 && colorScheme === "light") {
            await page.screenshot({
              path: `${LIGHT_DIRECTORY}/${entry.name}.png`,
              animations: "disabled",
            });
          } else if (size.width !== 1440 && size.width !== 360) {
            await page.screenshot({
              path: testInfo.outputPath(`${colorScheme}-${entry.name}-${size.width}.png`),
              animations: "disabled",
            });
          }
        }
      }
      expect(problems).toEqual([]);
      await context.close();
    } finally {
      await gateway.dispose();
    }
  });
}
