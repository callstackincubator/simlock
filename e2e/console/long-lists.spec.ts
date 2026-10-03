import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Route } from "@playwright/test";

import { connectSimlock } from "../../dist/client/index.js";
import {
  expect,
  NAV_LABELS,
  type RunningDaemon,
  signIn,
  startDaemon,
  test as base,
} from "./fixtures.js";

/**
 * Long lists: every table pages, the worker cards page, and the events feed draws only the rows
 * in view. The paging tests answer one route with a list of the length they need, built here,
 * and pass every other request to a real daemon. The browser lane's own tests run against a
 * single host seeded for real with 300 leases and 5,000 events.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

/** A single host whose limits fit 300 fake devices. */
const ROOMY = {
  limits: {
    android: { maxDevices: 8, maxRunning: 8 },
    ios: { maxDevices: 400, maxRunning: 400 },
    maxRunning: 400,
  },
};

const LEASES = 300;
const EVENTS = 5_000;

interface Seeded {
  readonly host: RunningDaemon;
  readonly worker: string;
}

const test = base.extend<object, { seeded: Seeded }>({
  seeded: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here, even an empty one.
    async ({}, use) => {
      const host = await startDaemon("worker", { config: ROOMY, driverScript: { ios: IOS } });
      try {
        await seed(host);
        const workers = (await read(host, "/v1/workers")) as { workers: { id: string }[] };
        await use({ host, worker: workers.workers[0]?.id ?? "" });
      } finally {
        await host.dispose();
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
});

/**
 * Takes {@link LEASES} leases, each for its own requester, over the daemon's socket as an agent
 * host would, then renews them until the last hour holds at least {@link EVENTS} events: each
 * renew is one `lease.renewed`.
 */
async function seed(host: RunningDaemon): Promise<void> {
  const client = await connectSimlock({ endpoint: host.socketPath, principal: "console-load" });
  try {
    const leases: string[] = [];
    for (let batch = 0; batch < LEASES; batch += 20) {
      const grants = await Promise.all(
        Array.from({ length: Math.min(20, LEASES - batch) }, (_, offset) =>
          client.requestLease({
            model: "iPhone 16",
            osVersion: "18.4",
            platform: "ios",
            requesterId: `load-${batch + offset}`,
          }),
        ),
      );
      leases.push(...grants.map((grant) => grant.lease.id));
    }
    let missing = EVENTS - (await recentEvents(host)).length;
    while (missing > 0) {
      const round = leases.slice(0, Math.min(leases.length, missing));
      await Promise.all(round.map((leaseId) => client.renewLease({ leaseId })));
      missing -= round.length;
    }
  } finally {
    await client.close();
  }
  expect(((await read(host, "/v1/leases")) as { leases: unknown[] }).leases).toHaveLength(LEASES);
  expect((await recentEvents(host)).length).toBeGreaterThanOrEqual(EVENTS);
}

async function read(host: RunningDaemon, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, host.url), {
    headers: { Authorization: `Bearer ${host.tokens.operator}` },
  });
  expect(response.status, path).toBe(200);
  return response.json();
}

interface Envelope {
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
}

async function recentEvents(host: RunningDaemon): Promise<readonly Envelope[]> {
  return ((await read(host, "/v1/events?since=1h")) as { events: Envelope[] }).events;
}

/** Signs in on the console's first page, then opens `path`. */
async function open(page: Page, host: RunningDaemon, path: string): Promise<void> {
  await page.goto(host.url);
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
  await page.goto(new URL(path, host.url).href);
  await expect(page.locator("#main h1")).toBeVisible();
  await expect(page.locator("#main")).not.toContainText("Loading…");
}

/**
 * Answers `GET <pathname>` with what `body` returns at the time of the request, on top of the
 * daemon's own response, so its headers (its `Date` among them) stay real.
 */
