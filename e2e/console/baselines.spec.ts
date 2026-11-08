import type { Locator, Page } from "@playwright/test";

import { answer } from "./stub-answers.js";
import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

async function leaseId(daemon: RunningDaemon, agent: string, extra: readonly string[] = []) {
  const granted = await daemon.cli([...LEASE, "--agent-id", agent, "--detach", ...extra]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

async function save(daemon: RunningDaemon, name: string, lease: string, note?: string) {
  const args = ["baseline", "save", name, "--lease", lease];
  const saved = await daemon.cli(note === undefined ? args : [...args, "--note", note]);
  expect(saved.code, saved.stderr).toBe(0);
}

async function openBaselines(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(new URL("/baselines", daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Baselines" })).toBeVisible();
}

function row(page: Page, name: string): Locator {
  return page.locator("main tbody tr").filter({ hasText: name });
}

test.describe("the Baselines page", () => {
  test("lists each baseline the worker holds in a platform group, a save shows its row with no reload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const lease = await leaseId(host, "saver");
      await openBaselines(page, host);
      await expect(page.getByText("No baselines.")).toBeVisible();

      await save(host, "checkout", lease, "app 4.2");

      const checkout = row(page, "checkout");
      await expect(checkout).toBeVisible();
      await expect(checkout).toContainText("iPhone 16 · iOS 18.4");
      await expect(checkout).toContainText("1 MiB");
      await expect(checkout).toContainText("ago");
      await expect(checkout).toContainText("ready");
      await expect(page.getByRole("cell", { name: /^iOS · 1 baseline$/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Disk used by baselines" })).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("a second save keeps one row, a lease naming the baseline shows it in the device's drawer, and a removal takes the row away with no reload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await save(host, "checkout", await leaseId(host, "first"), "app 4.2");
      await openBaselines(page, host);
      await expect(row(page, "checkout")).toBeVisible();

      await save(host, "checkout", await leaseId(host, "second"));
      await expect(page.locator("main tbody tr")).toHaveCount(2);

      const copy = await leaseId(host, "copier", ["--baseline", "checkout"]);
      const plain = await leaseId(host, "plain");
      const view = await workers(host);
      const onCopy = view.leases.find((held) => held.id === copy);
      const onPlain = view.leases.find((held) => held.id === plain);
      await openDrawer(page, host, view.id, onCopy?.deviceId ?? "");
      await expect(fact(page, "Baseline")).toHaveText("checkout v2");
      await openDrawer(page, host, view.id, onPlain?.deviceId ?? "");
      await expect(page.getByRole("dialog").locator("dt", { hasText: "Runtime" })).toBeVisible();
      await expect(page.getByRole("dialog").locator("dt", { hasText: "Baseline" })).toHaveCount(0);

      await page.goto(new URL("/baselines", host.url).toString());
      for (const id of [copy, plain]) {
        const released = await host.cli(["release", id]);
        expect(released.code, released.stderr).toBe(0);
      }
      const removed = await host.cli(["baseline", "remove", "checkout", "--yes"]);
      expect(removed.code, removed.stderr).toBe(0);
      await expect(page.getByText("No baselines.")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, the Worker column names each worker's baseline, a relayed save shows its row and each worker has its own disk line", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const [first, second] = fleet.workers as [RunningDaemon, RunningDaemon];
      await openBaselines(page, fleet.gateway);

      await save(first, "alpha", await leaseId(first, "a"));
      await expect(page.getByRole("columnheader", { name: "Worker" })).toBeVisible();
      await expect(row(page, "alpha")).toContainText("worker-a");
      await save(second, "beta", await leaseId(second, "b"));
      await expect(row(page, "beta")).toContainText("worker-b");
      await expect(page.locator("main tbody tr")).toHaveCount(3);
      await expect(page.locator(".baseline-disk li")).toHaveCount(2);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a stale baseline shows its reason word for word, an entry with no size shows a dash, filters and search narrow the groups, and 26 entries page at 25", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed";
      const entries = Array.from({ length: 26 }, (_, index) => ({
        mode: "full",
        model: "iPhone 16",
        name: `base-${String(index).padStart(2, "0")}`,
        osVersion: "18.4",
        platform: "ios",
        savedAt: new Date(Date.now() - 3_600_000).toISOString(),
        version: 1,
        ...(index === 0 ? { staleReason: reason } : { sizeBytes: 2 ** 20 }),
      }));
      const requests: string[] = [];
      page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
      await answer(page, "/v1/baselines", () => ({ baselines: entries }));
      await openBaselines(page, host);

      await expect(page.locator("main tbody tr")).toHaveCount(26);
      await expect(row(page, "base-25")).toHaveCount(0);
      const stale = row(page, "base-00");
      await expect(stale.locator(".pill")).toHaveText("stale");
      await expect(stale).toContainText(reason);
      await expect(stale).toContainText("—");
      await expect(page.getByRole("cell", { name: /^iOS · 26 baselines$/ })).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();
      await expect(row(page, "base-25")).toBeVisible();

      await page.getByLabel("Stale", { exact: true }).check();
      await expect(page.locator("main tbody tr")).toHaveCount(2);
      await expect(page.getByRole("cell", { name: /^iOS · 1 baseline$/ })).toBeVisible();
      await page.getByLabel("Ready", { exact: true }).check();
      await page.getByRole("searchbox", { name: "Search baselines" }).fill("base-07");
      await expect(page.locator("main tbody tr")).toHaveCount(2);
      await expect(row(page, "base-07")).toBeVisible();
      await page.getByRole("searchbox", { name: "Search baselines" }).fill("zzz");
      await expect(page.getByText("No baselines match this filter or search.")).toBeVisible();
      expect(requests.filter((request) => request.includes("baseline.save"))).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("Prepare baseline is a link to the documentation, and no Building filter or row menu is shown", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET") writes.push(request.url());
      });
      await openBaselines(page, host);
      const link = page.getByRole("link", { name: "Prepare baseline" });
      await expect(link).toHaveAttribute(
        "href",
        "https://callstackincubator.github.io/simlock/docs/worker/baselines",
      );
      await expect(page.getByRole("radio")).toHaveCount(3);
      await expect(page.getByLabel("Building")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Actions for/ })).toHaveCount(0);
      expect(writes).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});

interface WorkerFacts {
  readonly id: string;
  readonly leases: readonly { readonly id: string; readonly deviceId: string }[];
}

async function workers(daemon: RunningDaemon): Promise<WorkerFacts> {
  const listed = await daemon.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  const [view] = (listed.json as { workers: WorkerFacts[] }).workers;
  if (view === undefined) throw new Error("no worker");
  return view;
}

async function openDrawer(
  page: Page,
  daemon: RunningDaemon,
  workerId: string,
  deviceId: string,
): Promise<void> {
  const path = `/fleet/${encodeURIComponent(workerId)}/${encodeURIComponent(deviceId)}?tab=devices`;
  await page.goto(new URL(path, daemon.url).toString());
  await expect(page.getByRole("dialog")).toBeVisible();
}

function fact(scope: Page, label: string): Locator {
  return scope
    .getByRole("dialog")
    .locator("dt", { hasText: label })
    .locator("xpath=following-sibling::dd[1]");
}
