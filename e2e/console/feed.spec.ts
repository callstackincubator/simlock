import type { Locator, Page, Response, Route } from "@playwright/test";

import { connectSimlock } from "../../dist/client/index.js";
import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";
import { IOS, LEASE } from "./pages.js";
import { events, stubReplay } from "./stubs.js";

// why: the event feed draws only the rows in view of an inner scroll box, so what it keeps in view,
// what it asks the daemon for as the reader nears the end, and how it moves under a reader are
// things only a browser engine's layout and scrolling can show.

async function lease(daemon: RunningDaemon, agent: string): Promise<void> {
  const granted = await daemon.cli([...LEASE, "--detach", "--agent-id", agent]);
  expect(granted.code, granted.stderr).toBe(0);
}

async function openEvents(page: Page, daemon: RunningDaemon, path = "/activity"): Promise<void> {
  await page.goto(new URL(path, daemon.url).href);
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

function rows(page: Page): Locator {
  return feed(page).getByRole("listitem");
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

interface Stubbed {
  readonly id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

// why: one clock for every stubbed event, so a time the test names is the time the page shows.
const BASE = Date.now();

function stubbedRange(from: number, to: number): Stubbed[] {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const n = to - index;
    return {
      event: "lease.renewed",
      id: `evt_${String(n).padStart(4, "0")}`,
      payload: {},
      seq: 1_000_000 - n,
      timestamp: BASE - n * 60_000,
    };
  });
}

interface StubbedAnswer {
  readonly status?: number;
  readonly events?: readonly Stubbed[];
}

// why: answers every `GET /v1/events` with what `answer` returns for its query, and records each
// query, so a test sees which pages the console asked for.
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
      const { events: answered = [], status = 200 } = await answer(new URLSearchParams(search));
      await route.fulfill({
        headers: { date: new Date().toUTCString() },
        json:
          status === 200
            ? { events: answered }
            : { error: { code: "STUBBED", message: "stubbed" } },
        status,
      });
    },
  );
  return queries;
}

function older(queries: readonly string[]): string[] {
  return queries.filter((query) => !query.startsWith("?since="));
}

const NUMBER = /evt_load_(\d+)/;

// why: scrolls the feed down past its first 2,000 pixels with the mouse wheel, as a reader would.
async function scrollDown(page: Page): Promise<void> {
  const scrolled = () => feed(page).evaluate((box) => box.scrollTop);
  await feed(page).hover();
  for (let turn = 0; turn < 40 && (await scrolled()) <= 2_000; turn += 1) {
    await page.mouse.wheel(0, 1_000);
  }
  await expect.poll(scrolled).toBeGreaterThan(2_000);
  // why: a wheel scroll can still be moving, so the box has to have stood still for a while.
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
    const inView = [...box.querySelectorAll<HTMLElement>("li")]
      .map((row) => ({ row, top: row.getBoundingClientRect().top - edge }))
      .filter(({ row, top }) => top + row.getBoundingClientRect().height > 0)
      .sort((a, b) => a.top - b.top);
    const first = inView[0];
    const href = first?.row.querySelector("a")?.getAttribute("href") ?? "";
    return {
      n: new RegExp(pattern).exec(decodeURIComponent(href))?.[1] ?? "",
      top: Math.round(first?.top ?? Number.NaN),
    };
  }, NUMBER.source);
}

