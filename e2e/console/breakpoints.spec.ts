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
// two ways a narrow window breaks a page; a list that scrolls inside its own box does not widen the card.
async function problemsOf(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) {
      found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    }
    for (const card of document.querySelectorAll("#main .card, #main .panel, #main section")) {
      if (card.scrollWidth > card.clientWidth + 1) {
        found.push(
          `${card.tagName.toLowerCase()}.${String(card.className).slice(0, 40)} overflows`,
        );
      }
    }
    return found;
  });
}

async function shoot(
  page: Page,
  scheme: string,
  name: string,
  width: number,
  out: string,
): Promise<void> {
  const light = scheme === "light" && width === 1440;
  if (!light && (width === 1440 || width === 360)) return;
  const path = light ? `${LIGHT_DIRECTORY}/${name}.png` : `${out}/${scheme}-${name}-${width}.png`;
  await page.screenshot({ path, animations: "disabled" });
}

async function sweep(
  page: Page,
  gatewayUrl: string,
  scheme: string,
  out: string,
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const entry of await renderCases()) {
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto(new URL(entry.path, gatewayUrl).href);
      await expect(page.locator("#main")).not.toContainText("Loading…");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const label = `${scheme} ${entry.name} ${size.width}x${size.height}`;
      for (const problem of await problemsOf(page)) problems.push(`${label}: ${problem}`);
      await shoot(page, scheme, entry.name, size.width, out);
    }
  }
  return problems;
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`every page fits the window from 1440 to 360 pixels wide with no sideways scroll (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(540_000);
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
      expect(await sweep(page, gateway.url, colorScheme, testInfo.outputDir)).toEqual([]);
      await context.close();
    } finally {
      await gateway.dispose();
    }
  });
}
