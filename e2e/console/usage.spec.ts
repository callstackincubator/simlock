import type { Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface Samples {
  readonly p95: number | null;
}

interface Stats {
  readonly totals: {
    readonly requests: number;
    readonly granted: number;
    readonly bySource: Readonly<Record<string, number | undefined>>;
    readonly rejected: {
      readonly total: number;
      readonly byReason: Readonly<Record<string, number>>;
    };
    readonly wait: Samples;
    readonly utilisation: {
      readonly slots: { readonly peak: number | null; readonly mean: number | null };
    };
  };
  readonly requesters: readonly {
    readonly id: string;
    readonly label?: string;
    readonly requests: number;
    readonly granted: number;
    readonly rejected: number;
  }[];
  readonly workers: readonly { readonly id: string; readonly label?: string }[];
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

// why: one waiter, one --no-wait refusal and one grant, so wait, rejections and requesters all have
// something to show; the slots figures come from completed minutes, so the run waits for the one it
// started in to end.
async function scriptedRun(host: RunningDaemon, completeMinute = false): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const held = await host.cli([...LEASE, "--agent-id", "holder", "--detach"]);
  expect(held.code, held.stderr).toBe(0);
  host.cliBackground([...LEASE, "--agent-id", "waiter"]);
  await waitFor(async () => (await waitingCount(host)) === 1, { label: "a request waiting" });
  const refused = await host.cli([...LEASE, "--agent-id", "refused", "--no-wait", "--detach"]);
  expect(refused.code).toBe(11);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const released = await host.cli(["release", (held.json as { lease: { id: string } }).lease.id]);
  expect(released.code, released.stderr).toBe(0);
  await waitFor(async () => (await waitingCount(host)) === 0, { label: "the request granted" });
  if (!completeMinute) return;
  const minuteOver = (minute + 1) * 60_000 + 1_000;
  await waitFor(() => Date.now() >= minuteOver, { label: "the minute over", timeout: 70_000 });
  await waitFor(async () => (await statsOf(host, "1h")).totals.utilisation.slots.peak !== null, {
    label: "the run in a completed minute",
    timeout: 30_000,
  });
}

async function openUsage(page: Page, host: RunningDaemon, path = "/usage"): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await settled(page);
}

function tile(page: Page, label: string) {
  return page
    .locator("#main .stat")
    .filter({ has: page.locator(".stat-label", { hasText: new RegExp(`^${label}$`) }) });
}

async function tileValue(page: Page, label: string): Promise<string> {
  return (await tile(page, label).locator(".stat-value").textContent()) ?? "";
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true });
}

async function expectCounts(
  page: Page,
  name: string,
  counts: Readonly<Record<string, number | undefined>>,
): Promise<void> {
  for (const [key, count] of Object.entries(counts)) {
    if (count !== undefined) {
      await expect(region(page, name)).toContainText(new RegExp(`${key}\\W*${count}\\b`));
    }
  }
}

async function expectRequesters(page: Page, requesters: Stats["requesters"]): Promise<void> {
  for (const requester of requesters) {
    const row = region(page, "Per requester")
      .getByRole("row")
      .filter({ hasText: requester.label ?? requester.id });
    await expect(row).toContainText(
      new RegExp(`${requester.requests}\\s*${requester.granted}\\s*${requester.rejected}`),
    );
  }
}

