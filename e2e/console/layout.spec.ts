import type { Page } from "@playwright/test";

import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function openPage(
  page: Page,
  daemon: RunningDaemon,
  path: string,
  title: string,
  signedIn: boolean,
) {
  await page.goto(new URL(path, daemon.url).toString());
  if (!signedIn) await signIn(page, daemon.tokens.operator);
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
      for (const [index, { path, title }] of pages.entries()) {
        await openPage(page, fleet.gateway, path, title, index > 0);
        const gutter = await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollbarGutter,
        );
        expect(gutter, path).toBe("stable");
      }
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a worker page has no breadcrumb, and its Warm pool tab draws a 1px --border line between the facts and the table", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await openPage(page, fleet.gateway, `/fleet/${id}?tab=warm-pool`, "layout-a", false);

      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
      const panel = page.getByRole("region", { name: "Warm pool", exact: true });
      await expect(panel.locator(".facts")).toBeVisible();
      const line = await panel.locator(".table-card").evaluate((card) => {
        const style = getComputedStyle(card);
        const probe = document.createElement("span");
        probe.style.color = "var(--border)";
        document.body.append(probe);
        const border = getComputedStyle(probe).color;
        probe.remove();
        return { border, color: style.borderTopColor, width: style.borderTopWidth };
      });
      expect(line.width).toBe("1px");
      expect(line.color).toBe(line.border);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
