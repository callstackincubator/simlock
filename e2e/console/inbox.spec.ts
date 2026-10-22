import type { Locator, Page, Route } from "@playwright/test";

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

/** why: What `GET /v1/workers` says, as far as these tests read. */
interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly drained: boolean;
  readonly capacity?: { readonly ramBudget?: { readonly overLimit: boolean } };
  readonly devices: readonly {
    readonly id: string;
    readonly state: string;
    readonly stalled?: boolean;
    readonly transitionAgeMs?: number;
  }[];
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

/** why: The fake driver's script once its reclaim fails, so a released device is quarantined. */
const FAILING_RECLAIM = {
  ios: { ...IOS, failures: { reclaim: { message: "erase failed", type: "generic" as const } } },
};

/**
 * why: a worker whose stall threshold is one second: a device left `provisioning` with nothing
 * working on it is stalled a second after it entered that state. The pool is off: a kind it
 * learned from the first lease would be refilled with a ready device the stranded lease takes.
 */
const STALLING = {
  config: {
    stalledTransition: { minimumThresholdMs: 1_000, thresholdMultiplier: 1 },
    warmPool: { enabled: false },
  },
  driverScript: { ios: IOS },
} as const;

async function workers(daemon: RunningDaemon): Promise<readonly WorkerView[]> {
  const listed = await daemon.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: WorkerView[] }).workers;
}

/**
 * why: Waits, asking every 20 ms, until the daemon's own `worker list` (over its socket, so a joined worker without HTTP answers too) says what `predicate`
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

/** why: Leases a device, then releases it with a driver whose reclaim fails: it is quarantined. */
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
 * why: Leaves a device `provisioning` with nothing working on it, as a daemon that stops mid-boot
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

