import type { Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

async function operatorGet(host: RunningDaemon, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, host.url), {
    headers: { Authorization: `Bearer ${host.tokens.operator}` },
  });
  expect(response.status, path).toBe(200);
  return response.json();
}

async function waitingCount(host: RunningDaemon): Promise<number> {
  const { requests } = (await operatorGet(host, "/v1/lease-requests")) as { requests: unknown[] };
  return requests.length;
}

// why: holds a lease while a request waits, then releases it so stats has a real nonzero wait.
async function scriptedRun(host: RunningDaemon): Promise<void> {
  const held = await host.cli([...LEASE, "--agent-id", "holder", "--detach"]);
  expect(held.code, held.stderr).toBe(0);
  host.cliBackground([...LEASE, "--agent-id", "waiter"]);
  await waitFor(async () => (await waitingCount(host)) === 1, { label: "a request waiting" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const released = await host.cli(["release", (held.json as { lease: { id: string } }).lease.id]);
  expect(released.code, released.stderr).toBe(0);
  await waitFor(async () => (await waitingCount(host)) === 0, { label: "the request granted" });
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

// why: the Wait p95 tile is drawn at once, with a dash until the stats answer; the chart tables are not.
async function figuresShown(page: Page): Promise<void> {
  await expect(page.locator("#main table.chart-data")).toHaveCount(2);
}

async function tablesOf(page: Page): Promise<readonly (readonly string[])[]> {
  const tables = page.locator("#main table.chart-data");
  const count = await tables.count();
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      tables.nth(index).locator("tbody td.num").allTextContents(),
    ),
  );
}

test.describe("the Overview's figures", () => {
  test("a daemon stop and start, with the events behind the figures pruned, shows the same Wait p95 and chart rows", async ({
    page,
  }) => {
    const host = await startDaemon("worker", {
      config: { ...ONE_DEVICE, eventLog: { retention: 5_000 } },
      driverScript: { ios: IOS },
    });
    try {
      await scriptedRun(host);
      await host.prepareHistoricalUsage();
      await openOverview(page, host, "/?range=24h");
      await figuresShown(page);
      const before = {
        rows: (await tablesOf(page)).map((rows) => rows.filter((row) => row !== "—")),
        wait: await tileText(page, "Wait p95"),
      };

      expect(before.rows).toHaveLength(2);
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
      await expect.poll(() => tileText(page, "Wait p95")).toBe(before.wait);
      const after = (await tablesOf(page)).map((rows) => rows.filter((row) => row !== "—"));
      expect(after.map((rows, index) => rows.slice(-(before.rows[index]?.length ?? 0)))).toEqual(
        before.rows,
      );
    } finally {
      await host.dispose();
    }
  });
});

test.describe("the range chips", () => {
  test("sit in the page header on Overview and in the toolbar on Usage", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      for (const [path, area] of [
        ["/", "#main .page-head .page-actions"],
        ["/usage", "#main .toolbar .toolbar-start"],
      ] as const) {
        await page.goto(new URL(path, host.url).toString());
        if (path === "/") await signIn(page, host.tokens.operator);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const chips = page.locator(area).getByRole("group", { name: "Range" });
        await expect(chips, path).toBeVisible();
        await expect(chips.getByRole("radio")).toHaveCount(4);
      }
    } finally {
      await host.dispose();
    }
  });
});
