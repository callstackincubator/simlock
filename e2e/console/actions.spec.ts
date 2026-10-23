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

async function waitForDisconnected(gateway: RunningDaemon): Promise<void> {
  await waitFor(
    async () => {
      const listed = await gateway.cli(["worker", "list", "--json"]);
      return (listed.json as { workers: { connection: string }[] }).workers.some(
        (view) => view.connection === "disconnected",
      );
    },
    { label: "the gateway sees the stopped worker disconnected" },
  );
}

async function startWithStoppedWorker(label: string) {
  const fleet = await startFleet([{ driverScript: { ios: IOS }, label }]);
  const [stopped] = fleet.workers as [RunningDaemon];
  await stopped.stop();
  await waitForDisconnected(fleet.gateway);
  return fleet;
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
      await expect(row).toContainText("drained", { timeout: 10_000 });

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
      await waitForDisconnected(fleet.gateway);
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
      await dialog.getByRole("textbox").fill("gone-a ");
      await expect(remove).toBeDisabled();
      await dialog.getByRole("textbox").fill("Gone-A");
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

  test("a write that gets no answer shows The daemon did not answer. and the operator stays signed in", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "silent-agent");
      await openPage(page, daemon, "/leases", "Leases");
      await page.route("**/v1/leases/*", (route) =>
        route.request().method() === "DELETE" ? route.abort() : route.continue(),
      );
      const row = rowOf(page, "silent-agent");
      const menuButton = row.getByRole("button", { name: "Actions for silent-agent" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      await page
        .getByRole("alertdialog", { name: "Release silent-agent's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();

      const toasts = page.getByRole("region", { name: "Notifications" });
      await expect(toasts.getByText("Couldn't release silent-agent's lease")).toBeVisible();
      await expect(toasts.getByText("The daemon did not answer.", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
      await expect(row).toBeVisible();
    } finally {
      await daemon.dispose();
    }
  });

  test("a write the daemon answers with 401 shows no error toast and signs the operator out", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "expired-agent");
      await openPage(page, daemon, "/leases", "Leases");
      await page.route("**/v1/leases/*", (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({
              json: { error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" } },
              status: 401,
            })
          : route.continue(),
      );
      const row = rowOf(page, "expired-agent");
      const menuButton = row.getByRole("button", { name: "Actions for expired-agent" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      await page
        .getByRole("alertdialog", { name: "Release expired-agent's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();

      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.getByText("Couldn't release expired-agent's lease")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally {
      await daemon.dispose();
    }
  });

  test("while a release is in flight its button reads Releasing… and is disabled, and a second click sends no second DELETE", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "slow-agent");
      await openPage(page, daemon, "/leases", "Leases");
      const deletes: string[] = [];
      let answer: (() => Promise<void>) | undefined;
      await page.route("**/v1/leases/*", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        deletes.push(route.request().url());
        answer = () => route.continue();
        return undefined;
      });
      const row = rowOf(page, "slow-agent");
      const menuButton = row.getByRole("button", { name: "Actions for slow-agent" });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Release slow-agent's lease?" });
      await dialog.getByRole("button", { name: "Release lease" }).click();

      const busy = dialog.getByRole("button", { name: "Releasing…" });
      await expect(busy).toBeDisabled();
      await busy.click({ force: true });
      await expect.poll(() => deletes.length).toBe(1);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();

      await answer?.();
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Released slow-agent's lease")).toBeVisible();
      expect(deletes).toHaveLength(1);
    } finally {
      await daemon.dispose();
    }
  });

  test("the row menu shows the dangerous items last, after a separator, in the error colour", async ({
    page,
  }) => {
    const fleet = await startWithStoppedWorker("menu-a");
    try {
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      await rowOf(page, "menu-a").getByRole("button", { name: "Actions for menu-a" }).click();

      const items = page.getByRole("menuitem");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toHaveText("Drain");
      await expect(items.nth(1)).toHaveText("Remove worker");
      await expect(page.getByRole("separator")).toHaveCount(1);
      const order = await page
        .getByRole("menu")
        .evaluate((menu) =>
          [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((node) =>
            node.getAttribute("role"),
          ),
        );
      expect(order).toEqual(["menuitem", "separator", "menuitem"]);
      const colours = await items.evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      );
      const error = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--status-error)";
        document.body.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      });
      expect(colours[1]).toBe(error);
      expect(colours[0]).not.toBe(error);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("release from a lease drawer's ⋯ works as from the row, and a worker drawer's button is its first safe action", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "bar-a" }]);
    try {
      await leaseOverSocket(fleet.gateway, "drawer-agent");
      await openPage(page, fleet.gateway, "/leases", "Leases");
      await rowOf(page, "drawer-agent").getByRole("link").first().click();
      const drawer = page.getByRole("dialog", { name: "drawer-agent" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Release lease" })).toHaveCount(0);
      await drawer.getByRole("button", { name: "Actions for drawer-agent" }).click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      await page
        .getByRole("alertdialog", { name: "Release drawer-agent's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();
      await expect(page.getByText("Released drawer-agent's lease")).toBeVisible();
      expect(await heldBy(fleet.gateway)).not.toContain("drawer-agent");

      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await page.goto(new URL(`/fleet/${id}`, fleet.gateway.url).toString());
      await expect(page.getByRole("heading", { level: 1, name: "bar-a" })).toBeVisible();
      await page.getByRole("button", { name: "Drain", exact: true }).click();
      await expect(page.getByText("bar-a drained", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Actions for bar-a" }).click();
      await expect(page.getByRole("menuitem", { name: "Undrain" })).toBeVisible();
      await page.keyboard.press("Escape");

      const [stopped] = fleet.workers as [RunningDaemon];
      await stopped.stop();
      await waitForDisconnected(fleet.gateway);
      await page.getByRole("button", { name: "Actions for bar-a" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Undrain", "Remove worker"]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove worker" })).toHaveCount(0);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a right-click on a row opens the same menu as its ⋯, Escape closes it, and the keyboard moves through it", async ({
    page,
  }) => {
    const fleet = await startWithStoppedWorker("ctx-a");
    try {
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      const row = rowOf(page, "ctx-a");
      await row.getByRole("button", { name: "Actions for ctx-a" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      const viaButton = await page.getByRole("menuitem").allInnerTexts();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      await row.click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByRole("menu")).toBeFocused();
      await expect(page.getByRole("menuitem")).toHaveText(viaButton);
      expect(viaButton).toEqual(["Drain", "Remove worker"]);

      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Drain", exact: true })).toHaveAttribute(
        "data-highlighted",
        "",
      );
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Remove worker" })).toHaveAttribute(
        "data-highlighted",
        "",
      );
      await page.keyboard.press("ArrowUp");
      await expect(page.getByRole("menuitem", { name: "Drain", exact: true })).toHaveAttribute(
        "data-highlighted",
        "",
      );

      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page).toHaveURL(/\/fleet$/);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a success toast leaves after 6 s and stays while hovered, an error toast stays until closed, and at most three show while a fourth hides the oldest until one closes", async ({
    page,
  }) => {
    const names = ["toast-a", "toast-b", "toast-c", "toast-d"];
    const fleet = await startFleet(names.map((label) => ({ driverScript: { ios: IOS }, label })));
    try {
      await page.clock.install();
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      // why: with time frozen, only the fast-forwards below age a toast, however slow the machine.
      await page.clock.pauseAt(new Date(Date.now() + 1_000));
      const toasts = page.getByRole("region", { name: "Notifications" });
      const toastOf = (text: string) => toasts.locator(".toast").filter({ hasText: text });
      const act = async (worker: string, item: string) => {
        // why: the toasts stack over the table's last column, so the keyboard opens the menu.
        await rowOf(page, worker)
          .getByRole("button", { name: `Actions for ${worker}` })
          .press("Enter");
        await page
          .getByRole("menu", { name: `Actions for ${worker}` })
          .getByRole("menuitem", { name: item, exact: true })
          .click();
        // why: a pointer left on the clicked item can sit where the toast appears, and a hovered
        // toast never times out.
        await page.mouse.move(0, 0);
      };

      await page.route("**/v1/workers/*/drain", (route) => route.abort());
      await act("toast-b", "Drain");
      const refused = toastOf("Couldn't drain toast-b");
      await expect(refused).toBeVisible();
      await page.clock.runFor(500);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.clock.fastForward(30_000);
      await page.clock.runFor(500);
      await expect(refused).toBeVisible();
      await expect(
        refused.getByRole("button", { name: "Close", includeHidden: true }),
      ).toBeVisible();
      await refused.getByRole("button", { name: "Close", includeHidden: true }).click();
      await page.clock.runFor(500);
      await expect(refused).toBeHidden();
      await page.unroute("**/v1/workers/*/drain");

      await act("toast-a", "Drain");
      const drained = toastOf("toast-a drained");
      await expect(drained).toBeVisible();
      await page.clock.fastForward(5_500);
      await expect(drained).toBeVisible();
      await page.clock.fastForward(1_000);
      await page.clock.runFor(500);
      await expect(drained).toBeHidden();

      await act("toast-a", "Undrain");
      const undrained = toastOf("toast-a takes leases again");
      await expect(undrained).toBeVisible();
      await undrained.hover();
      await page.clock.fastForward(10_000);
      await expect(undrained).toBeVisible();
      await page.mouse.move(0, 0);
      await page.clock.fastForward(6_500);
      await page.clock.runFor(500);
      await expect(undrained).toBeHidden();

      await act("toast-a", "Drain");
      await act("toast-b", "Drain");
      await act("toast-c", "Drain");
      await act("toast-d", "Drain");
      await expect(toastOf("toast-d drained")).toBeVisible();
      await expect(toasts.locator(".toast:visible")).toHaveCount(3);
      await expect(toastOf("toast-a drained")).toBeHidden();

      await expect(
        toastOf("toast-d drained").getByRole("button", { name: "Close", includeHidden: true }),
      ).toBeVisible();
      await toastOf("toast-d drained")
        .getByRole("button", { name: "Close", includeHidden: true })
        .click();
      await page.clock.runFor(500);
      await expect(toastOf("toast-a drained")).toBeVisible();
      await expect(toasts.locator(".toast:visible")).toHaveCount(3);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("an error toast's text is in the role=alert element and a success toast's in the aria-live=polite region", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "say-a" }]);
    try {
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      const openMenu = async (item: string) => {
        await rowOf(page, "say-a").getByRole("button", { name: "Actions for say-a" }).click();
        await page.getByRole("menuitem", { name: item, exact: true }).click();
      };
      await page.route("**/v1/workers/*/drain", (route) => route.abort());
      await openMenu("Drain");
      await expect(page.getByRole("alert")).toContainText("Couldn't drain say-a");
      await expect(page.getByRole("alert")).toContainText("The daemon did not answer.");

      await page.unroute("**/v1/workers/*/drain");
      await openMenu("Drain");
      await expect(page.locator('[aria-live="polite"]')).toContainText("say-a drained");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("on a single host no menu, drawer or Inbox row offers Drain, Undrain or Remove", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(daemon, "solo-agent");
      const workerAction = /^(Drain|Undrain|Remove)/;

      await openPage(page, daemon, "/fleet", "Fleet");
      const row = page.locator("main tbody tr");
      await expect(row).toHaveCount(1);
      await row.click({ button: "right" });
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(row.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
      await row.getByRole("link").first().click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: workerAction })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);

      await page.goto(new URL("/leases", daemon.url).toString());
      await rowOf(page, "solo-agent").getByRole("link").first().click();
      const drawer = page.getByRole("dialog", { name: "solo-agent" });
      await drawer.getByRole("button", { name: "Actions for solo-agent" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Release lease"]);
      await page.keyboard.press("Escape");

      // why: a single host has no drained worker, so the list says one is, to give the Inbox a row
      // that offers Undrain on a gateway.
      await page.route(
        (url) => url.pathname === "/v1/workers",
        async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as { workers: Record<string, unknown>[] };
          await route.fulfill({
            json: { ...body, workers: body.workers.map((view) => ({ ...view, drained: true })) },
            response,
          });
        },
      );
      await page.goto(new URL("/inbox", daemon.url).toString());
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      await expect(page.locator("main .inbox-list li")).toHaveCount(1);
      await expect(page.getByRole("button", { name: workerAction })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    } finally {
      await daemon.dispose();
    }
  });

  test("an item's menu entries are disabled while its action is in flight, and a click on one sends nothing", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "busy-a" }]);
    try {
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      const posts: string[] = [];
      let answer: (() => Promise<void>) | undefined;
      await page.route("**/v1/workers/*/drain", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts.push(route.request().url());
        answer = () => route.continue();
        return undefined;
      });
      const menuButton = rowOf(page, "busy-a").getByRole("button", { name: "Actions for busy-a" });
      await menuButton.click();
      await page.getByRole("menuitem", { name: "Drain", exact: true }).click();
      await expect.poll(() => posts.length).toBe(1);

      await menuButton.click();
      const entry = page.getByRole("menuitem", { name: "Drain", exact: true });
      await expect(entry).toHaveAttribute("aria-disabled", "true");
      await entry.click({ force: true });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(posts).toHaveLength(1);

      await answer?.();
      await expect(page.getByText("busy-a drained", { exact: true })).toBeVisible();
      await menuButton.click();
      await expect(page.getByRole("menuitem", { name: "Undrain", exact: true })).toBeEnabled();
      expect(posts).toHaveLength(1);
      await page.keyboard.press("Escape");

      const undrains: string[] = [];
      let answerUndrain: (() => Promise<void>) | undefined;
      await page.route("**/v1/workers/*/drain", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        undrains.push(route.request().url());
        answerUndrain = () => route.continue();
        return undefined;
      });
      await rowOf(page, "busy-a").getByRole("link").first().click();
      const pageButton = page.getByRole("button", { name: "Undrain", exact: true });
      await pageButton.click();
      await expect.poll(() => undrains.length).toBe(1);
      await expect(pageButton).toBeDisabled();
      await page.getByRole("navigation").getByRole("link", { name: /Inbox/ }).click();
      const fix = page
        .locator("main .inbox-list li")
        .filter({ hasText: "busy-a" })
        .getByRole("button", { name: "Undrain", exact: true });
      await expect(fix).toBeDisabled();
      await fix.click({ force: true });
      expect(undrains).toHaveLength(1);

      await answerUndrain?.();
      await expect(page.getByText("busy-a takes leases again")).toBeVisible();
      expect(undrains).toHaveLength(1);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
