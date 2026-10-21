import type { Page, Route } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  joinOldWorker,
  type RunningDaemon,
  settled,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

const RANGES = [
  { label: "1 hour", since: "1h", unit: "last hour" },
  { label: "6 hours", since: "6h", unit: "last 6 hours" },
  { label: "24 hours", since: "24h", unit: "last 24 hours" },
  { label: "7 days", since: "7d", unit: "last 7 days" },
] as const;

const CHARTS = ["leasesHeld", "queueDepth", "slotsUsed"] as const;

interface Stats {
  readonly totals: { readonly granted: number; readonly wait: { readonly p95: number | null } };
  readonly series: readonly Record<(typeof CHARTS)[number], number | null>[];
}

async function operatorGet(host: RunningDaemon, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, host.url), {
    headers: { Authorization: `Bearer ${host.tokens.operator}` },
  });
  expect(response.status, path).toBe(200);
  return response.json();
}

async function statsOf(host: RunningDaemon, since: string): Promise<Stats> {
  return (await operatorGet(host, `/v1/stats?since=${since}`)) as Stats;
}

function waitText(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1_000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

async function waitingCount(host: RunningDaemon): Promise<number> {
  const { requests } = (await operatorGet(host, "/v1/lease-requests")) as { requests: unknown[] };
  return requests.length;
}

// why: the charts draw complete minutes only, so a run is charted once the minute it started in is
// over; the Granted tile is the live figure and needs no such wait.
async function scriptedRun(host: RunningDaemon): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const held = await host.cli([...LEASE, "--agent-id", "holder", "--detach"]);
  expect(held.code, held.stderr).toBe(0);
  host.cliBackground([...LEASE, "--agent-id", "waiter"]);
  await waitFor(async () => (await waitingCount(host)) === 1, { label: "a request waiting" });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const released = await host.cli(["release", (held.json as { lease: { id: string } }).lease.id]);
  expect(released.code, released.stderr).toBe(0);
  await waitFor(async () => (await waitingCount(host)) === 0, { label: "the request granted" });
  const minuteOver = (minute + 1) * 60_000 + 1_000;
  await waitFor(() => Date.now() >= minuteOver, { label: "the minute over", timeout: 70_000 });
  await waitFor(
    async () => {
      const stats = await statsOf(host, "1h");
      return CHARTS.every((key) => stats.series.some((point) => point[key] !== null));
    },
    { label: "the run in a completed minute", timeout: 30_000 },
  );
}

async function openOverview(page: Page, host: RunningDaemon, path = "/"): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await settled(page);
}

function tile(page: Page, label: string) {
  return page
    .getByRole("list", { name: "Fleet at a glance" })
    .getByRole("listitem")
    .filter({ has: page.locator(".stat-label", { hasText: new RegExp(`^${label}$`) }) });
}

async function tileText(page: Page, label: string): Promise<string> {
  const parts = await tile(page, label)
    .locator(".stat-label, .stat-value, .stat-unit")
    .allTextContents();
  return parts.join(" | ");
}

async function tablesOf(page: Page): Promise<readonly (readonly string[])[]> {
  const tables = page.locator("#main details.chart-data");
  const count = await tables.count();
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      tables.nth(index).locator("tbody td.num").allTextContents(),
    ),
  );
}

function expectedTables(stats: Stats): readonly (readonly string[])[] {
  return CHARTS.map((key) =>
    [...stats.series].reverse().map((point) => (point[key] === null ? "—" : String(point[key]))),
  );
}

