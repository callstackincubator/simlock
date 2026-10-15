import type { Locator, Page, Route } from "@playwright/test";

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
  readonly load?: {
    readonly readAt: number;
    readonly cpu?: { readonly busyPercent: number; readonly cores: number };
    readonly memory?: { readonly availableBytes: number; readonly totalBytes: number };
    readonly disk?: { readonly freeBytes: number; readonly totalBytes: number };
  };
}

interface WorkerPayload {
  load?:
    | {
        memory?: { availableBytes?: number; pressure?: string; totalBytes?: number } | undefined;
      }
    | undefined;
}

// why: the two fields a colour case has to state; everything else in the reading stays the
// daemon's.
interface MemoryClaim {
  readonly pressure?: string;
  readonly usedPercent: number;
}

/**
 * why: only macOS reports a memory pressure, and how full a CI machine's memory happens to be is
 * nobody's to predict — so the colour test states the memory reading it wants and this writes just
 * those fields into the daemon's own answer, leaving every other field, its headers and its `Date`
 * real. The route is asked again per request, so the reading stays as fresh as the daemon's own.
 */
async function answerMemory(page: Page, claim: () => MemoryClaim): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/workers",
    async (route: Route) => {
      const response = await route.fetch();
      const listed = (await response.json()) as { workers: WorkerPayload[] };
      for (const worker of listed.workers) {
        const memory = worker.load?.memory;
        const total = memory?.totalBytes;
        if (memory === undefined || typeof total !== "number" || total <= 0) continue;
        const wanted = claim();
        memory.availableBytes = Math.round((total * (100 - wanted.usedPercent)) / 100);
        if (wanted.pressure === undefined) delete memory.pressure;
        else memory.pressure = wanted.pressure;
      }
      await route.fulfill({ json: listed, response });
    },
  );
}

