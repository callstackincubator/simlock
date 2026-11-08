import type { Locator, Page, Response } from "@playwright/test";

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
  signInWithKeyboard,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";
import { returnToTab } from "./tab.js";
import { answer } from "./stub-answers.js";
import { fetchFull } from "./full-fetch.js";

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
  off: "idle",
  ready: "ok",
  running: "ok",
};

async function readStatusIndicators(page: Page) {
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
        ariaHidden: element.getAttribute("aria-hidden"),
        ariaLabel: element.getAttribute("aria-label"),
        colour: getComputedStyle(element).backgroundColor,
        kind:
          element.closest(".status") && !element.closest(".sidebar-account")
            ? ("pill" as const)
            : ("standalone" as const),
        role: element.getAttribute("role"),
        title: element.getAttribute("title"),
        word:
          element.getAttribute("aria-label") ?? element.parentElement?.textContent?.trim() ?? "",
      })),
      tones: ["--status-ok", "--status-warn", "--status-error", "--status-idle"].map(named),
    };
  });
}

async function expectStatusIndicatorColours(
  page: Page,
  where: string,
  words: readonly (readonly [string, "pill" | "standalone"])[],
  theme: "light" | "dark",
): Promise<void> {
  await expect(page.locator(".status-dot").first()).toBeVisible();
  const { accent, shown } = await readStatusIndicators(page);
  const colours = {
    light: {
      pill: ["rgb(20, 111, 53)", "rgb(146, 87, 10)", "rgb(185, 28, 28)", "rgb(85, 85, 95)"],
      standalone: ["rgb(21, 128, 61)", "rgb(146, 87, 10)", "rgb(185, 28, 28)", "rgb(87, 83, 78)"],
    },
    dark: {
      pill: ["rgb(134, 239, 172)", "rgb(253, 224, 71)", "rgb(252, 165, 165)", "rgb(185, 185, 194)"],
      standalone: [
        "rgb(74, 222, 128)",
        "rgb(250, 204, 21)",
        "rgb(248, 113, 113)",
        "rgb(168, 162, 158)",
      ],
    },
  } as const;
  for (const [word, kind] of words) {
    expect(shown, where).toEqual(expect.arrayContaining([expect.objectContaining({ word, kind })]));
  }
  for (const indicator of shown) {
    const context = `${indicator.word} ${indicator.kind} in ${where}`;
    expect(indicator.word, where).not.toBe("");
    if (indicator.ariaLabel !== null) {
      expect(indicator.role, context).toBe("img");
      expect(indicator.title, context).toBe(indicator.word);
    } else {
      expect(indicator.ariaHidden, context).toBe("true");
    }
    const palette = colours[theme][indicator.kind];
    expect(indicator.colour, context).not.toBe(accent);
    expect(palette, context).toContain(indicator.colour);
    const tone = TONE_OF[indicator.word.toLowerCase()];
    expect(tone, context).toBeDefined();
    expect(indicator.colour, context).toBe(palette[TONES.indexOf(tone!)]);
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
  const system = [
    view.host === undefined ? "" : `${view.host.os} ${view.host.osVersion}`,
    view.version === undefined ? "" : `simlock ${view.version}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  if (view.connection === "incompatible") {
    return {
      bars: 0,
      slots: "No devices",
      text: [`${name}${system}`, "incompatible", "", "—", "—", "—", "—", ""],
    };
  }
  const limit = (view.capacity?.ios.limit ?? 0) + (view.capacity?.android.limit ?? 0);
  const leased = view.leases.length;
  return {
    bars: 3,
    slots: leased === 0 ? `${limit} free` : `${leased} leased, ${limit - leased} free`,
    text: [
      `${name}${system}`,
      view.drained ? "drained" : "connected",
      limit > 10 ? `${leased} / ${limit}` : "",
      runningOverLimit(view),
      "12%",
      "50%",
      "40%",
      "",
    ],
  };
}

test.describe("the workers page", () => {
  test("an operator reads slots and sees accessible state counts, squares through ten and a meter with a printed fraction above ten", async ({
    daemon,
    page,
  }) => {
    const cases = [
      { name: "zero", limit: 0, states: [], label: "No devices", fraction: "" },
      {
        name: "ten",
        limit: 10,
        states: ["leased", "leased", "absent", "quarantined"],
        label: "2 leased, 1 absent, 1 quarantined, 6 free",
        fraction: "",
      },
      {
        name: "twenty",
        limit: 20,
        states: ["leased", "leased", "absent", "quarantined"],
        label: "2 leased, 1 absent, 1 quarantined, 16 free",
        fraction: "2 / 20",
      },
    ] as const;
    const platform = (limit: number) => ({
      atRamBudget: false,
      limit,
      maxRunning: limit,
      overLimit: false,
      reserved: 0,
      running: 0,
      used: 0,
      warm: 0,
    });
    await answer(page, "/v1/workers", () => ({
      workers: cases.map(({ limit, name, states }) => ({
        id: `wrk_${name}`,
        label: name,
        connection: "connected",
        drained: false,
        lastSeenAt: Date.now(),
        capacity: {
          android: platform(0),
          global: { maxRunning: limit, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: platform(limit),
        },
        devices: states.map((state, index) => ({
          id: `dev_${name}_${index}`,
          physical: false,
          servesDefaultMode: true,
          spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
          state,
        })),
      })),
    }));
    await openConsole(page, daemon);
    for (const { name, limit, label, fraction } of cases) {
      const shown = row(page, name);
      const slots = shown.getByRole("img", { name: label, exact: true });
      await expect(slots, name).toHaveCount(1);
      if (limit > 0) await expect(slots, name).toBeVisible();
      await expect(slots.locator(".slot"), name).toHaveCount(limit <= 10 ? limit : 0);
      await expect(slots.locator(".load-bar"), name).toHaveCount(limit > 10 ? 1 : 0);
      await expect(slots, name).toHaveText(fraction);
      if (name === "ten") {
        await expect(slots).toHaveCSS("gap", "3px");
        await expect(slots.locator(".slot").first()).toHaveCSS("height", "12px");
        await expect(slots.locator('[title="iPhone 16 18.4, absent"]')).toHaveCount(1);
        await expect(slots.locator('[title="iPhone 16 18.4, quarantined"]')).toHaveCount(1);
      }
      if (name === "twenty") {
        await expect(slots.locator(".load-bar")).toHaveCSS("--load-bar", "10%");
        await expect(slots.locator(".load-bar")).toHaveCSS("height", "4px");
      }
      for (const index of [4, 5, 6]) {
        await expect(shown.getByRole("cell").nth(index), name).toHaveText("—");
      }
    }
  });

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
        await expect(shown.locator(".worker-meter .load-bar"), name).toHaveCount(want.bars);
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
    for (const index of [4, 5, 6]) {
      await expect(
        row(page, host.label ?? host.id)
          .getByRole("cell")
          .nth(index),
      ).toHaveText("—");
    }
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
          (await status(host)).devices.every((device) =>
            ["deleted", "leased", "ready"].includes(device.state),
          ),
        { label: "every device ready, leased or deleted" },
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
          (await status(host)).devices.every((device) =>
            ["deleted", "leased", "ready"].includes(device.state),
          ),
        { label: "every device ready, leased or deleted" },
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

  test("on a gateway the Events tab lists only that worker's events, on a single host all of them, and scrolls back through that worker's history, shows its new events at the top, and with none says No events for this worker yet.", async ({
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

      const idA = idOf("worker-a");
      const feed = page.getByRole("region", { name: "Event feed for this worker" });
      const asked: string[] = [];
      const answered: { readonly payload?: { readonly workerId?: string } }[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/v1/events") asked.push(url.search);
      });
      const reads: Promise<void>[] = [];
      const readEvents = (response: Response) => {
        if (new URL(response.url()).pathname !== "/v1/events") return;
        reads.push(
          response.json().then((body: { events?: (typeof answered)[number][] }) => {
            answered.push(...(body.events ?? []));
          }),
        );
      };
      page.on("response", readEvents);
      // why: a page of older events holds 100, so more than 100 of worker A's own are needed.
      for (let round = 0; round < 25; round += 1) {
        const granted = await fleet.gateway.cli([
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 16",
          "--os",
          "18.4",
          "--detach",
          "--agent-id",
          `history-${round}`,
        ]);
        expect(granted.code, granted.stderr).toBe(0);
        const released = await fleet.gateway.cli([
          "release",
          (JSON.parse(granted.stdout) as { lease: { id: string } }).lease.id,
        ]);
        expect(released.code, released.stderr).toBe(0);
      }
      // why: taller than the feed's own height cap, so only a feed that fills the page reaches the bottom.
      await page.setViewportSize({ height: 1_800, width: 1_280 });
      await eventsOf(fleet.gateway, idA);
      await expect(feed).toBeVisible();
      const box = await feed.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(1_800 - 120);
      await expect(page.getByText("Start of the history (", { exact: false })).toHaveCount(0);
      await expect
        .poll(async () => {
          await feed.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
          return page.getByText("Start of the history (", { exact: false }).count();
        })
        .toBe(1);
      expect(asked.some((query) => query.includes("before="))).toBe(true);
      expect(asked.filter((query) => !query.includes(`worker=${encodeURIComponent(idA)}`))).toEqual(
        [],
      );
      // why: a body still unread when host.dispose() closes the page would reject the test.
      page.off("response", readEvents);
      await Promise.all(reads);
      expect(answered.length).toBeGreaterThan(100);
      expect(answered.filter((event) => event.payload?.workerId !== idA)).toEqual([]);

      await feed.evaluate((element) => element.scrollTo({ top: 0 }));
      const newest = await feed.getByRole("listitem").first().innerText();
      expect((await fleet.gateway.cli(["worker", "undrain", idOf("worker-b")])).code).toBe(0);
      await lease(fleet.gateway, "console-e2e-other", "iPhone 17");
      await lease(fleet.gateway, "console-e2e-new");
      await expect.poll(() => feed.getByRole("listitem").first().innerText()).not.toBe(newest);
      await expect(feed.getByText("console-e2e-new").first()).toBeVisible();
      await expect(feed.getByText("console-e2e-other")).toHaveCount(0);

      const replay = (url: URL) => url.pathname === "/v1/events";
      await page.route(replay, async (route) => {
        await route.fulfill({ json: { events: [] } });
      });
      await eventsOf(fleet.gateway, idOf("worker-a"));
      await expect(page.getByText("No events for this worker yet.")).toBeVisible();
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
          .or(page.getByText("No events for this worker yet.")),
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

  test("a granted lease eventually appears on the worker's page and Fleet row without a reload", async ({
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
        timeout: 10_000,
      });
      await page.goBack();
      await expect(running()).toHaveText(/^1 \/ \d+$/, { timeout: 10_000 });
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
      const { accent, neutral, tones } = await readStatusIndicators(page);

      for (const [level, usedPercent, tone] of [
        ["normal", 50, "ok"],
        ["warn", 50, "warn"],
        ["critical", 50, "error"],
        ["normal", 97, "ok"],
        [undefined, 97, "error"],
        [undefined, 50, "neutral"],
      ] as const) {
        claim = { usedPercent, ...(level === undefined ? {} : { pressure: level }) };
        await returnToTab(page);
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

  test("a disconnected worker's state word and load eventually say so", async ({ page }) => {
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

      await expect(page.locator(".worker-line")).toContainText("disconnected", { timeout: 10_000 });
      await expect(page.getByText("No reading while disconnected")).toBeVisible({
        timeout: 10_000,
      });

      await page.goBack();
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

  test("every status indicator shows its word with its context's status colour, and none uses the accent colour", async ({
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
        await expectStatusIndicatorColours(
          page,
          `list ${colorScheme}`,
          [
            ["connected", "pill"],
            ["drained", "pill"],
            ["incompatible", "pill"],
          ],
          colorScheme,
        );
        await row(page, "worker-a").getByRole("link").click();
        await openTab(page, "Host");
        await expectStatusIndicatorColours(
          page,
          `host ${colorScheme}`,
          [
            ["connected", "pill"],
            ["running", "pill"],
            ["compatible", "pill"],
          ],
          colorScheme,
        );
        await openTab(page, "Devices");
        await expectStatusIndicatorColours(
          page,
          `devices ${colorScheme}`,
          [
            ["connected", "pill"],
            ["leased", "standalone"],
          ],
          colorScheme,
        );
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
    await signInWithKeyboard(page, daemon.tokens.operator, tab);
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

    await follow(page.getByRole("link", { name: "Fleet", exact: true }), "backward");
    await expect(page).toHaveURL(/\/fleet$/);
  });
});

test.describe("Fleet worker actions", () => {
  test("a worker drawer's button is its first safe action", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "bar-a" }]);
    try {
      const workersUrl = (url: URL) => url.pathname === "/v1/workers";
      await page.route(workersUrl, async (route) => {
        const response = await fetchFull(route);
        const body = (await response.json()) as { workers: Record<string, unknown>[] };
        await route.fulfill({
          response,
          json: {
            ...body,
            workers: body.workers.map((worker) => ({
              ...worker,
              version: "0.3.0",
              latestVersion: "0.4.0",
              update: null,
              lastUpdateFailure: null,
            })),
          },
        });
      });
      await openPage(page, fleet.gateway, "/fleet", "Fleet");
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await page.goto(new URL(`/fleet/${id}`, fleet.gateway.url).toString());
      await expect(page.getByRole("heading", { level: 1, name: "bar-a" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Drain", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Actions for bar-a" }).click();
      await expect(page.getByRole("menuitem", { name: "Update…" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.unroute(workersUrl);
      await page.getByRole("button", { name: "Drain", exact: true }).click();
      await expect(page.getByText("bar-a drained", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Actions for bar-a" })).toHaveCount(0);

      const [stopped] = fleet.workers as [RunningDaemon];
      await stopped.stop();
      await waitForDisconnected(fleet.gateway);
      await page.getByRole("button", { name: "Actions for bar-a" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Remove worker"]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Undrain", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove worker" })).toHaveCount(0);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("on a single host no Fleet menu or worker page offers Drain, Undrain or Remove", async ({
    page,
  }) => {
    const daemon = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(daemon, "solo-agent");
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
    } finally {
      await daemon.dispose();
    }
  });

  test("a worker is drained from Fleet with no dialog, and Undo undrains it", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "drain-a" }]);
    try {
      // why: the row shows the host's own disk and CPU; one over its limit outranks "drained" (#886).
      await answerWithoutLoad(page);
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
      // why: the page tells its views of an answer through a timer, which a frozen clock never fires, so a table still loading when time freezes never shows.
      await expect(rowOf(page, "toast-d")).toBeVisible();
      // why: with time frozen, only the fast-forwards below age a toast, however slow the machine.
      await page.clock.pauseAt(new Date(Date.now() + 1_000));
      const toasts = page.getByRole("region", { name: "Notifications" });
      const toastOf = (text: string) => toasts.locator(".toast").filter({ hasText: text });
      const act = async (worker: string, item: string) => {
        // why: the toasts stack over the table's last column, so the keyboard opens the menu.
        await rowOf(page, worker)
          .getByRole("button", { name: `Actions for ${worker}` })
          .press("Enter");
        const entry = page
          .getByRole("menu", { name: `Actions for ${worker}` })
          .getByRole("menuitem", { name: item, exact: true });
        // why: the answer to the read an earlier action set off lands in real time, and the page shows it only once the frozen clock moves again, so until the menu offers the item the clock moves a little at a time.
        let tries = 0;
        await expect(async () => {
          if (tries++ > 0) await page.clock.runFor(500);
          await expect(entry).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 20_000 });
        await entry.click();
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
