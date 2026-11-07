import { mkdir } from "node:fs/promises";

import { expect, settled, signIn, test } from "./fixtures.js";
import { renderCases, renderFixture } from "./render-fixtures.js";

test.use({ locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce" });

test("a reviewer opens the render harness and receives stable named screenshots from signed-in fixture pages", async ({
  gateway,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const cases = await renderCases();
  expect(
    cases.map(({ name }) => name),
    "named reference and unreferenced pages",
  ).toEqual([
    "1-overview",
    "2-fleet",
    "3-worker",
    "4-device-screen-drawer",
    "5-leases",
    "6-lease-drawer",
    "7-baselines",
    "8-activity",
    "inbox",
    "queue",
    "usage",
    "not-found",
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await renderFixture(page);
  await page.goto(gateway.url);
  await signIn(page, gateway.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const directory = "docs/internal/console-redesign/current";
  await mkdir(directory, { recursive: true });
  for (const entry of cases) {
    await page.goto(new URL(entry.path, gateway.url).href);
    await expect(page.locator("#main")).not.toContainText("Loading…");
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    if (entry.name === "2-fleet") {
      await expect(page.getByText("Szymons-MacBook-Pro.local")).toBeVisible();
      await expect(page.getByText("91%")).toBeVisible();
      await expect(page.locator("main tbody tr")).toHaveCount(8);
    }
    if (entry.name === "4-device-screen-drawer") {
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("tab", { name: "Screen" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    if (entry.name === "5-leases") await expect(page.locator("main tbody tr")).toHaveCount(14);
    if (entry.name === "6-lease-drawer") await expect(page.getByRole("dialog")).toBeVisible();
    if (entry.name === "7-baselines") {
      await expect(page.locator("main tbody tr")).toHaveCount(9);
      await expect(page.getByText("stale", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("android-35-pixel8", { exact: true })).toBeVisible();
    }
    if (entry.name === "8-activity")
      await expect(page.getByText("lease.granted").first()).toBeVisible();
    const path = `${directory}/${entry.name}.png`;
    const first = await page.screenshot({ path, animations: "disabled" });
    const second = await page.screenshot({ animations: "disabled" });
    expect(second, `${entry.name} repeated capture`).toEqual(first);
    await testInfo.attach(entry.name, { path, contentType: "image/png" });
  }
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Operator token")).toBeVisible();
  await page.screenshot({ path: `${directory}/sign-in.png`, animations: "disabled" });
  await signIn(page, gateway.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  for (const [scenario, expected] of [
    ["empty", "No leases."],
    ["long", "x".repeat(256)],
    ["refused", "Fixture route refused"],
  ] as const) {
    await page.unrouteAll({ behavior: "wait" });
    await renderFixture(page, scenario);
    await page.goto(new URL("/leases", gateway.url).href);
    if (scenario === "long") await expect(page.locator(`[title="${expected}"]`)).toBeVisible();
    else await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    await page.screenshot({ path: `${directory}/leases-${scenario}.png`, animations: "disabled" });
  }
});
