import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

/** One lease as `simlock list --leases` prints it, as far as these tests read. */
interface ListedLease {
  readonly id: string;
  readonly requesterId: string;
  readonly deviceId: string;
  readonly ttlDeadline: number;
  readonly workerId?: string;
}

/** A granted lease as `GET /v1/lease-requests/{id}` hands it back. */
interface GrantedLease {
  readonly id: string;
  readonly requestId?: string;
  readonly udid: string;
  readonly device: string;
  readonly mode: string;
}

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function listLeases(daemon: RunningDaemon): Promise<readonly ListedLease[]> {
  const listed = await daemon.cli(["list", "--leases"]);
  expect(listed.code, listed.stderr).toBe(0);
  return listed.json as readonly ListedLease[];
}

/** A token created with `--label`, as an operator would make one for an agent. */
async function labelledToken(
  daemon: RunningDaemon,
  label: string,
): Promise<{ readonly id: string; readonly secret: string }> {
  const minted = await daemon.cli(["token", "create", "--role", "agent", "--label", label]);
  expect(minted.code, minted.stderr).toBe(0);
  const { secret, token } = minted.json as { secret: string; token: { id: string } };
  return { id: token.id, secret };
}

/** Takes a lease over HTTP with `secret`, as an agent with that token would. */
async function leaseOverHttp(
  daemon: RunningDaemon,
  secret: string,
  options: { readonly model?: string; readonly ttlMs?: number } = {},
): Promise<GrantedLease> {
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const created = await fetch(new URL("/v1/lease-requests", daemon.url), {
    body: JSON.stringify({
      device: options.model ?? "iPhone 16",
      os: "18.4",
      platform: "ios",
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
    headers,
    method: "POST",
  });
  expect(created.status).toBe(201);
  let request = ((await created.json()) as { request: { id: string; state: string } }).request;
  const id = request.id;
  for (let attempt = 0; request.state !== "granted" && attempt < 6; attempt += 1) {
    const polled = await fetch(new URL(`/v1/lease-requests/${id}?wait=10`, daemon.url), {
      headers,
    });
    request = ((await polled.json()) as { request: typeof request }).request;
  }
  expect(request.state).toBe("granted");
  return (request as unknown as { lease: GrantedLease }).lease;
}

/** Takes a lease over the local socket, as an agent on the host would: no token names it. */
async function leaseOverSocket(daemon: RunningDaemon, agent: string, model = "iPhone 16") {
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

/**
 * Waits, asking every 20 ms, until the daemon's own `GET /v1/leases` says what `predicate` looks
 * for. The console's second starts there: it cannot show a fact before its daemon has it.
 */
async function untilTheDaemonSays(
  daemon: RunningDaemon,
  predicate: (leases: readonly ListedLease[]) => boolean,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(new URL("/v1/leases", daemon.url), {
        headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
      });
      return predicate(((await response.json()) as { leases: ListedLease[] }).leases);
    },
    { interval: 20, label: "the daemon's own lease list", timeout: 10_000 },
  );
}

async function openLeases(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
  await page.getByRole("link", { name: "Leases", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
}

/** A lease's row, by its id. */
function leaseRow(page: Page, id: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: id, exact: true }) });
}

/** A lease's cell in the column named `label`. */
function leaseCell(page: Page, id: string, label: string): Locator {
  return leaseRow(page, id).locator(`td[data-label="${label}"]`);
}

