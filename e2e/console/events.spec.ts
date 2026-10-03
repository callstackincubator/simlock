import type { Locator, Page } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

/** One line of `simlock events`, as far as these tests read it. */
interface Envelope {
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/** Takes a lease with the CLI, detached, and returns its id. */
async function lease(daemon: RunningDaemon, agent: string): Promise<string> {
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
  const id = (granted.json as { lease?: { id?: unknown } }).lease?.id;
  expect(typeof id).toBe("string");
  return id as string;
}

/** What `simlock events --since 1h` prints. */
async function cliEvents(daemon: RunningDaemon): Promise<readonly Envelope[]> {
  const result = await daemon.cli(["events", "--since", "1h"]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Envelope);
}

async function openEvents(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(new URL("/events", daemon.url).href);
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
}

/** Every event the view shows. */
function rows(page: Page): Locator {
  return page.locator("#main li.event");
}

/** The events the view shows with this name and this payload value somewhere in it. */
function row(page: Page, name: string, value: string): Locator {
  return rows(page)
    .filter({ has: page.locator(".event-name", { hasText: new RegExp(`^${name}$`) }) })
    .filter({ has: page.locator("dd", { hasText: new RegExp(`^${value}$`) }) });
}

/**
 * Each event the view shows, as its time, name and payload, in the order shown. The feed draws
 * only the rows in its box, so this scrolls it from the top to the bottom, reading each row as
 * it is drawn, and back to the top.
 */
async function shownEvents(page: Page): Promise<string[]> {
  return page.getByRole("region", { name: "Event feed" }).evaluate(async (box) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const seen = new Map<number, string>();
    box.scrollTop = 0;
    for (let step = 0; step < 1_000; step += 1) {
      await frame();
      for (const item of box.querySelectorAll("li.event")) {
        seen.set(
          Number(item.getAttribute("aria-posinset")),
          [
            item.querySelector("time")?.getAttribute("datetime") ?? "",
            item.querySelector(".event-name")?.textContent ?? "",
            ...[...item.querySelectorAll(".event-payload > div")].map(
              (pair) =>
                `${pair.querySelector("dt")?.textContent ?? ""}=${pair.querySelector("dd")?.textContent ?? ""}`,
            ),
          ].join(" "),
        );
      }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
      box.scrollTop += box.clientHeight;
    }
    box.scrollTop = 0;
    return [...seen.entries()].sort(([a], [b]) => a - b).map(([, shown]) => shown);
  });
}

/** An event from the CLI, written as {@link shownEvents} reads the view: strings as themselves. */
function asShown(event: Envelope): string {
  return [
    new Date(event.timestamp).toISOString(),
    event.event,
    ...Object.entries(event.payload).map(
      ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
  ].join(" ");
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the events view", () => {
  test("a lease taken with the CLI appears in the events view within a second", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host);
      await expect(rows(page).first()).toBeVisible();

      const id = await lease(host, "console-e2e-events");

      await expect(row(page, "lease.granted", id)).toHaveCount(1, { timeout: 1_000 });
    } finally {
      await host.dispose();
    }
  });

  test("the events view matches simlock events --since 1h, and a restart leaves no gap and no duplicate", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-before");
      await openEvents(page, host);
      const before = (await cliEvents(host)).map(asShown);
      await expect.poll(() => shownEvents(page)).toEqual(before.toReversed());

      await host.stop();
      await expect(page.locator(".connection")).toHaveText(/^Reconnecting/);
      await host.start();
      await expect(page.locator(".connection")).toHaveText("Connected", { timeout: 30_000 });
      await lease(host, "console-e2e-after");

      // Every event once, newest first, the ones sent while the console was away included.
      const after = await cliEvents(host);
      expect(after.length).toBeGreaterThan(before.length);
      await expect.poll(() => shownEvents(page)).toEqual(after.map(asShown).toReversed());
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, a worker's event shows that worker's label", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const worker = fleet.workers[0] as RunningDaemon;
      await openEvents(page, fleet.gateway);

      const id = await lease(worker, "console-e2e-label");

      const granted = row(page, "lease.granted", id);
      await expect(granted).toHaveCount(1);
      // The payload names the worker by id only; the label comes from the worker list.
      await expect(granted.locator("dt", { hasText: /^workerId$/ })).toHaveCount(1);
      await expect(granted.locator(".event-worker")).toHaveText("worker-a");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a worker joining a gateway shows no join token anywhere in the events view", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const worker = fleet.workers[0] as RunningDaemon;
      const joinToken = fleet.gateway.tokens.worker;
      for (const daemon of [fleet.gateway, worker]) {
        const name = daemon === worker ? "the worker" : "the gateway";
        await openEvents(page, daemon);
        // The events that would carry the join token if anything did: the worker's own start,
        // with its config, and the gateway's word that the worker joined.
        const wanted = daemon === worker ? "daemon.started" : "worker.connected";
        await expect(
          rows(page).filter({ has: page.locator(".event-name", { hasText: wanted }) }),
          name,
        ).not.toHaveCount(0);
        const started = await cliEvents(daemon);
        await expect.poll(async () => (await shownEvents(page)).length, name).toBe(started.length);

        // Every event, drawn as the feed scrolls past it, and the page as it stands.
        expect((await shownEvents(page)).join("\n"), name).not.toContain(joinToken);
        expect(await page.content(), name).not.toContain(joinToken);
        expect(await page.locator("body").innerText(), name).not.toContain(joinToken);

        await page.getByRole("button", { name: "Sign out" }).click();
      }
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the Events view has no horizontal scroll at 360px wide", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-narrow");
      await page.setViewportSize({ height: 740, width: 360 });
      await openEvents(page, host);
      // `daemon.started` carries the whole config: the longest payload there is.
      await expect(
        rows(page).filter({ has: page.locator(".event-name", { hasText: "daemon.started" }) }),
      ).not.toHaveCount(0);
      await expect(rows(page).filter({ hasText: "lease.granted" })).not.toHaveCount(0);

      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the Events view is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-keyboard");
      await keyboardOnly(page, host, tab);
    } finally {
      await host.dispose();
    }
  });
});

/** Signs in, opens the Events view and filters it, with the keyboard alone. */
async function keyboardOnly(page: Page, host: RunningDaemon, tab: string): Promise<void> {
  await page.goto(host.url);
  await page.keyboard.press(tab);
  await page.keyboard.type(host.tokens.operator);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

  const nav = page.getByRole("link", { name: "Events", exact: true });
  for (let step = 0; step < 20 && !(await isFocused(nav)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(nav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "daemon.started" })).not.toHaveCount(0);

  // Into the filter: Tab reaches the checked choice, and the arrow keys move along them.
  const all = page.getByRole("radio", { name: "All" });
  for (let step = 0; step < 20 && !(await isFocused(all)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(all).toBeFocused();
  await expect(all).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();

  const names = await rows(page).locator(".event-name").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name.startsWith("lease."))).toBe(true);
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}
