import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Route } from "@playwright/test";

import { connectSimlock } from "../../dist/client/index.js";
import {
  expect,
  NAV,
  type RunningDaemon,
  settled,
  signIn,
  signInWithKeyboard,
  startDaemon,
  test as base,
} from "./fixtures.js";
import { answer, leases, pad } from "./stub-answers.js";
import { returnToTab } from "./tab.js";

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
  readonly id: string;
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
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(new URL(path, host.url).href);
  await expect(page.locator("#main h1")).toBeVisible();
  await expect(page.locator("#main")).not.toContainText("Loading…");
}

// why: a page before the last hour answers with no events, so the stubbed list ends where it did
// before Activity scrolled back.
async function answerEvents(page: Page, replay: readonly unknown[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/events",
    async (route: Route) => {
      const since = new URL(route.request().url()).searchParams.has("since");
      await route.fulfill({ json: { events: since ? replay : [] } });
    },
  );
}

function rowIds(list: Locator, section: string): Promise<string[]> {
  return list.getByRole("link").evaluateAll(
    (links, prefix) =>
      links.map((link) => {
        const path = (link.getAttribute("href") ?? "").split("?")[0] ?? "";
        return decodeURIComponent(path.slice(prefix.length + 1).replace(/\/$/, ""));
      }),
    section,
  );
}

function leaseRows(page: Page): Locator {
  return page.locator("main tbody");
}

function ids(from: number, to: number, prefix = "lse"): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `${prefix}_${pad(from + index)}`);
}

/** The pager of the table or list named `label`. */
function pager(page: Page, label: string): Locator {
  return page.getByRole("navigation", { name: `${label} pages` });
}

