import type { Locator, Page } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  settled,
  test,
} from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

interface Envelope {
  readonly id: string;
  readonly timestamp: number;
  readonly event: string;
}

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

async function cliEvents(daemon: RunningDaemon): Promise<readonly Envelope[]> {
  const result = await daemon.cli(["events", "--since", "1h"]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Envelope);
}

async function openEvents(page: Page, daemon: RunningDaemon, path = "/events"): Promise<void> {
  await page.goto(new URL(path, daemon.url).href);
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

function rows(page: Page): Locator {
  return feed(page).getByRole("listitem");
}

function title(page: Page): Locator {
  return page.getByRole("heading", { level: 2 }).first();
}

async function shownEvents(page: Page): Promise<string[]> {
  return feed(page).evaluate(async (box) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const seen = new Map<number, string>();
    box.scrollTop = 0;
    for (let step = 0; step < 1_000; step += 1) {
      await frame();
      for (const item of box.querySelectorAll("li")) {
        const link = item.querySelector("a");
        const name = item.querySelector("time + span");
        seen.set(
          Math.round(item.getBoundingClientRect().top + box.scrollTop),
          [
            item.querySelector("time")?.getAttribute("datetime") ?? "",
            name?.textContent ?? "",
            link?.getAttribute("href")?.replace("/events/", "") ?? "",
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

function asShown(event: Envelope): string {
  return `${new Date(event.timestamp).toISOString()} ${event.event} ${encodeURIComponent(event.id)}`;
}

async function openEvent(page: Page, id: string): Promise<void> {
  const link = feed(page).locator(`a[href="/events/${encodeURIComponent(id)}"]`);
  await feed(page).evaluate((box) => box.scrollTo({ top: 0 }));
  for (let step = 0; step < 200 && (await link.count()) === 0; step += 1) {
    await feed(page).evaluate((box) => box.scrollBy({ top: box.clientHeight / 2 }));
    await page.waitForTimeout(30);
  }
  await link.click();
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  await settled(page);
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the events page", () => {
  test("a lease taken with the CLI appears in the feed within a second, and its page opens from it", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host);
      await expect(rows(page).first()).toBeVisible();
      const granted = rows(page).filter({ hasText: "lease.granted" });
      await expect(granted).toHaveCount(0);

      const id = await lease(host, "console-e2e-events");

      await expect(granted).toHaveCount(1, { timeout: 1_000 });
      await granted.click();
      await expect(title(page)).toHaveText("lease.granted");
      await expect(page).toHaveURL(/\/events\/[^/]+$/);
      await expect(page.getByText("leaseId", { exact: true })).toBeVisible();
      await expect(page.locator("dd", { hasText: new RegExp(`^${id}$`) })).toBeVisible();

      await page.getByRole("link", { name: "Open lease" }).click();
      await expect(page).toHaveURL(new RegExp(`/leases/${id}/?$`));
    } finally {
      await host.dispose();
    }
  });

  test("the feed matches simlock events --since 1h, and a restart leaves no gap and no duplicate", async ({
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

      const after = await cliEvents(host);
      expect(after.length).toBeGreaterThan(before.length);
      await expect.poll(() => shownEvents(page)).toEqual(after.map(asShown).toReversed());
    } finally {
      await host.dispose();
    }
  });

  test("choosing a row puts the event in the URL and its payload whole in the inspector", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-choose");
      await openEvents(page, host);
      const started = (await cliEvents(host)).find((event) => event.event === "daemon.started");
      expect(started).toBeDefined();

      await openEvent(page, (started as Envelope).id);

      await expect(page).toHaveURL(new RegExp(`/events/${(started as Envelope).id}$`));
      await expect(title(page)).toHaveText("daemon.started");
      await expect(page.getByRole("heading", { level: 2, name: "Payload" })).toBeVisible();
      await page.reload();
      await expect(title(page)).toHaveText("daemon.started");
    } finally {
      await host.dispose();
    }
  });

  test("an event the feed does not hold says so and links back", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openEvents(page, host, "/events/evt_not_there");

      await expect(page.getByText("Event not in the last hour.")).toBeVisible();
      await page.getByRole("link", { name: "Back to events" }).click();
      await expect(page).toHaveURL(/\/events$/);
    } finally {
      await host.dispose();
    }
  });

  test("the filter shows only one subject's events and is kept in the URL", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-filter");
      await openEvents(page, host);

      await page.getByRole("radio", { name: "Leases" }).check({ force: true });

      await expect(page).toHaveURL(/\?subject=lease$/);
      const names = await rows(page).locator("time + span").allTextContents();
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name.startsWith("lease."))).toBe(true);
      await page.reload();
      await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();
    } finally {
      await host.dispose();
    }
  });

  test("the feed scrolls inside itself with the keyboard, and counts the events that came in while scrolled down", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      for (let index = 0; index < 6; index += 1) await lease(host, `console-e2e-scroll-${index}`);
      await openEvents(page, host);
      await expect.poll(() => rows(page).count()).toBeGreaterThan(5);

      await feed(page).focus();
      await page.keyboard.press("End");
      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBeGreaterThan(0);

      await lease(host, "console-e2e-scroll-new");
      const more = page.getByRole("button", { name: /^\d+ new events?$/ });
      await expect(more).toBeVisible();
      await more.click();
      await expect.poll(() => feed(page).evaluate((box) => box.scrollTop)).toBe(0);
      await expect(more).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, a worker's event shows that worker's label", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const worker = fleet.workers[0] as RunningDaemon;
      await openEvents(page, fleet.gateway);

      await lease(worker, "console-e2e-label");

      const granted = rows(page).filter({ hasText: "lease.granted" });
      await expect(granted).toHaveCount(1);
      await expect(granted).toContainText("worker-a");
      await granted.click();
      await expect(page.getByText("workerId", { exact: true })).toBeVisible();
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a worker joining a gateway shows no join token anywhere in the events page", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const worker = fleet.workers[0] as RunningDaemon;
      const joinToken = fleet.gateway.tokens.worker;
      for (const daemon of [fleet.gateway, worker]) {
        const name = daemon === worker ? "the worker" : "the gateway";
        await openEvents(page, daemon);
        const wanted = daemon === worker ? "daemon.started" : "worker.connected";
        await expect(rows(page).filter({ hasText: wanted }), name).not.toHaveCount(0);
        const events = await cliEvents(daemon);
        await expect.poll(async () => (await shownEvents(page)).length, name).toBe(events.length);

        const seen: string[] = [];
        for (const event of events) {
          await openEvent(page, event.id);
          await expect(title(page)).toHaveText(event.event);
          seen.push(await page.locator("#main").innerText());
        }
        expect(seen.join("\n"), name).not.toContain(joinToken);
        expect(await page.content(), name).not.toContain(joinToken);

        await page.getByRole("button", { name: "Sign out" }).click();
      }
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the events page has no horizontal scroll at 360px wide, even with the longest payload", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await lease(host, "console-e2e-narrow");
      await page.setViewportSize({ height: 740, width: 360 });
      await openEvents(page, host);
      expect(await hasHorizontalScroll(page)).toBe(false);

      const started = (await cliEvents(host)).find((event) => event.event === "daemon.started");
      await openEvent(page, (started as Envelope).id);
      await expect(title(page)).toHaveText("daemon.started");

      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the events page is usable with the keyboard alone", async ({ browserName, page }) => {
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

async function keyboardOnly(page: Page, host: RunningDaemon, tab: string): Promise<void> {
  await page.goto(host.url);
  await page.keyboard.press(tab);
  await page.keyboard.type(host.tokens.operator);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation").first()).toBeVisible();

  const nav = page.getByRole("link", { name: "Events", exact: true });
  for (let step = 0; step < 30 && !(await isFocused(nav)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(nav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "lease.granted" })).not.toHaveCount(0);

  const all = page.getByRole("radio", { name: "All" });
  for (let step = 0; step < 30 && !(await isFocused(all)); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(all).toBeFocused();
  await expect(all).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();

  const names = await rows(page).locator("time + span").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name.startsWith("lease."))).toBe(true);

  for (let step = 0; step < 10 && !(await isFocused(feed(page))); step += 1) {
    await page.keyboard.press(tab);
  }
  await expect(feed(page)).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/events\/[^/?]+\?subject=lease$/);
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}
