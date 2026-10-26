import type { Locator, Page, Route } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  signInWithKeyboard,
  startDaemon,
  startFleet,
  settled,
  test,
} from "./fixtures.js";
import { fetchFull } from "./full-fetch.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

interface Envelope {
  readonly id: string;
  readonly timestamp: number;
  readonly event: string;
}

async function lease(daemon: RunningDaemon, agent: string): Promise<string> {
  const granted = await daemon.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--detach",
    "--agent-id",
    agent,
  ]);
  expect(granted.code, granted.stderr).toBe(0);
  const id = (granted.json as { lease?: { id?: unknown } }).lease?.id;
  expect(typeof id).toBe("string");
  return id as string;
}

async function cliEvents(daemon: RunningDaemon): Promise<readonly Envelope[]> {
  const result = await daemon.cli(["events", "--since", "1h"]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Envelope);
}

async function openEvents(page: Page, daemon: RunningDaemon, path = "/activity"): Promise<void> {
  await page.goto(new URL(path, daemon.url).href);
  await signIn(page, daemon.tokens.operator);
  // why: a drawer over the page hides the page's heading from the accessibility tree.
  if (new URL(path, daemon.url).pathname === "/activity") {
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  } else await expect(page.getByRole("dialog")).toBeVisible();
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

function rows(page: Page): Locator {
  return feed(page).getByRole("listitem");
}

function title(page: Page): Locator {
  return page.getByRole("heading", { level: 2 }).first();
}

async function shownEvents(page: Page): Promise<string[]> {
  return feed(page).evaluate(async (box) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const seen = new Map<number, string>();
    box.scrollTop = 0;
    for (let step = 0; step < 1_000; step += 1) {
      await frame();
      for (const item of box.querySelectorAll("li")) {
        const link = item.querySelector("a");
        const name = item.querySelector("time + span");
        seen.set(
          Math.round(item.getBoundingClientRect().top + box.scrollTop),
          [
            item.querySelector("time")?.getAttribute("datetime") ?? "",
            name?.textContent ?? "",
            link?.getAttribute("href")?.replace("/activity/", "") ?? "",
          ].join(" "),
        );
      }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
      box.scrollTop += box.clientHeight;
    }
    box.scrollTop = 0;
    return [...seen.entries()].sort(([a], [b]) => a - b).map(([, shown]) => shown);
  });
}

function asShown(event: Envelope): string {
  return `${new Date(event.timestamp).toISOString()} ${event.event} ${encodeURIComponent(event.id)}`;
}

async function openEvent(page: Page, id: string): Promise<void> {
  const link = feed(page).locator(`a[href="/activity/${encodeURIComponent(id)}"]`);
  await feed(page).evaluate((box) => box.scrollTo({ top: 0 }));
  for (let step = 0; step < 200 && (await link.count()) === 0; step += 1) {
    await feed(page).evaluate((box) => box.scrollBy({ top: box.clientHeight / 2 }));
    await page.waitForTimeout(30);
  }
  await link.click();
}

interface Stubbed {
  readonly id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: Record<string, never>;
}

function stubbed(n: number, now: number): Stubbed {
  return {
    event: "lease.renewed",
    id: `evt_${String(n).padStart(4, "0")}`,
    payload: {},
    seq: 1_000_000 - n,
    timestamp: now - n * 60_000,
  };
}

// why: one clock for every stubbed event, so a time the test names is the time the page shows.
const BASE = Date.now();

function stubbedRange(from: number, to: number): Stubbed[] {
  return Array.from({ length: to - from + 1 }, (_, index) => stubbed(to - index, BASE));
}

