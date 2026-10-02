import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  joinOldWorker,
  OLD_PROTOCOL,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

/** What `simlock worker list --json` and `simlock status --json` say, as far as these tests read. */
interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly drained: boolean;
  readonly health?: string;
  readonly version?: string;
  readonly protocol?: {
    readonly gateway: { readonly min: number; readonly max: number };
    readonly worker: { readonly min: number; readonly max: number };
  };
  readonly capacity?: {
    readonly global: { readonly running: number };
    readonly ios: { readonly running: number; readonly limit: number };
    readonly android: { readonly running: number; readonly limit: number };
  };
  readonly leases: readonly { readonly deviceId: string; readonly grantedAt: number }[];
}

interface Status {
  readonly devices: readonly { readonly id: string; readonly state: string }[];
  readonly host: {
    readonly os: string;
    readonly osVersion: string;
    readonly arch: string;
  };
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function workerList(daemon: RunningDaemon): Promise<readonly WorkerView[]> {
  const listed = await daemon.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: readonly WorkerView[] }).workers;
}

async function status(daemon: RunningDaemon): Promise<Status> {
  const result = await daemon.cli(["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Status;
}

async function lease(daemon: RunningDaemon, agent: string, model = "iPhone 16"): Promise<void> {
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

/**
 * Waits, asking every 20 ms, until the gateway's own `GET /v1/workers` says what `predicate`
 * looks for. The console's second starts there: it cannot show a fact before its daemon has it.
 */
async function untilTheGatewaySays(
  gateway: RunningDaemon,
  predicate: (views: readonly WorkerView[]) => boolean,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(new URL("/v1/workers", gateway.url), {
        headers: { Authorization: `Bearer ${gateway.tokens.operator}` },
      });
      return predicate(((await response.json()) as { workers: WorkerView[] }).workers);
    },
    { interval: 20, label: "the gateway's own worker views", timeout: 10_000 },
  );
}

async function openConsole(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
}

/** A worker's card on the list, by the name it shows. */
function card(page: Page, name: string): Locator {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 2, name, exact: true }) });
}

/** The value beside a label in a list of facts. */
function fact(scope: Locator, label: string): Locator {
  return scope.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
}

/** A device's row in a worker's device table. */
function deviceRow(page: Page, id: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: id, exact: true }) });
}