async function answer(page: Page, pathname: string, body: () => unknown): Promise<void> {
  await page.route(
    (url) => url.pathname === pathname,
    async (route: Route) => {
      const response = await route.fetch();
      await route.fulfill({ json: body(), response });
    },
  );
}

/** `count` leases on the one host, `lse_0001` granted first. */
function leases(count: number): unknown[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `dev_${pad(index + 1)}`,
    grantedAt: now - 3_600_000 + index * 1_000,
    id: `lse_${pad(index + 1)}`,
    lastRenewedAt: now - 60_000,
    ownerId: "tok_load",
    requesterId: "tok_load",
    ttlDeadline: now + 600_000,
    ttlMs: 900_000,
  }));
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

/** The ids in the first column of a table, top to bottom. */
function firstColumn(table: Locator): Promise<string[]> {
  return table.locator("tbody tr td:first-child").allTextContents();
}

function ids(from: number, to: number, prefix = "lse"): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `${prefix}_${pad(from + index)}`);
}

/** The pager of the table or list named `label`. */
function pager(page: Page, label: string): Locator {
  return page.getByRole("navigation", { name: `${label} pages` });
}

test.describe("long lists page", () => {
  test("a table of 1,240 rows shows 25 and the pager says 1–25 of 1,240", async ({
    daemon,
    page,
  }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases");

    const table = page.getByRole("region", { name: "All leases" }).locator("table");
    expect(await firstColumn(table)).toEqual(ids(1, 25));
    await expect(pager(page, "All leases").locator(".pager-range")).toHaveText("1–25 of 1,240");
    await expect(pager(page, "All leases")).toContainText("Page 1 of 50");
  });

  test("next and previous move by one page and stop at the ends", async ({ daemon, page }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(60) }));
    await open(page, daemon, "/leases");
    const table = page.getByRole("region", { name: "All leases" }).locator("table");
    const nav = pager(page, "All leases");
    const range = nav.locator(".pager-range");
    const next = nav.getByRole("button", { name: "Next" });
    const previous = nav.getByRole("button", { name: "Previous" });

    // At an end the button stays in place and says it is unavailable; a click there does nothing.
    await expect(previous).toHaveAttribute("aria-disabled", "true");
    const start = await page.evaluate(() => window.history.length);
    await previous.click({ force: true });
    await expect(range).toHaveText("1–25 of 60");
    expect(await page.evaluate(() => window.history.length)).toBe(start);

    await next.click();
    await expect(range).toHaveText("26–50 of 60");
    expect(await firstColumn(table)).toEqual(ids(26, 50));
    await next.click();
    await expect(range).toHaveText("51–60 of 60");
    expect(await firstColumn(table)).toEqual(ids(51, 60));
    await expect(next).toHaveAttribute("aria-disabled", "true");
    const entries = await page.evaluate(() => window.history.length);
    await next.click({ force: true });
    await expect(range).toHaveText("51–60 of 60");
    await expect(page).toHaveURL(/[?&]page=3$/);
    // Nothing moved: not even a history entry for a page past the end.
    expect(await page.evaluate(() => window.history.length)).toBe(entries);

    await previous.click();
    await expect(range).toHaveText("26–50 of 60");
    await previous.click();
    await expect(range).toHaveText("1–25 of 60");
    expect(await firstColumn(table)).toEqual(ids(1, 25));
    // The first page is the plain address.
    await expect(page).toHaveURL(/\/leases$/);
  });

  test("choosing 50 per page shows 50 rows and writes size=50 to the URL", async ({
    daemon,
    page,
  }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases");
    const table = page.getByRole("region", { name: "All leases" }).locator("table");
    const range = pager(page, "All leases").locator(".pager-range");

    await pager(page, "All leases").getByLabel("Per page").selectOption("50");

    await expect(range).toHaveText("1–50 of 1,240");
    expect(await firstColumn(table)).toEqual(ids(1, 50));
    await expect(page).toHaveURL(/\/leases\?size=50$/);

    // From rows 101 to 125, 50 a page goes to the page that still starts with row 101.
    await page.goto(new URL("/leases?page=5", daemon.url).href);
    await expect(range).toHaveText("101–125 of 1,240");
    await pager(page, "All leases").getByLabel("Per page").selectOption("50");
    await expect(range).toHaveText("101–150 of 1,240");
    expect(new URL(page.url()).searchParams.toString()).toBe("page=3&size=50");
  });

  test("opening a URL with page=3 shows the third page", async ({ daemon, page }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases?page=3");
    const table = page.getByRole("region", { name: "All leases" }).locator("table");

    await expect(pager(page, "All leases").locator(".pager-range")).toHaveText("51–75 of 1,240");
    expect(await firstColumn(table)).toEqual(ids(51, 75));
    await expect(page).toHaveURL(/\/leases\?page=3$/);
  });

  test("when a refresh shrinks the list below the current page, the last page shows", async ({
    daemon,
    page,
  }) => {
    let count = 60;
    await answer(page, "/v1/leases", () => ({ leases: leases(count) }));
    await open(page, daemon, "/leases?page=3");
    const table = page.getByRole("region", { name: "All leases" }).locator("table");
    const range = pager(page, "All leases").locator(".pager-range");
    await expect(range).toHaveText("51–60 of 60");

    count = 30;

    // The next refresh, within a second, leaves no third page: the second, now the last, shows.
    await expect(range).toHaveText("26–30 of 30", { timeout: 2_000 });
    expect(await firstColumn(table)).toEqual(ids(26, 30));
    await expect(page).toHaveURL(/\/leases\?page=2$/);
  });

  test("the pager is hidden when every row fits on one page", async ({ daemon, page }) => {
    let count = 25;
    await answer(page, "/v1/leases", () => ({ leases: leases(count) }));
    await open(page, daemon, "/leases");
    const rows = page.getByRole("region", { name: "All leases" }).locator("tbody tr");
    await expect(rows).toHaveCount(25);
    await expect(pager(page, "All leases")).toHaveCount(0);

    // One row more and the list needs a second page: the pager shows.
    count = 26;
    await expect(pager(page, "All leases").locator(".pager-range")).toHaveText("1–25 of 26");
  });

  test("two tables on one page keep their own page in the URL", async ({ daemon, page }) => {
    const listed = (await read(daemon, "/v1/workers")) as { workers: Record<string, unknown>[] };
    const host = listed.workers[0] ?? {};
    const devices = Array.from({ length: 60 }, (_, index) => ({
      id: `dev_${pad(index + 1)}`,
      mode: "full",
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "ready",
    }));
    await answer(page, "/v1/workers", () => ({ workers: [{ ...host, devices }] }));
    await answer(page, "/v1/leases", () => ({ leases: leases(60) }));
    await open(page, daemon, `/workers/${encodeURIComponent(String(host.id))}`);
    const devicesTable = page.getByRole("region", { name: "Devices" }).locator("table");
    const leasesTable = page.getByRole("region", { name: "Leases" }).locator("table");

    await pager(page, "Devices").getByRole("button", { name: "Next" }).click();
    await expect(pager(page, "Devices").locator(".pager-range")).toHaveText("26–50 of 60");
    await pager(page, "Leases").getByRole("button", { name: "Next" }).click();
    await pager(page, "Leases").getByRole("button", { name: "Next" }).click();
    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("51–60 of 60");

    // Each table moved on its own, and the URL holds both pages.
    expect(await firstColumn(devicesTable)).toEqual(ids(26, 50, "dev"));
    expect(await firstColumn(leasesTable)).toEqual(ids(51, 60));
    expect(new URL(page.url()).searchParams.toString()).toBe("devices-page=2&leases-page=3");

    // A reload opens both where they were.
    await page.reload();
    await expect(pager(page, "Devices").locator(".pager-range")).toHaveText("26–50 of 60");
    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("51–60 of 60");
  });

  test("the worker cards page at 24", async ({ daemon, page }) => {
    const listed = (await read(daemon, "/v1/workers")) as { workers: Record<string, unknown>[] };
    const host = listed.workers[0] ?? {};
    let count = 30;
    const workers = Array.from({ length: 30 }, (_, index) => ({
      ...host,
      id: `wrk_${pad(index + 1)}`,
      label: `worker-${pad(index + 1)}`,
    }));
    await answer(page, "/v1/workers", () => ({ workers: workers.slice(0, count) }));
    await open(page, daemon, "/workers");
    const cards = page.getByRole("region", { name: "All workers" }).locator("li.card");
    const titles = () => cards.locator(".card-title").allTextContents();
    const labels = (from: number, to: number) =>
      ids(from, to, "worker").map((id) => id.replace("_", "-"));

    expect(await titles()).toEqual(labels(1, 24));
    await expect(pager(page, "All workers").locator(".pager-range")).toHaveText("1–24 of 30");
    await pager(page, "All workers").getByRole("button", { name: "Next" }).click();
    await expect(pager(page, "All workers").locator(".pager-range")).toHaveText("25–30 of 30");
    expect(await titles()).toEqual(labels(25, 30));
    // The cards' sizes are 24, 48 and 96; a new size keeps the first card shown in view.
    await expect(pager(page, "All workers").getByLabel("Per page").locator("option")).toHaveText([
      "24",
      "48",
      "96",
    ]);
    await pager(page, "All workers").getByLabel("Per page").selectOption("48");
    await expect(page).toHaveURL(/\/workers\?size=48$/);
    expect(await titles()).toEqual(labels(1, 30));

    // Busiest workers ranks five, and links to the cards for the rest.
    const busiest = page.getByRole("region", { name: "Busiest workers" });
    await expect(busiest.locator("tbody tr")).toHaveCount(5);
    await busiest.getByRole("link", { name: "All 30 workers" }).click();
    await expect(page).toHaveURL(/#all-workers$/);
    // With five workers there is no rest to link to.
    count = 5;
    await expect(busiest.locator("tbody tr")).toHaveCount(5);
    await expect(busiest.getByRole("link")).toHaveCount(0);
  });
});