function localMinute(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

interface StubbedAnswer {
  readonly status?: number;
  readonly events?: readonly Stubbed[];
}

/**
 * why: Answers every `GET /v1/events` with what `answer` returns for its query, and records each
 * query, so a test sees which pages the console asked for.
 */
async function stubEvents(
  page: Page,
  answer: (query: URLSearchParams) => StubbedAnswer | Promise<StubbedAnswer>,
): Promise<string[]> {
  const queries: string[] = [];
  await page.route(
    (url) => url.pathname === "/v1/events",
    async (route: Route) => {
      const { search } = new URL(route.request().url());
      queries.push(search);
      const { events = [], status = 200 } = await answer(new URLSearchParams(search));
      if (status === 200) await route.fulfill({ json: { events } });
      else
        await route.fulfill({ json: { error: { code: "STUBBED", message: "stubbed" } }, status });
    },
  );
  return queries;
}

async function firstRowInView(page: Page): Promise<{ href: string | null; top: number }> {
  return feed(page).evaluate((box) => {
    const edge = box.getBoundingClientRect().top;
    const link = [...box.querySelectorAll("li")].find(
      (item) => item.getBoundingClientRect().bottom > edge,
    );
    return {
      href: link?.querySelector("a")?.getAttribute("href") ?? null,
      top: Math.round((link?.getBoundingClientRect().top ?? 0) - edge),
    };
  });
}

// why: the first visit signs in; a later one in the same test finds the session still there.
async function visit(
  page: Page,
  daemon: RunningDaemon,
  path: string,
  first: boolean,
): Promise<void> {
  if (first) return openEvents(page, daemon, path);
  await page.goto(new URL(path, daemon.url).href);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
}

function older(queries: readonly string[]): string[] {
  return queries.filter((query) => !query.startsWith("?since="));
}

// why: the feed draws only the rows in view and prints no count, so its scroll height, one row
// tall per event, is the only measure of how many events it holds.
const ROW_PX = 60;

async function eventsHeld(page: Page): Promise<number> {
  return Math.round((await feed(page).evaluate((box) => box.scrollHeight)) / ROW_PX);
}

async function rowOffset(page: Page, id: string): Promise<number> {
  return feed(page).evaluate((box, wanted) => {
    const link = box.querySelector(`a[href^="/activity/${wanted}"]`);
    if (link === null) throw new Error(`${wanted} is not drawn`);
    return Math.round(
      link.closest("li")!.getBoundingClientRect().top - box.getBoundingClientRect().top,
    );
  }, id);
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  await settled(page);
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Activity page", () => {
  test("a lease taken with the CLI appears in the feed, and its page opens from it", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host);
      await expect(rows(page).first()).toBeVisible();
      const granted = rows(page).filter({ hasText: "lease.granted" });
      await expect(granted).toHaveCount(0);

      const id = await lease(host, "console-e2e-events");

      await expect(granted).toHaveCount(1, { timeout: 10_000 });
      await granted.click();
      await expect(title(page)).toHaveText("lease.granted");
      await expect(page).toHaveURL(/\/activity\/[^/]+$/);
      await expect(page.getByText("leaseId", { exact: true })).toBeVisible();
      await expect(page.locator("dd", { hasText: new RegExp(`^${id}$`) })).toBeVisible();

      await page.getByRole("link", { name: "Open lease" }).click();
      await expect(page).toHaveURL(new RegExp(`/leases/${id}/?$`));
    } finally {
      await host.dispose();
    }
  });

  test("the feed matches simlock events --since 1h, and a restart leaves no gap and no duplicate", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-before");
      await openEvents(page, host);
      const before = (await cliEvents(host)).map(asShown);
      await expect.poll(() => shownEvents(page)).toEqual(before.toReversed());

      await host.stop();
      await expect(page.locator(".connection")).toHaveText(/^Reconnecting/);
      await host.start();
      await expect(page.locator(".connection")).toHaveText("Connected", { timeout: 30_000 });
      await lease(host, "console-e2e-after");

      const after = await cliEvents(host);
      expect(after.length).toBeGreaterThan(before.length);
      await expect.poll(() => shownEvents(page)).toEqual(after.map(asShown).toReversed());
    } finally {
      await host.dispose();
    }
  });

  test("choosing a row puts the event in the URL and its payload whole in the drawer", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-choose");
      await openEvents(page, host);
      const started = (await cliEvents(host)).find((event) => event.event === "daemon.started");
      expect(started).toBeDefined();

      await openEvent(page, (started as Envelope).id);

      await expect(page).toHaveURL(new RegExp(`/activity/${(started as Envelope).id}$`));
      await expect(title(page)).toHaveText("daemon.started");
      await expect(page.getByRole("heading", { level: 3, name: "Payload" })).toBeVisible();
      await page.reload();
      await expect(title(page)).toHaveText("daemon.started");
    } finally {
      await host.dispose();
    }
  });

  test("an address for an event not among those loaded opens the drawer and says older events load as the list scrolls", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host, "/activity/evt_not_there");

      await expect(
        page
          .getByRole("dialog")
          .getByText(
            "This event is not among those loaded. Older events load as you scroll the list, or with Load older events.",
          ),
      ).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("loaded directly at an event's address, closing the drawer replaces the address with /activity and focus goes to the heading", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host, "/activity/evt_not_there");
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      const entries = await page.evaluate(() => window.history.length);

      await page.keyboard.press("Escape");

      await expect(drawer).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/activity");
      expect(await page.evaluate(() => window.history.length)).toBe(entries);
      await expect(page.locator("main h1")).toBeFocused();
    } finally {
      await host.dispose();
    }
  });

  test("the filter and the search show only the events they match and are kept in the URL", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-filter");
      await openEvents(page, host);

      await page.getByRole("radio", { name: "Leases" }).check({ force: true });

      await expect(page).toHaveURL(/\?subject=lease$/);
      const names = await rows(page).locator("time + span").allTextContents();
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name.startsWith("lease."))).toBe(true);
      await page.reload();
      await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();

      await page.getByRole("searchbox", { name: "Search events" }).fill("GRANTED");

      await expect(page).toHaveURL(/\?subject=lease&q=GRANTED$/);
      await expect(rows(page)).not.toHaveCount(0);
      expect(
        (await rows(page).locator("time + span").allTextContents()).every(
          (name) => name === "lease.granted",
        ),
      ).toBe(true);
      await page.reload();
      await expect(page.getByRole("searchbox", { name: "Search events" })).toHaveValue("GRANTED");
    } finally {
      await host.dispose();
    }
  });

  test("the feed scrolls inside itself with the keyboard, and counts the events that came in while scrolled down", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // why: the real daemon answers the page before the oldest late, as on a loaded runner (#1006); the
      // test notes the row in view only after the end row has moved it.
      await page.route(
        (url) => url.pathname === "/v1/events" && url.searchParams.has("before"),
        async (route: Route) => {
          await gate;
          await route.continue();
        },
      );
      for (let index = 0; index < 6; index += 1) await lease(host, `console-e2e-scroll-${index}`);
      await openEvents(page, host);
      await expect.poll(() => rows(page).count()).toBeGreaterThan(5);

      await feed(page).focus();
      await page.keyboard.press("End");
      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBeGreaterThan(0);

      const atEnd = () =>
        feed(page).evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
      await expect.poll(atEnd).toBeLessThan(2);
      release();
      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
      await expect.poll(atEnd).toBeLessThan(2);
      const inView = await firstRowInView(page);
      await lease(host, "console-e2e-scroll-new");
      const more = page.getByRole("button", { name: /^\d+ new events?$/ });
      await expect(more).toBeVisible();
      expect(await firstRowInView(page)).toEqual(inView);
      await more.click();
      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      await expect(more).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("a reader at the end of the feed stays at its end when the end row arrives and shrinks the box", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queries = await stubEvents(page, (query) =>
        query.get("before") === null
          ? { events: stubbedRange(1, 30) }
          : gate.then(() => ({ events: [] })),
      );
      await openEvents(page, host);
      await expect.poll(() => older(queries).length).toBe(1);

      await feed(page).evaluate((box) => box.scrollTo({ top: box.scrollHeight }));
      await expect.poll(() => rowOffset(page, "evt_0030").catch(() => undefined)).toBeDefined();
      release();

      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
      await expect
        .poll(() =>
          feed(page).evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight),
        )
        .toBeLessThan(2);
    } finally {
      await host.dispose();
    }
  });

  test("scrolling within 20 rows of the end loads the 100 events before the oldest held and appends them without moving the rows in view", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queries = await stubEvents(page, (query) => {
        const before = query.get("before");
        if (before === null) return { events: stubbedRange(1, 30) };
        if (before === "evt_0030") return { events: stubbedRange(31, 130) };
        if (before === "evt_0130") return gate.then(() => ({ events: stubbedRange(131, 180) }));
        return {};
      });
      await openEvents(page, host);

      await expect.poll(() => eventsHeld(page)).toBe(130);
      expect(older(queries)).toEqual(["?before=evt_0030&limit=100"]);

      // why: 30 rows from the end is farther than 20, so the list asks for nothing yet.
      await feed(page).evaluate((box, top) => box.scrollTo({ top }), 85 * ROW_PX);
      await expect.poll(() => rowOffset(page, "evt_0090").catch(() => undefined)).toBeDefined();
      await page.waitForTimeout(300);
      expect(older(queries)).toEqual(["?before=evt_0030&limit=100"]);

      // why: the reader is at the very end of the 130 rows when the last page arrives, with the
      // history's end row; the answer waits until the test has noted the row in view.
      await feed(page).evaluate((box) => box.scrollTo({ top: box.scrollHeight }));
      await expect.poll(() => rowOffset(page, "evt_0130").catch(() => undefined)).toBeDefined();
      await expect.poll(() => older(queries).length).toBe(2);
      const inView = await rowOffset(page, "evt_0130");
      const scrolled = await feed(page).evaluate((box) => box.scrollTop);
      release();
      await expect.poll(() => eventsHeld(page)).toBe(180);
      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();

      expect(older(queries)).toEqual(["?before=evt_0030&limit=100", "?before=evt_0130&limit=100"]);
      expect(await rowOffset(page, "evt_0130")).toBe(inView);
      expect(await feed(page).evaluate((box) => box.scrollTop)).toBe(scrolled);
    } finally {
      await host.dispose();
    }
  });

  test("each end row shows its wording: the history's start, the 10,000 cap, a 422, a 503 and a 500 with Try again, and a page of events already held", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let queries = await stubEvents(page, (query) => {
        if (query.get("before") === null) return { events: stubbedRange(1, 30) };
        return query.get("before") === "evt_0030" ? { events: stubbedRange(31, 70) } : {};
      });
      await openEvents(page, host);
      await expect(
        page.getByText(`Start of the history (${localMinute(BASE - 70 * 60_000)})`),
      ).toBeVisible();
      await expect.poll(() => eventsHeld(page)).toBe(70);
      expect(older(queries)).toEqual(["?before=evt_0030&limit=100"]);

      queries = await stubEvents(page, () => ({ events: stubbedRange(1, 10_000) }));
      await page.reload();
      await expect(page.getByText("Showing the newest 10,000 events.")).toBeVisible();
      await feed(page).focus();
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      expect(older(queries)).toEqual([]);

      queries = await stubEvents(page, (query) =>
        query.get("before") === null ? { events: stubbedRange(1, 30) } : { status: 422 },
      );
      await page.reload();
      await expect(page.getByText("Older events are no longer kept.")).toBeVisible();
      expect(older(queries)).toHaveLength(1);

      for (const status of [503, 500]) {
        let failing = true;
        queries = await stubEvents(page, (query) => {
          if (query.get("before") === null) return { events: stubbedRange(1, 30) };
          return failing ? { status } : { events: stubbedRange(31, 40) };
        });
        await page.reload();
        await expect(page.getByText("Older events are not available right now.")).toBeVisible();
        expect(older(queries)).toHaveLength(1);
        failing = false;
        await page.getByRole("button", { name: "Try again" }).click();
        await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
        expect(older(queries)).toHaveLength(2);
      }

      queries = await stubEvents(page, () => ({ events: stubbedRange(1, 100) }));
      await page.reload();
      await expect.poll(() => eventsHeld(page)).toBe(100);
      await feed(page).focus();
      await page.keyboard.press("End");
      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
      expect(older(queries)).toEqual(["?before=evt_0100&limit=100"]);
      expect(await eventsHeld(page)).toBe(100);
    } finally {
      await host.dispose();
    }
  });

  test("the real daemon answers the older page: the events before the oldest held join the list once, and the history starts", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-older-a");
      await lease(host, "console-e2e-older-b");
      const queries: string[] = [];
      let all: Array<Envelope & { readonly seq: number }> = [];
      await page.route(
        (url) => url.pathname === "/v1/events",
        async (route: Route) => {
          const { search } = new URL(route.request().url());
          if (!search.startsWith("?since=")) {
            queries.push(search);
            await route.fallback();
            return;
          }
          // why: the page holds only the newest two events, so the rest must come from the daemon's older page.
          const body = (await (await fetchFull(route)).json()) as {
            events: Array<Envelope & { readonly seq: number }>;
          };
          all = body.events.toSorted((a, b) => b.seq - a.seq);
          await route.fulfill({ json: { events: all.slice(0, 2) } });
        },
      );
      await openEvents(page, host);
      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
      expect(all.length).toBeGreaterThan(3);
      expect(queries).toEqual([`?before=${encodeURIComponent(all[1]!.id)}&limit=100`]);
      await expect.poll(() => eventsHeld(page)).toBe(all.length);
      const oldest = all.at(-1)!;
      await expect(
        page.getByText(`Start of the history (${localMinute(oldest.timestamp)})`),
      ).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("a daemon with no events in the last hour but older history shows them at once, and an empty history says No events yet", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let queries = await stubEvents(page, (query) =>
        query.has("since") ? {} : { events: stubbedRange(1, 40) },
      );
      await openEvents(page, host);
      await expect.poll(() => eventsHeld(page)).toBe(40);
      await expect(rows(page).first()).toBeVisible();
      expect(older(queries)).toEqual(["?limit=100"]);

      queries = await stubEvents(page, () => ({}));
      await page.reload();
      await expect(page.getByText("No events yet.")).toBeVisible();
      expect(older(queries)).toEqual(["?limit=100"]);
    } finally {
      await host.dispose();
    }
  });

  test("with a chip or a search on, nothing loads by itself, and Load older events loads one page per press", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      for (const [turn, address] of ["/activity?subject=lease", "/activity?q=RENEWED"].entries()) {
        const queries = await stubEvents(page, (query) => {
          if (query.get("before") === null) return { events: stubbedRange(1, 30) };
          if (query.get("before") === "evt_0030") return { events: stubbedRange(31, 130) };
          return query.get("before") === "evt_0130" ? { events: stubbedRange(131, 230) } : {};
        });
        await visit(page, host, address, turn === 0);
        await expect.poll(() => eventsHeld(page)).toBe(30);
        const more = page.getByRole("button", { name: "Load older events" });
        await expect(more).toBeVisible();
        await page.waitForTimeout(500);
        expect(older(queries)).toEqual([]);

        await more.click();
        await expect.poll(() => eventsHeld(page)).toBe(130);
        expect(older(queries)).toEqual(["?before=evt_0030&limit=100"]);
        await page.waitForTimeout(500);
        expect(older(queries)).toHaveLength(1);

        await more.click();
        await expect.poll(() => eventsHeld(page)).toBe(230);
        expect(older(queries)).toHaveLength(2);
      }
    } finally {
      await host.dispose();
    }
  });

  test("a chip or a search that matches no held event says so and offers Load older events, which loads one page", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const queries = await stubEvents(page, (query) =>
        query.get("before") === null
          ? { events: stubbedRange(1, 30) }
          : { events: stubbedRange(31, 70) },
      );
      const cases = [
        ["/activity?subject=worker", "No worker events among those loaded."],
        ["/activity?q=zzz", "No events match zzz among those loaded."],
      ] as const;
      for (const [turn, [address, said]] of cases.entries()) {
        queries.length = 0;
        await visit(page, host, address, turn === 0);
        await expect(page.getByText(said)).toBeVisible();
        const more = page.getByRole("button", { name: "Load older events" });
        await expect(more).toBeVisible();

        await more.click();

        await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
        expect(older(queries)).toEqual(["?before=evt_0030&limit=100"]);
        await expect(page.getByText(said)).toBeVisible();
        await expect(more).toHaveCount(0);
      }
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, a worker's event shows that worker's label", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const worker = fleet.workers[0] as RunningDaemon;
      await openEvents(page, fleet.gateway);

      await lease(worker, "console-e2e-label");

      const granted = rows(page).filter({ hasText: "lease.granted" });
      await expect(granted).toHaveCount(1);
      await expect(granted).toContainText("worker-a");
      await granted.click();
      await expect(page.getByText("workerId", { exact: true })).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a worker joining a gateway shows no join token anywhere in the gateway's events page", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const joinToken = fleet.gateway.tokens.worker;
      await openEvents(page, fleet.gateway);
      await expect(rows(page).filter({ hasText: "worker.connected" })).not.toHaveCount(0);
      const events = await cliEvents(fleet.gateway);
      await expect.poll(async () => (await shownEvents(page)).length).toBe(events.length);

      const seen: string[] = [];
      for (const event of events) {
        await openEvent(page, event.id);
        await expect(title(page)).toHaveText(event.event);
        seen.push(await page.getByRole("dialog").innerText());
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      expect(seen.join("\n")).not.toContain(joinToken);
      expect(await page.content()).not.toContain(joinToken);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the events page has no horizontal scroll at 360px wide, even with the longest payload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-narrow");
      await page.setViewportSize({ height: 740, width: 360 });
      await openEvents(page, host);
      expect(await hasHorizontalScroll(page)).toBe(false);

      const started = (await cliEvents(host)).find((event) => event.event === "daemon.started");
      await openEvent(page, (started as Envelope).id);
      await expect(title(page)).toHaveText("daemon.started");

      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the events page is usable with the keyboard alone", async ({ browserName, page }) => {
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-keyboard");
      await keyboardOnly(page, host, tab);
    } finally {
      await host.dispose();
    }
  });
});

async function keyboardOnly(page: Page, host: RunningDaemon, tab: string): Promise<void> {
  await page.goto(host.url);
  await signInWithKeyboard(page, host.tokens.operator, tab);
  await expect(page.getByRole("navigation").first()).toBeVisible();

  const nav = page.getByRole("link", { name: "Activity", exact: true });
  for (let step = 0; step < 30 && !(await isFocused(nav)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(nav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "lease.granted" })).not.toHaveCount(0);

  const all = page.getByRole("radio", { name: "All" });
  for (let step = 0; step < 30 && !(await isFocused(all)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(all).toBeFocused();
  await expect(all).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();

  const names = await rows(page).locator("time + span").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name.startsWith("lease."))).toBe(true);

  for (let step = 0; step < 10 && !(await isFocused(feed(page))); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(feed(page)).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/activity\/[^/?]+\?subject=lease$/);
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}