test.describe("the Overview's figures", () => {
  // why: a run is charted once its minute is over, which can take most of a minute.
  test.describe.configure({ timeout: 150_000 });

  test("picking each of 1 hour, 6 hours, 24 hours and 7 days writes its ?range=, and the two tiles and all three chart tables equal GET /v1/stats", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await scriptedRun(host);
      await openOverview(page, host);

      for (const range of RANGES) {
        await page.getByRole("radio", { name: range.label }).check();
        await expect(page.getByRole("radio", { name: range.label })).toBeChecked();
        if (range.since === "1h") expect(new URL(page.url()).search).toBe("");
        else expect(new URL(page.url()).search).toBe(`?range=${range.since}`);
        await expect(
          page.getByRole("heading", { name: `Leases held, ${range.unit}`, exact: true }),
        ).toBeVisible();

        const stats = await statsOf(host, range.since);
        await expect
          .poll(() => tileText(page, "Granted"))
          .toBe(`Granted | ${stats.totals.granted} | ${range.unit}`);
        await expect
          .poll(() => tileText(page, "Wait p95"))
          .toBe(`Wait p95 | ${waitText(stats.totals.wait.p95)} | ${range.unit}`);
        const expected = expectedTables(stats);
        expect(expected.every((rows) => rows.some((row) => row !== "—"))).toBe(true);
        await expect.poll(() => tablesOf(page)).toEqual(expected);
      }
    } finally {
      await host.dispose();
    }
  });

  test("a reload of /?range=6h keeps 6 hours checked and the same tile numbers", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await scriptedRun(host);
      await openOverview(page, host, "/?range=6h");
      await expect(page.getByRole("radio", { name: "6 hours" })).toBeChecked();
      await expect(tile(page, "Granted")).toBeVisible();
      const before = [await tileText(page, "Granted"), await tileText(page, "Wait p95")];

      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      await expect(page.getByRole("radio", { name: "6 hours" })).toBeChecked();
      await expect.poll(() => tileText(page, "Granted")).toBe(before[0]);
      await expect.poll(() => tileText(page, "Wait p95")).toBe(before[1]);
    } finally {
      await host.dispose();
    }
  });

  test("a daemon stop and start, with the events behind the figures pruned, shows the same Wait p95, Granted and chart rows", async ({
    page,
  }) => {
    const host = await startDaemon("worker", {
      config: { ...ONE_DEVICE, eventLog: { retention: 5_000 } },
      driverScript: { ios: IOS },
    });
    try {
      await scriptedRun(host);
      await openOverview(page, host, "/?range=24h");
      await expect(tile(page, "Granted")).toBeVisible();
      const before = {
        granted: await tileText(page, "Granted"),
        rows: (await tablesOf(page)).map((rows) => rows.filter((row) => row !== "—")),
        wait: await tileText(page, "Wait p95"),
      };

      expect(before.rows).toHaveLength(3);
      expect(before.rows.every((rows) => rows.length > 0)).toBe(true);

      await host.stop();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await host.start();
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      const { events } = (await operatorGet(host, "/v1/events?since=24h")) as {
        events: { event: string }[];
      };
      expect(events.filter((entry) => entry.event === "lease.granted")).toEqual([]);
      await expect.poll(() => tileText(page, "Granted")).toBe(before.granted);
      await expect.poll(() => tileText(page, "Wait p95")).toBe(before.wait);
      const after = (await tablesOf(page)).map((rows) => rows.filter((row) => row !== "—"));
      expect(after.map((rows, index) => rows.slice(-(before.rows[index]?.length ?? 0)))).toEqual(
        before.rows,
      );
    } finally {
      await host.dispose();
    }
  });

  test("a lease granted while the Overview is open raises Granted within 2 seconds with no reload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openOverview(page, host);
      await expect(tile(page, "Granted")).toBeVisible();
      await expect(tile(page, "Granted")).toContainText("0");

      const granted = await host.cli([...LEASE, "--agent-id", "late", "--detach"]);
      expect(granted.code, granted.stderr).toBe(0);

      await expect(tile(page, "Granted").locator(".stat-value")).toHaveText("1", {
        timeout: 2_000,
      });
    } finally {
      await host.dispose();
    }
  });

  test("Overview's tiles and links land on /queue, /fleet and /activity, not Not found", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const links = [
        { follow: () => tile(page, "Waiting").getByRole("link").click(), path: "/queue" },
        { follow: () => tile(page, "Workers").getByRole("link").click(), path: "/fleet" },
        { follow: () => page.getByRole("link", { name: /^All \d+$/ }).click(), path: "/fleet" },
        { follow: () => page.getByRole("link", { name: "All events" }).click(), path: "/activity" },
      ];
      await openOverview(page, host);
      for (const { follow, path } of links) {
        await page.goto(new URL("/", host.url).toString());
        await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
        await follow();
        await expect(page, path).toHaveURL(new RegExp(`${path}$`));
        await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toHaveCount(
          0,
        );
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
    } finally {
      await host.dispose();
    }
  });

  test("the Queue page's Wait p95 equals GET /v1/stats?since=1h totals.wait.p95, also when opened as /queue?range=7d", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await scriptedRun(host);
      const stats = await statsOf(host, "1h");
      await page.goto(new URL("/queue?range=7d", host.url).toString());
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();

      await expect(page.getByRole("radio")).toHaveCount(0);
      await expect(page.locator("#main")).toContainText(
        `Wait p95 ${waitText(stats.totals.wait.p95)} last hour`,
      );
    } finally {
      await host.dispose();
    }
  });
});

async function workerConnection(host: RunningDaemon, label: string): Promise<string | undefined> {
  const { workers } = (await operatorGet(host, "/v1/workers")) as {
    workers: { label?: string; connection: string }[];
  };
  return workers.find((worker) => worker.label === label)?.connection;
}

