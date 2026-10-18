import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { answerMemory, answerWithoutLoad, type MemoryClaim } from "./workers-answers.js";
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
  readonly leases: readonly {
    readonly id: string;
    readonly deviceId: string;
    readonly grantedAt: number;
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
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
}

function row(page: Page, name: string): Locator {
  return page
    .getByRole("list", { name: "Workers", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
}

function title(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 2, name, exact: true });
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

test.describe("the workers page", () => {
  test("on a gateway, every worker appears as a row with its state square, its name and its running over limit, and opens in the inspector", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const b = (await workerList(fleet.gateway)).find((view) => view.label === "worker-b");
      const drained = found(b, "worker-b").id;
      expect((await fleet.gateway.cli(["worker", "drain", drained])).code).toBe(0);
      await lease(fleet.workers[0] as RunningDaemon, "console-e2e");
      await waitFor(
        async () => (await workerList(fleet.gateway)).some((view) => view.leases.length === 1),
        { label: "the gateway's view of worker-a carries its lease" },
      );
      const listed = await workerList(fleet.gateway);

      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);

      await expect(
        page.getByRole("list", { name: "Workers", exact: true }).getByRole("listitem"),
      ).toHaveCount(listed.length);
      await expect(page.locator(".list-meta")).toHaveText(`${listed.length} / ${listed.length} up`);
      for (const view of listed) {
        const shown = row(page, view.label ?? view.id);
        await expect(shown, view.label).toHaveText(`${view.label}${runningOverLimit(view)}`);
        await expect(
          shown.getByRole("img", { name: view.drained ? "drained" : "connected" }),
        ).toBeVisible();
      }

      await row(page, "worker-a").getByRole("link").click();
      const a = found(
        listed.find((view) => view.label === "worker-a"),
        "worker-a",
      );
      await expect(page).toHaveURL(new RegExp(`/workers/${a.id}$`));
      await expect(title(page, "worker-a")).toBeVisible();
      await expect(fact(page.locator("#main"), "Leases").or(figure(page, "Leases"))).toContainText(
        "1",
      );
      await expect(row(page, "worker-a").getByRole("link")).toHaveAttribute("aria-current", "page");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("an incompatible worker shows both protocol ranges", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      const view = await incompatibleWorker(gateway, "wrk_old");
      const gatewayRange = found(view.protocol?.gateway, "the gateway's protocol range");
      expect(view.protocol?.worker).toEqual(OLD_PROTOCOL);

      await openConsole(page, gateway);
      await expect(
        row(page, "old-worker").getByRole("img", { name: "incompatible" }),
      ).toBeVisible();
      await row(page, "old-worker").getByRole("link").click();

      const expected =
        `incompatible gateway ${gatewayRange.min}–${gatewayRange.max}, ` +
        `worker ${OLD_PROTOCOL.min}–${OLD_PROTOCOL.max}`;
      await expect(page.getByRole("tabpanel")).toContainText(expected);
      await openTab(page, "Host");
      await expect(fact(page.locator("#main"), "Protocol")).toHaveText(expected);
      await expect(fact(page.locator("#main"), "Connection")).toHaveText("incompatible");
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("on a single host, the list has one worker, and with no id in the URL it shows that worker in the inspector", async ({
    daemon,
    page,
  }) => {
    const host = found((await workerList(daemon))[0], "the host's worker");

    await answerWithoutLoad(page);
    await openConsole(page, daemon);

    await expect(
      page.getByRole("list", { name: "Workers", exact: true }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(page).toHaveURL(/\/workers$/);
    await expect(title(page, host.id)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(host.id);
    await row(page, host.id).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/workers/${encodeURIComponent(host.id)}$`));
    await expect(page.locator(".inspector-line")).toContainText(host.version ?? "");
    await expect(page.locator(".inspector-line")).toContainText("connected");
  });

  test("a worker that no list has says so and links back to the list", async ({ daemon, page }) => {
    await openConsole(page, daemon);

    await page.goto(new URL("/workers/wrk_nope", daemon.url).href);

    await expect(page.getByText("Worker not found.")).toBeVisible();
    await page.getByRole("link", { name: "All workers" }).click();
    await expect(page).toHaveURL(/\/workers$/);
    await expect(page.getByRole("list", { name: "Workers", exact: true })).toBeVisible();
  });

  test("the Issues and Busy filters keep the workers they name", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    try {
      const b = (await workerList(fleet.gateway)).find((view) => view.label === "worker-b");
      const drained = found(b, "worker-b").id;
      expect((await fleet.gateway.cli(["worker", "drain", drained])).code).toBe(0);
      await answerWithoutLoad(page);
      await openConsole(page, fleet.gateway);
      await expect(row(page, "worker-a")).toBeVisible();

      await page.getByLabel("Issues").check();
      await expect(row(page, "worker-b")).toBeVisible();
      await expect(row(page, "worker-a")).toHaveCount(0);

      await page.getByLabel("Busy").check();
      await expect(page.getByText("No worker matches.")).toBeVisible();

      await page.getByLabel("All", { exact: true }).check();
      await expect(row(page, "worker-a")).toBeVisible();
      await expect(row(page, "worker-b")).toBeVisible();
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

  test("a worker's host tab shows its facts and catalog, and its warm pool tab the installs in progress", async ({
    page,
  }) => {
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
      const [view] = await workerList(host);

      await openConsole(page, host);
      await row(page, view?.id ?? "")
        .getByRole("link")
        .click();

      await openTab(page, "Host");
      const main = page.locator("#main");
      await expect(fact(main, "Operating system")).toHaveText(`${facts.os} ${facts.osVersion}`);
      await expect(fact(main, "CPU architecture")).toHaveText(facts.arch);
      await expect(fact(main, "Tools")).toHaveText("xcode 16.4 (16F6) for iOS");
      await expect(fact(main, "Worker id")).toHaveText(view?.id ?? "");
      await expect(fact(main, "iOS")).toContainText("Models: iPhone 16, iPad Air");
      await expect(fact(main, "iOS")).toContainText(/Runtimes: 18\.4.*, 26\.0/);
      await expect(fact(main, "agent-device")).toContainText(/available|off|unavailable/);

      await openTab(page, "Warm pool");
      const installs = page.getByRole("region", { name: "Installs in progress", exact: true });
      await expect(installs).toContainText(/iOS 19\.0\s*downloading for \d+ s, 1 waiter/);
    } finally {
      await host.dispose();
    }
  });

  test("a granted lease shows on the worker's row and inspector within a second, without a reload", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      await openConsole(page, fleet.gateway);
      await row(page, "worker-a").getByRole("link").click();
      await expect(row(page, "worker-a")).toHaveText(/0 \/ \d+$/);
      await expect(figure(page, "Leases")).toContainText("0");

      await lease(fleet.gateway, "console-e2e");
      await untilTheGatewaySays(
        fleet.gateway,
        (views) => views.find((view) => view.label === "worker-a")?.leases.length === 1,
      );

      await expect(row(page, "worker-a")).toHaveText(/1 \/ \d+$/, { timeout: 1_000 });
      await expect(figure(page, "Leases")).toContainText("1", { timeout: 1_000 });
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("on a single host, the overview shows CPU, memory and disk as figures with the reading's age ticking", async ({
    daemon,
    page,
  }) => {
    await openConsole(page, daemon);

    await expect(figure(page, "CPU")).toContainText(/\d+% busy, /, { timeout: 20_000 });
    await expect(figure(page, "Memory")).toContainText("available");
    await expect(figure(page, "Disk")).toContainText("free");
    const read = page.getByText(/^Read \d+ s ago$/);
    await expect(read).toBeVisible();
    const first = await read.textContent();
    await expect(read).not.toHaveText(first ?? "", { timeout: 10_000 });
  });

  test("a bar sits under each figure, filled to that figure's own percent", async ({
    daemon,
    page,
  }) => {
    await openConsole(page, daemon);
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
    await openConsole(page, daemon);
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
    await openConsole(page, daemon);

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

  test("a disconnected worker's square and load say so within a second", async ({ page }) => {
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

      await expect(row(page, "worker-b").getByRole("img", { name: "disconnected" })).toBeVisible({
        timeout: 1_000,
      });
      await expect(page.getByText("No reading while disconnected")).toBeVisible({ timeout: 1_000 });
      await expect(row(page, "worker-a").getByRole("img", { name: "disconnected" })).toHaveCount(0);
      await expect(page.locator(".list-meta")).toHaveText("1 / 2 up");
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
      await expect(
        row(page, "old-worker").getByRole("img", { name: "incompatible" }),
      ).toBeVisible();
      await expect(row(page, "worker-b").getByRole("img", { name: "drained" })).toBeVisible();

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
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
        await openTab(page, "Overview");
        await expectSquareColours(page, `overview ${colorScheme}`, ["connected", "leased"]);
      }
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("the workers page has no horizontal scroll at 360px wide, in the list and in the inspector", async ({
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
      await page.goto(new URL("/workers", host.url).href);
      await signIn(page, host.tokens.operator);
      const [view] = await workerList(host);
      await expect(page.getByRole("list", { name: "Workers", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2 })).toBeHidden();
      expect(await hasHorizontalScroll(page)).toBe(false);

      await row(page, view?.id ?? "")
        .getByRole("link")
        .click();
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await expect(page.getByRole("list", { name: "Workers", exact: true })).toBeHidden();
      expect(await hasHorizontalScroll(page)).toBe(false);
      for (const tab of ["Host", "Warm pool"]) {
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
    await follow(page.getByRole("link", { name: "Workers", exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

    await follow(row(page, name).getByRole("link"));
    await expect(page).toHaveURL(new RegExp(`/workers/${encodeURIComponent(name)}$`));
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
      page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Workers" }),
      "backward",
    );
    await expect(page).toHaveURL(/\/workers$/);
  });
});
