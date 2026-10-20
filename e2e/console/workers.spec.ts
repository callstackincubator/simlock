import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  answerMemory,
  answerWithLoad,
  answerWithoutLoad,
  type MemoryClaim,
} from "./workers-answers.js";
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

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly drained: boolean;
  readonly lastSeenAt: number;
  readonly health?: string;
  readonly version?: string;
  readonly host?: { readonly os: string; readonly osVersion: string };
  readonly protocol?: {
    readonly gateway: { readonly min: number; readonly max: number };
    readonly worker: { readonly min: number; readonly max: number };
  };
  readonly capacity?: {
    readonly global: { readonly running: number };
    readonly ios: { readonly running: number; readonly limit: number };
    readonly android: { readonly running: number; readonly limit: number };
  };
  readonly leases: readonly {
    readonly id: string;
    readonly deviceId: string;
    readonly grantedAt: number;
    readonly requesterId: string;
  }[];
  readonly load?: {
    readonly readAt: number;
    readonly cpu?: { readonly busyPercent: number; readonly cores: number };
    readonly memory?: { readonly availableBytes: number; readonly totalBytes: number };
    readonly disk?: { readonly freeBytes: number; readonly totalBytes: number };
  };
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
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
}

async function openWorkerPage(page: Page, daemon: RunningDaemon): Promise<void> {
  await openConsole(page, daemon);
  const view = found((await workerList(daemon))[0], "the host's worker");
  await row(page, view.label ?? view.id)
    .getByRole("link")
    .click();
  await expect(title(page, view.label ?? view.id)).toBeVisible();
}

function row(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("link", { exact: true, name }) });
}

