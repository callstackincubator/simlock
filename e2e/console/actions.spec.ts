import type { Locator, Page } from "@playwright/test";

import { expect, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";

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
      await expect(page.getByRole("dialog")).toBeVisible();
    } finally {
      await daemon.dispose();
    }
  });
});
