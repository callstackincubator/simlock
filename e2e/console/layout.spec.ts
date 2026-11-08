import type { Locator, Page } from "@playwright/test";

import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";
import { answer, pad } from "./stub-answers.js";
import { answerWithoutLoad } from "./workers-answers.js";

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

function lastContentOf(page: Page, index: number): Locator {
  if (index === 0) return page.getByRole("link", { name: "layout-a", exact: true });
  if (index === 1) return page.getByRole("region", { name: "Worker events" });
  return page.getByRole("region", { name: "Events on this worker" });
}

async function expectShellGeometry(page: Page, nav: Locator, path: string): Promise<void> {
  for (const [height, navHeight] of [
    [900, 876],
    [500, 476],
  ] as const) {
    await page.setViewportSize({ width: 1440, height });
    expect(await nav.boundingBox(), `${path} ${height} navigation`).toEqual({
      x: 12,
      y: 12,
      width: 200,
      height: navHeight,
    });
    const geometry = await page.evaluate(() => {
      const main = document.querySelector("main")!.getBoundingClientRect();
      const head = document.querySelector(".page-head")!.getBoundingClientRect();
      return {
        mainX: main.x,
        mainWidth: main.width,
        headX: head.x,
        headY: head.y,
        headWidth: head.width,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry, `${path} ${height} content geometry`).toEqual({
      mainX: 212,
      mainWidth: 1228,
      headX: 224,
      headY: 12,
      headWidth: 1204,
      scrollWidth: 1440,
    });
  }
}

async function expectScrollsAndStaysReachable(
  page: Page,
  nav: Locator,
  target: Locator,
  path: string,
  index: number,
  title: string,
): Promise<void> {
  expect(await page.evaluate(() => window.scrollY), `${path} starts at top`).toBe(0);
  // why: a wheel over the worker page's event log scrolls the log, so the pointer rests on its side card.
  await page.mouse.move(index === 2 ? 400 : 1000, 250);
  await page.mouse.wheel(0, 5000);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: `${path} scrolls` })
    .toBeGreaterThan(0);
  await expect(target, `${path} last content is not clipped`).toBeInViewport({ ratio: 1 });
  const box = await target.boundingBox();
  expect(box, `${path} last content`).not.toBeNull();
  expect(box!.y, `${path} last content top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${path} last content bottom`).toBeLessThanOrEqual(500);
  const scrolledNav = await nav.boundingBox();
  expect(scrolledNav!.x, `${path} scrolled navigation x`).toBe(12);
  expect(scrolledNav!.y, `${path} scrolled navigation y`).toBeCloseTo(12, 0);
  expect(scrolledNav!.width, `${path} scrolled navigation width`).toBe(200);
  await expect(
    nav.getByRole("link", { name: "Overview", exact: true }),
    `${path} navigation remains reachable`,
  ).toBeInViewport({ ratio: 1 });
  await page.mouse.wheel(0, -5000);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: `${path} scrolls back to the top`,
    })
    .toBe(0);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
    `${path} heading is reachable again`,
  ).toBeInViewport({ ratio: 1 });
}

async function checkPage(
  page: Page,
  gateway: RunningDaemon,
  workers: readonly unknown[],
  index: number,
  path: string,
  title: string,
): Promise<void> {
  if (path === "/fleet") await answer(page, "/v1/workers", () => ({ workers }));
  if (index === 2) await page.unrouteAll({ behavior: "wait" });
  await openPage(page, gateway, path, title, index > 0);
  if (index === 0) await expect(page.getByText("Wait p95", { exact: true })).toBeVisible();
  const target = lastContentOf(page, index);
  await expect(target).toHaveCount(1);
  const nav = page.getByRole("navigation", { name: "Console" });
  await expectShellGeometry(page, nav, path);
  await expectScrollsAndStaysReachable(page, nav, target, path, index, title);
}

test.describe("the console's layout", () => {
  test("the shell keeps its reference geometry and scrolls the Overview, Fleet and worker pages", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      const response = await fetch(new URL("/v1/workers", fleet.gateway.url), {
        headers: { Authorization: `Bearer ${fleet.gateway.tokens.operator}` },
      });
      expect(response.status).toBe(200);
      const host = ((await response.json()) as { workers: Record<string, unknown>[] }).workers[0];
      expect(host).toBeDefined();
      const workers = Array.from({ length: 30 }, (_, index) => ({
        ...host,
        id: `wrk_${pad(index + 1)}`,
        label: `worker-${pad(index + 1)}`,
      }));
      const pages = [
        { path: "/", title: "Overview" },
        { path: "/fleet", title: "Fleet" },
        { path: `/fleet/${id}`, title: "layout-a" },
      ];
      for (const [index, { path, title }] of pages.entries()) {
        await checkPage(page, fleet.gateway, workers, index, path, title);
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
      const panel = page.getByRole("region", { name: "Warm pool facts", exact: true });
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

  test("a fleet tile's ⋯ lies inside the tile with its 14px padding to the right edge, and an Inbox row's button has 8px above and below", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await answerWithoutLoad(page);
      await openPage(page, fleet.gateway, "/fleet", "Fleet", false);
      const menu = page.locator(".fleet-tile").getByRole("button", { name: /^Actions for/ });
      const box = await menu.evaluate((button) => {
        const tile = button.closest(".fleet-tile")?.getBoundingClientRect();
        const own = button.getBoundingClientRect();
        return {
          left: own.left,
          right: own.right,
          tileLeft: tile?.left ?? 0,
          tileRight: tile?.right ?? 0,
        };
      });
      expect(box.left).toBeGreaterThanOrEqual(box.tileLeft);
      expect(box.tileRight - box.right).toBe(15);

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
