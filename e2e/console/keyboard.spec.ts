import type { Locator, Page } from "@playwright/test";

import {
  expect,
  joinOldWorker,
  NAV,
  NAV_LABELS,
  type RunningDaemon,
  signInWithKeyboard,
  startDaemon,
  test,
} from "./fixtures.js";
import {
  IOS,
  labelledToken,
  LEASE,
  leaseOverHttp,
  openSignedIn,
  startHostWithLease,
  startWorld,
  visit,
} from "./pages.js";
import { endingItem, leases, stubJson, waitingItem } from "./stubs.js";

// why: Base UI moves focus into and out of menus, dialogs and drawers itself, and which control a
// Tab reaches next is the browser's: a simulated DOM can say neither, so both are looked at in a
// real engine. Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
function keysOf(browserName: string): { readonly back: string; readonly tab: string } {
  return browserName === "webkit"
    ? { back: "Alt+Shift+Tab", tab: "Alt+Tab" }
    : { back: "Shift+Tab", tab: "Tab" };
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}

// why: presses `key` until `target` has focus, at most `limit` times.
async function tabTo(page: Page, target: Locator, key: string, limit = 40): Promise<void> {
  for (let step = 0; step < limit && !(await isFocused(target)); step += 1) {
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function follow(page: Page, link: Locator, key: string): Promise<void> {
  await tabTo(page, link, key);
  await page.keyboard.press("Enter");
}

// why: a modal's controls are reached in the order they are written: from the control that has
// focus on opening, each Tab lands on the next one, and each Shift+Tab walks back. The controls are
// numbered in the page so the order is read off the focus itself.
async function expectFocusOrder(
  page: Page,
  container: Locator,
  keys: { readonly back: string; readonly tab: string },
): Promise<number> {
  const stops = await container.evaluate((element) => {
    const found = [
      ...element.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled)"),
    ];
    found.forEach((control, index) => control.setAttribute("data-stop", String(index)));
    return found.length;
  });
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-stop") ?? "-1");
  const start = Number(await focused());
  expect(stops, "a modal has controls to reach").toBeGreaterThan(1);
  for (let next = start + 1; next < stops; next += 1) {
    await page.keyboard.press(keys.tab);
    expect(await focused(), `Tab reaches control ${next}`).toBe(String(next));
  }
  for (let previous = stops - 2; previous >= 0; previous -= 1) {
    await page.keyboard.press(keys.back);
    expect(await focused(), `Shift+Tab walks back to control ${previous}`).toBe(String(previous));
  }
  return stops;
}

const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };

interface Keys {
  readonly back: string;
  readonly tab: string;
}

async function shellControls(page: Page): Promise<string[]> {
  return page
    .locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.closest("#main") === null)
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""),
    );
}

async function exerciseControl(page: Page, label: string): Promise<void> {
  if (label === "Collapse sidebar") {
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeFocused();
  }
  if (label === "Search or jump to…") {
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key);
      await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
      await expect(page.locator(".palette")).toHaveCSS("border-radius", "10px");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeFocused();
    }
  }
}

async function tabThrough(page: Page, tab: string, count: number): Promise<string[]> {
  const visited: string[] = [];
  for (let step = 0; step < count; step += 1) {
    await page.keyboard.press(tab);
    const label = await page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent?.trim() ??
        "",
    );
    visited.push(label);
    await exerciseControl(page, label);
  }
  return visited;
}

