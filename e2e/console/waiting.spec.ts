import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";

/** What `GET /v1/lease-requests` answers, as far as these tests read. */
interface WaitingRequest {
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

async function openWaiting(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(new URL("/waiting", daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Waiting" })).toBeVisible();
}

/** A waiting request's row, by its requester. */
function row(page: Page, requester: string): Locator {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: requester, exact: true }) });
}

function cell(scope: Locator, label: string): Locator {
  return scope.locator(`td[data-label="${label}"]`);
}

/** Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Waiting view", () => {
  test("a request waiting for a device appears with its requester, spec, time waited and queue position", async ({
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

      const b = row(page, "agent-b");
      await expect(cell(b, "Device")).toHaveText("iOS iPhone 16, runtime 18.4");
      await expect(cell(b, "Stage")).toHaveText("queued");
      await expect(cell(b, "Place in queue")).toHaveText("1");
      await expect(cell(b, "Waiting for")).toHaveText(/^\d+ s$/);
      const c = row(page, "agent-c");
      await expect(cell(c, "Device")).toHaveText("iOS iPhone 16, runtime 18.4, mode slim");
      await expect(cell(c, "Place in queue")).toHaveText("2");
      // The time waited counts on in the browser, with no reload.
      const before = await cell(c, "Waiting for").textContent();
      await expect(cell(c, "Waiting for")).not.toHaveText(before ?? "", { timeout: 3_000 });
    } finally {
      await host.dispose();
    }
  });

  test("on a gateway, the fleet queue's requests and a worker's own appear, the worker's with that worker", async ({
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
      // A local agent on the worker takes its one device, and a second one waits in the
      // worker's own queue. A fleet request for a model no worker lists waits in the gateway's.
      await holdTheDevice(worker, "local-a");
      worker.cliBackground([...LEASE, "--agent-id", "local-b"]);
      gateway.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 99",
        "--agent-id",
        "fleet-c",
      ]);
      await untilTheDaemonSays(
        gateway,
        (requests) =>
          requests.some((request) => request.requesterId === "fleet-c") &&
          requests.some((request) => request.requesterId === "local-b"),
      );

      await openWaiting(page, gateway);

      await expect(cell(row(page, "local-b"), "Worker")).toHaveText("worker-a");
      await expect(cell(row(page, "local-b"), "Place in queue")).toHaveText("1");
      await expect(cell(row(page, "fleet-c"), "Device")).toHaveText("iOS iPhone 99");
      await expect(cell(row(page, "fleet-c"), "Place in queue")).toHaveText("1");
      await expect(cell(row(page, "fleet-c"), "Worker")).toHaveText("—");
    } finally {
      await worker?.dispose();
      await gateway.dispose();
    }
  });

  test("a waiting request leaves the view within a second of being granted", async ({ page }) => {
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      const held = await holdTheDevice(host, "holder");
      host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      await openWaiting(page, host);
      await expect(row(page, "agent-b")).toBeVisible();

      expect((await host.cli(["release", held])).code).toBe(0);
      await untilTheDaemonSays(host, (requests) => requests.length === 0);

      await expect(row(page, "agent-b")).toHaveCount(0, { timeout: 1_000 });
      await expect(page.getByText("No requests are waiting.")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("the Waiting view has no horizontal scroll at 360px wide", async ({ page }) => {
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

      await expect(page.locator("tbody tr")).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the Waiting view is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
    try {
      await holdTheDevice(host, "holder");
      host.cliBackground([...LEASE, "--agent-id", "agent-b"]);
      await untilTheDaemonSays(host, (requests) => requests.length === 1);
      const listed = await host.cli(["worker", "list", "--json"]);
      const hostId = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
      /** Tabs forward until the link named `label` has focus, and follows it with Enter. */
      const follow = async (label: string) => {
        const link = page.getByRole("link", { name: label, exact: true });
        for (let step = 0; step < 20; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(tab);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await page.goto(host.url);
      await page.keyboard.press(tab);
      await page.keyboard.type(host.tokens.operator);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      await follow("Waiting");
      await expect(page.getByRole("heading", { level: 1, name: "Waiting" })).toBeVisible();
      await expect(row(page, "agent-b")).toBeVisible();

      // The request's worker opens that worker's page.
      await follow(hostId);
      await expect(page.getByRole("heading", { level: 1, name: hostId })).toBeVisible();
    } finally {
      await host.dispose();
    }
  });
});
