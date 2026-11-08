import type { Locator, Page, Response } from "@playwright/test";

import { answerMemory, answerWithoutLoad, type MemoryClaim } from "./workers-answers.js";
import {
  disposeFleet,
  expect,
  joinOldWorker,
  type RunningDaemon,
  signIn,
  signInWithKeyboard,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";
import { returnToTab } from "./tab.js";
import { answer } from "./stub-answers.js";

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly drained: boolean;
  readonly lastSeenAt: number;
  readonly host?: { readonly os: string; readonly osVersion: string };
  readonly leases: readonly { readonly id: string }[];
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function workerList(daemon: RunningDaemon): Promise<readonly WorkerView[]> {
  const listed = await daemon.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: readonly WorkerView[] }).workers;
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
    .first()
    .click();
  await expect(title(page, view.label ?? view.id)).toBeVisible();
}

// why: a worker is a card or a tile on the Fleet page, found by the link that carries its name.
function row(page: Page, name: string): Locator {
  return page.locator(".fleet-card").filter({ has: page.getByRole("link", { exact: true, name }) });
}

function title(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 1, name: `Fleet / ${name}`, exact: true });
}

function figures(page: Page): Locator {
  return page.getByRole("group", { name: "Load and leases" });
}

function figure(page: Page, label: string): Locator {
  return figures(page)
    .locator(".worker-gauge")
    .filter({ has: page.locator(".fleet-label", { hasText: label }) });
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
}

const TONES = ["ok", "warn", "error", "idle"] as const;

const TONE_OF: Readonly<Partial<Record<string, (typeof TONES)[number]>>> = {
  compatible: "ok",
  connected: "ok",
  drained: "warn",
  error: "error",
  idle: "idle",
  incompatible: "error",
  info: "idle",
  leased: "idle",
  live: "ok",
  off: "idle",
  ok: "ok",
  ready: "ok",
  running: "ok",
  warn: "warn",
};

async function readStatusIndicators(page: Page) {
  const pills = await page.locator(".pill").evaluateAll((elements) =>
    elements.map((element) => ({
      ariaHidden: element.querySelector(".pill-dot")?.getAttribute("aria-hidden") ?? "true",
      ariaLabel: null,
      colour: getComputedStyle(element).color,
      kind: "pill" as const,
      role: null,
      title: null,
      word: element.textContent?.trim() ?? "",
    })),
  );
  const rest = await readStatusDots(page);
  return { ...rest, shown: [...pills, ...rest.shown] };
}

async function readStatusDots(page: Page) {
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
  await expect(page.locator(".pill").first()).toBeVisible();
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

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the workers page", () => {
  test("slot squares are 16px tall with a 4px gap, and the meter above ten slots is 4px tall", async ({
    daemon,
    page,
  }) => {
    const cases = [
      { limit: 10, name: "ten" },
      { limit: 20, name: "twenty" },
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
      workers: cases.map(({ limit, name }) => ({
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
        devices: [],
      })),
    }));
    await openConsole(page, daemon);

    const ten = row(page, "ten").getByRole("img");
    await expect(ten).toHaveCSS("gap", "4px");
    await expect(ten.locator(".slot").first()).toHaveCSS("height", "16px");
    await expect(row(page, "twenty").locator(".load-bar")).toHaveCSS("height", "4px");
  });

  test("the Events tab scrolls back through that worker's history to its start, asking for that worker's events only", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const idA = found((await workerList(fleet.gateway))[0], "worker-a").id;
      await page.goto(fleet.gateway.url);
      await signIn(page, fleet.gateway.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
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
      await page.goto(
        new URL(`/fleet/${encodeURIComponent(idA)}?tab=events`, fleet.gateway.url).href,
      );
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
      // why: a body still unread when the fleet is disposed would reject the test.
      page.off("response", readEvents);
      await Promise.all(reads);
      expect(answered.length).toBeGreaterThan(100);
      expect(answered.filter((event) => event.payload?.workerId !== idA)).toEqual([]);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the worker page's ring gauges sit above its cards", async ({ daemon, page }) => {
    await openWorkerPage(page, daemon);

    await expect(figure(page, "CPU")).toContainText(/\d+% busy/, { timeout: 20_000 });
    const grid = await page.locator(".worker-grid").boundingBox();
    const gauges = await figures(page).boundingBox();
    expect(gauges?.y, "the rings sit above the cards").toBeLessThan(grid?.y ?? 0);
  });

  test("each memory pressure paints its ring in that pressure's colour, and never the accent, in both themes", async ({
    daemon,
    page,
  }) => {
    await openWorkerPage(page, daemon);
    await expect(figure(page, "Memory")).toContainText("used");
    // why: only macOS reports a memory pressure, and how full a CI machine's memory happens to be
    // is nobody's to predict. This answers the page's own read of the worker list with the memory
    // reading's own fields set to the level the case asks for and every other field left as the
    // daemon sent it, so what is painted is the real component's doing and the same colour is
    // expected on any machine.
    let claim: MemoryClaim = { usedPercent: 50 };
    await answerMemory(page, () => claim);

    const memoryFill = () =>
      figure(page, "Memory").evaluate((card) => {
        const ring = card.querySelector(".ring-box") as HTMLElement;
        return {
          tone: /ring-(ok|warn|error|idle|neutral)/.exec(ring.className)?.[1] ?? "",
          colour: getComputedStyle(ring.querySelector(".ring-value") as SVGCircleElement).stroke,
        };
      });
    const paintedFills = () =>
      figures(page)
        .locator(".ring-box")
        .evaluateAll((rings) =>
          rings.map((ring) => ({
            tone: /ring-(ok|warn|error|idle|neutral)/.exec(ring.className)?.[1] ?? "",
            colour: getComputedStyle(ring.querySelector(".ring-value") as SVGCircleElement).stroke,
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
        await expect(page.getByRole("region", { name: "Worker events" })).toBeVisible();
        await expectStatusIndicatorColours(
          page,
          `list ${colorScheme}`,
          [
            ["drained", "pill"],
            ["incompatible", "pill"],
            ["live", "pill"],
          ],
          colorScheme,
        );
        await row(page, "worker-a").getByRole("link").first().click();
        await expect(page.getByRole("region", { name: "Events on this worker" })).toBeVisible();
        await expectStatusIndicatorColours(
          page,
          `worker ${colorScheme}`,
          [
            ["connected", "pill"],
            ["leased", "pill"],
            ["live", "pill"],
          ],
          colorScheme,
        );
      }
    } finally {
      hangUp();
      await disposeFleet(fleet);
    }
  });

  test("the fleet pages have no horizontal scroll at 360px wide, in the cards and on a worker's page", async ({
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
        .first()
        .click();
      await expect(page.locator(".worker-device").first()).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
      for (const tab of ["Warm pool", "Devices"]) {
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

    await follow(row(page, name).getByRole("link").first());
    await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(name)}$`));
    await expect(title(page, name)).toBeVisible();

    const host_tab = page.getByRole("tab", { name: "Warm pool" });
    for (let step = 0; step < 30; step += 1) {
      if (await host_tab.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press(tab);
    }
    await expect(host_tab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(host_tab).toHaveAttribute("aria-selected", "true");

    await follow(
      page.locator("#main").getByRole("link", { name: "Fleet", exact: true }),
      "backward",
    );
    await expect(page).toHaveURL(/\/fleet$/);
  });
});
