import type { Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

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

  test("the Waiting page's Wait p95 equals GET /v1/stats?since=1h totals.wait.p95, also when opened as /waiting?range=7d", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await scriptedRun(host);
      const stats = await statsOf(host, "1h");
      await page.goto(new URL("/waiting?range=7d", host.url).toString());
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Waiting" })).toBeVisible();

      await expect(page.getByRole("radio")).toHaveCount(0);
      await expect(page.locator("#main")).toContainText(
        `Wait p95 ${waitText(stats.totals.wait.p95)} last hour`,
      );
    } finally {
      await host.dispose();
    }
  });
});
