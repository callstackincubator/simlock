import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
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
import { returnToTab } from "./tab.js";

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

async function openLeases(page: Page, daemon: RunningDaemon, path = "/leases"): Promise<void> {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  // why: the drawer hides the page behind it from assistive technology, so a direct load finds the heading by hidden role too.
  await expect(
    page.getByRole("heading", { includeHidden: true, level: 1, name: "Leases" }),
  ).toBeVisible();
}

function leaseRow(page: Page, id: string): Locator {
  return page
    .locator("main tbody tr")
    .filter({ has: page.locator(`a[href^="/leases/${encodeURIComponent(id)}/"]`) });
}

function rowLink(page: Page, id: string): Locator {
  return leaseRow(page, id).locator("a").first();
}

function inspectorTitle(page: Page, name: string | RegExp): Locator {
  return page.getByRole("heading", { level: 2, name });
}

function card(page: Page, name: string): Locator {
  return page.getByRole("region", { exact: true, name });
}

function fact(page: Page, cardName: string, label: string): Locator {
  return card(page, cardName)
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

async function boxOf(locator: Locator): Promise<{ x: number; width: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box");
  return box;
}

test.describe("the leases page", () => {
  test("every lease in simlock list --leases appears in the fleet list", async ({ page }) => {
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

      await expect(page.locator("main tbody tr")).toHaveCount(listed.length);
      await expect(page.getByText(`${listed.length} held`)).toBeVisible();
      for (const lease of listed) {
        const row = leaseRow(page, lease.id);
        await expect(row, lease.id).toBeVisible();
        await expect(row).toContainText(
          lease.requesterId === ci.id ? "ci-runner-3" : lease.requesterId,
        );
        const worker = workers.find((candidate) => candidate.id === lease.workerId);
        await expect(row).toContainText(worker?.label ?? "");
        await expect(row).toContainText(/\d+ min( \d+ s)?|\d+ s/);
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

      await expect(leaseRow(page, granted.id)).toContainText("ci-runner-3");
      await expect(leaseRow(page, granted.id)).not.toContainText(ci.id);
    } finally {
      await host.dispose();
    }
  });

  test("a lease row opens a dialog named after its holder at the lease's address, on its Details tab, over the table, and nothing opens by itself", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-first");
      await leaseOverSocket(host, "agent-second");
      const first = (await listLeases(host)).find((lease) => lease.requesterId === "agent-first");

      await openLeases(page, host);

      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/leases");

      await leaseRow(page, first?.id ?? "").click();

      const drawer = page.getByRole("dialog", { name: /agent-first/ });
      await expect(drawer).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(`/leases/${encodeURIComponent(first?.id ?? "")}/`);
      await expect(drawer.getByRole("tab", { name: "Details" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(fact(page, "Device", "UDID")).not.toHaveText("—");
      await expect(page.locator("main table")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("loading /leases/<id> directly opens the drawer over the table", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-direct");
      const [lease] = (await listLeases(host)) as [ListedLease];

      await openLeases(page, host, `/leases/${encodeURIComponent(lease.id)}/`);

      await expect(page.getByRole("dialog", { name: /agent-direct/ })).toBeVisible();
      await expect(leaseRow(page, lease.id)).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("loaded directly at a lease's address, closing the drawer replaces the address with /leases and focus goes to the heading", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-direct");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host, `/leases/${encodeURIComponent(lease.id)}/`);
      const drawer = page.getByRole("dialog", { name: /agent-direct/ });
      await expect(drawer).toBeVisible();
      const entries = await page.evaluate(() => window.history.length);

      await page.keyboard.press("Escape");

      await expect(drawer).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/leases");
      expect(await page.evaluate(() => window.history.length)).toBe(entries);
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeFocused();
    } finally {
      await host.dispose();
    }
  });

  test("the dim layer covers the sidebar: its links cannot be clicked while the drawer is open", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-dim");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host);
      await leaseRow(page, lease.id).click();
      await expect(page.getByRole("dialog")).toBeVisible();

      const covered = await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>(".sidebar-nav a");
        const box = link?.getBoundingClientRect();
        if (box === undefined) return undefined;
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top?.classList.contains("drawer-dim");
      });

      expect(covered).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  test("the drawer animates once: switching its tabs does not restart the animation", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-motion");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host);
      await page.evaluate(() => {
        const counted = window as unknown as { drawerStarts: number };
        counted.drawerStarts = 0;
        document.addEventListener(
          "animationstart",
          (event) => {
            if ((event.target as Element).classList.contains("drawer")) counted.drawerStarts += 1;
          },
          true,
        );
      });

      await leaseRow(page, lease.id).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      for (const name of ["Events", "Details", "Events", "Details"]) {
        await page.getByRole("tab", { name }).click();
      }
      await page.waitForTimeout(400);

      expect(
        await page.evaluate(() => (window as unknown as { drawerStarts: number }).drawerStarts),
      ).toBe(1);
    } finally {
      await host.dispose();
    }
  });

  test("at 360px wide the drawer fills the width and the page has no sideways scroll", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-narrow");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await page.setViewportSize({ height: 740, width: 360 });
      await openLeases(page, host, `/leases/${encodeURIComponent(lease.id)}/`);

      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      // why: the page reserves a scrollbar gutter, so the page is narrower than the 360px viewport.
      const available = await page.evaluate(
        () => document.documentElement.getBoundingClientRect().width,
      );
      expect((await drawer.boundingBox())?.width).toBeCloseTo(available, 0);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the drawer's close button is 40px tall with the button border", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-icon");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host, `/leases/${encodeURIComponent(lease.id)}/`);

      const shape = await page
        .getByRole("dialog")
        .getByRole("button", { name: "Close" })
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { border: style.borderTopWidth, height: element.getBoundingClientRect().height };
        });

      expect(shape).toEqual({ border: "1px", height: 40 });
    } finally {
      await host.dispose();
    }
  });

  test("the Events tab lists the events that name the lease", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-events");
      await leaseOverSocket(host, "agent-other");
      const [lease] = (await listLeases(host)) as [ListedLease, ListedLease];
      await openLeases(page, host);
      await leaseRow(page, lease.id).click();

      await page.getByRole("tab", { name: "Events" }).click();

      const events = page.getByRole("dialog").getByRole("tabpanel");
      await expect(events.getByText("lease.granted")).toHaveCount(1);
    } finally {
      await host.dispose();
    }
  });

  test("the search sets ?q= without adding history entries, a lease opened from it keeps ?q=, and closing returns to the filtered table", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-needle");
      await leaseOverSocket(host, "agent-hay");
      const found = (await listLeases(host)).find((lease) => lease.requesterId === "agent-needle");
      await openLeases(page, host, "/leases?page=2");
      const entries = await page.evaluate(() => window.history.length);

      await page.getByRole("searchbox", { name: "Search leases" }).pressSequentially("NEEDLE");

      await expect(page.locator("main tbody tr")).toHaveCount(1);
      expect(new URL(page.url()).search).toBe("?q=NEEDLE");
      expect(await page.evaluate(() => window.history.length)).toBe(entries);

      await leaseRow(page, found?.id ?? "").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(new URL(page.url()).search).toBe("?q=NEEDLE");

      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).search).toBe("?q=NEEDLE");
      await expect(page.locator("main tbody tr")).toHaveCount(1);
    } finally {
      await host.dispose();
    }
  });

  test("the toolbar puts the filter chips on the left and the search box on the right, at the page title's padding", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-bar");
      await openLeases(page, host);

      const title = await boxOf(page.getByRole("heading", { level: 1, name: "Leases" }));
      const chips = await boxOf(page.getByRole("group", { name: "Filter leases" }));
      const search = await boxOf(page.getByRole("searchbox", { name: "Search leases" }));
      const table = await boxOf(page.locator("main .table-card"));

      expect(chips.x).toBeCloseTo(title.x, 0);
      expect(search.x).toBeGreaterThan(chips.x + chips.width);
      expect(search.x + search.width).toBeCloseTo(table.x + table.width, 0);
    } finally {
      await host.dispose();
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
      await leaseRow(page, granted.id).click();

      await expect(inspectorTitle(page, /ci-runner-3/)).toBeVisible();
      await expect(fact(page, "Lease", "Holder")).toHaveText(`ci-runner-3 ${ci.id}`);
      await expect(fact(page, "Device", "Worker")).toHaveText("worker-a");
      await expect(fact(page, "Device", "Model")).toHaveText(granted.device);
      await expect(fact(page, "Device", "UDID")).toHaveText(granted.udid);
      await expect(fact(page, "Device", "Mode")).toHaveText(granted.mode);
      await expect(fact(page, "Lease", "Request")).toHaveText(granted.requestId ?? "");
      await expect(card(page, "Expires in").getByRole("timer")).toHaveText(
        /^\d+ min( \d+ s)?$|^\d+ s$/,
      );
      // The page's own address survives a reload, though the id holds a `.`.
      await page.reload();
      await expect(fact(page, "Device", "UDID")).toHaveText(granted.udid);

      // A worker's own lease, which the gateway did not issue, opens too.
      await page.keyboard.press("Escape");
      await leaseRow(page, local?.id ?? "").click();
      await expect(inspectorTitle(page, /local-agent/)).toBeVisible();
      await expect(fact(page, "Device", "Worker")).toHaveText("worker-b");
      await expect(fact(page, "Device", "UDID")).not.toHaveText("—");
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
      await leaseRow(page, granted.id).click();

      await expect(inspectorTitle(page, /ci-runner-3/)).toBeVisible();
      await expect(fact(page, "Lease", "Holder")).toHaveText(`ci-runner-3 ${ci.id}`);
      await expect(fact(page, "Device", "Worker")).toHaveText(view?.id ?? "");
      await expect(fact(page, "Device", "UDID")).toHaveText(granted.udid);
      await expect(fact(page, "Lease", "Request")).toHaveText(granted.requestId ?? "");
      await page.reload();
      await expect(fact(page, "Device", "UDID")).toHaveText(granted.udid);
    } finally {
      await host.dispose();
    }
  });

  test("the filters narrow the list to the expiring leases or to one platform", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const soon = await leaseOverHttp(host, ci.secret, { ttlMs: 120_000 });
      const nightly = await labelledToken(host, "nightly");
      const later = await leaseOverHttp(host, nightly.secret, { ttlMs: 3_000_000 });
      await openLeases(page, host);
      await expect(leaseRow(page, soon.id)).toBeVisible();
      await expect(leaseRow(page, later.id)).toBeVisible();

      await page.getByRole("radio", { name: "Ending < 5 min" }).check();
      await expect(leaseRow(page, soon.id)).toBeVisible();
      await expect(leaseRow(page, later.id)).toHaveCount(0);

      await page.getByRole("radio", { name: "iOS" }).check();
      await expect(leaseRow(page, later.id)).toBeVisible();

      await page.getByRole("radio", { name: "Android" }).check();
      await expect(page.getByText("No leases match this filter or search.")).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("a released lease leaves the list without a reload", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-1");
      await leaseOverSocket(host, "agent-2");
      const [released, kept] = (await listLeases(host)) as [ListedLease, ListedLease];
      await openLeases(page, host);
      await expect(page.locator("main tbody tr")).toHaveCount(2);

      expect((await host.cli(["release", released.id])).code).toBe(0);
      await untilTheDaemonSays(host, (leases) => leases.every((lease) => lease.id !== released.id));

      await expect(leaseRow(page, released.id)).toHaveCount(0, { timeout: 10_000 });
      await expect(leaseRow(page, kept.id)).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test('a lease that ends while its drawer is open, and an address naming a lease never held, show "This lease is not held."', async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-1");
      const [released] = (await listLeases(host)) as [ListedLease];
      await openLeases(page, host);
      await leaseRow(page, released.id).click();
      await expect(inspectorTitle(page, /agent-1/)).toBeVisible();

      expect((await host.cli(["release", released.id])).code).toBe(0);

      const drawer = page.getByRole("dialog");
      await expect(drawer.getByText("This lease is not held.")).toBeVisible();
      await expect(fact(page, "Device", "UDID")).toHaveCount(0);
      await expect(drawer.getByRole("button", { name: "Close" })).toBeVisible();

      await page.goto(new URL("/leases/lse_nobody/", host.url).toString());
      await expect(page.getByRole("dialog").getByText("This lease is not held.")).toBeVisible();
      await expect(page.locator("main")).toContainText("No leases.");
    } finally {
      await host.dispose();
    }
  });

  test("a renewed lease shows its new time left", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret, { ttlMs: 120_000 });
      const [before] = await listLeases(host);
      await openLeases(page, host);
      const expiry = leaseRow(page, granted.id);
      await expect(expiry).toContainText(/\b1 min \d+ s/);

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

      await returnToTab(page);

      await expect(expiry).toContainText(/(49|50) min/);
    } finally {
      await host.dispose();
    }
  });

  test("the leases page has no horizontal scroll at 360px wide, and shows the list before a lease", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      await page.setViewportSize({ height: 740, width: 360 });
      await openLeases(page, host);
      await expect(leaseRow(page, granted.id)).toBeVisible();
      await expect(inspectorTitle(page, /ci-runner-3/)).toBeHidden();
      expect(await hasHorizontalScroll(page)).toBe(false);

      await leaseRow(page, granted.id).click();
      await expect(inspectorTitle(page, /ci-runner-3/)).toBeVisible();
      await expect(fact(page, "Device", "UDID")).toHaveText(granted.udid);
      await expect(page.getByRole("dialog").getByRole("tab")).toHaveText(["Details", "Events"]);
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test("the leases page is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      const follow = async (link: Locator, direction: "forward" | "backward" = "forward") => {
        const key = direction === "forward" ? tab : `Shift+${tab}`;
        for (let step = 0; step < 40; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(key);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      // why: a loaded runner answers the first identity check late; holding it for a second keeps the
      // "Signing in…" screen up, so a keyboard sign-in that does not wait for the form loses here every run.
      await page.route(
        (url) => url.pathname === "/v1/identity",
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await route.continue();
        },
        { times: 1 },
      );
      await page.goto(host.url);
      await signInWithKeyboard(page, host.tokens.operator, tab);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      await follow(
        page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Leases" }),
      );
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
      await follow(rowLink(page, granted.id));
      await expect(inspectorTitle(page, /ci-runner-3/)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/leases");
    } finally {
      await host.dispose();
    }
  });
});