/** `count` events, one every 300 ms back from a second ago, newest first; `n` numbers them. */
function events(count: number): unknown[] {
  const newest = Date.now() - 1_000;
  return Array.from({ length: count }, (_, index) => ({
    event: "load.generated",
    module: "load",
    payload: { n: count - index },
    seq: count - index,
    timestamp: newest - index * 300,
  }));
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

/** The number on the Events shown card. */
async function eventsShown(page: Page): Promise<number> {
  return Number(await page.locator(".stat-value").first().textContent());
}

/** Scrolls the feed down past its first 2,000 pixels with the mouse wheel, as a reader would. */
async function scrollDown(page: Page): Promise<void> {
  const scrolled = () => feed(page).evaluate((box) => box.scrollTop);
  await feed(page).hover();
  for (let turn = 0; turn < 40 && (await scrolled()) <= 2_000; turn += 1) {
    await page.mouse.wheel(0, 1_000);
  }
  await expect.poll(scrolled).toBeGreaterThan(2_000);
  // A wheel scroll can still be moving: wait until the box has stood still for a while.
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await scrolled();
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [300] },
    )
    .toBe(true);
}

/** The feed's first row in view, by its payload's `n`, and its top against the box's top. */
async function firstInView(page: Page): Promise<{ n: string; top: number }> {
  return feed(page).evaluate((box) => {
    const edge = box.getBoundingClientRect().top;
    const rows = [...box.querySelectorAll<HTMLElement>("li.event")]
      .map((row) => ({ row, top: row.getBoundingClientRect().top - edge }))
      .filter(({ row, top }) => top + row.getBoundingClientRect().height > 0)
      .sort((a, b) => a.top - b.top);
    const first = rows[0];
    return {
      n: first?.row.querySelector("dd")?.textContent ?? "",
      top: Math.round(first?.top ?? Number.NaN),
    };
  });
}

