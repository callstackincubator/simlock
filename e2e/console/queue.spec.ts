import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

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

async function openWaiting(page: Page, daemon: RunningDaemon, path = "/queue"): Promise<void> {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  // why: a drawer over the page hides the page's heading from the accessibility tree.
  if (new URL(path, daemon.url).pathname === "/queue") {
    await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
  } else await expect(page.getByRole("dialog")).toBeVisible();
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
  test("Queue lists each waiting request with place, requester, device, stage, why and wait, and a row opens its drawer with the inspector's facts", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await holdTheDevice(host, "holder");
      host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      host.cliBackground([...LEASE, "--agent-id", "agent-c", "--mode", "slim"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 2);

      await openWaiting(page, host);

      await expect(row(page, "agent-b")).toContainText("#1");
      await expect(row(page, "agent-b")).toContainText("iOS iPhone 16, runtime 18.4");
      await expect(row(page, "agent-b")).toContainText("queued");
      await expect(row(page, "agent-c")).toContainText("#2");
      await expect(row(page, "agent-c")).toContainText("iOS iPhone 16, runtime 18.4, mode slim");
      await expect(page.getByText("2 waiting")).toBeVisible();

      await expect(row(page, "agent-b")).toContainText("Full: device limit");
      await expect(row(page, "agent-b").locator("td").last()).toHaveText(/^\d+ s|\d+ min/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/queue");

      await row(page, "agent-c").getByRole("link", { name: "agent-c" }).click();
      const drawer = drawerOf(page, "agent-c");
      await expect(drawer).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/^\/queue\/.+/);
      for (const label of ["Waiting", "Place", "Stage", "Device", "Queue", "Why"]) {
        await expect(drawer.locator("dt", { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
      }
      await expect(drawer).toContainText("2 of 2");
      await expect(drawer).toContainText("iOS iPhone 16, runtime 18.4, mode slim");
      const waited = drawer.locator("dd").first();
      const before = await waited.textContent();
      await expect(waited).not.toHaveText(before ?? "", { timeout: 3_000 });
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, a worker's request links to that worker and the fleet queue's request names the gateway's queue", async ({
    page,
  }) => {
    const gateway = await startDaemon("gateway");
    let worker: RunningDaemon | undefined;
    try {
      worker = await startDaemon("worker", {
        config: {
          ...ONE_DEVICE,
          gateway: {
            label: "worker-a",
            token: gateway.tokens.worker,
            url: `ws://127.0.0.1:${String(gateway.port)}`,
          },
        },
        driverScript: { ios: IOS },
      });
      // why: A local agent on the worker takes the fleet's one device, and a second one waits in the
      // worker's own queue. A further lease through the gateway then waits in the gateway's.
      await holdTheDevice(worker, "local-a");
      worker.cliBackground([...LEASE, "--agent-id", "local-b"]);
      await untilTheDaemonSays(gateway, (requests) =>
        requests.some((request) => request.requesterId === "local-b"),
      );
      gateway.cliBackground([...LEASE, "--agent-id", "fleet-c"]);
      await untilTheDaemonSays(gateway, (requests) =>
        requests.some((request) => request.requesterId === "fleet-c"),
      );

      await openWaiting(page, gateway);

      await row(page, "local-b").getByRole("link").click();
      const local = drawerOf(page, "local-b");
      await expect(local.getByRole("link", { name: "worker-a" })).toBeVisible();
      await expect(local).toContainText("1 of 1");
      await page.keyboard.press("Escape");

      await row(page, "fleet-c").getByRole("link").click();
      const fleet = drawerOf(page, "fleet-c");
      await expect(fleet).toContainText("the gateway's queue");
      await expect(fleet).toContainText("iOS iPhone 16, runtime 18.4");
      await expect(fleet).toContainText("queued");
      await expect(fleet).toContainText("1 of 1");
    } finally {
      await worker?.dispose();
      await gateway.dispose();
    }
  });

  test("a request that is granted while its drawer is open leaves the list within a second, and the drawer says Request not waiting", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      const held = await holdTheDevice(host, "holder");
      const waiter = host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      await openWaiting(page, host);
      await row(page, "agent-b").getByRole("link").click();
      await expect(drawerOf(page, "agent-b")).toBeVisible();

      expect((await host.cli(["release", held])).code).toBe(0);
      const grant = JSON.parse(await waiter.firstStdoutLine(10_000)) as {
        lease: { requesterId: string };
      };
      expect(grant.lease.requesterId).toBe("agent-b");
      await untilTheDaemonSays(host, (requests) => requests.length === 0);

      await expect(page.getByText("Request not waiting.")).toBeVisible({ timeout: 1_000 });
      await page.keyboard.press("Escape");
      expect(new URL(page.url()).pathname).toBe("/queue");
      await expect(row(page, "agent-b")).toHaveCount(0);
      await expect(page.getByText("No requests are waiting.")).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("a request id that was never waiting says it is not waiting", async ({ page }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await openWaiting(page, host, "/queue/req_none");

      await expect(page.getByRole("dialog").getByText("Request not waiting.")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("loaded directly at a request's address, closing the drawer replaces the address with /queue", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await openWaiting(page, host, "/queue/req_none");
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      const entries = await page.evaluate(() => window.history.length);

      await page.keyboard.press("Escape");

      await expect(drawer).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/queue");
      expect(await page.evaluate(() => window.history.length)).toBe(entries);
    } finally {
      await host.dispose();
    }
  });

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
      await page.keyboard.press(tab);
      await page.keyboard.type(host.tokens.operator);
      await page.keyboard.press("Enter");
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
