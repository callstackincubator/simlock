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

  test("a fleet row's ⋯ lies inside its cell with 24px to the table's right edge, and an Inbox row's button has 8px above and below", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await openPage(page, fleet.gateway, "/fleet", "Fleet", false);
      const menu = page.locator("main tbody tr").getByRole("button", { name: /^Actions for/ });
      const box = await menu.evaluate((button) => {
        const cell = button.closest("td")?.getBoundingClientRect();
        const table = button.closest("table")?.getBoundingClientRect();
        const own = button.getBoundingClientRect();
        return {
          cellLeft: cell?.left ?? 0,
          cellRight: cell?.right ?? 0,
          left: own.left,
          right: own.right,
          tableRight: table?.right ?? 0,
        };
      });
      expect(box.left).toBeGreaterThanOrEqual(box.cellLeft);
      expect(box.right).toBeLessThanOrEqual(box.cellRight);
      expect(box.tableRight - box.right).toBe(24);

      expect((await fleet.gateway.cli(["worker", "drain", id])).code).toBe(0);
      await openPage(page, fleet.gateway, "/inbox", "Inbox", true);
      const undrain = page.getByRole("button", { name: "Undrain", exact: true });
      const gaps = await undrain.evaluate((button) => {
        const row = button.closest("li")?.getBoundingClientRect();
        const own = button.getBoundingClientRect();
        return { bottom: (row?.bottom ?? 0) - own.bottom, top: own.top - (row?.top ?? 0) };
      });
      expect(gaps).toEqual({ bottom: 8, top: 8 });
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a toast's close button lies beside its text, inside the toast, and a one-line toast centres both", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await openPage(page, fleet.gateway, `/fleet/${id}`, "layout-a", false);

      const measure = (title: string) =>
        page
          .locator(".toast")
          .filter({ has: page.getByText(title, { exact: true }) })
          .evaluate((toast) => {
            const box = toast.getBoundingClientRect();
            const close = toast.querySelector(".toast-close")?.getBoundingClientRect();
            const title = toast.querySelector(".toast-title");
            if (close === undefined || title === null) throw new Error("toast has no parts");
            const range = document.createRange();
            range.selectNodeContents(title);
            const text = range.getBoundingClientRect();
            return {
              closeInside:
                close.left >= box.left &&
                close.right <= box.right &&
                close.top >= box.top &&
                close.bottom <= box.bottom,
              centres: Math.abs(close.top + close.height / 2 - (text.top + text.height / 2)),
              overlap:
                text.right > close.left && text.left < close.right && text.bottom > close.top,
              hasAction: toast.querySelector(".toast-action") !== null,
            };
          });

      await page.getByRole("button", { name: "Drain", exact: true }).click();
      await expect(page.getByText("layout-a drained", { exact: true })).toBeVisible();
      const drained = await measure("layout-a drained");
      expect(drained.hasAction).toBe(true);
      expect(drained.closeInside).toBe(true);
      expect(drained.overlap).toBe(false);

      await page.getByRole("button", { name: "Undrain", exact: true }).click();
      await expect(page.getByText("layout-a takes leases again", { exact: true })).toBeVisible();
      const undrained = await measure("layout-a takes leases again");
      expect(undrained.hasAction).toBe(false);
      expect(undrained.closeInside).toBe(true);
      expect(undrained.overlap).toBe(false);
      expect(undrained.centres).toBeLessThanOrEqual(4);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
