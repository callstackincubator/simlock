import type { Locator, Page } from "@playwright/test";

import { expect, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";

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
});
