import type { Locator, Page, Response } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  signInWithKeyboard,
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