test.describe("long lists page", () => {
  test("a list of 1,240 leases shows 25 rows and the pager says 1–25 of 1,240", async ({
    daemon,
    page,
  }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases");

    expect(await rowIds(leaseRows(page), "/leases")).toEqual(ids(1, 25));
    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("1–25 of 1,240");
    await expect(pager(page, "Leases")).toContainText("Page 1 of 50");
  });

  test("next and previous move by one page and stop at the ends", async ({ daemon, page }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(60) }));
    await open(page, daemon, "/leases");
    const rows = leaseRows(page);
    const nav = pager(page, "Leases");
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
    expect(await rowIds(rows, "/leases")).toEqual(ids(26, 50));
    await next.click();
    await expect(range).toHaveText("51–60 of 60");
    expect(await rowIds(rows, "/leases")).toEqual(ids(51, 60));
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
    expect(await rowIds(rows, "/leases")).toEqual(ids(1, 25));
    // The first page is the plain address.
    await expect(page).toHaveURL(/\/leases$/);
  });

  test("choosing 50 per page shows 50 rows and writes size=50 to the URL", async ({
    daemon,
    page,
  }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases");
    const range = pager(page, "Leases").locator(".pager-range");

    await pager(page, "Leases").getByLabel("Per page").selectOption("50");

    await expect(range).toHaveText("1–50 of 1,240");
    expect(await rowIds(leaseRows(page), "/leases")).toEqual(ids(1, 50));
    await expect(page).toHaveURL(/\/leases\?size=50$/);

    // From rows 101 to 125, 50 a page goes to the page that still starts with row 101.
    await page.goto(new URL("/leases?page=5", daemon.url).href);
    await expect(range).toHaveText("101–125 of 1,240");
    await pager(page, "Leases").getByLabel("Per page").selectOption("50");
    await expect(range).toHaveText("101–150 of 1,240");
    expect(new URL(page.url()).searchParams.toString()).toBe("page=3&size=50");
  });

  test("opening a URL with page=3 shows the third page", async ({ daemon, page }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(1_240) }));
    await open(page, daemon, "/leases?page=3");

    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("51–75 of 1,240");
    expect(await rowIds(leaseRows(page), "/leases")).toEqual(ids(51, 75));
    await expect(page).toHaveURL(/\/leases\?page=3$/);
  });

  test("when a refresh shrinks the list below the current page, the last page shows", async ({
    daemon,
    page,
  }) => {
    let count = 60;
    await answer(page, "/v1/leases", () => ({ leases: leases(count) }));
    await open(page, daemon, "/leases?page=3");
    const range = pager(page, "Leases").locator(".pager-range");
    await expect(range).toHaveText("51–60 of 60");

    count = 30;
    await returnToTab(page);

    // why: the list refresh is asynchronous; its final page may take more than one poll cycle.
    // The next refresh leaves no third page: the second, now the last, shows.
    await expect(range).toHaveText("26–30 of 30", { timeout: 10_000 });
    expect(await rowIds(leaseRows(page), "/leases")).toEqual(ids(26, 30));
    await expect(page).toHaveURL(/\/leases\?page=2$/);
  });

  test("a focused link in the list keeps its focus, and its row its place, across two refreshes", async ({
    daemon,
    page,
  }) => {
    // One list, served again on every refresh: its countdowns move, so each render shows.
    const listed = leases(60);
    let served = 0;
    await answer(page, "/v1/leases", () => {
      served += 1;
      return { leases: listed };
    });
    await open(page, daemon, "/leases?page=2");
    const row = leaseRows(page).locator("tr").nth(2);
    const link = row.getByRole("link");
    const expires = row.locator("td:not(.table-menu)").last();
    await expect(link).toHaveAttribute("href", "/leases/lse_0028/?page=2");
    await link.focus();
    await expect(link).toBeFocused();
    // The element itself is marked: a link drawn again in its place would not carry the mark.
    await link.evaluate((element) => {
      (element as unknown as { kept?: boolean }).kept = true;
    });

    // Twice: the daemon answers once more, then the row's countdown moves, so a render follows.
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const since = served;
      await returnToTab(page);
      await expect.poll(() => served, { timeout: 3_000 }).toBeGreaterThan(since);
      const before = await expires.textContent();
      await expect.poll(() => expires.textContent(), { timeout: 3_000 }).not.toBe(before);
    }

    await expect(link).toBeFocused();
    expect(await link.evaluate((element) => (element as unknown as { kept?: boolean }).kept)).toBe(
      true,
    );
    expect(await rowIds(leaseRows(page), "/leases")).toEqual(ids(26, 50));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leases\/lse_0028\/\?page=2$/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  for (const how of ["Escape", "the close button", "the dim layer"] as const) {
    test(`${how} closes a lease's drawer and returns to /leases keeping ?page=2&size=25, with focus on the row that opened it and Back not reopening it`, async ({
      daemon,
      page,
    }) => {
      await answer(page, "/v1/leases", () => ({ leases: leases(60) }));
      await open(page, daemon, "/leases?page=2&size=25");
      const row = leaseRows(page).locator('a[href^="/leases/lse_0028/"]');
      await row.click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(/\/leases\/lse_0028\/\?page=2&size=25$/);

      if (how === "Escape") await page.keyboard.press("Escape");
      else if (how === "the close button")
        await drawer.getByRole("button", { name: "Close" }).click();
      else await page.locator(".drawer-dim").click({ position: { x: 10, y: 10 } });

      await expect(drawer).toHaveCount(0);
      await expect(page).toHaveURL(/\/leases\?page=2&size=25$/);
      await expect(row).toBeFocused();
      await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).pathname).not.toMatch(/^\/leases\/./);
    });
  }

  test("changing the leases search goes back to page 1", async ({ daemon, page }) => {
    await answer(page, "/v1/leases", () => ({ leases: leases(60) }));
    await open(page, daemon, "/leases?page=2");
    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("26–50 of 60");

    await page.getByRole("searchbox", { name: "Search leases" }).fill("lse_00");

    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("1–25 of 60");
    await expect(page).toHaveURL(/\/leases\?q=lse_00$/);
  });

  test("the pager is hidden when every row fits on one page", async ({ daemon, page }) => {
    let count = 25;
    await answer(page, "/v1/leases", () => ({ leases: leases(count) }));
    await open(page, daemon, "/leases");
    await expect(leaseRows(page).locator("tr")).toHaveCount(25);
    await expect(pager(page, "Leases")).toHaveCount(0);

    // One row more and the list needs a second page: the pager shows.
    count = 26;
    await returnToTab(page);
    await expect(pager(page, "Leases").locator(".pager-range")).toHaveText("1–25 of 26");
  });

  test("the Fleet table and the devices table on a worker's page keep their own page in the URL", async ({
    daemon,
    page,
  }) => {
    const listed = (await read(daemon, "/v1/workers")) as { workers: Record<string, unknown>[] };
    const host = listed.workers[0] ?? {};
    const devices = Array.from({ length: 60 }, (_, index) => ({
      id: `dev_${pad(index + 1)}`,
      mode: "full",
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "ready",
    }));
    const workers = Array.from({ length: 30 }, (_, index) => ({
      ...host,
      devices,
      id: `wrk_${pad(index + 1)}`,
      label: `worker-${pad(index + 1)}`,
    }));
    await answer(page, "/v1/workers", () => ({ workers }));
    await open(page, daemon, "/fleet");
    const devicesTable = page.getByRole("region", { name: "Devices" }).locator("table");
    const deviceIds = async () =>
      (await devicesTable.locator("tbody tr td:first-child").allTextContents()).map(
        (text) => /dev_\d+/.exec(text)?.[0],
      );

    await pager(page, "Workers").getByRole("button", { name: "Next" }).click();
    await expect(pager(page, "Workers").locator(".pager-range")).toHaveText("26–30 of 30");
    await expect(page.locator("main tbody").getByRole("link").first()).toHaveText("worker-0026");
    expect(await rowIds(page.locator("main tbody"), "/fleet")).toEqual(ids(26, 30, "wrk"));
    await page.getByRole("link", { exact: true, name: "worker-0026" }).click();
    await pager(page, "Devices").getByRole("button", { name: "Next" }).click();
    await pager(page, "Devices").getByRole("button", { name: "Next" }).click();
    await expect(pager(page, "Devices").locator(".pager-range")).toHaveText("51–60 of 60");

    expect(await deviceIds()).toEqual(ids(51, 60, "dev"));
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
      "devices-page": "3",
      page: "2",
    });

    await page.reload();
    await expect(pager(page, "Devices").locator(".pager-range")).toHaveText("51–60 of 60");
    await page.goBack({ waitUntil: "commit" });
    await page.goBack({ waitUntil: "commit" });
    await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(/\/fleet\?page=2$/);
    await expect(pager(page, "Workers").locator(".pager-range")).toHaveText("26–30 of 30");
  });

  test("the worker list pages at 25 like the others and keeps a new size in the URL", async ({
    daemon,
    page,
  }) => {
    const listed = (await read(daemon, "/v1/workers")) as { workers: Record<string, unknown>[] };
    const host = listed.workers[0] ?? {};
    const workers = Array.from({ length: 30 }, (_, index) => ({
      ...host,
      id: `wrk_${pad(index + 1)}`,
      label: `worker-${pad(index + 1)}`,
    }));
    await answer(page, "/v1/workers", () => ({ workers }));
    await open(page, daemon, "/fleet");
    const rows = page.locator("main tbody");
    const range = pager(page, "Workers").locator(".pager-range");

    expect(await rowIds(rows, "/fleet")).toEqual(ids(1, 25, "wrk"));
    await expect(range).toHaveText("1–25 of 30");
    await pager(page, "Workers").getByRole("button", { name: "Next" }).click();
    await expect(range).toHaveText("26–30 of 30");
    await expect(rows.getByRole("link").first()).toHaveText("worker-0026");
    expect(await rowIds(rows, "/fleet")).toEqual(ids(26, 30, "wrk"));
    await expect(pager(page, "Workers").getByLabel("Per page").locator("option")).toHaveText([
      "25",
      "50",
      "100",
    ]);
    await pager(page, "Workers").getByLabel("Per page").selectOption("50");
    await expect(page).toHaveURL(/\/fleet\?size=50$/);
    expect(await rowIds(rows, "/fleet")).toEqual(ids(1, 30, "wrk"));
    await expect(pager(page, "Workers")).toHaveCount(0);
  });
});