async function openInbox(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  // why: a phone folds the navigation into a menu, so the page is opened by its address.
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(new URL("/inbox", daemon.url).href);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

function rows(page: Page): Locator {
  return page.locator("main").getByRole("list").getByRole("link");
}

function item(page: Page, condition: string, subject: string): Locator {
  return rows(page)
    .filter({ has: page.getByRole("img", { exact: true, name: condition }) })
    .filter({ hasText: subject });
}

async function closeDrawer(page: Page): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

function facts(page: Page): Locator {
  return page.getByRole("group", { name: "Facts" });
}

/** why: Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Inbox view", () => {
  test("/inbox lists a drained worker under Needs a look and a disconnected one under Broken; the chips show one group at a time", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const a = (await workers(fleet.gateway)).find((view) => view.label === "worker-a");
      expect((await fleet.gateway.cli(["worker", "drain", a?.id ?? ""])).code).toBe(0);
      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheDaemonSays(
        fleet.gateway,
        (views) =>
          views.find((view) => view.label === "worker-a")?.drained === true &&
          views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );
      await openInbox(page, fleet.gateway);

      const broken = page.getByRole("region", { name: "Broken" });
      const needsALook = page.getByRole("region", { name: "Needs a look" });
      await expect(broken.getByRole("link", { name: /worker-b/ })).toBeVisible();
      await expect(needsALook.getByRole("link", { name: /worker-a/ })).toBeVisible();
      await expect(page.getByRole("region", { name: "Heads-up" })).toHaveCount(0);

      await page.getByRole("radio", { name: "Broken" }).check();
      await expect(broken).toBeVisible();
      await expect(needsALook).toHaveCount(0);

      await page.getByRole("radio", { name: "Needs a look" }).check();
      await expect(needsALook).toBeVisible();
      await expect(broken).toHaveCount(0);

      await page.getByRole("radio", { name: "All" }).check();
      await expect(broken).toBeVisible();
      await expect(needsALook).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a waiting request stubbed with a createdAt 61 s before the daemon's now shows under Needs a look, and one at 30 s does not", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      // why: a request cannot wait a minute on a real daemon quickly, so the list is stubbed, each
      // age counted from the daemon's own clock (its Date header).
      await page.route(
        (url) => url.pathname === "/v1/lease-requests",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          const request = (id: string, waitedMs: number) => ({
            createdAt: now - waitedMs,
            id,
            platform: "ios",
            queuePosition: 1,
            requesterId: id,
            spec: { platform: "ios" },
            stage: "queued",
          });
          await route.fulfill({
            json: { requests: [request("long-waiter", 61_000), request("short-waiter", 30_000)] },
            response,
          });
        },
      );

      await openInbox(page, host);

      const needsALook = page.getByRole("region", { name: "Needs a look" });
      await expect(
        needsALook.getByRole("link", { name: /long-waiter has waited 1 min/ }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /short-waiter/ })).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("a lease stubbed with 4 minutes left shows under Heads-up, and one with 10 minutes does not", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      // why: a lease cannot be 4 minutes from its deadline on a real daemon quickly, so the list is
      // stubbed, each deadline counted from the daemon's own clock (its Date header).
      await page.route(
        (url) => url.pathname === "/v1/leases",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          const lease = (id: string, leftMs: number) => ({
            deviceId: "dev_stub",
            grantedAt: now - 60_000,
            id,
            idChosenByRequester: false,
            lastRenewedAt: now - 30_000,
            ownerId: "tok_stub",
            requesterId: "tok_stub",
            ttlDeadline: now + leftMs,
            ttlMs: 900_000,
          });
          await route.fulfill({
            json: { leases: [lease("lease-soon", 4 * 60_000), lease("lease-later", 10 * 60_000)] },
            response,
          });
        },
      );

      await openInbox(page, host);

      const headsUp = page.getByRole("region", { name: "Heads-up" });
      await expect(headsUp.getByRole("link")).toHaveCount(1);
      await expect(
        headsUp.getByRole("link", { name: /tok_stub · dev_stub ends in 3:\d\d/ }),
      ).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("an Inbox item whose key holds a . reloads at its address", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      // why: a gateway's lease id holds a `.`, which a single host never makes, so the list is stubbed.
      await page.route(
        (url) => url.pathname === "/v1/leases",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          await route.fulfill({
            json: {
              leases: [
                {
                  deviceId: "dev_stub",
                  grantedAt: now - 60_000,
                  id: "wrk_a.lse_1",
                  idChosenByRequester: false,
                  lastRenewedAt: now - 30_000,
                  ownerId: "tok_stub",
                  requesterId: "tok_stub",
                  ttlDeadline: now + 4 * 60_000,
                  ttlMs: 900_000,
                },
              ],
            },
            response,
          });
        },
      );
      await openInbox(page, host);

      await page.getByRole("region", { name: "Heads-up" }).getByRole("link").click();
      const address = new URL(page.url()).pathname;
      expect(address).toBe(`/inbox/${encodeURIComponent("lease/wrk_a.lse_1/ending")}/`);
      await page.reload();

      await expect(
        page.getByRole("dialog").getByRole("heading", { name: "tok_stub · dev_stub" }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(address);
    } finally {
      await host.dispose();
    }
  });

  test("an Inbox row opens /inbox/<key> with the what-happened box and the item's details; a cleared item says This is no longer in the Inbox.", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const [a] = await workers(fleet.gateway);
      expect((await fleet.gateway.cli(["worker", "drain", a?.id ?? ""])).code).toBe(0);
      await openInbox(page, fleet.gateway);

      await item(page, "drained", "worker-a").click();

      await expect(page).toHaveURL(new RegExp(`/inbox/${encodeURIComponent(`${a?.id}/drained`)}$`));
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("heading", { name: "worker-a" })).toBeVisible();
      await expect(drawer.getByRole("region", { name: "What happened" })).toContainText(
        "worker-a is drained",
      );
      await expect(facts(page)).toContainText(/Leases still held\s*0/);
      await expect(drawer.getByRole("link", { name: "Open worker" })).toHaveAttribute(
        "href",
        `/fleet/${encodeURIComponent(a?.id ?? "")}`,
      );

      expect((await fleet.gateway.cli(["worker", "undrain", a?.id ?? ""])).code).toBe(0);
      await untilTheDaemonSays(fleet.gateway, (views) => views[0]?.drained === false);

      await expect(drawer).toContainText("This is no longer in the Inbox.", { timeout: 10_000 });
      await expect(drawer.getByRole("region", { name: "What happened" })).toHaveCount(0);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("with /v1/lease-requests stubbed to fail, the Inbox says Could not check: waiting requests and not Nothing needs you", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await page.route(
        (url) => url.pathname === "/v1/lease-requests",
        (route) =>
          route.fulfill({
            json: { error: { code: "INTERNAL", message: "The queue is down." } },
            status: 500,
          }),
      );
      await openInbox(page, host);

      await expect(page.getByText("Could not check: waiting requests")).toBeVisible();
      await expect(page.getByText("Nothing needs you.")).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("draining a worker adds it to the Inbox view", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openInbox(page, fleet.gateway);
      await expect(page.getByText("Nothing needs you.")).toBeVisible();
      const b = (await workers(fleet.gateway)).find((view) => view.label === "worker-b");

      expect((await fleet.gateway.cli(["worker", "drain", b?.id ?? ""])).code).toBe(0);
      await untilTheDaemonSays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.drained === true,
      );

      const drained = item(page, "drained", "worker-b");
      await expect(drained).toBeVisible({ timeout: 10_000 });
      await expect(drained).toHaveAttribute(
        "href",
        `/inbox/${encodeURIComponent(`${b?.id}/drained`)}`,
      );
      await expect(rows(page)).toHaveCount(1);
      await expect(page).toHaveURL(/\/inbox$/);
      await drained.click();
      await expect(
        page.getByRole("dialog").getByRole("heading", { name: "worker-b" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Open worker" })).toHaveAttribute(
        "href",
        `/fleet/${encodeURIComponent(b?.id ?? "")}`,
      );
      await expect(facts(page)).toContainText("Leases still held");
      const recent = page.getByRole("region", { name: "Recent events" });
      await expect(recent.getByRole("link", { name: /worker\.drain-started/ })).toHaveAttribute(
        "href",
        /^\/activity\/.+/,
      );
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("undraining it removes it from the Inbox view", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const [a] = await workers(fleet.gateway);
      expect((await fleet.gateway.cli(["worker", "drain", a?.id ?? ""])).code).toBe(0);
      await openInbox(page, fleet.gateway);
      const drained = item(page, "drained", "worker-a");
      await expect(drained).toBeVisible();

      expect((await fleet.gateway.cli(["worker", "undrain", a?.id ?? ""])).code).toBe(0);
      await untilTheDaemonSays(fleet.gateway, (views) => views[0]?.drained === false);

      await expect(drained).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText("Nothing needs you.")).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("stopping a worker adds it as disconnected", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openInbox(page, fleet.gateway);
      await expect(page.getByText("Nothing needs you.")).toBeVisible();

      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheDaemonSays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );

      await expect(item(page, "disconnected", "worker-b")).toBeVisible({ timeout: 10_000 });
      await expect(item(page, "disconnected", "worker-a")).toHaveCount(0);
      await item(page, "disconnected", "worker-b").click();
      await expect(facts(page)).toContainText(/Last seen\s*\d+ s ago/);
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
      // why: Joined by hand rather than with `startFleet`, which has no way to pass the worker the
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
      // why: A stall starts with no event, so the gateway learns of it on its next periodic read of
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

      await openInbox(page, fleet.gateway);

      await expect(item(page, "incompatible", "old-worker")).toBeVisible();
      await item(page, "incompatible", "old-worker").click();
      await expect(facts(page)).toContainText("Gateway protocol");
      await expect(facts(page)).toContainText("Worker protocol");

      await closeDrawer(page);

      await item(page, "quarantined", "iPhone 16 on worker-a").click();
      await expect(facts(page)).toContainText(quarantined?.id ?? "");
      await closeDrawer(page);

      await item(page, "stalled", "iPhone 16 on worker-a").click();
      await expect(facts(page)).toContainText(stalled?.id ?? "");
      await expect(facts(page)).toContainText(/In this state for\s*\d+ (s|min)/);
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
      // why: Back with each iOS device costing more than the whole budget: the devices it already
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
          view.devices.some(
            (device) => device.state === "provisioning" && (device.transitionAgeMs ?? 0) > 1_000,
          )
        );
      });
      const quarantined = view?.devices.find((device) => device.state === "quarantined");
      const stalled = view?.devices.find((device) => device.state === "provisioning");
      // why: Past its one-second threshold, and nothing works on it since the restart.
      expect(stalled?.stalled, "the stranded device is reported stalled").toBe(true);

      await openInbox(page, host);

      const name = view?.id ?? "";
      await expect(item(page, "quarantined", `iPhone 16 on ${name}`)).toBeVisible();
      await expect(item(page, "stalled", `iPhone 16 on ${name}`)).toBeVisible();
      await expect(item(page, "over RAM budget", name)).toBeVisible();
      await expect(rows(page)).toHaveCount(3);
      expect(quarantined?.id).toBeTruthy();
      expect(stalled?.id).toBeTruthy();

      await item(page, "quarantined", `iPhone 16 on ${name}`).click();
      await expect(facts(page)).toContainText(/Cause\s*Purge failed: Error: erase failed/);
      await closeDrawer(page);

      await item(page, "over RAM budget", name).click();
      await expect(facts(page)).toContainText(/Used\s*\d+\.\d\d GiB/);
      await expect(facts(page)).toContainText(/Limit\s*\d+\.\d\d GiB/);
    } finally {
      await host.dispose();
    }
  });

  test("the sidebar's Inbox count equals the problem items and is hidden at 0", async ({
    page,
  }) => {
    const gateway = await startDaemon("gateway");
    const hangUps: (() => void)[] = [];
    try {
      hangUps.push(await joinOldWorker(gateway, { id: "wrk_old_1", label: "old-1" }));
      hangUps.push(await joinOldWorker(gateway, { id: "wrk_old_2", label: "old-2" }));
      await untilTheDaemonSays(
        gateway,
        (views) => views.filter((view) => view.connection === "incompatible").length === 2,
      );
      // why: a request that has waited two minutes is a problem item and counts; a lease about to end
      // is a heads-up and does not. Neither can be had quickly from a real daemon, so both are stubbed,
      // the waiting list by `waiters` so that it can empty.
      let waiters = ["long-waiter"];
      await page.route(
        (url) => url.pathname === "/v1/lease-requests",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          await route.fulfill({
            json: {
              requests: waiters.map((id) => ({
                createdAt: now - 125_000,
                id,
                platform: "ios",
                queuePosition: 1,
                requesterId: id,
                spec: { platform: "ios" },
                stage: "queued",
              })),
            },
            response,
          });
        },
      );
      await page.route(
        (url) => url.pathname === "/v1/leases",
        async (route: Route) => {
          const response = await route.fetch();
          const now = new Date(response.headers().date ?? "").getTime();
          await route.fulfill({
            json: {
              leases: [
                {
                  deviceId: "dev_stub",
                  grantedAt: now - 60_000,
                  id: "lease-soon",
                  idChosenByRequester: false,
                  lastRenewedAt: now - 30_000,
                  ownerId: "tok_stub",
                  requesterId: "tok_stub",
                  ttlDeadline: now + 60_000,
                  ttlMs: 900_000,
                },
              ],
            },
            response,
          });
        },
      );
      await page.goto(gateway.url);
      await signIn(page, gateway.tokens.operator);

      const inboxLink = page
        .getByRole("navigation", { name: "Console" })
        .getByRole("link", { name: /^Inbox/ });
      for (const label of NAV_LABELS) {
        await page
          .getByRole("navigation", { name: "Console" })
          .getByRole("link", { name: label })
          .click();
        await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
        await expect(inboxLink).toHaveAccessibleName("Inbox 3 items");
      }

      // why: One worker hangs up and is removed: its item goes, and one from the count.
      hangUps.shift()?.();
      await untilTheDaemonSays(gateway, (views) =>
        views.some((view) => view.id === "wrk_old_1" && view.connection === "disconnected"),
      );
      const removed = await gateway.cli(["worker", "remove", "wrk_old_1"]);
      expect(removed.code, removed.stderr).toBe(0);
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      await expect(inboxLink).toHaveAccessibleName("Inbox 2 items");

      waiters = [];
      await expect(inboxLink).toHaveAccessibleName("Inbox 1 item");

      hangUps.shift()?.();
      await untilTheDaemonSays(gateway, (views) =>
        views.some((view) => view.id === "wrk_old_2" && view.connection === "disconnected"),
      );
      const removedLast = await gateway.cli(["worker", "remove", "wrk_old_2"]);
      expect(removedLast.code, removedLast.stderr).toBe(0);
      await expect(inboxLink).toHaveAccessibleName("Inbox");
    } finally {
      for (const hangUp of hangUps) hangUp();
      await gateway.dispose();
    }
  });

  test("the Inbox view has no horizontal scroll at 360px wide", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, {
        id: "wrk_with_a_long_id_that_does_not_fit_on_a_phone_0123456789",
        label: "aworkerwithalabelfartoolongforonelineonaphonewithnohyphensinit",
      });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      await page.setViewportSize({ height: 740, width: 360 });

      await openInbox(page, gateway);

      await expect(rows(page)).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
      // why: a panel clips what overflows it, so the page never scrolls; the row itself must fit.
      const box = await rows(page).boundingBox();
      expect(box?.width ?? Infinity).toBeLessThanOrEqual(360);
      await rows(page).click();
      await expect(page.getByRole("heading", { level: 2, name: /^aworkerwith/ })).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("the Inbox view is usable with the keyboard alone", async ({ browserName, page }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      /** why: Tabs forward until `link` has focus, and follows it with Enter. */
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
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      await follow(
        page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: /^Inbox/ }),
      );
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

      await follow(item(page, "incompatible", "old-worker"));
      await expect(page.getByRole("heading", { level: 2, name: "old-worker" })).toBeVisible();

      await follow(page.getByRole("link", { name: "Open worker" }));
      await expect(page).toHaveURL(/\/fleet\/wrk_old$/);
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });
});
