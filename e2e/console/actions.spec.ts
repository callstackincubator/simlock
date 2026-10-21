import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";

const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function leaseOverSocket(daemon: RunningDaemon, agent: string, model = "iPhone 16") {
  const granted = await daemon.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    model,
    "--os",
    "18.4",
    "--detach",
    "--agent-id",
    agent,
  ]);
  expect(granted.code, granted.stderr).toBe(0);
}

async function heldBy(daemon: RunningDaemon): Promise<readonly string[]> {
  const listed = await daemon.cli(["list", "--leases"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as readonly { requesterId: string }[]).map((lease) => lease.requesterId);
}

async function waitingCount(daemon: RunningDaemon): Promise<number> {
  const response = await fetch(new URL("/v1/lease-requests", daemon.url), {
    headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
  });
  return ((await response.json()) as { requests: unknown[] }).requests.length;
}

async function openPage(page: Page, daemon: RunningDaemon, path: string, title: string) {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

function rowOf(page: Page, name: string): Locator {
  return page.locator("main tbody tr").filter({ hasText: name });
}

test.describe("the console acts", () => {
  test("a lease is released from its row's menu after a dialog, and a toast follows", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "release-agent");
      await openPage(page, daemon, "/leases", "Leases");
      const row = rowOf(page, "release-agent");
      await expect(row).toContainText(/iPhone 16 · \S+/);
      const worker = /iPhone 16 · (\S+)/.exec(await row.innerText())?.[1] ?? "";
      expect(worker).not.toBe("");

      const menuButton = row.getByRole("button", { name: "Actions for release-agent" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Release release-agent's lease?" });
      await expect(dialog).toContainText(
        `iPhone 16 on ${worker} goes back to the pool now, and release-agent's next command on it fails.`,
      );

      await dialog.getByRole("button", { name: "Keep" }).click();
      await expect(dialog).toBeHidden();
      expect(await heldBy(daemon)).toContain("release-agent");
      await expect(row).toBeVisible();

      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      await dialog.getByRole("button", { name: "Release lease" }).click();
      const toast = page.getByText("Released release-agent's lease");
      await expect(toast).toBeVisible();
      await expect(page.getByText(`iPhone 16 on ${worker} goes back to the pool.`)).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(await heldBy(daemon)).not.toContain("release-agent");

      await page.getByRole("button", { name: "View device" }).click();
      await expect(page).toHaveURL(/\/fleet\/[^/]+\/[^/]+$/);
      await expect(page.getByRole("dialog", { name: "iPhone 16" })).toBeVisible();
    } finally {
      await daemon.dispose();
    }
  });

  test("a waiting request is cancelled from the Queue's menu after a dialog, and leaves the list", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "holder");
      daemon.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--agent-id",
        "waiter",
      ]);
      await waitFor(async () => (await waitingCount(daemon)) === 1, {
        label: "the daemon lists the waiting request",
      });
      await openPage(page, daemon, "/queue", "Queue");
      const row = rowOf(page, "waiter");
      const menuButton = row.getByRole("button", { name: "Actions for waiter" });
      await expect(menuButton).toBeVisible();

      await menuButton.click();
      await page.getByRole("menuitem", { name: "Cancel request" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Cancel waiter's request?" });
      await expect(dialog).toContainText(
        "waiter stops waiting for iOS iPhone 16, runtime 18.4 and gets an error.",
      );
      await dialog.getByRole("button", { name: "Keep" }).click();
      await expect(dialog).toBeHidden();
      expect(await waitingCount(daemon)).toBe(1);

      await menuButton.click();
      await page.getByRole("menuitem", { name: "Cancel request" }).click();
      await dialog.getByRole("button", { name: "Cancel request" }).click();
      await expect(page.getByText("Cancelled waiter's request")).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(await waitingCount(daemon)).toBe(0);
    } finally {
      await daemon.dispose();
    }
  });
});