/** `count` events, one every 300 ms back from a second ago, newest first; `n` numbers them. */
function events(count: number): unknown[] {
  const newest = Date.now() - 1_000;
  return Array.from({ length: count }, (_, index) => ({
    event: "load.generated",
    id: `evt_load_${count - index}`,
    module: "load",
    payload: { n: count - index },
    seq: count - index,
    timestamp: newest - index * 300,
  }));
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

// why: the feed draws only the rows in view and prints no count, so its scroll height, one row
// tall per event, is the only measure of how many events it holds.
const ROW_PX = 60;

async function eventsHeld(page: Page): Promise<number> {
  return Math.round((await feed(page).evaluate((box) => box.scrollHeight)) / ROW_PX);
}

const NUMBER = /evt_load_(\d+)/;

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

async function firstInView(page: Page): Promise<{ n: string; top: number }> {
  return feed(page).evaluate((box, pattern) => {
    const edge = box.getBoundingClientRect().top;
    const rows = [...box.querySelectorAll<HTMLElement>("li")]
      .map((row) => ({ row, top: row.getBoundingClientRect().top - edge }))
      .filter(({ row, top }) => top + row.getBoundingClientRect().height > 0)
      .sort((a, b) => a.top - b.top);
    const first = rows[0];
    const href = first?.row.querySelector("a")?.getAttribute("href") ?? "";
    return {
      n: new RegExp(pattern).exec(decodeURIComponent(href))?.[1] ?? "",
      top: Math.round(first?.top ?? Number.NaN),
    };
  }, NUMBER.source);
}

test.describe("the events feed", () => {
  test("the events feed puts fewer than 100 rows in the DOM while it holds 10,000 events", async ({
    daemon,
    page,
  }) => {
    const replay = events(10_000);
    await answerEvents(page, replay);
    await open(page, daemon, "/activity");
    await expect.poll(() => eventsHeld(page)).toBe(10_000);

    const rows = feed(page).getByRole("listitem");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(100);
    expect((await firstInView(page)).n).toBe("10000");
    // Halfway down, the rows there are drawn in place of the first ones, and no more of them.
    await feed(page).evaluate((box) => {
      box.scrollTop = box.scrollHeight / 2;
    });
    await expect.poll(async () => Number((await firstInView(page)).n)).toBeGreaterThan(4_000);
    expect(Number((await firstInView(page)).n)).toBeLessThan(6_000);
    expect(await rows.count()).toBeLessThan(100);
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
      await answerEvents(page, replay);
      await open(page, host, "/activity");
      await expect.poll(() => eventsHeld(page)).toBe(1_000);

      await scrollDown(page);
      const before = await firstInView(page);
      expect(before.n).not.toBe("1000");

      // Each renew is one lease.renewed, newer than every event in the list.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsHeld(page)).toBe(1_001);
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
      await answerEvents(page, replay);
      await open(page, host, "/activity");
      await expect.poll(() => eventsHeld(page)).toBe(1_000);
      await scrollDown(page);
      await client.renewLease({ leaseId: grant.lease.id });
      const button = page.getByRole("button", { name: "1 new event" });

      await button.click();

      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      await expect(button).toHaveCount(0);
      // The button is gone, so focus moves to the feed rather than dropping to the page.
      await expect(feed(page)).toBeFocused();
      const top = feed(page).getByRole("listitem").first();
      await expect(top.locator("time + span")).toHaveText("lease.renewed");
      // At the top, the next event shows at the top with no count.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsHeld(page)).toBe(1_002);
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
    await answerEvents(page, replay);
    await open(page, daemon, "/activity");
    await expect.poll(() => eventsHeld(page)).toBe(1_000);
    await scrollDown(page);

    // Every generated event is under Other: the same list, shown again from its top.
    await page.getByRole("radio", { name: "Other" }).check();

    await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
    expect((await firstInView(page)).n).toBe("1000");
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
    await signInWithKeyboard(page, host.tokens.operator, tab);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await tabTo(page, page.getByRole("link", { name: "Leases", exact: true }), tab);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();

    const nav = pager(page, "Leases");
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

    await page.keyboard.press(back);
    await expect(
      leaseRows(page)
        .getByRole("button", { name: /^Actions for/ })
        .last(),
    ).toBeFocused();
    await page.keyboard.press(back);
    const link = leaseRows(page).getByRole("link").last();
    await expect(link).toBeFocused();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/leases\/lse_[^/]+\/\?page=6&size=50$/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === href);
  });

  test("the events feed scrolls through 5,000 events smoothly and the newest stays first", async ({
    browserName,
    page,
    seeded,
  }) => {
    const { host } = seeded;
    await open(page, host, "/activity");
    await expect.poll(() => eventsHeld(page)).toBeGreaterThanOrEqual(EVENTS);
    const held = await eventsHeld(page);

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
        const rows = box.querySelectorAll("li");
        most = Math.max(most, rows.length);
        const edge = box.getBoundingClientRect();
        const covered = [...rows].some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= edge.top + 1 && rect.bottom > edge.top;
        });
        if (!covered) blank += 1;
      }
      const sorted = [...gaps].sort((a, b) => a - b);
      const lastRow = [...box.querySelectorAll("li")].at(-1);
      return {
        blank,
        lastHref: lastRow?.querySelector("a")?.getAttribute("href") ?? "",
        median: sorted[Math.floor(sorted.length / 2)] ?? 0,
        most,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        steps: gaps.length,
        worst: sorted.at(-1) ?? 0,
      };
    });
    console.log(`${browserName}: ${held} events, ${JSON.stringify(run)}`);
    const oldest = (await recentEvents(host)).reduce((a, b) =>
      b.timestamp < a.timestamp || (b.timestamp === a.timestamp && b.seq < a.seq) ? b : a,
    );
    expect(run.lastHref).toBe(`/activity/${encodeURIComponent(oldest.id)}`);
    expect(run.blank).toBe(0);
    expect(run.most).toBeLessThan(100);
    expect(run.p95).toBeLessThan(50);
    // Smooth: the p95 frame above, and no freeze. Long frames are not counted one by one: CI's
    // WebKit drew 15 of 662 frames over 100 ms with every other measure in bounds.
    expect(run.worst).toBeLessThan(1_000);

    // Back at the top, the first row is the newest event the daemon has.
    await feed(page).evaluate((box) => {
      box.scrollTop = 0;
    });
    const events = await recentEvents(host);
    const newest = events.reduce((a, b) =>
      b.timestamp > a.timestamp || (b.timestamp === a.timestamp && b.seq > a.seq) ? b : a,
    );
    const first = feed(page).getByRole("listitem").first();
    await expect(first.locator("time")).toHaveAttribute(
      "datetime",
      new Date(newest.timestamp).toISOString(),
    );
    await expect(first.locator("time + span")).toHaveText(newest.event);
  });

  /** Every page, with a pager in view where the page has one, and the feed scrolled. */
  async function everyPage(page: Page, seeded: Seeded, visit: (path: string) => Promise<void>) {
    const leaseList = (await read(seeded.host, "/v1/leases")) as { leases: { id: string }[] };
    const lease = leaseList.leases[0]?.id ?? "";
    for (const path of [
      ...NAV.map((entry) => entry.path),
      "/leases?page=12",
      `/fleet/${encodeURIComponent(seeded.worker)}?devices-page=2`,
      `/leases/${encodeURIComponent(lease)}/`,
    ]) {
      await page.goto(new URL(path, seeded.host.url).href);
      await expect(
        page
          .locator("#main")
          .getByRole("heading", { includeHidden: path.startsWith("/leases/") })
          .first(),
      ).toBeVisible();
      await expect(page.locator("#main")).not.toContainText("Loading…");
      if (path.startsWith("/leases/")) await expect(page.getByRole("dialog")).toBeVisible();
      if (path === "/activity") {
        await expect.poll(() => eventsHeld(page)).toBeGreaterThanOrEqual(EVENTS);
        await feed(page).evaluate((box) => {
          box.scrollTop = box.scrollHeight / 3;
        });
      }
      if (path.startsWith("/leases?") || path.startsWith("/fleet/")) {
        await expect(page.locator(".pager").first()).toBeVisible();
      }
      await settled(page);
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
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

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
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

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
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

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
