import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  joinOldWorker,
  NAV_LABELS,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

/** What `GET /v1/workers` says, as far as these tests read. */
interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly drained: boolean;
  readonly capacity?: { readonly ramBudget?: { readonly overLimit: boolean } };
  readonly devices: readonly { readonly id: string; readonly state: string; stalled?: boolean }[];
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

/** The fake driver's script once its reclaim fails, so a released device is quarantined. */
const FAILING_RECLAIM = {
  ios: { ...IOS, failures: { reclaim: { message: "erase failed", type: "generic" as const } } },
};

/**
 * A worker whose stall threshold is one second: a device left `provisioning` with nothing
 * working on it is stalled a second after it entered that state.
 */
const STALLING = {
  config: { stalledTransition: { minimumThresholdMs: 1_000, thresholdMultiplier: 1 } },
  driverScript: { ios: IOS },
} as const;

async function workers(daemon: RunningDaemon): Promise<readonly WorkerView[]> {
  const response = await fetch(new URL("/v1/workers", daemon.url), {
    headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
  });
  return ((await response.json()) as { workers: WorkerView[] }).workers;
}

/**
 * Waits, asking every 20 ms, until the daemon's own `GET /v1/workers` says what `predicate`
 * looks for. The console's second starts there: it cannot show a fact before its daemon has it.
 */
async function untilTheDaemonSays(
  daemon: RunningDaemon,
  predicate: (views: readonly WorkerView[]) => boolean,
  timeout = 30_000,
): Promise<void> {
  await waitFor(async () => predicate(await workers(daemon)), {
    interval: 20,
    label: "the daemon's own worker views",
    timeout,
  });
}

async function lease(daemon: RunningDaemon, agent: string): Promise<{ id: string }> {
  const granted = await daemon.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--detach",
    "--agent-id",
    agent,
  ]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease;
}

/** Leases a device, then releases it with a driver whose reclaim fails: it is quarantined. */
async function quarantineOne(daemon: RunningDaemon): Promise<void> {
  const held = await lease(daemon, "console-e2e-quarantine");
  await daemon.writeDriverScript(FAILING_RECLAIM);
  const released = await daemon.cli(["release", held.id]);
  expect(released.code, released.stderr).toBe(0);
  await untilTheDaemonSays(daemon, (views) =>
    views.some((view) => view.devices.some((device) => device.state === "quarantined")),
  );
}

/**
 * Leaves a device `provisioning` with nothing working on it, as a daemon that stops mid-boot
 * does: a lease starts a boot the driver takes two minutes over, and the daemon stops while
 * it runs. While the boot runs it is a live operation, never a stall; once the daemon is back
 * nothing drives it any more. `beforeStart` runs while the daemon is down.
 */
async function strandProvisioning(
  daemon: RunningDaemon,
  beforeStart: () => Promise<void> = async () => {},
): Promise<void> {
  await daemon.writeDriverScript({
    ios: { ...FAILING_RECLAIM.ios, latencyMs: { makeReady: 120_000 } },
  });
  daemon.cliBackground([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--detach",
    "--agent-id",
    "console-e2e-stranded",
  ]);
  await untilTheDaemonSays(daemon, (views) =>
    views.some((view) => view.devices.some((device) => device.state === "provisioning")),
  );
  await daemon.stop();
  await beforeStart();
  await daemon.start();
}