test.describe("the Overview's Inbox lines", () => {
  test("an empty Inbox shows Nothing needs you and no Needs you panel; a disconnected worker shows the panel with that item first, and All in Inbox (1)", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openOverview(page, fleet.gateway);
      await expect(page.getByText("Nothing needs you")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);

      await (fleet.workers[1] as RunningDaemon).stop();
      await waitFor(
        async () => (await workerConnection(fleet.gateway, "worker-b")) === "disconnected",
        {
          label: "worker-b disconnected",
        },
      );

      const panel = page.getByRole("region", { name: "Needs you" });
      await expect(panel).toBeVisible();
      await expect(page.getByText("Nothing needs you")).toHaveCount(0);
      await expect(panel.getByRole("link").first()).toContainText("worker-b");
      await expect(panel.getByRole("link", { name: "All in Inbox (1)" })).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("with five problem items the panel shows four, and a row opens /inbox/<key>", async ({
    page,
  }) => {
    const gateway = await startDaemon("gateway");
    const hangUps: (() => void)[] = [];
    try {
      for (let index = 1; index <= 5; index += 1) {
        hangUps.push(
          await joinOldWorker(gateway, { id: `wrk_old_${index}`, label: `old-${index}` }),
        );
      }
      await waitFor(
        async () => {
          const { workers } = (await operatorGet(gateway, "/v1/workers")) as {
            workers: { connection: string }[];
          };
          return workers.filter((worker) => worker.connection === "incompatible").length === 5;
        },
        { label: "five incompatible workers" },
      );
      await openOverview(page, gateway);

      const panel = page.getByRole("region", { name: "Needs you" });
      await expect(panel.getByRole("listitem")).toHaveCount(4);
      await expect(panel.getByRole("link", { name: "All in Inbox (5)" })).toBeVisible();
      await panel.getByRole("listitem").first().getByRole("link").click();
      await expect(page).toHaveURL(/\/inbox\/wrk_old_\d%2Fincompatible$/);
    } finally {
      for (const hangUp of hangUps) hangUp();
      await gateway.dispose();
    }
  });

  test("with /v1/lease-requests stubbed to fail, Overview says Could not check: waiting requests and not Nothing needs you", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await page.route(
        (url) => url.pathname === "/v1/lease-requests",
        (route) =>
          route.fulfill({
            json: { error: { code: "INTERNAL", message: "The queue is down." } },
            status: 500,
          }),
      );
      await openOverview(page, host);

      await expect(page.getByText("Could not check: waiting requests")).toBeVisible();
      await expect(page.getByText("Nothing needs you")).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });
});

test.describe("the Overview's five numbers", () => {
  test("show the daemon's values: one lease held of four devices with three ready, one request waiting with its longest wait, two of two workers, Wait p95, and Ending soon counting a lease with 4 minutes left and not one with 10", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const held: string[] = [];
      for (const agent of ["one", "two", "three", "four"]) {
        const granted = await fleet.gateway.cli([...LEASE, "--agent-id", agent, "--detach"]);
        expect(granted.code, granted.stderr).toBe(0);
        held.push((granted.json as { lease: { id: string } }).lease.id);
      }
      for (const id of held.slice(1)) {
        const released = await fleet.gateway.cli(["release", id]);
        expect(released.code, released.stderr).toBe(0);
      }
      await waitFor(
        async () => {
          const { workers } = (await operatorGet(fleet.gateway, "/v1/workers")) as {
            workers: { devices: { state: string }[] }[];
          };
          const states = workers.flatMap((worker) => worker.devices.map((device) => device.state));
          return states.length === 4 && states.filter((state) => state === "ready").length === 3;
        },
        { label: "four devices, three ready" },
      );
      // why: a request is stubbed as waiting 2 minutes and a lease as ending, at times a real daemon cannot reach quickly,
      // each counted from the daemon's own clock (its Date header).
      await page.route(
        (url) => url.pathname === "/v1/lease-requests",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          await route.fulfill({
            json: {
              requests: [
                {
                  createdAt: now - 125_000,
                  id: "req_stub",
                  platform: "ios",
                  queuePosition: 1,
                  requesterId: "stub",
                  stage: "queued",
                },
              ],
            },
            response,
          });
        },
      );
      await page.route(
        (url) => url.pathname === "/v1/leases",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          const { leases } = (await response.json()) as {
            leases: { id: string; ttlDeadline: number }[];
          };
          const [first] = leases;
          if (first === undefined) throw new Error("the daemon lists no lease");
          await route.fulfill({
            json: {
              leases: [
                { ...first, ttlDeadline: now + 4 * 60_000 },
                { ...first, id: "lease-later", ttlDeadline: now + 10 * 60_000 },
              ],
            },
            response,
          });
        },
      );

      await openOverview(page, fleet.gateway);

      const stats = await statsOf(fleet.gateway, "1h");
      await expect.poll(() => tileText(page, "Leased")).toBe("Leased | 1 | of 4 · 3 ready");
      await expect
        .poll(() => tileText(page, "Waiting"))
        .toMatch(/^Waiting \| 1 \| longest 2 min \d+ s$/);
      await expect.poll(() => tileText(page, "Workers")).toBe("Workers | 2 | of 2");
      await expect
        .poll(() => tileText(page, "Wait p95"))
        .toBe(`Wait p95 | ${waitText(stats.totals.wait.p95)} | last hour`);
      await expect.poll(() => tileText(page, "Ending soon")).toBe("Ending soon | 1 | under 5 min");
    } finally {
      await disposeFleet(fleet);
    }
  });
});
