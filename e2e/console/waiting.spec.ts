import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

/** What `GET /v1/lease-requests` answers, as far as these tests read. */
interface WaitingRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly queuePosition?: number;
  readonly workerId?: string;
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
/** One iOS device and no more, so a second request waits. */
const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

/** Leases the host's one device for `agent`, and answers the lease id. */
async function holdTheDevice(daemon: RunningDaemon, agent: string): Promise<string> {
  const granted = await daemon.cli([...LEASE, "--agent-id", agent, "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

/** The daemon's own `GET /v1/lease-requests`, asked as an operator. */
async function waiting(daemon: RunningDaemon): Promise<readonly WaitingRequest[]> {
  const response = await fetch(new URL("/v1/lease-requests", daemon.url), {
    headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { requests: WaitingRequest[] }).requests;
}

/**
 * Waits, asking every 20 ms, until the daemon's own list says what `predicate` looks for. The
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

async function openWaiting(page: Page, daemon: RunningDaemon, path = "/waiting"): Promise<void> {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Waiting" })).toBeVisible();
}

function row(page: Page, requester: string): Locator {
  return page
    .getByRole("list", { name: "Waiting requests" })
    .getByRole("link")
    .filter({ hasText: requester });
}

function inspectorOf(page: Page, requester: string): Locator {
  return page.getByRole("region", { name: requester, exact: true });
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Waiting page", () => {
  test("a request waiting for a device appears in the list with its place, device and stage, and opens with its time waited", async ({
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

      // why: With no request named, the first row is the one shown, and the URL stays as it was.
      await expect(page.getByRole("heading", { level: 2, name: "agent-b" })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/waiting");

      await row(page, "agent-c").click();
      await expect(page.getByRole("heading", { level: 2, name: "agent-c" })).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/^\/waiting\/.+/);
      const inspector = inspectorOf(page, "agent-c");
      await expect(inspector).toContainText("wants iOS iPhone 16, runtime 18.4, mode slim");
      await expect(inspector).toContainText("2 of 2");
      await expect(inspector.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
      // The time waited counts on in the browser, with no reload.
      const waited = inspector.locator(".waiting-card-value").first();
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
      // A local agent on the worker takes the fleet's one device, and a second one waits in the
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

      await row(page, "local-b").click();
      const local = inspectorOf(page, "local-b");
      await expect(local.getByRole("link", { name: "worker-a" })).toBeVisible();
      await expect(local).toContainText("1 of 1");

      await row(page, "fleet-c").click();
      const fleet = inspectorOf(page, "fleet-c");
      await expect(fleet).toContainText("the gateway's queue");
      await expect(fleet).toContainText("iOS iPhone 16, runtime 18.4");
      await expect(fleet).toContainText("queued");
      await expect(fleet).toContainText("1 of 1");
    } finally {
      await worker?.dispose();
      await gateway.dispose();
    }
  });

  test("a waiting request leaves the list within a second of being granted, and its own page says it is not waiting", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      const held = await holdTheDevice(host, "holder");
      const waiter = host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      await openWaiting(page, host);
      await row(page, "agent-b").click();
      await expect(page.getByRole("heading", { level: 2, name: "agent-b" })).toBeVisible();

      expect((await host.cli(["release", held])).code).toBe(0);
      const grant = JSON.parse(await waiter.firstStdoutLine(10_000)) as {
        lease: { requesterId: string };
      };
      expect(grant.lease.requesterId).toBe("agent-b");
      await untilTheDaemonSays(host, (requests) => requests.length === 0);

      await expect(row(page, "agent-b")).toHaveCount(0, { timeout: 1_000 });
      await expect(page.getByText("No requests are waiting.")).toBeVisible();
      await expect(page.getByText("Request not waiting.")).toBeVisible();

      await page.getByRole("link", { name: "Back to waiting" }).click();
      expect(new URL(page.url()).pathname).toBe("/waiting");
      await expect(page.getByText("Request not waiting.")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("a request id that was never waiting says it is not waiting", async ({ page }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await openWaiting(page, host, "/waiting/req_none");

      await expect(page.getByText("Request not waiting.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to waiting" })).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("the Waiting page has no horizontal scroll at 360px wide", async ({ page }) => {
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

      await expect(
        page.getByRole("list", { name: "Waiting requests" }).getByRole("link"),
      ).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
      await page.getByRole("list", { name: "Waiting requests" }).getByRole("link").click();
      await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      await settled(page);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the Waiting page is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
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
      await page.goto(new URL("/waiting", host.url).toString());
      await page.keyboard.press(tab);
      await page.keyboard.type(host.tokens.operator);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Waiting" })).toBeVisible();

      await follow(row(page, "agent-b"));
      await expect(page.getByRole("heading", { level: 2, name: "agent-b" })).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/^\/waiting\/.+/);

      // The request's worker opens that worker's page.
      await follow(inspectorOf(page, "agent-b").getByRole("link").last());
      expect(new URL(page.url()).pathname).toMatch(/^\/workers\/.+/);
    } finally {
      await host.dispose();
    }
  });
});