interface Status {
  readonly devices: readonly {
    readonly id: string;
    readonly state: string;
    readonly mode: string;
    readonly physical: boolean;
    readonly spec: {
      readonly platform: string;
      readonly model: string;
      readonly osVersion: string;
      readonly imageTag?: string;
    };
  }[];
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

interface PaintedGauge {
  readonly track: number;
  readonly fill: number;
  readonly sliding: boolean;
}

// why: taken from the worker's own reading rather than from the page, so the console cannot agree
// with itself; there is no expected level until the reading holds a figure for each of the three.
function gaugePercents(load: NonNullable<WorkerView["load"]>): readonly number[] | undefined {
  const { cpu, disk, memory } = load;
  if (cpu === undefined || disk === undefined || memory === undefined) return undefined;
  const whole = (percent: number) => Math.round(Math.min(100, Math.max(0, percent)));
  return [
    whole(cpu.busyPercent),
    whole((1 - memory.availableBytes / memory.totalBytes) * 100),
    whole((1 - disk.freeBytes / disk.totalBytes) * 100),
  ];
}

function paintedGauges(panel: Locator): Promise<readonly PaintedGauge[]> {
  return panel.locator(".load-bar").evaluateAll((bars) =>
    bars.map((bar) => {
      const fill = bar.firstElementChild as HTMLElement;
      // why: the fill's own 120 ms ease means a width read mid-slide sits between two levels, so
      // this asks the browser whether a transition is still running and reports it with the width.
      return {
        track: bar.getBoundingClientRect().width,
        fill: fill.getBoundingClientRect().width,
        sliding: fill.getAnimations().some((animation) => animation.playState === "running"),
      };
    }),
  );
}

function fillsMatch(painted: readonly PaintedGauge[], percents: readonly number[]): boolean {
  return (
    painted.length === percents.length &&
    painted.every((bar, index) => {
      const percent = percents[index] ?? -1;
      return Math.abs(bar.fill - (bar.track * percent) / 100) <= 1;
    })
  );
}

interface PaintedTone {
  readonly colour: string;
  readonly tone: string;
}

// why: what the memory poll cannot see, because it watches one gauge: that every other gauge on
// the panel carries a tone class at all, and wears none of them in the accent. Which token a tone
// class resolves to is the poll's claim, proven for all four in both themes.
function gaugeToneFaults(painted: readonly PaintedTone[], accent: string): string[] {
  const faults: string[] = [];
  for (const fill of painted) {
    if (fill.tone === "") faults.push("a gauge carries no tone class");
    else if (fill.colour === accent)
      faults.push(`the ${fill.tone} gauge is painted with the accent`);
  }
  return faults;
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

/** The status tones, in the order the colour test reads their tokens. */
const TONES = ["ok", "warn", "error", "idle"] as const;

/** What each word the colour test meets means, as the design guide sorts them. */
const TONE_OF: Readonly<Partial<Record<string, (typeof TONES)[number]>>> = {
  Connected: "ok",
  compatible: "ok",
  connected: "ok",
  drained: "warn",
  incompatible: "error",
  leased: "ok",
  ready: "ok",
  running: "ok",
};

/** Every status on the page: its word and its square's colour, with the tokens' colours. */
async function readStatuses(page: Page) {
  return page.locator(".status").evaluateAll((elements) => {
    const root = getComputedStyle(document.documentElement);
    const named = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = root.getPropertyValue(token).trim();
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    return {
      accent: named("--accent"),
      shown: elements.map((element) => ({
        colour: getComputedStyle(element.querySelector(".status-dot") ?? element).backgroundColor,
        word: element.textContent?.trim() ?? "",
      })),
      tones: ["--status-ok", "--status-warn", "--status-error", "--status-idle"].map(named),
    };
  });
}

/**
 * Every status on the page is a word with a status colour that is not the accent, the colour
 * each known word should have; and `words` are among them.
 */
async function expectStatusColours(
  page: Page,
  where: string,
  words: readonly string[],
): Promise<void> {
  await expect(page.locator(".status").first()).toBeVisible();
  const { accent, shown, tones } = await readStatuses(page);
  expect(shown.map((status) => status.word)).toEqual(expect.arrayContaining([...words]));
  for (const status of shown) {
    const context = `${status.word} in ${where}`;
    expect(status.word, where).not.toBe("");
    expect(tones, context).toContain(status.colour);
    expect(status.colour, context).not.toBe(accent);
    const tone = TONE_OF[status.word];
    if (tone !== undefined) expect(status.colour, context).toBe(tones[TONES.indexOf(tone)]);
  }
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

  test("a worker's detail lists every device it has, with state and, where the data has one, time in that state", async ({
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

      const deviceTable = page
        .getByRole("region", { name: "Devices", exact: true })
        .locator(".panel-body");
      await expect(deviceTable.locator("tbody tr")).toHaveCount(devices.length);
      for (const device of devices) {
        const cells = deviceRow(page, device.id).getByRole("cell");
        await expect(cells.nth(1)).toHaveText(device.state);
        await expect(cells.nth(3)).toHaveText(device.spec.platform === "ios" ? "iOS" : "Android");
        await expect(cells.nth(4)).toHaveText(device.physical ? "Physical" : "Virtual");
        await expect(cells.nth(5)).toHaveText(device.spec.model);
        await expect(cells.nth(6)).toHaveText(device.spec.osVersion);
        await expect(cells.nth(7)).toHaveText(device.mode);
        await expect(cells.nth(8)).toHaveText(device.spec.imageTag ?? "—");
        const held = view?.leases.find((candidate) => candidate.deviceId === device.id);
        if (held === undefined) {
          // A ready device: the worker view carries no time for that state.
          await expect(cells.nth(2), device.id).toHaveText("—");
          continue;
        }
        await expect(cells.nth(2), device.id).toHaveText(/^\d+ s$/);
        const shown = Number.parseInt((await cells.nth(2).textContent()) ?? "", 10);
        // Within 3 seconds: the Date header counts whole seconds, the page shows whole seconds,
        // and the page is read a moment before the expected value is worked out. Three hours
        // off, as the browser's own clock would make it, is far outside.
        expect(Math.abs(shown - (Date.now() - held.grantedAt) / 1000)).toBeLessThanOrEqual(3);
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
        .getByRole("region", { name: "Installs in progress", exact: true })
        .locator(".panel-body");
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

  test("on a single host, a card shows its Load row and the detail shows the Load panel with an age that ticks", async ({
    daemon,
    page,
  }) => {
    const [host] = await workerList(daemon);
    await openConsole(page, daemon);

    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Load")).toHaveText(/^CPU .*memory .*disk /);
    await shown.getByRole("link", { name: host?.id ?? "" }).click();

    const panel = page.getByRole("region", { name: "Load", exact: true });
    const read = fact(panel, "Read");
    await expect(read).toHaveText(/^\d+ s ago$/);
    const first = await read.textContent();
    await expect(read).not.toHaveText(first ?? "", { timeout: 10_000 });
    await expect(fact(panel, "Memory")).toContainText("available");
  });

  test("a worker's detail draws a bar under each figure, filled to that figure's own percent", async ({
    daemon,
    page,
  }) => {
    const [host] = await workerList(daemon);
    await openConsole(page, daemon);
    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Load")).toHaveText(/^CPU .*memory .*disk /);
    await shown.getByRole("link", { name: host?.id ?? "" }).click();

    const panel = page.getByRole("region", { name: "Load", exact: true });
    // why: both the worker's reading (every 15 s) and the fill's own 120 ms slide can move between
    // two measurements, so this measures around both and retries until the fill has settled at the
    // level the reading implies — otherwise the bar and the figure compared are not the same pair.
    await waitFor(
      async () => {
        const before = (await workerList(daemon))[0]?.load;
        const wanted = before === undefined ? undefined : gaugePercents(before);
        if (wanted === undefined) return false;
        const painted = await paintedGauges(panel);
        const now = (await workerList(daemon))[0]?.load;
        // why: what has to hold still is the level, not the reading — a fresh sample that rounds to
        // the same percents is the same pair of figures and bars. The reading's own stamp moves
        // between two reads even when nothing in it does, so comparing it here only ever costs
        // retries.
        const since = now === undefined ? undefined : gaugePercents(now);
        if (since === undefined || JSON.stringify(wanted) !== JSON.stringify(since)) return false;
        if (painted.some((bar) => bar.sliding)) return false;
        return fillsMatch(painted, wanted);
      },
      { interval: 500, timeout: 40_000, label: () => "the fill to match the figure" },
    );
  });

  test("a load gauge sits in a line of its own under its figure, capped rather than full width", async ({
    daemon,
    page,
  }) => {
    const [host] = await workerList(daemon);
    await openConsole(page, daemon);
    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Load")).toHaveText(/^CPU .*memory .*disk /);
    await shown.getByRole("link", { name: host?.id ?? "" }).click();

    const panel = page.getByRole("region", { name: "Load", exact: true });
    const row = fact(panel, "Memory");
    await expect(row.locator(".load-bar")).toBeVisible();
    // why: the viewport is 1280 wide, so the value column is far wider than the cap; a bar that
    // filled its column instead of capping, or sat beside the text instead of under it, fails here.
    const geometry = await row.evaluate((cell) => {
      const figure = cell.querySelector(".load-figure > span") as HTMLElement;
      const bar = cell.querySelector(".load-bar") as HTMLElement;
      const text = figure.getBoundingClientRect();
      const track = bar.getBoundingClientRect();
      return {
        column: cell.getBoundingClientRect().width,
        left: track.left - text.left,
        root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        top: track.top,
        track: track.width,
        textBottom: text.bottom,
      };
    });

    expect(geometry.track).toBeCloseTo(20 * geometry.root, 0);
    expect(geometry.track).toBeLessThan(geometry.column - 100);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.textBottom);
    expect(geometry.left).toBeCloseTo(0, 0);
  });

  test("each memory pressure paints its gauge in that pressure's colour, and never the accent, in both themes", async ({
    daemon,
    page,
  }) => {
    const [host] = await workerList(daemon);
    await openConsole(page, daemon);
    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Load")).toHaveText(/^CPU .*memory .*disk /);
    // why: only macOS reports a memory pressure, and how full a CI machine's memory happens to be
    // is nobody's to predict. This answers the page's own read of the worker list with the memory
    // reading's own fields set to the level the case asks for and every other field left as the
    // daemon sent it, so what is painted is the real component's doing and the same colour is
    // expected on any machine.
    let claim: MemoryClaim = { usedPercent: 50 };
    await answerMemory(page, () => claim);
    await shown.getByRole("link", { name: host?.id ?? "" }).click();

    const panel = page.getByRole("region", { name: "Load", exact: true });
    await expect(panel.locator(".load-bar").first()).toBeVisible();
    const memory = fact(panel, "Memory");
    const paintedFills = () =>
      panel.locator(".load-bar").evaluateAll((bars) =>
        bars.map((bar) => ({
          tone: /load-bar-(\w+)/.exec(bar.className)?.[1] ?? "",
          colour: getComputedStyle(bar.firstElementChild as HTMLElement).backgroundColor,
        })),
      );
    // why: the page polls every second, so each level shows within about that. The memory gauge is
    // identified by its own row, so a tone read here cannot be a leftover of the last level.
    const memoryFill = () =>
      memory.evaluate((cell) => {
        const bar = cell.querySelector(".load-bar") as HTMLElement;
        return {
          tone: /load-bar-(\w+)/.exec(bar.className)?.[1] ?? "",
          colour: getComputedStyle(bar.firstElementChild as HTMLElement).backgroundColor,
        };
      });

    // why: these six are the whole colour rule for a memory gauge — the worker's three words, that
    // the word outranks the console's threshold, and the threshold on its own at either end. Each is
    // seen in each theme by the real component, so a tone rule deleted, swapped, or given the accent
    // fails a named assertion here.
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const { accent, tones } = await readStatuses(page);

      for (const [level, usedPercent, tone] of [
        ["normal", 50, "ok"],
        ["warn", 50, "warn"],
        ["critical", 50, "error"],
        ["normal", 97, "ok"],
        [undefined, 97, "error"],
        [undefined, 50, "idle"],
      ] as const) {
        claim = { usedPercent, ...(level === undefined ? {} : { pressure: level }) };
        const want = tones[TONES.indexOf(tone)];
        const at = `${usedPercent}%${level === undefined ? " with no word" : ` and ${level}`}`;
        await expect
          .poll(() => memoryFill(), {
            timeout: 5_000,
            message: `${at} to paint the ${tone} gauge in ${colorScheme}`,
          })
          .toEqual({ tone, colour: want });
        expect(want, `the ${tone} gauge in ${colorScheme}`).not.toBe(accent);

        // why: the poll above watches the memory gauge; this watches the rest of the panel, for the
        // one thing a poll of a single gauge cannot see.
        const fills = await paintedFills();
        expect(fills.length).toBeGreaterThan(1);
        expect(gaugeToneFaults(fills, accent)).toEqual([]);
      }
    }
  });

  test("a load gauge's fill transitions its width over the document's duration token, and over none under reduced motion", async ({
    browserName,
    daemon,
    page,
  }) => {
    const [host] = await workerList(daemon);
    await openConsole(page, daemon);
    const shown = card(page, host?.id ?? "");
    await expect(fact(shown, "Load")).toHaveText(/^CPU .*memory .*disk /);
    await shown.getByRole("link", { name: host?.id ?? "" }).click();

    const panel = page.getByRole("region", { name: "Load", exact: true });
    const fill = panel.locator(".load-bar-fill").first();
    await expect(fill).toBeVisible();
    // why: the stylesheet moves the fill's width over the document's own duration token, which is
    // what `prefers-reduced-motion: reduce` already sets to zero. Both sides are read back as
    // computed values and compared as milliseconds: a browser writes the token's `120ms` as `.12s`.
    const asMs = (value: string) =>
      value.trim().endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
    await expect
      .poll(async () => {
        const style = await fill.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            duration: computed.transitionDuration,
            property: computed.transitionProperty,
            token: getComputedStyle(document.documentElement).getPropertyValue("--duration").trim(),
          };
        });
        return style.property === "width" && asMs(style.duration) === asMs(style.token);
      })
      .toBe(true);

    if (browserName === "chromium") {
      // why: emulated in Chromium alone — it is the one engine whose reduced-motion emulation was
      // verified on the machine that wrote this test, and a guard must not hide a real failure in
      // the other two.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(fill).toHaveCSS("transition-duration", "0s");
    }
  });

  test("a disconnected worker's Load row says No reading while disconnected within a second", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openConsole(page, fleet.gateway);
      const load = fact(card(page, "worker-b"), "Load");
      // why: the gateway shows a worker's first reading after its refresh, so allow twice the default 5 s wait.
      await expect(load).toHaveText(/^CPU /, { timeout: 10_000 });

      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );

      await expect(load).toHaveText("No reading while disconnected", { timeout: 1_000 });
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

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.getByRole("link", { name: "Workers", exact: true }).click();
        await expectStatusColours(page, `list ${colorScheme}`, [
          "connected",
          "drained",
          "incompatible",
          "running",
          "compatible",
        ]);
        await page.getByRole("link", { name: "worker-a", exact: true }).click();
        await expectStatusColours(page, `detail ${colorScheme}`, ["connected", "leased"]);
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