test.describe("the events feed", () => {
  test("the events feed puts fewer than 100 rows in the DOM while it holds 10,000 events", async ({
    daemon,
    page,
  }) => {
    const replay = events(10_000);
    await answer(page, "/v1/events", () => ({ events: replay }));
    await open(page, daemon, "/events");
    await expect.poll(() => eventsShown(page)).toBe(10_000);

    const rows = feed(page).locator("li.event");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(100);
    // Halfway down, the rows there are drawn in place of the first ones, and no more of them.
    await feed(page).evaluate((box) => {
      box.scrollTop = box.scrollHeight / 2;
    });
    await expect(rows.first()).not.toHaveAttribute("aria-posinset", "1");
    expect(await rows.count()).toBeLessThan(100);
    await expect(rows.first()).toHaveAttribute("aria-setsize", "10000");
  });

  test("a new event while scrolled down keeps the visible rows in place and counts in the new-events button", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    const client = await connectSimlock({ endpoint: host.socketPath, principal: "feed-reader" });
    try {
      const grant = await client.requestLease({
        model: "iPhone 16",
        osVersion: "18.4",
        platform: "ios",
      });
      const replay = events(1_000);
      await answer(page, "/v1/events", () => ({ events: replay }));
      await open(page, host, "/events");
      await expect.poll(() => eventsShown(page)).toBe(1_000);

      await scrollDown(page);
      const before = await firstInView(page);
      expect(before.n).not.toBe("1000");

      // Each renew is one lease.renewed, newer than every event in the list.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsShown(page)).toBe(1_001);
      await expect(page.getByRole("button", { name: "1 new event" })).toBeVisible();
      expect(await firstInView(page)).toEqual(before);

      await client.renewLease({ leaseId: grant.lease.id });
      await expect(page.getByRole("button", { name: "2 new events" })).toBeVisible();
      expect(await firstInView(page)).toEqual(before);
    } finally {
      await client.close();
      await host.dispose();
    }
  });

  test("the new-events button scrolls to the top and clears its count", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    const client = await connectSimlock({ endpoint: host.socketPath, principal: "feed-reader" });
    try {
      const grant = await client.requestLease({
        model: "iPhone 16",
        osVersion: "18.4",
        platform: "ios",
      });
      const replay = events(1_000);
      await answer(page, "/v1/events", () => ({ events: replay }));
      await open(page, host, "/events");
      await expect.poll(() => eventsShown(page)).toBe(1_000);
      await scrollDown(page);
      await client.renewLease({ leaseId: grant.lease.id });
      const button = page.getByRole("button", { name: "1 new event" });

      await button.click();

      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      await expect(button).toHaveCount(0);
      // The button is gone, so focus moves to the feed rather than dropping to the page.
      await expect(feed(page)).toBeFocused();
      const top = feed(page).locator("li.event[aria-posinset='1']");
      await expect(top.locator(".event-name")).toHaveText("lease.renewed");
      // At the top, the next event shows at the top with no count.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsShown(page)).toBe(1_002);
      await expect(page.getByRole("button", { name: /new event/ })).toHaveCount(0);
      expect(await feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      const newest = (await recentEvents(host)).at(-1);
      expect(newest?.event).toBe("lease.renewed");
      await expect(top.locator("time")).toHaveAttribute(
        "datetime",
        new Date(newest?.timestamp ?? 0).toISOString(),
      );

      // Down again: the count starts from what was at the top when the reader left it.
      await scrollDown(page);
      await client.renewLease({ leaseId: grant.lease.id });
      await expect(page.getByRole("button", { name: "1 new event" })).toBeVisible();
    } finally {
      await client.close();
      await host.dispose();
    }
  });

  test("choosing another filter starts the feed again at the top", async ({ daemon, page }) => {
    const replay = events(1_000);
    await answer(page, "/v1/events", () => ({ events: replay }));
    await open(page, daemon, "/events");
    await expect.poll(() => eventsShown(page)).toBe(1_000);
    await scrollDown(page);

    // Every generated event is under Other: the same list, shown again from its top.
    await page.getByRole("radio", { name: "Other" }).check();

    await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
    await expect(feed(page).locator("li.event").first()).toHaveAttribute("aria-posinset", "1");
  });
});