async function openPagesBackwards(page: Page, back: string): Promise<void> {
  for (const [index, entry] of [...NAV].reverse().entries()) {
    if (index > 0) await page.keyboard.press(back);
    await expect(page.getByRole("link", { name: entry.label, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${entry.path === "/" ? "/" : entry.path}$`));
    await expect(page.getByRole("heading", { level: 1, name: entry.label })).toBeVisible();
  }
}

// why: the shell is walked with Tab, then back with Shift+Tab opening each page on the way, then
// the skip link moves focus to the page's main.
async function shellIsUsable(page: Page, host: RunningDaemon, keys: Keys): Promise<void> {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(host.url);
  await signInWithKeyboard(page, host.tokens.operator, keys.tab);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const controls = await shellControls(page);
  const visited = await tabThrough(page, keys.tab, controls.length);
  expect(controls).toEqual([
    "Skip to content",
    "Collapse sidebar",
    "Search or jump to…",
    ...NAV_LABELS,
    "Sign out",
  ]);
  expect(visited).toEqual(controls);

  // why: focus is on Sign out; walk back to the last page link, then open each page on the way up.
  await page.keyboard.press(keys.back);
  await openPagesBackwards(page, keys.back);
  for (let step = 0; step < 3; step += 1) await page.keyboard.press(keys.back);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
}

// why: each stop in the page's main, numbered in the order the page writes it, must be reached by
// Tab in that order after the skip link; a radio group is one stop, at its checked radio, nothing
// inside a closed disclosure is a stop, and neither is a disabled control.
async function mainStopsAreInOrder(page: Page, path: string, keys: Keys): Promise<void> {
  const stops = await page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      "#main a[href], #main button, #main input, #main summary, #main [tabindex]:not([tabindex='-1'])",
    );
    const kept = [...candidates].filter((element) => {
      if (element.matches(":disabled")) return false;
      if (element instanceof HTMLInputElement && element.type === "radio") return element.checked;
      const closed = element.closest("details:not([open])");
      return closed === null || element.tagName === "SUMMARY";
    });
    kept.forEach((element, index) => element.setAttribute("data-stop", String(index)));
    return kept.length;
  });
  await page.keyboard.press(keys.tab);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  const visited: string[] = [];
  for (let step = 0; step < stops; step += 1) {
    await page.keyboard.press(keys.tab);
    visited.push(
      await page.evaluate(() => document.activeElement?.getAttribute("data-stop") ?? "-"),
    );
  }
  expect(visited, path).toEqual(Array.from({ length: stops }, (_, index) => String(index)));
}

// why: how long the page took to show `expected` in `range` after the next key press, in
// milliseconds: from the key going down to the text changing, as the page's own clock counts.
async function timeKey(page: Page, key: string, range: Locator, expected: string) {
  await range.evaluate((element, wanted) => {
    const state = window as unknown as { pressedAt?: number; shownAt?: number };
    delete state.pressedAt;
    delete state.shownAt;
    document.addEventListener("keydown", () => (state.pressedAt = performance.now()), {
      capture: true,
      once: true,
    });
    const observer = new MutationObserver(() => {
      if (element.textContent !== wanted) return;
      state.shownAt = performance.now();
      observer.disconnect();
    });
    observer.observe(element, { characterData: true, childList: true, subtree: true });
  }, expected);
  await page.keyboard.press(key);
  await expect(range).toHaveText(expected);
  return page.evaluate(() => {
    const state = window as unknown as { pressedAt?: number; shownAt?: number };
    return (state.shownAt ?? Number.NaN) - (state.pressedAt ?? Number.NaN);
  });
}

// why: three hundred leases are paged by keyboard alone, each page within a quarter of a second of
// its key, then the size is chosen by its first digit and a row opened.
async function leasesPageByKeyboard(page: Page, host: RunningDaemon, keys: Keys): Promise<void> {
  await stubJson(page, "/v1/leases", () => ({ leases: leases(300) }));
  await visit(page, host, "/leases");
  const pager = page.getByRole("navigation", { name: "Leases pages" });
  const range = pager.locator(".pager-range");
  await expect(range).toHaveText("1–25 of 300");
  await tabTo(page, pager.getByRole("button", { name: "Next" }), keys.tab, 200);

  const times: number[] = [];
  for (let shown = 25; shown < 300; shown += 25) {
    times.push(await timeKey(page, "Enter", range, `${shown + 1}–${shown + 25} of 300`));
  }
  await expect(pager.getByRole("button", { name: "Next" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(range).toHaveText("276–300 of 300");
  await expect(pager.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press(keys.back);
  times.push(await timeKey(page, "Enter", range, "251–275 of 300"));
  expect(Math.max(...times)).toBeLessThan(250);

  await tabTo(page, pager.getByLabel("Per page"), keys.back, 200);
  await page.keyboard.press("5");
  await expect(range).toHaveText("251–300 of 300");

  await page.keyboard.press(keys.back);
  const link = page.locator("main tbody").getByRole("link").last();
  await expect(link).toBeFocused();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/leases\/lse_[^/]+\/\?page=6&size=50$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === href);
  await page.unrouteAll({ behavior: "wait" });
}

test.describe("keyboard and focus in a real browser", () => {
  test("focus goes into a menu, a dialog and a drawer, follows their controls in order, and Escape closes each and hands focus back", async ({
    browserName,
    page,
  }) => {
    test.setTimeout(120_000);
    const keys = keysOf(browserName);
    const world = await startWorld();
    try {
      const { host } = world;
      await openSignedIn(page, host);

      await stubJson(page, "/v1/inbox", () => ({
        items: [
          waitingItem("req_busy", 125_000),
          endingItem("lse_busy", 60_000, {
            holder: "tok_busy",
            model: "dev_busy",
          }),
        ],
      }));
      await visit(page, host, "/inbox");
      const trigger = page.getByRole("button", { name: /^Actions for/ }).first();
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      if ((await menu.getByRole("menuitem").count()) > 1) {
        await page.keyboard.press("ArrowDown");
        await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.unrouteAll({ behavior: "wait" });

      await visit(page, host, "/leases");
      await page.locator("main tbody tr").filter({ hasText: "console-views" }).click();
      const release = page
        .getByRole("region", { exact: true, name: "Lease" })
        .getByRole("button", { exact: true, name: "Release" });
      await release.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("alertdialog", { name: "Release console-views's lease?" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Keep" })).toBeFocused();
      await expectFocusOrder(page, dialog, keys);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(release).toBeFocused();

      await visit(page, host, "/activity");
      const row = page.getByRole("region", { name: "Event feed" }).getByRole("link").first();
      await row.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await expect
        .poll(() => drawer.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
      await expectFocusOrder(page, drawer, keys);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/activity");
      await expect(row).toBeFocused();
    } finally {
      await world.dispose();
    }
  });

  test("every page is usable with the keyboard alone: Tab reaches each control in order and each page's controls work", async ({
    browserName,
    page,
  }) => {
    test.setTimeout(240_000);
    const keys = keysOf(browserName);
    const { back, tab } = keys;
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      // why: the only device is held, so a second request waits behind it in the Queue.
      const held = await leaseOverHttp(host, await labelledToken(host, "ci-runner-3"));
      host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await expect
        .poll(async () => {
          const response = await fetch(new URL("/v1/lease-requests", host.url), {
            headers: { Authorization: `Bearer ${host.tokens.operator}` },
          });
          return ((await response.json()) as { requests: unknown[] }).requests.length;
        })
        .toBe(1);
      const listed = await host.cli(["worker", "list", "--json"]);
      const workerId = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      const nav = page.getByRole("navigation", { name: "Console" });
      const feed = page.getByRole("region", { name: "Event feed" });

      await test.step("the shell", () => shellIsUsable(page, host, keys));

      for (const { label, path } of NAV) {
        await test.step(`${label} follows the page's own order of controls`, async () => {
          await visit(page, host, path);
          await mainStopsAreInOrder(page, path, keys);
        });
      }

      await test.step("Overview's chart is read with the arrow keys", async () => {
        await visit(page, host, "/");
        await expect(page.locator("#main .chart")).toHaveCount(1);
        await page.locator(".chart [tabindex='0']").first().focus();
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator(".chart-tip")).toContainText("leases held");
        // why: the chart's numbers are a table only a screen reader reads; it holds no stop for the keyboard.
        await expect(page.getByRole("table", { name: "Leases held" })).toBeAttached();
      });

      await test.step("Fleet opens a worker, whose tab is chosen with Enter and whose crumb goes back", async () => {
        await visit(page, host, "/");
        await follow(page, nav.getByRole("link", { name: "Fleet", exact: true }), tab);
        await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
        await follow(
          page,
          page
            .locator(".fleet-table tbody tr:not(.table-group)")
            .filter({ has: page.getByRole("link", { exact: true, name: workerId }) })
            .getByRole("link")
            .first(),
          tab,
        );
        await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(workerId)}$`));
        await expect(
          page.getByRole("heading", { level: 1, name: `Fleet / ${workerId}`, exact: true }),
        ).toBeVisible();
        await visit(page, host, `/fleet/${encodeURIComponent(workerId)}`);
        await mainStopsAreInOrder(page, "a worker page", keys);
        await visit(page, host, `/fleet/${encodeURIComponent(workerId)}`);

        const warmPool = page.getByRole("tab", { name: "Warm pool" });
        await tabTo(page, warmPool, tab, 30);
        await page.keyboard.press("Enter");
        await expect(warmPool).toHaveAttribute("aria-selected", "true");
        // why: Firefox does not wrap focus from the page's last control to its first, so the crumb,
        // which comes before the focused control, is reached going backward.
        await follow(
          page,
          page.locator("#main").getByRole("link", { name: "Fleet", exact: true }),
          back,
        );
        await expect(page).toHaveURL(/\/fleet$/);
      });

      await test.step("Leases opens a lease's pane from its row and closes it back to the row", async () => {
        await visit(page, host, "/");
        await follow(page, nav.getByRole("link", { name: "Leases", exact: true }), tab);
        await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
        const rowLink = page
          .locator("main tbody tr")
          .filter({ has: page.locator(`a[href^="/leases/${encodeURIComponent(held)}/"]`) })
          .locator("a")
          .first();
        await follow(page, rowLink, tab);
        const pane = page.getByRole("region", { exact: true, name: "Lease" });
        await expect(pane).toContainText("ci-runner-3");
        await follow(page, pane.getByRole("button", { name: "Close lease" }), tab);
        await expect.poll(() => new URL(page.url()).pathname).toBe("/leases");
        await expect(rowLink).toBeFocused();
      });

      await test.step("Leases holding 300 leases pages and stays usable by keyboard", () =>
        leasesPageByKeyboard(page, host, keys));

      await test.step("Queue opens a request's drawer from its row, and the drawer's last link opens the worker", async () => {
        await visit(page, host, "/");
        await follow(page, nav.getByRole("link", { name: "Queue", exact: true }), tab);
        await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
        const drawer = page.getByRole("dialog", { exact: true, name: "agent-b" });
        await follow(
          page,
          page.locator("main tbody tr").filter({ hasText: "agent-b" }).getByRole("link"),
          tab,
        );
        await expect(drawer).toBeVisible();
        expect(new URL(page.url()).pathname).toMatch(/^\/queue\/.+/);
        await follow(page, drawer.getByRole("link").last(), tab);
        expect(new URL(page.url()).pathname).toMatch(/^\/fleet\/.+/);
      });

      await test.step("Activity filters by kind with Space, takes focus in its feed and opens an event with Enter, and its range is chosen with the arrow keys", async () => {
        await visit(page, host, "/");
        await follow(page, nav.getByRole("link", { name: "Activity", exact: true }), tab);
        await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
        await expect(
          feed.getByRole("listitem").filter({ hasText: "lease.granted" }),
        ).not.toHaveCount(0);

        await page.getByRole("radio", { name: "1 h" }).focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByRole("radio", { name: "6 h" })).toBeChecked();

        await visit(page, host, "/activity");
        const leasesKind = page
          .getByRole("group", { name: "Kind" })
          .getByRole("checkbox", { name: "Leases" });
        await tabTo(page, leasesKind, tab, 30);
        await expect(leasesKind).not.toBeChecked();
        await page.keyboard.press("Space");
        await expect(leasesKind).toBeChecked();
        const names = await feed.getByRole("listitem").locator(".event-name").allTextContents();
        expect(names.length).toBeGreaterThan(0);
        expect(names.every((name) => name.startsWith("lease."))).toBe(true);

        await tabTo(page, feed, tab, 10);
        await page.keyboard.press(tab);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/activity\/[^/?]+\?kind=lease$/);
      });

      await test.step("Sign out is pressed with Enter", async () => {
        await page.goto(host.url);
        await tabTo(page, page.getByRole("button", { name: "Sign out" }), tab, 30);
        await page.keyboard.press("Enter");
        await expect(page.getByLabel("Operator token")).toBeVisible();
      });

      await test.step("Inbox opens an item and its worker from the keyboard", async () => {
        hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
        await page.goto(gateway.url);
        await signInWithKeyboard(page, gateway.tokens.operator, tab);
        await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
        await follow(
          page,
          page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: /^Inbox/ }),
          tab,
        );
        await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
        const item = page
          .locator("main")
          .getByRole("list")
          .getByRole("link")
          .filter({ has: page.getByRole("img", { exact: true, name: "incompatible" }) })
          .filter({ hasText: "old-worker" });
        await expect(item).toBeVisible({ timeout: 15_000 });
        await follow(page, item, tab);
        await expect(page.getByRole("heading", { level: 2, name: "old-worker" })).toBeVisible();
        await follow(page, page.getByRole("link", { name: "Open worker" }), tab);
        await expect(page).toHaveURL(/\/fleet\/wrk_old$/);
      });
    } finally {
      hangUp();
      await gateway.dispose();
      await host.dispose();
    }
  });

  test("clicking a chart shows no outline, tabbing to it does", async ({ browserName, page }) => {
    const { tab } = keysOf(browserName);
    const { host } = await startHostWithLease();
    try {
      await openSignedIn(page, host);
      for (const [path, title, index] of [
        ["/", "Leases held", 0],
        ["/usage", "Device slots in use, last hour", 0],
        ["/activity", "Activity", 0],
      ] as const) {
        await visit(page, host, path);
        if (path === "/") await expect(page.locator("#main .chart")).toHaveCount(1);
        const chart = page.locator("#main .chart").nth(index);
        const heading = page.getByRole("heading", { name: title, exact: true });
        const ring = () => chart.evaluate((element) => getComputedStyle(element).outlineStyle);
        const focused = () =>
          chart.evaluate((element) => {
            const active = document.activeElement;
            return {
              inChart: active !== null && element.contains(active),
              own: active === null ? "" : getComputedStyle(active).outlineStyle,
            };
          });

        // why: a click on text inside the page focuses `main` (its skip-link target), so Tab
        // starts from the top of the page and reaches the chart after the controls above it.
        await heading.click();
        for (let step = 0; step < 20 && !(await focused()).inChart; step += 1) {
          await page.keyboard.press(tab);
        }
        expect(await focused(), `${path} tabbed`).toEqual({ inChart: true, own: "none" });
        expect(await ring(), `${path} tabbed`).toBe("solid");
        await page.keyboard.press("ArrowLeft");
        await expect(chart.locator(".chart-tip")).toBeVisible();

        await heading.click();
        expect(await ring(), `${path} left`).toBe("none");
        await chart.locator("svg").first().click();
        expect(await focused(), `${path} clicked`).toEqual({ inChart: true, own: "none" });
        expect(await ring(), `${path} clicked`).toBe("none");
      }
    } finally {
      await host.dispose();
    }
  });
});
