import { mkdir } from "node:fs/promises";

import type { Browser, Page } from "@playwright/test";

import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";
import { type RenderCase, renderCases, renderFixture, renderScenario } from "./render-fixtures.js";

// why: `pnpm console:screenshots` writes a picture of every fixture page for a person to set
// beside its render (docs/internal/console-redesign/PLAN.md); it compares nothing and fails only
// when a page does not load. Playwright runs it for its browser and its daemon fixtures, under its
// own config, so the browser lane never does.
const DIRECTORY = "docs/internal/console-redesign/current";
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
const LEASE_SCENARIOS = ["empty", "long", "refused"] as const;

async function open(page: Page, gateway: RunningDaemon, path: string): Promise<void> {
  await page.goto(new URL(path, gateway.url).href);
  await expect(page.locator("#main")).not.toContainText("Loading…");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
}

async function shoot(page: Page, path: string): Promise<void> {
  // why: a focused field draws its caret; a picture shows the page at rest.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
}

async function signedInPage(
  browser: Browser,
  gateway: RunningDaemon,
  viewport: { readonly width: number; readonly height: number },
  colorScheme: "dark" | "light",
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
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
  return page;
}

// why: the lease page's empty, long and refused fixtures, and the sign-in screen, at the
// designed width only.
async function shootExtras(page: Page, gateway: RunningDaemon): Promise<void> {
  for (const scenario of LEASE_SCENARIOS) {
    await renderScenario(page, scenario);
    await open(page, gateway, "/leases");
    await shoot(page, `${DIRECTORY}/leases-${scenario}.png`);
  }
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Operator token")).toBeVisible();
  await shoot(page, `${DIRECTORY}/sign-in.png`);
}

async function shootCases(
  page: Page,
  gateway: RunningDaemon,
  cases: readonly RenderCase[],
  name: (entry: RenderCase) => string,
): Promise<void> {
  for (const entry of cases) {
    await open(page, gateway, entry.path);
    await shoot(page, name(entry));
  }
}

test("write the console's screenshots", async ({ browser }) => {
  test.setTimeout(600_000);
  const cases = await renderCases();
  await mkdir(`${DIRECTORY}/light`, { recursive: true });
  const gateway = await startDaemon("gateway");
  try {
    for (const viewport of VIEWPORTS) {
      const wide = viewport.width === 1440;
      const suffix = wide ? "" : `-${viewport.width}x${viewport.height}`;
      const page = await signedInPage(browser, gateway, viewport, "dark");
      await shootCases(page, gateway, cases, (entry) => `${DIRECTORY}/${entry.name}${suffix}.png`);
      if (wide) await shootExtras(page, gateway);
      await page.context().close();
    }
    const light = await signedInPage(browser, gateway, VIEWPORTS[0], "light");
    await shootCases(light, gateway, cases, (entry) => `${DIRECTORY}/light/${entry.name}.png`);
    await light.context().close();
  } finally {
    await gateway.dispose();
  }
});
