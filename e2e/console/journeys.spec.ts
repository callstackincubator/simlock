import type { Locator, Page, Route } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";
import { IOS, LEASE } from "./pages.js";

// why: each journey here is an operator's act on a console page that ends in the real daemon's
// state, or a claim about what the real daemon sends the page; none can be had from answers written
// by hand.

interface Envelope {
  readonly id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
}

async function takeLease(daemon: RunningDaemon, agent: string): Promise<string> {
  const granted = await daemon.cli([...LEASE, "--detach", "--agent-id", agent]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

async function openConsole(page: Page, daemon: RunningDaemon, path = "/"): Promise<void> {
  await page.goto(new URL(path, daemon.url).href);
  await signIn(page, daemon.tokens.operator);
}

function feed(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

function localMinute(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

async function eventsHeld(page: Page): Promise<number> {
  // why: the feed draws only the rows in view and prints no count, so its scroll height, one 38px
  // row per event, is the only measure of how many events it holds.
  return Math.round((await feed(page).evaluate((box) => box.scrollHeight)) / 38);
}

async function openEvent(page: Page, id: string): Promise<void> {
  const link = feed(page).locator(`a[href="/activity/${encodeURIComponent(id)}"]`);
  await feed(page).evaluate((box) => box.scrollTo({ top: 0 }));
  for (let step = 0; step < 200 && (await link.count()) === 0; step += 1) {
    await feed(page).evaluate((box) => box.scrollBy({ top: box.clientHeight / 2 }));
    await page.waitForTimeout(30);
  }
  // why: a row near the edge of the drawn window is replaced as the feed scrolls it into view, so it is brought to the middle and clicked again if it moved.
  await expect(async () => {
    await link.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await link.click({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

test.describe("what an operator does in the console against a real daemon", () => {
  test("a lease granted through the CLI raises Leased on the open Overview and adds a lease.granted row to the open Activity feed", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openConsole(page, host);
      const tiles = page.getByRole("list", { name: "Fleet at a glance" });
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await expect(tiles.getByRole("link", { name: /^Leased 0/ })).toBeVisible();

      await takeLease(host, "journey-live-a");

      await expect(tiles.getByRole("link", { name: /^Leased 1/ })).toBeVisible();
      await page
        .getByRole("navigation", { name: "Console" })
        .getByRole("link", { name: "Activity", exact: true })
        .click();
      const granted = feed(page).getByRole("listitem").filter({ hasText: "lease.granted" });
      await expect(granted).toHaveCount(1);

      await takeLease(host, "journey-live-b");

      await expect(granted).toHaveCount(2);
    } finally {
      await host.dispose();
    }
  });

  test("releasing a lease from its inspector, after the dialog, ends it on the daemon", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await takeLease(host, "journey-release");
      await openConsole(page, host, "/leases");
      await page.locator("main tbody tr").filter({ hasText: "journey-release" }).click();
      await page
        .getByRole("region", { exact: true, name: "Lease" })
        .getByRole("button", { exact: true, name: "Release" })
        .click();

      await page
        .getByRole("alertdialog", { name: "Release journey-release's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();

      await expect(page.getByText("Released journey-release's lease")).toBeVisible();
      await expect(
        page.locator("main tbody tr").filter({ hasText: "journey-release" }),
      ).toHaveCount(0);
      const listed = await host.cli(["list", "--leases"]);
      expect(listed.json).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("draining a worker from its page, then undraining it, changes whether the gateway lets it take leases", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const drained = async () => {
        const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
        return (listed.json as { workers: { drained: boolean }[] }).workers[0]?.drained;
      };
      const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
      const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      await openConsole(page, fleet.gateway, `/fleet/${encodeURIComponent(id)}`);

      await page.getByRole("button", { exact: true, name: "Drain" }).click();

      await expect(page.getByText("worker-a drained", { exact: true })).toBeVisible();
      await expect.poll(drained).toBe(true);

      await page.getByRole("button", { exact: true, name: "Undrain" }).click();

      await expect(page.getByText("worker-a takes leases again", { exact: true })).toBeVisible();
      await expect.poll(drained).toBe(false);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a lease the gateway issued, whose id holds a '.', loads again on reload", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const minted = await fleet.gateway.cli([
        "token",
        "create",
        "--role",
        "agent",
        "--label",
        "ci-runner-3",
      ]);
      expect(minted.code, minted.stderr).toBe(0);
      const { secret } = minted.json as { secret: string };
      const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
      const created = await fetch(new URL("/v1/lease-requests", fleet.gateway.url), {
        body: JSON.stringify({ device: "iPhone 16", os: "18.4", platform: "ios" }),
        headers,
        method: "POST",
      });
      expect(created.status).toBe(201);
      let request = ((await created.json()) as { request: { id: string; state: string } }).request;
      for (let attempt = 0; request.state !== "granted" && attempt < 6; attempt += 1) {
        const polled = await fetch(
          new URL(`/v1/lease-requests/${request.id}?wait=10`, fleet.gateway.url),
          { headers },
        );
        request = ((await polled.json()) as { request: typeof request }).request;
      }
      expect(request.state).toBe("granted");
      const id = (request as unknown as { lease: { id: string } }).lease.id;
      // why: a lease the gateway issued names its worker in its id.
      expect(id).toContain(".");
      await openConsole(page, fleet.gateway, "/leases");
      await page
        .locator("main tbody tr")
        .filter({ has: page.locator(`a[href^="/leases/${encodeURIComponent(id)}/"]`) })
        .click();
      const idFact = () =>
        page
          .getByRole("region", { exact: true, name: "Lease" })
          .locator("dt", { hasText: /^Lease id$/ })
          .locator("xpath=following-sibling::dd[1]");
      await expect(idFact()).toHaveText(id);

      await page.reload();

      await expect(idFact()).toHaveText(id);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("the real gateway answers the older page of events once and the history starts, and no join token reaches the page in any event", async ({
    page,
  }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
    try {
      const [joinToken = ""] = fleet.joinTokens;
      await takeLease(fleet.gateway, "journey-older-a");
      await takeLease(fleet.gateway, "journey-older-b");
      const queries: string[] = [];
      let all: Envelope[] = [];
      await page.route(
        (url) => url.pathname === "/v1/events",
        async (route: Route) => {
          const { search } = new URL(route.request().url());
          if (!search.startsWith("?since=")) {
            queries.push(search);
            await route.fallback();
            return;
          }
          // why: the page holds only the newest two events, so the rest must come from the daemon's older page.
          const read = await fetch(new URL("/v1/events?since=1h", fleet.gateway.url), {
            headers: { Authorization: `Bearer ${fleet.gateway.tokens.operator}` },
          });
          all = ((await read.json()) as { events: Envelope[] }).events.toSorted(
            (a, b) => b.seq - a.seq,
          );
          await route.fulfill({
            headers: { date: new Date().toUTCString() },
            json: { events: all.slice(0, 2) },
          });
        },
      );
      await openConsole(page, fleet.gateway, "/activity");
      await expect(page.getByText("Start of the history (", { exact: false })).toBeVisible();
      expect(all.length).toBeGreaterThan(3);
      expect(queries).toEqual([`?before=${encodeURIComponent(all[1]!.id)}&limit=100`]);
      await expect.poll(() => eventsHeld(page)).toBe(all.length);
      await expect(
        page.getByText(`Start of the history (${localMinute(all.at(-1)!.timestamp)})`),
      ).toBeVisible();

      // why: the page reads the whole hour itself from here on, so its rows stand still to be opened.
      await page.unrouteAll({ behavior: "wait" });
      await page.reload();
      await expect(feed(page).getByRole("listitem").first()).toBeVisible();
      await expect.poll(() => eventsHeld(page)).toBe(all.length);
      const seen: string[] = [];
      for (const event of all) {
        await openEvent(page, event.id);
        await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(event.event);
        seen.push(await page.getByRole("dialog").innerText());
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      expect(seen.join("\n")).not.toContain(joinToken);
      expect(await page.content()).not.toContain(joinToken);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