test.describe("the events feed", () => {
  test("scrolls inside itself with the keyboard, keeps a reader at its end when the oldest page and the end row arrive late, and counts the events that came in while scrolled down", async ({
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

  test("a new event while scrolled down keeps the visible rows in place and counts in the new-events button, which scrolls to the top, clears its count and takes focus", async ({
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
      await stubReplay(page, events(1_000));
      await openEvents(page, host);
      await expect.poll(() => eventsHeld(page)).toBe(1_000);

      await scrollDown(page);
      const before = await firstInView(page);
      expect(before.n).not.toBe("1000");

      // why: each renew is one lease.renewed, newer than every event in the list.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsHeld(page)).toBe(1_001);
      await expect(page.getByRole("button", { name: "1 new event" })).toBeVisible();
      expect(await firstInView(page)).toEqual(before);

      await client.renewLease({ leaseId: grant.lease.id });
      await expect(page.getByRole("button", { name: "2 new events" })).toBeVisible();
      expect(await firstInView(page)).toEqual(before);

      const button = page.getByRole("button", { name: "2 new events" });
      await button.click();
      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      await expect(button).toHaveCount(0);
      // why: the button is gone, so focus moves to the feed rather than dropping to the page.
      await expect(feed(page)).toBeFocused();
      await expect(rows(page).first().locator(".event-name")).toHaveText("lease.renewed");

      // why: at the top, the next event shows at the top with no count.
      await client.renewLease({ leaseId: grant.lease.id });
      await expect.poll(() => eventsHeld(page)).toBe(1_003);
      await expect(page.getByRole("button", { name: /new event/ })).toHaveCount(0);
      expect(await feed(page).evaluate((box) => box.scrollTop)).toBe(0);

      // why: down again, the count starts from what was at the top when the reader left it.
      await scrollDown(page);
      await client.renewLease({ leaseId: grant.lease.id });
      await expect(page.getByRole("button", { name: "1 new event" })).toBeVisible();
    } finally {
      await client.close();
      await host.dispose();
    }
  });

  test("scrolling within 20 rows of the end loads the 100 events before the oldest held and appends them without moving the rows in view", async ({
    daemon,
    page,
  }) => {
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
    await openEvents(page, daemon, "/activity?range=24h");

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
  });

  test("at the end of a feed holding 10,000 events nothing more is asked for, and at the end of one holding the page asked for, the page adds no event", async ({
    daemon,
    page,
  }) => {
    let queries = await stubEvents(page, () => ({ events: stubbedRange(1, 10_000) }));
    await openEvents(page, daemon, "/activity?range=24h");
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
  });

  test("holding 10,000 events it puts fewer than 100 rows in the DOM, scrolls through them frame by frame with no blank and the newest first", async ({
    browserName,
    daemon,
    page,
  }) => {
    const replay = events(10_000);
    await stubReplay(page, replay);
    await openEvents(page, daemon);
    await expect.poll(() => eventsHeld(page)).toBe(10_000);

    expect(await rows(page).count()).toBeGreaterThan(0);
    expect(await rows(page).count()).toBeLessThan(100);
    expect((await firstInView(page)).n).toBe("10000");
    // why: halfway down, the rows there are drawn in place of the first ones, and no more of them.
    await feed(page).evaluate((box) => {
      box.scrollTop = box.scrollHeight / 2;
    });
    await expect.poll(async () => Number((await firstInView(page)).n)).toBeGreaterThan(4_000);
    expect(Number((await firstInView(page)).n)).toBeLessThan(6_000);
    expect(await rows(page).count()).toBeLessThan(100);
    await feed(page).evaluate((box) => {
      box.scrollTop = 0;
    });

    // why: down to the oldest, two boxes at a time, one step a frame, as a fast fling would.
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
        const drawn = box.querySelectorAll("li");
        most = Math.max(most, drawn.length);
        const edge = box.getBoundingClientRect();
        const covered = [...drawn].some((row) => {
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
        most,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        worst: sorted.at(-1) ?? 0,
      };
    });
    console.log(`${browserName}: 10,000 events, ${JSON.stringify(run)}`);
    expect(run.lastHref).toBe("/activity/evt_load_1");
    expect(run.blank).toBe(0);
    expect(run.most).toBeLessThan(100);
    expect(run.p95).toBeLessThan(50);
    // why: smooth means the p95 frame above and no freeze; long frames are not counted one by one,
    // as CI's WebKit drew 15 of 662 frames over 100 ms with every other measure in bounds.
    expect(run.worst).toBeLessThan(1_000);

    await feed(page).evaluate((box) => {
      box.scrollTop = 0;
    });
    const first = rows(page).first();
    await expect(first.locator("time")).toHaveAttribute(
      "datetime",
      new Date((replay[0] as { timestamp: number }).timestamp).toISOString(),
    );
  });

  test("choosing another filter starts the feed again at the top", async ({ daemon, page }) => {
    await stubReplay(page, events(1_000));
    await openEvents(page, daemon);
    await expect.poll(() => eventsHeld(page)).toBe(1_000);
    await scrollDown(page);

    // why: every generated event is under Other, so it is the same list, shown again from its top.
    await page
      .getByRole("group", { name: "Kind" })
      .getByRole("checkbox", { name: "Other" })
      .check();

    await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
    expect((await firstInView(page)).n).toBe("1000");
  });

  test("a worker's Events tab scrolls back through that worker's history to its start, asking for that worker's events only", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const idA = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await page.goto(fleet.gateway.url);
      await signIn(page, fleet.gateway.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      const workerFeed = page.getByRole("region", { name: "Event feed for this worker" });
      const asked: string[] = [];
      const answered: { readonly payload?: { readonly workerId?: string } }[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/v1/events") asked.push(url.search);
      });
      const reads: Promise<void>[] = [];
      const readEvents = (response: Response) => {
        if (new URL(response.url()).pathname !== "/v1/events") return;
        reads.push(
          response.json().then((body: { events?: (typeof answered)[number][] }) => {
            answered.push(...(body.events ?? []));
          }),
        );
      };
      page.on("response", readEvents);
      // why: a page of older events holds 100, so more than 100 of worker A's own are needed.
      for (let round = 0; round < 25; round += 1) {
        const granted = await fleet.gateway.cli([
          ...LEASE,
          "--detach",
          "--agent-id",
          `history-${round}`,
        ]);
        expect(granted.code, granted.stderr).toBe(0);
        const released = await fleet.gateway.cli([
          "release",
          (JSON.parse(granted.stdout) as { lease: { id: string } }).lease.id,
        ]);
        expect(released.code, released.stderr).toBe(0);
      }
      // why: taller than the feed's own height cap, so only a feed that fills the page reaches the bottom.
      await page.setViewportSize({ height: 1_800, width: 1_280 });
      await page.goto(
        new URL(`/fleet/${encodeURIComponent(idA)}?tab=events`, fleet.gateway.url).href,
      );
      await expect(workerFeed).toBeVisible();
      const box = await workerFeed.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(1_800 - 120);
      await expect(page.getByText("Start of the history (", { exact: false })).toHaveCount(0);
      await expect
        .poll(async () => {
          await workerFeed.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
          return page.getByText("Start of the history (", { exact: false }).count();
        })
        .toBe(1);
      expect(asked.some((query) => query.includes("before="))).toBe(true);
      expect(asked.filter((query) => !query.includes(`worker=${encodeURIComponent(idA)}`))).toEqual(
        [],
      );
      // why: a body still unread when the fleet is disposed would reject the test.
      page.off("response", readEvents);
      await Promise.all(reads);
      expect(answered.length).toBeGreaterThan(100);
      expect(answered.filter((event) => event.payload?.workerId !== idA)).toEqual([]);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