/**
 * How long the page took to show `expected` in `range` after the next key press, in
 * milliseconds: from the key going down to the text changing, as the page's own clock counts.
 */
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

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}

/** Presses `key` until `target` has focus, at most `limit` times. */
async function tabTo(page: Page, target: Locator, key: string, limit = 200): Promise<void> {
  for (let step = 0; step < limit && !(await isFocused(target)); step += 1) {
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("a single host with 300 leases and 5,000 events", () => {
  test("with 300 leases the leases view pages and stays usable with the keyboard alone", async ({
    browserName,
    page,
    seeded,
  }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const back = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
    const { host } = seeded;
    await page.goto(host.url);
    await page.keyboard.press(tab);
    await page.keyboard.type(host.tokens.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
    await tabTo(page, page.getByRole("link", { name: "Leases", exact: true }), tab);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();

    const nav = pager(page, "All leases");
    const range = nav.locator(".pager-range");
    await expect(range).toHaveText("1–25 of 300");
    await tabTo(page, nav.getByRole("button", { name: "Next" }), tab);

    // Every page, to the last, a key press each. Each shows within a quarter of a second.
    const times: number[] = [];
    for (let shown = 25; shown < LEASES; shown += 25) {
      times.push(await timeKey(page, "Enter", range, `${shown + 1}–${shown + 25} of 300`));
    }
    await expect(nav.getByRole("button", { name: "Next" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Enter");
    await expect(range).toHaveText("276–300 of 300");
    await expect(nav.getByRole("button", { name: "Next" })).toBeFocused();
    await page.keyboard.press(back);
    times.push(await timeKey(page, "Enter", range, "251–275 of 300"));
    console.log(
      `${browserName}: page changes took ${times.map((t) => t.toFixed(1)).join(", ")} ms`,
    );
    expect(Math.max(...times)).toBeLessThan(250);

    // The size, chosen by its first digit.
    const size = nav.getByLabel("Per page");
    await tabTo(page, size, back);
    await page.keyboard.press("5");
    await expect(range).toHaveText("251–300 of 300");

    // Back up into the table, to the last lease shown, and open it.
    await page.keyboard.press(back);
    const last = page.getByRole("region", { name: "All leases" }).locator("tbody tr").last();
    const link = last.getByRole("link");
    await expect(link).toBeFocused();
    const id = await link.textContent();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: id ?? "" })).toBeVisible();
  });

  test("the events feed scrolls through 5,000 events smoothly and the newest stays first", async ({
    browserName,
    page,
    seeded,
  }) => {
    const { host } = seeded;
    await open(page, host, "/events");
    await expect.poll(() => eventsShown(page)).toBeGreaterThanOrEqual(EVENTS);
    const held = await eventsShown(page);

    // Down to the oldest, two boxes at a time, one step a frame, as a fast fling would.
    const run = await feed(page).evaluate(async (box) => {
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const gaps: number[] = [];
      let most = 0;
      let blank = 0;
      let last = await frame();
      for (let step = 0; step < 5_000; step += 1) {
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
        box.scrollTop += box.clientHeight * 2;
        const now = await frame();
        gaps.push(now - last);
        last = now;
        const rows = box.querySelectorAll("li.event");
        most = Math.max(most, rows.length);
        const edge = box.getBoundingClientRect();
        const covered = [...rows].some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= edge.top + 1 && rect.bottom > edge.top;
        });
        if (!covered) blank += 1;
      }
      const sorted = [...gaps].sort((a, b) => a - b);
      const lastRow = [...box.querySelectorAll("li.event")].at(-1);
      return {
        blank,
        end: lastRow?.getAttribute("aria-posinset") === lastRow?.getAttribute("aria-setsize"),
        median: sorted[Math.floor(sorted.length / 2)] ?? 0,
        most,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        steps: gaps.length,
        slow: gaps.filter((gap) => gap > 100).length,
        worst: sorted.at(-1) ?? 0,
      };
    });
    console.log(`${browserName}: ${held} events, ${JSON.stringify(run)}`);
    expect(run.end).toBe(true);
    expect(run.blank).toBe(0);
    expect(run.most).toBeLessThan(100);
    expect(run.p95).toBeLessThan(50);
    // One pause, as a garbage collection or a busy runner makes, is not a stutter; more than one
    // frame in a hundred over 100 ms is.
    expect(run.slow).toBeLessThanOrEqual(Math.floor(run.steps / 100));

    // Back at the top, the first row is the newest event the daemon has.
    await feed(page).evaluate((box) => {
      box.scrollTop = 0;
    });
    const events = await recentEvents(host);
    const newest = events.reduce((a, b) =>
      b.timestamp > a.timestamp || (b.timestamp === a.timestamp && b.seq > a.seq) ? b : a,
    );
    const first = feed(page).locator("li.event[aria-posinset='1']");
    await expect(first.locator("time")).toHaveAttribute(
      "datetime",
      new Date(newest.timestamp).toISOString(),
    );
    await expect(first.locator(".event-name")).toHaveText(newest.event);
  });

  /** Every page, with a pager in view where the page has one, and the feed scrolled. */
  async function everyPage(page: Page, seeded: Seeded, visit: (path: string) => Promise<void>) {
    const leaseList = (await read(seeded.host, "/v1/leases")) as { leases: { id: string }[] };
    const lease = leaseList.leases[0]?.id ?? "";
    for (const path of [
      ...NAV_LABELS.map((label) => `/${label.toLowerCase()}`),
      "/leases?page=12",
      `/workers/${encodeURIComponent(seeded.worker)}?devices-page=2&leases-page=3`,
      `/leases/${encodeURIComponent(lease)}/`,
    ]) {
      await page.goto(new URL(path, seeded.host.url).href);
      await expect(page.locator("#main h1")).toBeVisible();
      await expect(page.locator("#main")).not.toContainText("Loading…");
      if (path === "/events") {
        await expect.poll(() => eventsShown(page)).toBeGreaterThanOrEqual(EVENTS);
        await feed(page).evaluate((box) => {
          box.scrollTop = box.scrollHeight / 3;
        });
      }
      if (path.startsWith("/leases?") || path.startsWith("/workers/")) {
        await expect(page.locator(".pager").first()).toBeVisible();
      }
      await visit(path);
    }
  }

  test("no view reports a Content-Security-Policy violation", async ({ page, seeded }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { cspViolations: string[] }).cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await page.goto(seeded.host.url);
    await signIn(page, seeded.host.tokens.operator);
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

    await everyPage(page, seeded, async (path) => {
      const found = await page.evaluate(() => ({
        styles: document.querySelectorAll("style").length,
        violations: (window as unknown as { cspViolations: string[] }).cspViolations,
      }));
      expect(found, path).toEqual({ styles: 0, violations: [] });
    });
  });

  test("every view has no horizontal page scroll at 360px wide", async ({ page, seeded }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await page.goto(seeded.host.url);
    await signIn(page, seeded.host.tokens.operator);
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

    await everyPage(page, seeded, async (path) => {
      expect(await hasHorizontalScroll(page), path).toBe(false);
    });
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the pagers and the events feed pass an automated WCAG AA check (${colorScheme})`, async ({
      page,
      seeded,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto(seeded.host.url);
      await signIn(page, seeded.host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      await everyPage(page, seeded, async (path) => {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const found = results.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
        expect(found, path).toEqual([]);
      });
    });
  }
});
