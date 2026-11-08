import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  expect,
  type RunningDaemon,
  settled,
  signIn,
  signInWithKeyboard,
  startDaemon,
  test,
} from "./fixtures.js";

interface WaitingRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly queuePosition?: number;
  readonly workerId?: string;
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

async function holdTheDevice(daemon: RunningDaemon, agent: string): Promise<string> {
  const granted = await daemon.cli([...LEASE, "--agent-id", agent, "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

async function waiting(daemon: RunningDaemon): Promise<readonly WaitingRequest[]> {
  const response = await fetch(new URL("/v1/lease-requests", daemon.url), {
    headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { requests: WaitingRequest[] }).requests;
}

/**
 * why: Waits, asking every 20 ms, until the daemon's own list says what `predicate` looks for. The
 * console's second starts there: it cannot show a fact before its daemon has it.
 */
async function untilTheDaemonSays(
  daemon: RunningDaemon,
  predicate: (requests: readonly WaitingRequest[]) => boolean,
): Promise<void> {
  await waitFor(async () => predicate(await waiting(daemon)), {
    interval: 20,
    label: "the daemon's own waiting requests",
    timeout: 10_000,
  });
}

async function openWaiting(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(new URL("/queue", daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
}

function row(page: Page, requester: string): Locator {
  return page.locator("main tbody tr").filter({ hasText: requester });
}

function drawerOf(page: Page, requester: string): Locator {
  return page.getByRole("dialog", { name: requester, exact: true });
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Queue page", () => {
  test("the Queue page has no horizontal scroll at 360px wide", async ({ page }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await holdTheDevice(host, "holder");
      host.cliBackground([
        ...LEASE,
        "--agent-id",
        "an-agent-with-a-rather-long-requester-id-0123456789",
        "--mode",
        "slim",
      ]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      await page.setViewportSize({ height: 740, width: 360 });

      await openWaiting(page, host);

      await expect(page.locator("main tbody tr")).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
      await page.locator("main tbody tr").getByRole("link").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settled(page);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the Queue page is usable with the keyboard alone", async ({ browserName, page }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await holdTheDevice(host, "holder");
      host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      const follow = async (link: Locator) => {
        for (let step = 0; step < 30; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(tab);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await page.goto(new URL("/queue", host.url).toString());
      await signInWithKeyboard(page, host.tokens.operator, tab);
      await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();

      await follow(row(page, "agent-b").getByRole("link"));
      await expect(drawerOf(page, "agent-b")).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/^\/queue\/.+/);

      // why: The request's worker opens that worker's page.
      await follow(drawerOf(page, "agent-b").getByRole("link").last());
      expect(new URL(page.url()).pathname).toMatch(/^\/fleet\/.+/);
    } finally {
      await host.dispose();
    }
  });
});