async function openAttention(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  await page.getByRole("link", { name: "Attention" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Attention" })).toBeVisible();
}

/** The item for `condition` about the worker or device named `subject`. */
function item(page: Page, condition: string, subject: string): Locator {
  return page
    .locator(".attention-list li")
    .filter({ has: page.locator(".status", { hasText: new RegExp(`^${condition}$`) }) })
    .filter({ hasText: subject });
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the attention view", () => {
  test("draining a worker adds it to the attention view within a second", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openAttention(page, fleet.gateway);
      await expect(page.getByText("Nothing needs attention.")).toBeVisible();
      const b = (await workers(fleet.gateway)).find((view) => view.label === "worker-b");

      expect((await fleet.gateway.cli(["worker", "drain", b?.id ?? ""])).code).toBe(0);
      await untilTheDaemonSays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.drained === true,
      );

      const drained = item(page, "drained", "worker-b");
      await expect(drained).toBeVisible({ timeout: 1_000 });
      await expect(drained.getByRole("link", { name: "worker-b" })).toHaveAttribute(
        "href",
        `/workers/${encodeURIComponent(b?.id ?? "")}`,
      );
      await expect(page.locator(".attention-list li")).toHaveCount(1);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("undraining it removes it within a second", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const [a] = await workers(fleet.gateway);
      expect((await fleet.gateway.cli(["worker", "drain", a?.id ?? ""])).code).toBe(0);
      await openAttention(page, fleet.gateway);
      const drained = item(page, "drained", "worker-a");
      await expect(drained).toBeVisible();

      expect((await fleet.gateway.cli(["worker", "undrain", a?.id ?? ""])).code).toBe(0);
      await untilTheDaemonSays(fleet.gateway, (views) => views[0]?.drained === false);

      await expect(drained).toHaveCount(0, { timeout: 1_000 });
      await expect(page.getByText("Nothing needs attention.")).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("stopping a worker adds it as disconnected within a second", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openAttention(page, fleet.gateway);
      await expect(page.getByText("Nothing needs attention.")).toBeVisible();

      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheDaemonSays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );

      await expect(item(page, "disconnected", "worker-b")).toBeVisible({ timeout: 1_000 });
      await expect(item(page, "disconnected", "worker-a")).toHaveCount(0);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("an incompatible worker, and a worker's quarantined and stalled devices, appear on a gateway", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const gateway = await startDaemon("gateway");
    const fleet = { gateway, workers: [] as RunningDaemon[] };
    let hangUp = () => {};
    try {
      // Joined by hand rather than with `startFleet`, which has no way to pass the worker the
      // stall threshold.
      const worker = await startDaemon("worker", {
        ...STALLING,
        config: {
          ...STALLING.config,
          gateway: {
            label: "worker-a",
            token: gateway.tokens.worker,
            url: `ws://127.0.0.1:${gateway.port}`,
          },
        },
      });
      fleet.workers.push(worker);
      hangUp = await joinOldWorker(fleet.gateway, { id: "wrk_old", label: "old-worker" });
      await quarantineOne(worker);
      await strandProvisioning(worker);
      let devices: WorkerView["devices"] = [];
      // A stall starts with no event, so the gateway learns of it on its next periodic read of
      // the worker, every 30 seconds.
      await untilTheDaemonSays(
        fleet.gateway,
        (views) => {
          devices = views.find((view) => view.label === "worker-a")?.devices ?? [];
          return (
            views.some((view) => view.connection === "incompatible") &&
            devices.some((device) => device.state === "quarantined") &&
            devices.some((device) => device.stalled === true)
          );
        },
        45_000,
      );
      const quarantined = devices.find((device) => device.state === "quarantined");
      const stalled = devices.find((device) => device.stalled === true);

      await openAttention(page, fleet.gateway);

      await expect(item(page, "incompatible", "old-worker")).toBeVisible();
      await expect(
        item(page, "quarantined", `Device ${quarantined?.id} on worker-a`),
      ).toBeVisible();
      await expect(item(page, "stalled", `Device ${stalled?.id} on worker-a`)).toContainText(
        /stuck provisioning for \d+ (s|min)/,
      );
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("a quarantined device, a stalled device and a host over its RAM budget appear on a single host", async ({
    page,
  }) => {
    const host = await startDaemon("worker", STALLING);
    try {
      const status = await host.cli(["status", "--json"]);
      const { limitBytes } = (status.json as { capacity: { ramBudget: { limitBytes: number } } })
        .capacity.ramBudget;
      await quarantineOne(host);
      // Back with each iOS device costing more than the whole budget: the devices it already
      // has put it over.
      await strandProvisioning(host, async () => {
        const set = await host.cli([
          "config",
          "set",
          "ramBudget.iosBytesPerDevice",
          `${limitBytes + 1024}`,
        ]);
        expect(set.code, set.stderr).toBe(0);
      });
      let view: WorkerView | undefined;
      await untilTheDaemonSays(host, (views) => {
        [view] = views;
        return (
          view?.capacity?.ramBudget?.overLimit === true &&
          view.devices.some((device) => device.state === "quarantined") &&
          view.devices.some((device) => device.stalled === true)
        );
      });
      const quarantined = view?.devices.find((device) => device.state === "quarantined");
      const stalled = view?.devices.find((device) => device.stalled === true);

      await openAttention(page, host);

      const name = view?.id ?? "";
      await expect(item(page, "quarantined", `Device ${quarantined?.id} on ${name}`)).toBeVisible();
      await expect(item(page, "stalled", `Device ${stalled?.id} on ${name}`)).toBeVisible();
      await expect(item(page, "over RAM budget", name)).toBeVisible();
      await expect(page.locator(".attention-list li")).toHaveCount(3);
    } finally {
      await host.dispose();
    }
  });

  test("the attention count shows in the shell from every view", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    const hangUps: (() => void)[] = [];
    try {
      hangUps.push(await joinOldWorker(gateway, { id: "wrk_old_1", label: "old-1" }));
      hangUps.push(await joinOldWorker(gateway, { id: "wrk_old_2", label: "old-2" }));
      await untilTheDaemonSays(
        gateway,
        (views) => views.filter((view) => view.connection === "incompatible").length === 2,
      );
      await page.goto(gateway.url);
      await signIn(page, gateway.tokens.operator);

      const attention = page.getByRole("navigation").getByRole("link", { name: /^Attention/ });
      for (const label of NAV_LABELS) {
        await page.getByRole("navigation").getByRole("link", { name: label }).click();
        await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
        await expect(attention.locator(".nav-count")).toHaveText(/^\D*2\D*$/);
        await expect(attention).toHaveAccessibleName("Attention 2 items");
      }

      // One worker hangs up and is removed: its item goes, and one from the count.
      hangUps.shift()?.();
      await untilTheDaemonSays(gateway, (views) =>
        views.some((view) => view.id === "wrk_old_1" && view.connection === "disconnected"),
      );
      const removed = await gateway.cli(["worker", "remove", "wrk_old_1"]);
      expect(removed.code, removed.stderr).toBe(0);
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      await expect(attention).toHaveAccessibleName("Attention 1 item");
    } finally {
      for (const hangUp of hangUps) hangUp();
      await gateway.dispose();
    }
  });

  test("the Attention view has no horizontal scroll at 360px wide", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, {
        id: "wrk_with_a_long_id_that_does_not_fit_on_a_phone_0123456789",
        label: "a-worker-with-a-label-far-too-long-for-one-line-on-a-phone",
      });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      await page.setViewportSize({ height: 740, width: 360 });

      await openAttention(page, gateway);

      await expect(page.locator(".attention-list li")).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("the Attention view is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      /** Tabs forward until `link` has focus, and follows it with Enter. */
      const follow = async (link: Locator) => {
        for (let step = 0; step < 20; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(tab);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await page.goto(gateway.url);
      await page.keyboard.press(tab);
      await page.keyboard.type(gateway.tokens.operator);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      await follow(page.getByRole("navigation").getByRole("link", { name: /^Attention/ }));
      await expect(page.getByRole("heading", { level: 1, name: "Attention" })).toBeVisible();

      await follow(item(page, "incompatible", "old-worker").getByRole("link"));
      await expect(page.getByRole("heading", { level: 1, name: "old-worker" })).toBeVisible();
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });
});