/** The value beside a label in a list of facts. */
function fact(page: Page, label: string): Locator {
  return page
    .locator("#main dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

/** The table under a heading on a worker's page. */
function tableUnder(page: Page, heading: string): Locator {
  return page
    .getByRole("heading", { level: 2, name: heading })
    .locator("xpath=following-sibling::*[1]");
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the leases views", () => {
  test("every lease in simlock list --leases appears in the fleet view", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      const [workerA] = fleet.workers as [RunningDaemon];
      const ci = await labelledToken(fleet.gateway, "ci-runner-3");
      // Through the gateway with a token, through the gateway's socket, and on a worker itself.
      await leaseOverHttp(fleet.gateway, ci.secret);
      await leaseOverSocket(fleet.gateway, "console-e2e", "iPhone 17");
      await leaseOverSocket(workerA, "local-agent");
      await waitFor(async () => (await listLeases(fleet.gateway)).length === 3, {
        label: "the gateway lists all three leases",
      });
      const listed = await listLeases(fleet.gateway);
      const workers = (
        (await fleet.gateway.cli(["worker", "list", "--json"])).json as {
          workers: { id: string; label: string }[];
        }
      ).workers;

      await openLeases(page, fleet.gateway);

      await expect(page.locator("tbody tr")).toHaveCount(listed.length);
      for (const lease of listed) {
        await expect(leaseRow(page, lease.id), lease.id).toBeVisible();
        const holder = lease.requesterId === ci.id ? `ci-runner-3 ${ci.id}` : lease.requesterId;
        await expect(leaseCell(page, lease.id, "Holder")).toHaveText(holder);
        const worker = workers.find((candidate) => candidate.id === lease.workerId);
        await expect(leaseCell(page, lease.id, "Worker")).toHaveText(worker?.label ?? "");
        await expect(leaseCell(page, lease.id, "Device")).toContainText(lease.deviceId);
        await expect(leaseCell(page, lease.id, "Expires in")).toHaveText(/^\d+ min( \d+ s)?$/);
      }
      expect(listed.map((lease) => lease.requesterId)).toContain(ci.id);
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a lease taken with a token labelled ci-runner-3 shows ci-runner-3 as its holder", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);

      await openLeases(page, host);

      await expect(leaseCell(page, granted.id, "Holder")).toHaveText(`ci-runner-3 ${ci.id}`);
    } finally {
      await host.dispose();
    }
  });

  test("a worker's detail lists only that worker's leases", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      await leaseOverSocket(fleet.gateway, "agent-a", "iPhone 16");
      await leaseOverSocket(fleet.gateway, "agent-b", "iPhone 17");
      await waitFor(async () => (await listLeases(fleet.gateway)).length === 2, {
        label: "the gateway lists both leases",
      });
      const listed = await listLeases(fleet.gateway);
      const holderOf = { "worker-a": "agent-a", "worker-b": "agent-b" } as const;

      await openLeases(page, fleet.gateway);
      for (const label of ["worker-a", "worker-b"] as const) {
        await page.getByRole("link", { name: "Workers", exact: true }).click();
        await page.getByRole("link", { name: label, exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();

        const own = listed.filter((lease) => lease.requesterId === holderOf[label]);
        expect(own).toHaveLength(1);
        const rows = tableUnder(page, "Leases").locator("tbody tr");
        await expect(rows).toHaveCount(1);
        await expect(rows.getByRole("link", { name: own[0]?.id ?? "", exact: true })).toBeVisible();
      }
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a lease opens to its details on a gateway", async ({ page }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: { ...IOS, knownModels: ["iPhone 17"] } }, label: "worker-b" },
    ]);
    try {
      const [, workerB] = fleet.workers as [RunningDaemon, RunningDaemon];
      const ci = await labelledToken(fleet.gateway, "ci-runner-3");
      const granted = await leaseOverHttp(fleet.gateway, ci.secret);
      await leaseOverSocket(workerB, "local-agent", "iPhone 17");
      await waitFor(async () => (await listLeases(fleet.gateway)).length === 2, {
        label: "the gateway lists both leases",
      });
      const local = (await listLeases(fleet.gateway)).find((lease) => lease.id !== granted.id);
      // A lease the gateway issued names its worker in its id.
      expect(granted.id).toContain(".");

      await openLeases(page, fleet.gateway);
      await page.getByRole("link", { name: granted.id, exact: true }).click();

      await expect(page.getByRole("heading", { level: 1, name: granted.id })).toBeVisible();
      await expect(fact(page, "Holder")).toHaveText(`ci-runner-3 ${ci.id}`);
      await expect(fact(page, "Worker")).toHaveText("worker-a");
      await expect(fact(page, "Device")).toContainText(granted.device);
      await expect(fact(page, "UDID")).toHaveText(granted.udid);
      await expect(fact(page, "Mode")).toHaveText(granted.mode);
      await expect(fact(page, "Request")).toHaveText(granted.requestId ?? "");
      await expect(fact(page, "Expires in")).toHaveText(/^\d+ min( \d+ s)?$/);
      // The page's own address survives a reload, though the id holds a `.`.
      await page.reload();
      await expect(fact(page, "UDID")).toHaveText(granted.udid);

      // A worker's own lease, which the gateway did not issue, opens too.
      await page.getByRole("link", { name: "All leases" }).click();
      await page.getByRole("link", { name: local?.id ?? "", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: local?.id ?? "" })).toBeVisible();
      await expect(fact(page, "Holder")).toHaveText("local-agent");
      await expect(fact(page, "Worker")).toHaveText("worker-b");
      await expect(fact(page, "UDID")).not.toHaveText("—");
    } finally {
      await disposeFleet(fleet);
    }
  });

  test("a lease opens to its details on a single host", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      // A single host is a fleet of one: the host itself, named by its id.
      const [view] = (
        (await host.cli(["worker", "list", "--json"])).json as { workers: { id: string }[] }
      ).workers;

      await openLeases(page, host);
      await page.getByRole("link", { name: granted.id, exact: true }).click();

      await expect(page.getByRole("heading", { level: 1, name: granted.id })).toBeVisible();
      await expect(fact(page, "Holder")).toHaveText(`ci-runner-3 ${ci.id}`);
      await expect(fact(page, "Worker")).toHaveText(view?.id ?? "");
      await expect(fact(page, "UDID")).toHaveText(granted.udid);
      await expect(fact(page, "Request")).toHaveText(granted.requestId ?? "");
      await page.reload();
      await expect(fact(page, "UDID")).toHaveText(granted.udid);
    } finally {
      await host.dispose();
    }
  });

  test("a released lease leaves the view within a second, without a reload", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-1");
      await leaseOverSocket(host, "agent-2");
      const [released, kept] = (await listLeases(host)) as [ListedLease, ListedLease];
      await openLeases(page, host);
      await expect(page.locator("tbody tr")).toHaveCount(2);

      expect((await host.cli(["release", released.id])).code).toBe(0);
      await untilTheDaemonSays(host, (leases) => leases.every((lease) => lease.id !== released.id));

      await expect(leaseRow(page, released.id)).toHaveCount(0, { timeout: 1_000 });
      await expect(leaseRow(page, kept.id)).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("a lease's page says it is not found once the lease is released", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-1");
      const [released] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host);
      await page.getByRole("link", { name: released.id, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: released.id })).toBeVisible();

      expect((await host.cli(["release", released.id])).code).toBe(0);

      await expect(page.getByRole("heading", { level: 1, name: "Lease not found" })).toBeVisible();
      await expect(fact(page, "UDID")).toHaveCount(0);
    } finally {
      await host.dispose();
    }
  });

  test("a renewed lease shows its new expiry within a second", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret, { ttlMs: 120_000 });
      const [before] = await listLeases(host);
      await openLeases(page, host);
      const expiry = leaseCell(page, granted.id, "Expires in");
      await expect(expiry).toHaveText(/^1 min \d+ s$/);

      const renewed = await fetch(new URL(`/v1/leases/${granted.id}/renew`, host.url), {
        body: JSON.stringify({ ttlMs: 3_000_000 }),
        headers: { Authorization: `Bearer ${ci.secret}`, "Content-Type": "application/json" },
        method: "POST",
      });
      expect(renewed.status).toBe(200);
      await untilTheDaemonSays(host, (leases) =>
        leases.some(
          (lease) => lease.id === granted.id && lease.ttlDeadline > (before?.ttlDeadline ?? 0),
        ),
      );

      await expect(expiry).toHaveText(/^(49|50) min( \d+ s)?$/, { timeout: 1_000 });
    } finally {
      await host.dispose();
    }
  });

  test("the leases views have no horizontal scroll at 360px wide", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      await page.setViewportSize({ height: 740, width: 360 });
      await openLeases(page, host);
      await expect(leaseRow(page, granted.id)).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);

      await page.getByRole("link", { name: granted.id, exact: true }).click();
      await expect(fact(page, "UDID")).toHaveText(granted.udid);
      expect(await hasHorizontalScroll(page)).toBe(false);

      await page.getByRole("link", { name: "Workers", exact: true }).click();
      await page.locator(".card").getByRole("link").click();
      await expect(tableUnder(page, "Leases").locator("tbody tr")).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the leases views are usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      /**
       * Tabs until the link named `label` has focus, forward or, for a link earlier on the page
       * such as the navigation, backward, and follows it with Enter.
       */
      const follow = async (label: string, direction: "forward" | "backward" = "forward") => {
        const link = page.getByRole("link", { name: label, exact: true });
        const key = direction === "forward" ? tab : `Shift+${tab}`;
        for (let step = 0; step < 30; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(key);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await page.goto(host.url);
      await page.keyboard.press(tab);
      await page.keyboard.type(host.tokens.operator);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      await follow("Leases");
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
      await follow(granted.id);
      await expect(page.getByRole("heading", { level: 1, name: granted.id })).toBeVisible();
      await follow("All leases");
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();

      // The same lease, from the table on its worker's page.
      const [view] = (
        (await host.cli(["worker", "list", "--json"])).json as { workers: { id: string }[] }
      ).workers;
      const name = view?.id ?? "";
      await follow("Workers", "backward");
      await follow(name);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await follow(granted.id);
      await expect(page.getByRole("heading", { level: 1, name: granted.id })).toBeVisible();
    } finally {
      await host.dispose();
    }
  });
});