test.describe("the Usage page", () => {
  test("after a scripted run, /usage?range=24h shows the requests, grants by source, rejections by reason, wait p95, slots peak and mean and requester rows of GET /v1/stats?since=24h and simlock stats --since 24h --json, and its per-worker table has one row, the host", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      test.setTimeout(150_000);
      await scriptedRun(host, true);
      const cliStats = await host.cli(["stats", "--since", "24h", "--json"]);
      expect(cliStats.code, cliStats.stderr).toBe(0);
      const stats = await statsOf(host, "24h");
      const fromCli = (cliStats.json as Stats).totals;

      await openUsage(page, host, "/usage?range=24h");

      expect(fromCli.requests).toBe(stats.totals.requests);
      expect(stats.totals.requests).toBeGreaterThanOrEqual(3);
      expect(await tileValue(page, "Requests")).toBe(String(stats.totals.requests));
      expect(await tileValue(page, "Granted")).toBe(String(stats.totals.granted));
      expect(await tileValue(page, "Rejected")).toBe(String(stats.totals.rejected.total));
      expect(await tileValue(page, "Wait p95")).toBe(waitText(stats.totals.wait.p95));
      await expectCounts(page, "Grants by source", stats.totals.bySource);
      await expectCounts(page, "Rejections by reason", stats.totals.rejected.byReason);
      await expect(region(page, "Use over the range")).toContainText(
        `peak ${stats.totals.utilisation.slots.peak}`,
      );
      // why: the mean is time-weighted over a window that moves, so it is read from the daemon
      // again with each look at the page.
      await expect
        .poll(async () => {
          const mean = (await statsOf(host, "24h")).totals.utilisation.slots.mean;
          const shown = await region(page, "Use over the range").textContent();
          return shown?.includes(`mean ${mean === null ? "—" : mean.toFixed(1)}`) ?? false;
        })
        .toBe(true);
      await expectRequesters(page, stats.requesters);
      expect(stats.requesters.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(["holder", "waiter", "refused"]),
      );
      const workers = region(page, "Per worker").locator("tbody tr");
      await expect(workers).toHaveCount(1);
      await expect(workers).toContainText(stats.workers[0]?.label ?? stats.workers[0]?.id ?? "");
    } finally {
      await host.dispose();
    }
  });

  test("/usage opens on 1 hour, choosing 7 days writes ?range=7d, and a reload keeps 7 days checked and the same figures", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await scriptedRun(host);
      await openUsage(page, host);
      await expect(page.getByRole("radio", { name: "1 hour" })).toBeChecked();

      await page.getByRole("radio", { name: "7 days" }).check();

      expect(new URL(page.url()).search).toBe("?range=7d");
      const stats = await statsOf(host, "7d");
      await expect.poll(() => tileValue(page, "Requests")).toBe(String(stats.totals.requests));
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
      await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
      await expect.poll(() => tileValue(page, "Requests")).toBe(String(stats.totals.requests));
      await expect.poll(() => tileValue(page, "Granted")).toBe(String(stats.totals.granted));
    } finally {
      await host.dispose();
    }
  });

  test("a lease granted while the page is open raises Requests and Granted within 2 seconds with no reload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openUsage(page, host);
      await expect(tile(page, "Requests")).toBeVisible();
      await expect(tile(page, "Granted").locator(".stat-value")).toHaveText("0");

      const granted = await host.cli([...LEASE, "--agent-id", "late", "--detach"]);
      expect(granted.code, granted.stderr).toBe(0);

      await expect(tile(page, "Requests").locator(".stat-value")).toHaveText("1", {
        timeout: 2_000,
      });
      await expect(tile(page, "Granted").locator(".stat-value")).toHaveText("1", {
        timeout: 2_000,
      });
    } finally {
      await host.dispose();
    }
  });

  test("shows the Device slots in use chart in the shared frame", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await page.goto(new URL("/usage?range=6h", host.url).toString());
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();

      await expect(
        page.getByRole("heading", { name: "Device slots in use, last 6 hours", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#main details.chart-data")).toHaveCount(1);
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway with two workers, the per-worker table has two rows, each named by its worker's label", async ({
    page,
  }) => {
    const gateway = await startDaemon("gateway");
    const workers: RunningDaemon[] = [];
    try {
      for (const label of ["worker-a", "worker-b"]) {
        workers.push(
          await startDaemon("worker", {
            config: {
              ...ONE_DEVICE,
              gateway: {
                label,
                token: gateway.tokens.worker,
                url: `ws://127.0.0.1:${String(gateway.port)}`,
              },
            },
            driverScript: { ios: IOS },
          }),
        );
      }
      await waitFor(
        async () => {
          const listed = (await operatorGet(gateway, "/v1/workers")) as {
            workers: { connection: string }[];
          };
          return listed.workers.filter((entry) => entry.connection === "connected").length === 2;
        },
        { label: "both workers connected" },
      );

      await openUsage(page, gateway);

      const rows = region(page, "Per worker").locator("tbody tr");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText(/worker-[ab]/);
      const names = await rows.locator("td:first-child").allTextContents();
      expect(names.map((name) => name.trim()).sort()).toEqual(["worker-a", "worker-b"]);
    } finally {
      for (const worker of workers) await worker.dispose();
      await gateway.dispose();
    }
  });
});
