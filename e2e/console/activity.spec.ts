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

function kind(page: Page, name: string): Locator {
  return page.getByRole("group", { name: "Kind" }).getByRole("checkbox", { name });
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
        const name = item.querySelector(".event-name");
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
  readonly payload: Record<string, unknown>;
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

function older(queries: readonly string[]): string[] {
  return queries.filter((query) => !query.startsWith("?since="));
}

// why: the feed draws only the rows in view and prints no count, so its scroll height, one row
// tall per event, is the only measure of how many events it holds.
const ROW_PX = 38;

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
      await openEvents(page, host, "/activity?range=24h");

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

  test("at the end of a feed holding 10,000 events nothing more is asked for, and at the end of one holding the page asked for, the page adds no event", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      let queries = await stubEvents(page, () => ({ events: stubbedRange(1, 10_000) }));
      await openEvents(page, host, "/activity?range=24h");
      await expect(page.getByText("Showing the newest 10,000 events.")).toBeVisible();
      await feed(page).focus();
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      expect(older(queries)).toEqual([]);

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

  test("a worker joining a gateway shows no join token anywhere in the gateway's events page", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const [joinToken = ""] = fleet.joinTokens;
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

  const leases = kind(page, "Leases");
  for (let step = 0; step < 30 && !(await isFocused(leases)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(leases).toBeFocused();
  await expect(leases).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(leases).toBeChecked();

  const names = await rows(page).locator(".event-name").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name.startsWith("lease."))).toBe(true);

  for (let step = 0; step < 10 && !(await isFocused(feed(page))); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(feed(page)).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/activity\/[^/?]+\?kind=lease$/);
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}