function title(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

function figures(page: Page): Locator {
  return page.getByRole("group", { name: "Load and leases" });
}

function figure(page: Page, label: string): Locator {
  return figures(page)
    .locator(".card")
    .filter({ has: page.getByText(label, { exact: true }) });
}

function fact(scope: Locator, label: string): Locator {
  return scope.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
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

function paintedGauges(scope: Locator): Promise<readonly PaintedGauge[]> {
  return scope.locator(".load-bar").evaluateAll((bars) =>
    bars.map((bar) => {
      const fill = bar.firstElementChild as HTMLElement;
      // why: the fill's own ease means a width read mid-slide sits between two levels, so this asks
      // the browser whether a transition is still running and reports it with the width.
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

const TONES = ["ok", "warn", "error", "idle"] as const;

const TONE_OF: Readonly<Partial<Record<string, (typeof TONES)[number]>>> = {
  compatible: "ok",
  connected: "ok",
  drained: "warn",
  incompatible: "error",
  leased: "ok",
  ready: "ok",
  running: "ok",
};

async function readSquares(page: Page) {
  return page.locator(".status-dot").evaluateAll((elements) => {
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
      neutral: named("--slot-leased"),
      shown: elements.map((element) => ({
        colour: getComputedStyle(element).backgroundColor,
        word:
          element.getAttribute("aria-label") ?? element.parentElement?.textContent?.trim() ?? "",
      })),
      tones: ["--status-ok", "--status-warn", "--status-error", "--status-idle"].map(named),
    };
  });
}

async function expectSquareColours(
  page: Page,
  where: string,
  words: readonly string[],
): Promise<void> {
  await expect(page.locator(".status-dot").first()).toBeVisible();
  const { accent, shown, tones } = await readSquares(page);
  expect(shown.map((square) => square.word)).toEqual(expect.arrayContaining([...words]));
  for (const square of shown) {
    const context = `${square.word} in ${where}`;
    expect(square.word, where).not.toBe("");
    expect(tones, context).toContain(square.colour);
    expect(square.colour, context).not.toBe(accent);
    const tone = TONE_OF[square.word];
    if (tone !== undefined) expect(square.colour, context).toBe(tones[TONES.indexOf(tone)]);
  }
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

function runningOverLimit(view: WorkerView): string {
  const ios = view.capacity?.ios ?? { limit: 0, running: 0 };
  const android = view.capacity?.android ?? { limit: 0, running: 0 };
  return `${ios.running + android.running} / ${ios.limit + android.limit}`;
}

async function incompatibleWorker(gateway: RunningDaemon, id: string): Promise<WorkerView> {
  let view: WorkerView | undefined;
  await waitFor(
    async () => {
      view = (await workerList(gateway)).find((candidate) => candidate.id === id);
      return view?.connection === "incompatible";
    },
    { label: "the gateway lists the old worker as incompatible" },
  );
  return found(view, id);
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

// why: taken from the gateway's own view of the worker and the figures the page was answered with,
// so the page cannot agree with itself.
function expectedRow(view: WorkerView): {
  readonly text: readonly string[];
  readonly slots: string;
  readonly bars: number;
} {
  const name = view.label ?? view.id;
  if (view.connection === "incompatible") {
    return { bars: 0, slots: "No devices", text: [name, "incompatible", "", "—", "—", "—", "—"] };
  }
  const limit = (view.capacity?.ios.limit ?? 0) + (view.capacity?.android.limit ?? 0);
  const leased = view.leases.length;
  const system = view.host === undefined ? "" : `${view.host.os} ${view.host.osVersion}`;
  return {
    bars: 3,
    slots: leased === 0 ? `${limit} free` : `${leased} leased, ${limit - leased} free`,
    text: [
      `${name}${system}`,
      view.drained ? "drained" : "connected",
      "",
      runningOverLimit(view),
      "12%",
      "50%",
      "40%",
    ],
  };
}

test.describe("the workers page", () => {
  test("the Fleet table lists every worker with its name, system, state word, slots group and its label, running of limit, and CPU, memory and disk", async ({
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
      expect((await fleet.gateway.cli(["worker", "drain", found(b, "worker-b").id])).code).toBe(0);
      await lease(fleet.workers[0] as RunningDaemon, "console-e2e");
      await waitFor(
        async () => (await workerList(fleet.gateway)).some((view) => view.leases.length === 1),
        { label: "the gateway's view of worker-a carries its lease" },
      );
      await incompatibleWorker(fleet.gateway, "wrk_old");
      const listed = await workerList(fleet.gateway);

      await answerWithLoad(page, { cpu: 12, disk: 40, memory: 50 });
      await openConsole(page, fleet.gateway);

      await expect(page.getByRole("row")).toHaveCount(listed.length + 1);
      await expect(page.getByText(`${listed.length - 1} / ${listed.length} up`)).toBeVisible();
      for (const view of listed) {
        const name = view.label ?? view.id;
        const want = expectedRow(view);
        const shown = row(page, name);
        await expect(shown.getByRole("cell"), name).toHaveText(want.text);
        await expect(shown.getByRole("cell").nth(2).getByRole("img"), name).toHaveAttribute(
          "aria-label",
          want.slots,
        );
        await expect(shown.locator(".load-bar"), name).toHaveCount(want.bars);
      }
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("clicking a row opens /fleet/<id> with the worker's name as the page heading, its state word and system beside it, and the Devices tab selected", async ({
    daemon,
    page,
  }) => {
    const host = found((await workerList(daemon))[0], "the host's worker");
    const { os, osVersion } = (await status(daemon)).host;

    await answerWithoutLoad(page);
    await openConsole(page, daemon);
    await row(page, host.label ?? host.id)
      .getByRole("cell")
      .nth(3)
      .click();

    await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(host.id)}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: host.label ?? host.id, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".worker-line")).toHaveText(`connected · ${os} ${osVersion}`);
    await expect(page.getByRole("tab", { name: "Devices" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("an incompatible worker says its devices cannot be read, and shows both protocol ranges", async ({
    page,
  }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      const view = await incompatibleWorker(gateway, "wrk_old");
      const gatewayRange = found(view.protocol?.gateway, "the gateway's protocol range");
      expect(view.protocol?.worker).toEqual(OLD_PROTOCOL);

      await openConsole(page, gateway);
      await expect(row(page, "old-worker")).toContainText("incompatible");
      await row(page, "old-worker").getByRole("link").click();

      const expected =
        `incompatible gateway ${gatewayRange.min}–${gatewayRange.max}, ` +
        `worker ${OLD_PROTOCOL.min}–${OLD_PROTOCOL.max}`;
      await expect(page.getByRole("tabpanel")).toHaveText(
        "No devices: the gateway cannot read this worker.",
      );
      await openTab(page, "Host");
      await expect(fact(page.locator("#main"), "Protocol")).toHaveText(expected);
      await expect(fact(page.locator("#main"), "Connection")).toHaveText("incompatible");
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("on a single host Fleet shows one row, the host, and its page works", async ({
    daemon,
    page,
  }) => {
    const host = found((await workerList(daemon))[0], "the host's worker");

    await answerWithoutLoad(page);
    await openConsole(page, daemon);

    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(page).toHaveURL(/\/fleet$/);
    await expect(page.getByText("1 / 1 up")).toBeVisible();
    await row(page, host.id).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(host.id)}$`));
    await expect(title(page, host.id)).toBeVisible();
    await expect(page.locator(".worker-line")).toContainText("connected");
    await expect(page.getByRole("tab", { name: "Devices" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openTab(page, "Host");
    await expect(fact(page.locator("#main"), "Version")).toHaveText(host.version ?? "");
  });

  test("an unknown worker id shows This worker is not in the fleet. and a link to Fleet, and an unknown device id shows This device is gone.", async ({
    daemon,
    page,
  }) => {
    const host = found((await workerList(daemon))[0], "the host's worker");
    await openConsole(page, daemon);

    await page.goto(new URL("/fleet/wrk_nope", daemon.url).href);

    await expect(page.getByText("This worker is not in the fleet.")).toBeVisible();
    await page.getByRole("link", { name: "Back to Fleet" }).click();
    await expect(page).toHaveURL(/\/fleet$/);
    await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();

    await page.goto(
      new URL(`/fleet/${encodeURIComponent(host.id)}/dev_nope?tab=devices`, daemon.url).href,
    );

    await expect(page.getByRole("dialog").getByText("This device is gone.")).toBeVisible();
  });

  test("the Issues and Busy filters keep the workers they name", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
      { driverScript: { ios: IOS }, label: "worker-c" },
    ]);
    try {
      const b = (await workerList(fleet.gateway)).find((view) => view.label === "worker-b");
      const drained = found(b, "worker-b").id;
      expect((await fleet.gateway.cli(["worker", "drain", drained])).code).toBe(0);
      await (fleet.workers[2] as RunningDaemon).stop();
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-c")?.connection === "disconnected",
      );
      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);
      await expect(row(page, "worker-a")).toBeVisible();

      await page.getByLabel("Issues").check();
      await expect(page).toHaveURL(/\/fleet\?filter=issues$/);
      await expect(row(page, "worker-b")).toBeVisible();
      await expect(row(page, "worker-c")).toBeVisible();
      await expect(row(page, "worker-a")).toHaveCount(0);

      await page.getByLabel("Busy").check();
      await expect(page.getByText("No worker matches.")).toBeVisible();

      await page.getByLabel("All", { exact: true }).check();
      await expect(row(page, "worker-a")).toBeVisible();
      await expect(row(page, "worker-b")).toBeVisible();
      await expect(row(page, "worker-c")).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the search box filters by any part of the worker's name, id or system, ignoring case, keeps ?q=, and clearing it brings every row back", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const [a, b] = await workerList(fleet.gateway);
      const first = found(a?.label === "worker-a" ? a : b, "worker-a");
      const second = found(a?.label === "worker-b" ? a : b, "worker-b");
      const system = found(first.host, "worker-a's host");
      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);
      const search = page.getByRole("searchbox", { name: "Search workers" });
      await expect(search).toBeVisible();

      await search.fill("WORKER-A");
      await expect(row(page, "worker-a")).toBeVisible();
      await expect(row(page, "worker-b")).toHaveCount(0);
      await expect(page).toHaveURL(/\/fleet\?q=WORKER-A$/);

      await search.fill(second.id.slice(2, 9).toUpperCase());
      await expect(row(page, "worker-b")).toBeVisible();
      await expect(row(page, "worker-a")).toHaveCount(0);

      await search.fill(`${system.os} ${system.osVersion}`.slice(1, 7).toUpperCase());
      await expect(row(page, "worker-a")).toBeVisible();
      await expect(row(page, "worker-b")).toBeVisible();

      await search.fill("no such worker");
      await expect(page.getByText("No worker matches.")).toBeVisible();
      await page.reload();
      await expect(search).toHaveValue("no such worker");
      await expect(page.getByText("No worker matches.")).toBeVisible();

      await search.fill("");
      await expect(row(page, "worker-a")).toBeVisible();
      await expect(row(page, "worker-b")).toBeVisible();
      await expect(page).toHaveURL(/\/fleet$/);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a disconnected worker's page shows the banner Disconnected · last seen … ago, and a drained worker's shows Drained", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
      { driverScript: { ios: IOS }, label: "worker-c" },
    ]);
    try {
      const views = await workerList(fleet.gateway);
      const idOf = (label: string) =>
        found(
          views.find((view) => view.label === label),
          label,
        ).id;
      expect((await fleet.gateway.cli(["worker", "drain", idOf("worker-b")])).code).toBe(0);
      await (fleet.workers[2] as RunningDaemon).stop();
      await untilTheGatewaySays(
        fleet.gateway,
        (listed) => listed.find((view) => view.label === "worker-c")?.connection === "disconnected",
      );
      const lost = found(
        (await workerList(fleet.gateway)).find((view) => view.label === "worker-c"),
        "worker-c",
      );
      const banner = (text: RegExp) => page.locator("#main").getByText(text);

      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);
      await page.goto(new URL(`/fleet/${encodeURIComponent(lost.id)}`, fleet.gateway.url).href);
      await expect(banner(/^Disconnected · last seen \d+ (s|min)/)).toBeVisible();
      const shown = await banner(/^Disconnected/).textContent();
      expect(shown).toMatch(/ ago$/);
      const seconds = Number.parseInt(/last seen (\d+) s/.exec(shown ?? "")?.[1] ?? "", 10);
      expect(Math.abs(seconds - (Date.now() - lost.lastSeenAt) / 1000)).toBeLessThanOrEqual(5);
      await expect(banner(/^Drained$/)).toHaveCount(0);

      await page.goto(
        new URL(`/fleet/${encodeURIComponent(idOf("worker-b"))}`, fleet.gateway.url).href,
      );
      await expect(banner(/^Drained$/)).toBeVisible();
      await expect(banner(/^Disconnected/)).toHaveCount(0);

      await page.goto(
        new URL(`/fleet/${encodeURIComponent(idOf("worker-a"))}`, fleet.gateway.url).href,
      );
      await expect(title(page, "worker-a")).toBeVisible();
      await expect(banner(/^Drained$|^Disconnected/)).toHaveCount(0);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a worker's devices list every device it has, with state and, where the data has one, time in that state", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-1");
      await lease(host, "console-e2e-2");
      expect((await host.cli(["release", "--all", "--yes"])).code).toBe(0);
      await lease(host, "console-e2e-3");
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
      await page.clock.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);

      await openConsole(page, host);
      await row(page, view?.id ?? "")
        .getByRole("link")
        .click();

      const table = page.getByRole("region", { name: "Devices", exact: true });
      await expect(table.locator("tbody tr")).toHaveCount(devices.length);
      for (const device of devices) {
        const shown = table.getByRole("row").filter({ hasText: device.id });
        const cells = shown.getByRole("cell");
        await expect(shown.getByRole("img", { name: device.state })).toBeVisible();
        await expect(cells.nth(0)).toContainText(device.spec.model);
        await expect(cells.nth(0)).toContainText(device.spec.osVersion);
        await expect(cells.nth(0)).toContainText(
          device.spec.platform === "ios" ? "iOS" : "Android",
        );
        await expect(cells.nth(3)).toContainText(device.physical ? "Physical" : "Virtual");
        const held = view?.leases.find((candidate) => candidate.deviceId === device.id);
        if (held === undefined) {
          await expect(cells.nth(1), device.id).toHaveText(device.state);
          await expect(cells.nth(2), device.id).toHaveText("—");
          continue;
        }
        await expect(cells.nth(1).getByRole("link")).toHaveAttribute(
          "href",
          new RegExp(`/leases/${encodeURIComponent(held.id)}/?$`),
        );
        await expect(cells.nth(2), device.id).toHaveText(/^\d+ s.*expires in /);
        const shownSeconds = Number.parseInt((await cells.nth(2).textContent()) ?? "", 10);
        expect(Math.abs(shownSeconds - (Date.now() - held.grantedAt) / 1000)).toBeLessThanOrEqual(
          3,
        );
        await expect(cells.nth(2)).not.toContainText(`${shownSeconds} s expires`);
      }
    } finally {
      await host.dispose();
    }
  });

  test("a Devices row opens the drawer at /fleet/<id>/<deviceId> with the device's model, runtime, state word, and holder and lease when leased; a leased device shows its UDID and an unleased simulator shows no UDID field", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-1");
      await lease(host, "console-e2e-2");
      expect((await host.cli(["release", "--all", "--yes"])).code).toBe(0);
      await lease(host, "console-e2e-3");
      await waitFor(
        async () =>
          (await status(host)).devices.every(
            (device) => device.state === "ready" || device.state === "leased",
          ),
        { label: "every device ready or leased" },
      );
      const { devices } = await status(host);
      const [view] = await workerList(host);
      const workerId = found(view, "the host's worker").id;
      const leased = found(
        devices.find((device) => device.state === "leased"),
        "a leased device",
      );
      const idle = found(
        devices.find((device) => device.state === "ready"),
        "a ready device",
      );
      const held = found(
        view?.leases.find((candidate) => candidate.deviceId === leased.id),
        "the lease on the leased device",
      );
      const asked = await fetch(new URL(`/v1/leases/${encodeURIComponent(held.id)}`, host.url), {
        headers: { Authorization: `Bearer ${host.tokens.operator}` },
      });
      const udid = ((await asked.json()) as { lease: { udid: string } }).lease.udid;
      expect(udid).not.toBe("");

      await openWorkerPage(page, host);
      const devicesTable = page.getByRole("region", { name: "Devices", exact: true });
      const drawer = page.getByRole("dialog");

      await devicesTable
        .getByRole("row")
        .filter({ hasText: idle.id })
        .getByRole("cell")
        .nth(3)
        .click();
      await expect(page).toHaveURL(
        new RegExp(
          `/fleet/${encodeURIComponent(workerId)}/${encodeURIComponent(idle.id)}\\?tab=devices$`,
        ),
      );
      await expect(fact(drawer, "Model")).toHaveText(idle.spec.model);
      await expect(fact(drawer, "Runtime")).toHaveText(idle.spec.osVersion);
      await expect(fact(drawer, "State")).toHaveText("ready");
      await expect(drawer.getByText("Holder")).toHaveCount(0);
      await expect(drawer.getByText("UDID")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();

      await devicesTable
        .getByRole("row")
        .filter({ hasText: leased.id })
        .getByRole("cell")
        .nth(3)
        .click();
      await expect(fact(drawer, "Model")).toHaveText(leased.spec.model);
      await expect(fact(drawer, "State")).toHaveText("leased");
      await expect(fact(drawer, "Holder")).toHaveText(held.requesterId);
      await expect(fact(drawer, "Lease").getByRole("link")).toHaveAttribute(
        "href",
        new RegExp(`/leases/${encodeURIComponent(held.id)}/?$`),
      );
      await expect(fact(drawer, "UDID")).toHaveText(udid);
    } finally {
      await host.dispose();
    }
  });

  test("closing the device drawer returns to /fleet/<id>?tab=devices with focus on the row", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e");
      const [view] = await workerList(host);
      const workerId = found(view, "the host's worker").id;
      const device = found((await status(host)).devices[0], "the host's device");

      await openWorkerPage(page, host);
      await openTab(page, "Devices");
      const link = page
        .getByRole("region", { name: "Devices", exact: true })
        .getByRole("row")
        .filter({ hasText: device.id })
        .getByRole("link", { name: device.spec.model });
      const drawer = page.getByRole("dialog");

      for (const close of [
        () => page.getByRole("button", { name: "Close" }).click(),
        () => page.keyboard.press("Escape"),
      ]) {
        await link.click();
        await expect(drawer).toBeVisible();
        await close();
        await expect(drawer).toBeHidden();
        await expect(page).toHaveURL(
          new RegExp(`/fleet/${encodeURIComponent(workerId)}\\?tab=devices$`),
        );
        await expect(link).toBeFocused();
      }
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway the Events tab lists only that worker's events, on a single host all of them, and with none it says No events for this worker in the last hour.", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const views = await workerList(fleet.gateway);
      const idOf = (label: string) =>
        found(
          views.find((view) => view.label === label),
          label,
        ).id;
      await lease(fleet.gateway, "console-e2e");
      expect((await fleet.gateway.cli(["worker", "drain", idOf("worker-b")])).code).toBe(0);
      await lease(host, "console-e2e-host");
      const eventsOf = async (daemon: RunningDaemon, id: string) => {
        await page.goto(new URL(`/fleet/${encodeURIComponent(id)}?tab=events`, daemon.url).href);
        return page.getByRole("list", { name: "Events for this worker" });
      };

      await page.goto(fleet.gateway.url);
      await signIn(page, fleet.gateway.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      const forA = await eventsOf(fleet.gateway, idOf("worker-a"));
      await expect(forA.getByText("lease.granted").first()).toBeVisible();
      await expect(forA.getByText("worker.drain-started")).toHaveCount(0);
      const forB = await eventsOf(fleet.gateway, idOf("worker-b"));
      await expect(forB.getByText("worker.drain-started").first()).toBeVisible();
      await expect(forB.getByText("lease.granted")).toHaveCount(0);

      const replay = (url: URL) => url.pathname === "/v1/events";
      await page.route(replay, async (route) => {
        await route.fulfill({ json: { events: [] } });
      });
      await eventsOf(fleet.gateway, idOf("worker-a"));
      await expect(page.getByText("No events for this worker in the last hour.")).toBeVisible();
      await page.unroute(replay);

      const [only] = await workerList(host);
      await page.goto(host.url);
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      const forHost = await eventsOf(host, found(only, "the host's worker").id);
      await expect(forHost.getByText("lease.granted").first()).toBeVisible();
    } finally {
      await host.dispose();
      await disposeFleet(fleet);
    }
  });

  test("each tab shows its content, sets ?tab=, and survives a reload", async ({ page }) => {
    const host = await startDaemon("worker", {
      driverScript: {
        ios: {
          availableOsVersions: ["18.4", "26.0"],
          knownModels: ["iPhone 16", "iPad Air"],
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
      const [listed] = await workerList(host);
      const id = found(listed, "the host's worker").id;

      await openConsole(page, host);
      await row(page, id).getByRole("link").click();

      await openTab(page, "Host");
      const main = page.locator("#main");
      await expect(fact(main, "Operating system")).toHaveText(`${facts.os} ${facts.osVersion}`);
      await expect(fact(main, "CPU architecture")).toHaveText(facts.arch);
      await expect(fact(main, "Tools")).toHaveText("xcode 16.4 (16F6) for iOS");
      await expect(fact(main, "Worker id")).toHaveText(id);
      await expect(fact(main, "iOS")).toContainText("Models: iPhone 16, iPad Air");
      await expect(fact(main, "iOS")).toContainText(/Runtimes: 18\.4.*, 26\.0/);
      await expect(fact(main, "agent-device")).toContainText(/available|off|unavailable/);

      await expect(page).toHaveURL(/\?tab=host$/);

      await openTab(page, "Warm pool");
      await expect(page).toHaveURL(/\?tab=warm-pool$/);
      const installs = page.getByRole("region", { name: "Installs in progress", exact: true });
      await expect(installs).toContainText(/iOS 19\.0\s*downloading for \d+ s, 1 waiter/);

      await openTab(page, "Devices");
      await expect(page).toHaveURL(/\?tab=devices$/);
      await expect(page.getByRole("region", { name: "Devices", exact: true })).toBeVisible();

      await openTab(page, "Events");
      await expect(page).toHaveURL(/\?tab=events$/);
      await expect(
        page
          .getByRole("list", { name: "Events for this worker" })
          .or(page.getByText("No events for this worker in the last hour.")),
      ).toBeVisible();

      for (const tab of ["Events", "Host", "Warm pool", "Devices"]) {
        await openTab(page, tab);
        await page.reload();
        await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      }
      await page.goto(new URL(`/fleet/${encodeURIComponent(id)}?tab=host`, host.url).href);
      await expect(fact(main, "Worker id")).toHaveText(id);
    } finally {
      await host.dispose();
    }
  });

  test("a granted lease shows on the worker's page and on its Fleet row within a second, without a reload", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      const running = () => row(page, "worker-a").getByRole("cell").nth(3);
      await openConsole(page, fleet.gateway);
      await expect(running()).toHaveText(/^0 \/ \d+$/);
      await row(page, "worker-a").getByRole("link").click();
      await expect(figure(page, "Leases").locator(".figure-count")).toHaveText("0");

      await lease(fleet.gateway, "console-e2e");
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-a")?.leases.length === 1,
      );

      await expect(figure(page, "Leases").locator(".figure-count")).toHaveText("1", {
        timeout: 1_000,
      });
      await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
      await expect(running()).toHaveText(/^1 \/ \d+$/, { timeout: 1_000 });
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the worker page shows load meters with the reading's age ticking, capacity cards with the slot legend, and the leases card, all above the tabs", async ({
    daemon,
    page,
  }) => {
    await openWorkerPage(page, daemon);

    await expect(figure(page, "CPU")).toContainText(/\d+% busy, /, { timeout: 20_000 });
    await expect(figure(page, "Memory")).toContainText("available");
    await expect(figure(page, "Disk")).toContainText("free");
    await expect(figure(page, "Leases")).toContainText("0");
    const capacity = page.getByRole("group", { name: "Capacity" });
    await expect(capacity.locator(".card").filter({ hasText: "iOS" })).toContainText("running");
    await expect(page.locator(".slot-legend")).toContainText("leased");
    const tabs = await page.getByRole("tablist").boundingBox();
    for (const above of [figures(page), capacity, page.locator(".slot-legend")]) {
      const box = await above.boundingBox();
      expect(box?.y, "a card sits above the tab list").toBeLessThan(tabs?.y ?? 0);
    }
    const read = page.getByText(/^Read \d+ s ago$/);
    await expect(read).toBeVisible();
    const first = await read.textContent();
    await expect(read).not.toHaveText(first ?? "", { timeout: 10_000 });
  });

  test("a bar sits under each figure, filled to that figure's own percent", async ({
    daemon,
    page,
  }) => {
    await openWorkerPage(page, daemon);
    await expect(figure(page, "CPU")).toContainText("busy", { timeout: 20_000 });

    // why: both the worker's reading (every 15 s) and the fill's own slide can move between two
    // measurements, so this measures around both and retries until the fill has settled at the
    // level the reading implies — otherwise the bar and the figure compared are not the same pair.
    await waitFor(
      async () => {
        const before = (await workerList(daemon))[0]?.load;
        const wanted = before === undefined ? undefined : gaugePercents(before);
        if (wanted === undefined) return false;
        const painted = await paintedGauges(figures(page));
        const now = (await workerList(daemon))[0]?.load;
        // why: what has to hold still is the level, not the reading — a fresh sample that rounds to
        // the same percents is the same pair of figures and bars.
        const since = now === undefined ? undefined : gaugePercents(now);
        if (since === undefined || JSON.stringify(wanted) !== JSON.stringify(since)) return false;
        if (painted.some((bar) => bar.sliding)) return false;
        return fillsMatch(painted, wanted);
      },
      { interval: 500, timeout: 40_000, label: () => "the fill to match the figure" },
    );

    const card = figure(page, "Memory");
    const geometry = await card.evaluate((element) => {
      const text = element.querySelector(".figure-text") as HTMLElement;
      const bar = element.querySelector(".load-bar") as HTMLElement;
      return {
        textBottom: text.getBoundingClientRect().bottom,
        top: bar.getBoundingClientRect().top,
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.textBottom);
  });

  test("each memory pressure paints its bar in that pressure's colour, and never the accent, in both themes", async ({
    daemon,
    page,
  }) => {
    await openWorkerPage(page, daemon);
    await expect(figure(page, "Memory")).toContainText("available");
    // why: only macOS reports a memory pressure, and how full a CI machine's memory happens to be
    // is nobody's to predict. This answers the page's own read of the worker list with the memory
    // reading's own fields set to the level the case asks for and every other field left as the
    // daemon sent it, so what is painted is the real component's doing and the same colour is
    // expected on any machine.
    let claim: MemoryClaim = { usedPercent: 50 };
    await answerMemory(page, () => claim);

    const memoryFill = () =>
      figure(page, "Memory").evaluate((card) => {
        const bar = card.querySelector(".load-bar") as HTMLElement;
        return {
          tone: /load-bar-(\w+)/.exec(bar.className)?.[1] ?? "",
          colour: getComputedStyle(bar.firstElementChild as HTMLElement).backgroundColor,
        };
      });
    const paintedFills = () =>
      figures(page)
        .locator(".load-bar")
        .evaluateAll((bars) =>
          bars.map((bar) => ({
            tone: /load-bar-(\w+)/.exec(bar.className)?.[1] ?? "",
            colour: getComputedStyle(bar.firstElementChild as HTMLElement).backgroundColor,
          })),
        );

    // why: these six are the whole colour rule for a memory bar — the worker's three words, that
    // the word outranks the console's threshold, and the threshold on its own at either end. Each is
    // seen in each theme by the real component, so a tone rule deleted, swapped, or given the accent
    // fails a named assertion here. A figure under its threshold is the neutral tone.
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const { accent, neutral, tones } = await readSquares(page);

      for (const [level, usedPercent, tone] of [
        ["normal", 50, "ok"],
        ["warn", 50, "warn"],
        ["critical", 50, "error"],
        ["normal", 97, "ok"],
        [undefined, 97, "error"],
        [undefined, 50, "neutral"],
      ] as const) {
        claim = { usedPercent, ...(level === undefined ? {} : { pressure: level }) };
        const want = tone === "neutral" ? neutral : tones[TONES.indexOf(tone)];
        const at = `${usedPercent}%${level === undefined ? " with no word" : ` and ${level}`}`;
        await expect
          .poll(() => memoryFill(), {
            timeout: 5_000,
            message: `${at} to paint the ${tone} bar in ${colorScheme}`,
          })
          .toEqual({ tone, colour: want });
        expect(want, `the ${tone} bar in ${colorScheme}`).not.toBe(accent);

        // why: the poll above watches the memory bar; this watches the rest of the figures, for
        // the one thing a poll of a single bar cannot see.
        const fills = await paintedFills();
        expect(fills.length).toBeGreaterThan(1);
        for (const fill of fills) {
          expect(fill.tone, "a bar carries a tone class").not.toBe("");
          expect(fill.colour, `the ${fill.tone} bar`).not.toBe(accent);
        }
      }
    }
  });

  test("a bar's fill transitions its width over the document's duration token, and over none under reduced motion", async ({
    browserName,
    daemon,
    page,
  }) => {
    await openWorkerPage(page, daemon);

    const fill = figures(page).locator(".load-bar-fill").first();
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

  test("a disconnected worker's state word and load say so within a second", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      await openConsole(page, fleet.gateway);
      await row(page, "worker-b").getByRole("link").click();
      // why: the gateway shows a worker's first reading after its refresh, so allow twice the default 5 s wait.
      await expect(figure(page, "CPU")).toBeVisible({ timeout: 10_000 });

      await (fleet.workers[1] as RunningDaemon).stop();
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-b")?.connection === "disconnected",
      );

      await expect(page.locator(".worker-line")).toContainText("disconnected", { timeout: 1_000 });
      await expect(page.getByText("No reading while disconnected")).toBeVisible({ timeout: 1_000 });

      await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
      await expect(row(page, "worker-b").getByRole("cell").nth(1)).toHaveText("disconnected");
      await expect(row(page, "worker-a").getByRole("cell").nth(1)).not.toHaveText("disconnected");
      await expect(page.getByText("1 / 2 up")).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("starting the daemon again refreshes the data the page shows", async ({ page }) => {
    const host = await startDaemon("worker", {
      driverScript: { ios: { ...IOS, toolVersions: [{ name: "xcode", version: "16.4" }] } },
    });
    try {
      const [view] = await workerList(host);
      await openConsole(page, host);
      await row(page, view?.id ?? "")
        .getByRole("link")
        .click();
      await openTab(page, "Host");
      const banner = page.locator(".connection");
      const tools = fact(page.locator("#main"), "Tools");
      await expect(tools).toHaveText("xcode 16.4 for iOS");

      await host.stop();
      await expect(banner).toHaveText(/^Reconnecting/);
      await expect(tools).toHaveText("xcode 16.4 for iOS");
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

  test("every status square shows its word with a status colour, and none uses the accent colour", async ({
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
      const drained = found(b, "worker-b").id;
      expect((await fleet.gateway.cli(["worker", "drain", drained])).code).toBe(0);
      await lease(fleet.workers[0] as RunningDaemon, "console-e2e");
      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);
      await expect(row(page, "old-worker")).toContainText("incompatible");
      await expect(row(page, "worker-b")).toContainText("drained");

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page
          .getByRole("navigation", { name: "Console" })
          .getByRole("link", { name: "Fleet" })
          .click();
        await expectSquareColours(page, `list ${colorScheme}`, [
          "connected",
          "drained",
          "incompatible",
        ]);
        await row(page, "worker-a").getByRole("link").click();
        await openTab(page, "Host");
        await expectSquareColours(page, `host ${colorScheme}`, [
          "connected",
          "running",
          "compatible",
        ]);
        await openTab(page, "Devices");
        await expectSquareColours(page, `devices ${colorScheme}`, ["connected", "leased"]);
      }
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("the fleet pages have no horizontal scroll at 360px wide, in the table and on a worker's page", async ({
    page,
  }) => {
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
      await page.goto(new URL("/fleet", host.url).href);
      await signIn(page, host.tokens.operator);
      const [view] = await workerList(host);
      await expect(row(page, view?.id ?? "")).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);

      await row(page, view?.id ?? "")
        .getByRole("link")
        .click();
      await expect(page.locator("tbody tr").first()).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
      for (const tab of ["Host", "Warm pool", "Events"]) {
        await openTab(page, tab);
        expect(await hasHorizontalScroll(page), tab).toBe(false);
      }
    } finally {
      await host.dispose();
    }
  });

  test("the workers page is usable with the keyboard alone", async ({
    browserName,
    daemon,
    page,
  }) => {
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const name = found((await workerList(daemon))[0], "the host's worker").id;
    // why: Firefox does not wrap focus from the page's last control to its first, so a link that
    // comes before the focused control is reached going backward.
    const follow = async (link: Locator, direction: "forward" | "backward" = "forward") => {
      const key = direction === "forward" ? tab : `Shift+${tab}`;
      for (let step = 0; step < 30; step += 1) {
        if (await link.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press(key);
      }
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
    };
    await page.goto("/");
    await page.keyboard.press(tab);
    await page.keyboard.type(daemon.tokens.operator);
    await page.keyboard.press("Enter");
    await follow(page.getByRole("link", { name: "Fleet", exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();

    await follow(row(page, name).getByRole("link"));
    await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(name)}$`));
    await expect(title(page, name)).toBeVisible();

    const host_tab = page.getByRole("tab", { name: "Host" });
    for (let step = 0; step < 30; step += 1) {
      if (await host_tab.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press(tab);
    }
    await expect(host_tab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(host_tab).toHaveAttribute("aria-selected", "true");

    await follow(
      page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Fleet" }),
      "backward",
    );
    await expect(page).toHaveURL(/\/fleet$/);
  });
});
