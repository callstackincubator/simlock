import type { Page } from "@playwright/test";

import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function openPage(page: Page, daemon: RunningDaemon, path: string, title: string) {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

test.describe("the console's layout", () => {
  test("the page reserves room for a scrollbar on every page", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      const pages = [
        { path: "/", title: "Overview" },
        { path: "/fleet", title: "Fleet" },
        { path: `/fleet/${id}`, title: "layout-a" },
      ];
      for (const { path, title } of pages) {
        await openPage(page, fleet.gateway, path, title);
        const gutter = await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollbarGutter,
        );
        expect(gutter, path).toBe("stable");
      }
    } finally {
      await disposeFleet(fleet);
    }
  });
});
