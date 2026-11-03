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
  test("lists each baseline the worker holds, a save shows its row with no reload", async ({
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
      await expect(checkout).toContainText("iOS");
      await expect(checkout).toContainText("iPhone 16");
      await expect(checkout).toContainText("18.4");
      await expect(checkout).toContainText("app 4.2");
      await expect(checkout).toContainText("1 MiB");
      await expect(checkout).toContainText("ago");
    } finally {
      await host.dispose();
    }
  });

  test("a second save shows version 2 in place, a lease naming the baseline shows it in the device's drawer, and a removal takes the row away with no reload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await save(host, "checkout", await leaseId(host, "first"), "app 4.2");
      await openBaselines(page, host);
      await expect(row(page, "checkout").getByRole("cell").nth(1)).toHaveText("1");

      await save(host, "checkout", await leaseId(host, "second"));
      await expect(row(page, "checkout").getByRole("cell").nth(1)).toHaveText("2");
      await expect(page.locator("main tbody tr")).toHaveCount(1);

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

  test("on a gateway, the Worker column names each worker's baseline and a relayed save shows its row", async ({
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
      await expect(page.locator("main tbody tr")).toHaveCount(2);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a stale baseline shows the square, stale and its reason word for word, an entry with no size shows a dash, and 26 entries page at 25", async ({
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
      await answer(page, "/v1/baselines", () => ({ baselines: entries }));
      await openBaselines(page, host);

      await expect(page.locator("main tbody tr")).toHaveCount(25);
      await expect(row(page, "base-25")).toHaveCount(0);
      const stale = row(page, "base-00");
      await expect(stale).toContainText(`stale · ${reason}`);
      await expect(stale).toContainText("—");
      await page.getByRole("button", { name: "Next" }).click();
      await expect(row(page, "base-25")).toBeVisible();
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
