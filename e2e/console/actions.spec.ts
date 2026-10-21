import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

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

  test("a worker is drained from Fleet with no dialog, and Undo undrains it", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "drain-a" }]);
    try {
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      const row = rowOf(page, "drain-a");
      await expect(row).toBeVisible();
      await expect(row).not.toContainText("drained");

      const menuButton = row.getByRole("button", { name: "Actions for drain-a" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Drain", exact: true }).click();
      await expect(page.getByText("drain-a drained", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Its leases keep running. New leases go to other workers."),
      ).toBeVisible();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(row).toContainText("drained");

      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("drain-a takes leases again")).toBeVisible();
      await expect(row).not.toContainText("drained");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the Inbox's fix button undrains a drained worker, and the item leaves the Inbox", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "inbox-a" }]);
    try {
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      expect((await fleet.gateway.cli(["worker", "drain", id])).code).toBe(0);
      await openPage(page, fleet.gateway, "/inbox", "Inbox");
      const item = page.locator("main .inbox-list li").filter({ hasText: "inbox-a" });
      const fix = item.getByRole("button", { name: "Undrain" });
      await expect(fix).toBeVisible();

      await fix.click();
      await expect(page.getByText("inbox-a takes leases again")).toBeVisible();
      await expect(item).toHaveCount(0);
      const after = await fleet.gateway.cli(["worker", "list", "--json"]);
      expect((after.json as { workers: { drained: boolean }[] }).workers[0]?.drained).toBe(false);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a stopped worker is removed once its name is typed exactly, and a connected worker offers no Remove", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "gone-a" },
      { driverScript: { ios: IOS }, label: "live-b" },
    ]);
    try {
      const [stopped] = fleet.workers as [RunningDaemon];
      await stopped.stop();
      await waitFor(
        async () => {
          const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
          return (listed.json as { workers: { connection: string }[] }).workers.some(
            (view) => view.connection === "disconnected",
          );
        },
        { label: "the gateway sees the stopped worker disconnected" },
      );
      await openPage(page, fleet.gateway, "/fleet", "Fleet");

      const live = rowOf(page, "live-b");
      await live.getByRole("button", { name: "Actions for live-b" }).click();
      await expect(page.getByRole("menuitem", { name: "Drain", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Remove worker" })).toHaveCount(0);
      await page.keyboard.press("Escape");

      const row = rowOf(page, "gone-a");
      await row.getByRole("button", { name: "Actions for gone-a" }).click();
      await page.getByRole("menuitem", { name: "Remove worker" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Remove gone-a?" });
      await expect(dialog).toContainText(
        "It leaves the fleet and its devices are forgotten. It can join again with a worker token. Type gone-a to confirm.",
      );
      const remove = dialog.getByRole("button", { name: "Remove worker" });
      await expect(remove).toBeDisabled();
      await dialog.getByRole("textbox").fill("gone-");
      await expect(remove).toBeDisabled();
      await dialog.getByRole("textbox").fill("gone-a");
      await expect(remove).toBeEnabled();

      await remove.click();
      await expect(page.getByText("gone-a removed")).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(live).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a refused action shows an error toast with the daemon's message and Retry, which sends again, while the dialog stays open as the row leaves", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "refused-agent");
      const listed = await daemon.cli(["list", "--leases"]);
      const leaseId = (listed.json as { id: string }[])[0]?.id ?? "";
      const deletes: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "DELETE") deletes.push(new URL(request.url()).pathname);
      });
      await openPage(page, daemon, "/leases", "Leases");
      const row = rowOf(page, "refused-agent");
      const menuButton = row.getByRole("button", { name: "Actions for refused-agent" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Release refused-agent's lease?" });
      await expect(dialog).toBeVisible();

      expect((await daemon.cli(["release", leaseId])).code).toBe(0);
      await expect(row).toHaveCount(0);
      await expect(dialog).toBeVisible();
      const refusal = await fetch(new URL(`/v1/leases/${leaseId}`, daemon.url), {
        headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
        method: "DELETE",
      });
      expect(refusal.status).toBe(404);
      const message = ((await refusal.json()) as { error: { message: string } }).error.message;

      await dialog.getByRole("button", { name: "Release lease" }).click();
      await expect(dialog).toBeHidden();
      const toasts = page.getByRole("region", { name: "Notifications" });
      await expect(toasts.getByText("Couldn't release refused-agent's lease")).toBeVisible();
      await expect(toasts.getByText(message, { exact: true })).toBeVisible();
      expect(deletes).toEqual([`/v1/leases/${leaseId}`]);

      await toasts.getByText("Retry", { exact: true }).click();
      await expect.poll(() => deletes.length).toBe(2);
      await expect(toasts.getByText("Couldn't release refused-agent's lease")).toBeVisible();
    } finally {
      await daemon.dispose();
    }
  });
});