/** What the list shows for a worker, written the way the console writes it. */
function expectedFacts(view: WorkerView): Record<string, string> {
  const capacity = view.capacity;
  return {
    Capacity:
      capacity === undefined
        ? "Not reported"
        : `iOS ${capacity.ios.running} of ${capacity.ios.limit} running, ` +
          `Android ${capacity.android.running} of ${capacity.android.limit} running`,
    Connection: view.drained ? `${view.connection} drained` : view.connection,
    Devices:
      capacity === undefined
        ? "Not reported"
        : `${capacity.global.running} running, ${view.leases.length} leased`,
    Health: view.health ?? "Not reported",
    Version: view.version ?? "Not reported",
  };
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the workers views", () => {
  test("on a gateway, every worker in simlock worker list appears with its state", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const b = (await workerList(fleet.gateway)).find((view) => view.label === "worker-b");
      expect((await fleet.gateway.cli(["worker", "drain", b?.id ?? ""])).code).toBe(0);
      await lease(fleet.workers[0] as RunningDaemon, "console-e2e");
      await waitFor(
        async () => (await workerList(fleet.gateway)).some((view) => view.leases.length === 1),
        { label: "the gateway's view of worker-a carries its lease" },
      );
      const listed = await workerList(fleet.gateway);

      await openConsole(page, fleet.gateway);

      await expect(page.locator(".card")).toHaveCount(listed.length);
      for (const view of listed) {
        const shown = card(page, view.label ?? view.id);
        await expect(shown).toContainText(view.id);
        for (const [label, value] of Object.entries(expectedFacts(view))) {
          await expect(fact(shown, label), `${view.label} ${label}`).toHaveText(value);
        }
        await expect(fact(shown, "Protocol")).toHaveText("compatible");
      }
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("an incompatible worker shows both protocol ranges", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      let view: WorkerView | undefined;
      await waitFor(
        async () => {
          view = (await workerList(gateway)).find((candidate) => candidate.id === "wrk_old");
          return view?.connection === "incompatible";
        },
        { label: "the gateway lists the old worker as incompatible" },
      );
      const gatewayRange = view?.protocol?.gateway;
      expect(view?.protocol?.worker).toEqual(OLD_PROTOCOL);

      await openConsole(page, gateway);

      const shown = card(page, "old-worker");
      await expect(fact(shown, "Connection")).toHaveText("incompatible");
      await expect(fact(shown, "Protocol")).toHaveText(
        `incompatible gateway ${gatewayRange?.min}–${gatewayRange?.max}, ` +
          `worker ${OLD_PROTOCOL.min}–${OLD_PROTOCOL.max}`,
      );
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("on a single host, the workers view shows one worker", async ({ daemon, page }) => {
    const [host] = await workerList(daemon);
    expect(host).toBeDefined();

    await openConsole(page, daemon);

    await expect(page.locator(".card")).toHaveCount(1);
    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Connection")).toHaveText("connected");
    await expect(fact(shown, "Version")).toHaveText(host?.version ?? "");
    await shown.getByRole("link", { name: host?.id ?? "" }).click();
    await expect(page.getByRole("heading", { level: 1, name: host?.id ?? "" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Devices" })).toBeVisible();
  });

  test("a worker's detail lists every device it has, with state and time in that state", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-1");
      await lease(host, "console-e2e-2");
      expect((await host.cli(["release", "--all", "--yes"])).code).toBe(0);
      await lease(host, "console-e2e-3");
      // Settled: no device between states, so the CLI and the page see the same states.
      await waitFor(
        async () =>
          (await status(host)).devices.every(
            (device) => device.state === "ready" || device.state === "leased",
          ),
        { label: "every device ready or leased" },
      );
      const { devices } = await status(host);
      const [view] = await workerList(host);
      expect(devices.map((device) => device.state).sort()).toEqual(
        expect.arrayContaining(["leased", "ready"]),
      );
      // The browser's clock is three hours fast; durations are by the daemon's clock all the same.
      await page.clock.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);

      await openConsole(page, host);
      await page.getByRole("link", { name: view?.id ?? "" }).click();

      await expect(page.locator("tbody tr")).toHaveCount(devices.length);
      for (const device of devices) {
        const cells = deviceRow(page, device.id).getByRole("cell");
        await expect(cells.nth(1)).toHaveText(device.state);
        const held = view?.leases.find((candidate) => candidate.deviceId === device.id);
        if (held === undefined) {
          // A ready device: the worker view carries no time for that state.
          await expect(cells.nth(2), device.id).toHaveText("—");
          continue;
        }
        // A leased device: in that state since its lease was granted, counting on with no reload.
        await expect(cells.nth(2), device.id).toHaveText(/^\d+ s$/);
        const shown = Number.parseInt((await cells.nth(2).textContent()) ?? "", 10);
        expect(Math.abs(shown - (Date.now() - held.grantedAt) / 1000)).toBeLessThanOrEqual(2);
        await expect(cells.nth(2)).not.toHaveText(`${shown} s`);
      }
    } finally {
      await host.dispose();
    }
  });

  test("a worker's detail shows its host facts, catalog and installs in progress", async ({
    page,
  }) => {
    const host = await startDaemon("worker", {
      driverScript: {
        ios: {
          availableOsVersions: ["18.4", "26.0"],
          knownModels: ["iPhone 16", "iPad Air"],
          // Held open for the whole test.
          latencyMs: { installComponent: 120_000 },
          toolVersions: [{ build: "16F6", name: "xcode", version: "16.4" }],
        },
      },
    });
    try {
      host.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "19.0",
        "--allow-download",
        "--detach",
      ]);
      await waitFor(async () => (await host.cli(["status", "--json"])).stdout.includes('"19.0"'), {
        label: "the host lists the install",
      });
      const facts = (await status(host)).host;
      const [view] = await workerList(host);

      await openConsole(page, host);
      await page.getByRole("link", { name: view?.id ?? "" }).click();

      const main = page.locator("#main");
      await expect(fact(main, "Operating system")).toHaveText(`${facts.os} ${facts.osVersion}`);
      await expect(fact(main, "CPU architecture")).toHaveText(facts.arch);
      await expect(fact(main, "Tools")).toHaveText("xcode 16.4 (16F6) for iOS");
      await expect(fact(main, "iOS")).toContainText("Models: iPhone 16, iPad Air");
      await expect(fact(main, "iOS")).toContainText(/Runtimes: 18\.4.*, 26\.0/);
      const installs = page
        .getByRole("heading", { level: 2, name: "Installs in progress" })
        .locator("xpath=following-sibling::*[1]");
      await expect(installs).toHaveText(/^iOS 19\.0 downloading for \d+ s, 1 waiter$/);
    } finally {
      await host.dispose();
    }
  });

  test("a granted lease shows on the worker within a second, without a reload", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      await openConsole(page, fleet.gateway);
      const shown = fact(card(page, "worker-a"), "Devices");
      await expect(shown).toHaveText(/, 0 leased$/);

      // Through the gateway, as an agent would: only worker-a has an iPhone 16.
      await lease(fleet.gateway, "console-e2e");
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-a")?.leases.length === 1,
      );

      await expect(shown).toHaveText(/, 1 leased$/, { timeout: 1_000 });
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a disconnected worker shows as disconnected within a second", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openConsole(page, fleet.gateway);
      const connection = fact(card(page, "worker-b"), "Connection");
      await expect(connection).toHaveText("connected");

      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );

      await expect(connection).toHaveText("disconnected", { timeout: 1_000 });
      await expect(fact(card(page, "worker-a"), "Connection")).toHaveText("connected");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("stopping the daemon shows the reconnecting banner with the data's age", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openConsole(page, host);
      const banner = page.locator(".connection");
      await expect(banner).toHaveText("Connected");
      const [view] = await workerList(host);

      await host.stop();

      await expect(banner).toHaveText(/^Reconnecting — data from \d+ s ago$/);
      const age = async () => Number(/(\d+) s ago/.exec((await banner.textContent()) ?? "")?.[1]);
      const first = await age();
      await expect.poll(age).toBeGreaterThan(first);
      // The data stays on screen.
      await expect(card(page, view?.id ?? "")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("starting the daemon again clears the banner and refreshes the data", async ({ page }) => {
    const host = await startDaemon("worker", {
      driverScript: { ios: { ...IOS, toolVersions: [{ name: "xcode", version: "16.4" }] } },
    });
    try {
      const [view] = await workerList(host);
      await openConsole(page, host);
      await page.getByRole("link", { name: view?.id ?? "" }).click();
      const banner = page.locator(".connection");
      const tools = fact(page.locator("#main"), "Tools");
      await expect(tools).toHaveText("xcode 16.4 for iOS");

      await host.stop();
      await expect(banner).toHaveText(/^Reconnecting/);
      // A fact the daemon reads only as it starts, so the page shows it only if it reads again.
      await host.writeDriverScript({
        ios: { ...IOS, toolVersions: [{ name: "xcode", version: "26.0" }] },
      });
      await host.start();

      await expect(banner).toHaveText("Connected", { timeout: 30_000 });
      await expect(tools).toHaveText("xcode 26.0 for iOS");
    } finally {
      await host.dispose();
    }
  });

  test("every status shows a word with its colour, and none uses the accent colour", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(fleet.gateway, { id: "wrk_old", label: "old-worker" });
      const b = (await workerList(fleet.gateway)).find((view) => view.label === "worker-b");
      expect((await fleet.gateway.cli(["worker", "drain", b?.id ?? ""])).code).toBe(0);
      await lease(fleet.workers[0] as RunningDaemon, "console-e2e");
      await openConsole(page, fleet.gateway);
      await expect(fact(card(page, "old-worker"), "Connection")).toHaveText("incompatible");
      await expect(fact(card(page, "worker-b"), "Connection")).toHaveText("connected drained");

      const statuses = async () =>
        page.locator(".status").evaluateAll((elements) => {
          const root = getComputedStyle(document.documentElement);
          const colour = (value: string) => {
            const probe = document.createElement("span");
            probe.style.color = value;
            document.body.append(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          };
          const named = (token: string) => colour(root.getPropertyValue(token).trim());
          const tones = ["--status-ok", "--status-warn", "--status-error", "--status-idle"];
          return {
            accent: named("--accent"),
            shown: elements.map((element) => ({
              colour: getComputedStyle(element.querySelector(".status-dot") ?? element)
                .backgroundColor,
              word: element.textContent?.trim() ?? "",
            })),
            tones: tones.map(named),
          };
        });

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const where of ["list", "detail"] as const) {
          if (where === "detail")
            await page.getByRole("link", { name: "worker-a", exact: true }).click();
          else await page.getByRole("link", { name: "Workers", exact: true }).click();
          await expect(page.locator(".status").first()).toBeVisible();
          const { accent, shown, tones } = await statuses();
          const words = shown.map((status) => status.word);
          expect(words).toEqual(
            expect.arrayContaining(
              where === "list"
                ? ["connected", "drained", "incompatible", "running", "compatible"]
                : ["connected", "leased"],
            ),
          );
          for (const status of shown) {
            expect(status.word, `${where} ${colorScheme}`).not.toBe("");
            expect(tones, `${status.word} in ${where} ${colorScheme}`).toContain(status.colour);
            expect(status.colour, `${status.word} in ${where} ${colorScheme}`).not.toBe(accent);
          }
        }
      }
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("the workers views have no horizontal scroll at 360px wide", async ({ page }) => {
    const host = await startDaemon("worker", {
      driverScript: {
        ios: {
          ...IOS,
          toolVersions: [{ build: "16F6", name: "xcode", version: "16.4" }],
        },
      },
    });
    try {
      await lease(host, "console-e2e");
      await page.setViewportSize({ height: 740, width: 360 });
      await openConsole(page, host);
      await expect(page.locator(".card")).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);

      await page.locator(".card").getByRole("link").click();
      await expect(page.locator("tbody tr").first()).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the workers views are usable with the keyboard alone", async ({
    browserName,
    daemon,
    page,
  }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const [host] = await workerList(daemon);
    const name = host?.id ?? "";
    /** Tabs forward until the link named `label` has focus, and follows it with Enter. */
    const follow = async (label: string) => {
      const link = page.getByRole("link", { name: label, exact: true });
      for (let step = 0; step < 20; step += 1) {
        if (await link.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press(tab);
      }
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
    };
    await page.goto("/");
    await page.keyboard.press(tab);
    await page.keyboard.type(daemon.tokens.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

    await follow(name);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    await follow("All workers");
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
  });
});
