import type { Locator, Page } from "@playwright/test";

import {
  expect,
  type RunningDaemon,
  signIn,
  signInWithKeyboard,
  startDaemon,
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

async function openLeases(page: Page, daemon: RunningDaemon, path = "/leases"): Promise<void> {
  await page.goto(new URL(path, daemon.url).toString());
  await signIn(page, daemon.tokens.operator);
  // why: a drawer hides the page behind it from assistive technology, so a direct load finds the heading by hidden role too.
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

// why: from 1280px wide the inspector is a pane beside the table; below that a lease opens as a dialog.
function pane(page: Page): Locator {
  return page.getByRole("region", { exact: true, name: "Lease" });
}

function summary(page: Page): Locator {
  return page.getByRole("region", { exact: true, name: "Lease summary" });
}

function fact(container: Locator, label: string): Locator {
  return container
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
  test("a lease row opens its inspector in the summary's place and the table does not move", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-first");
      const [lease] = (await listLeases(host)) as [ListedLease];

      await openLeases(page, host);

      await expect(summary(page)).toBeVisible();
      // why: the page slides in once when it opens; measure after it has settled.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      const before = await boxOf(page.locator("main .table-card"));
      const summaryBox = await boxOf(summary(page));

      await leaseRow(page, lease.id).click();

      await expect(pane(page)).toContainText("agent-first");
      expect(await boxOf(page.locator("main .table-card"))).toEqual(before);
      expect(await boxOf(pane(page))).toMatchObject({ width: summaryBox.width, x: summaryBox.x });
      expect(summaryBox.width).toBe(420);
    } finally {
      await host.dispose();
    }
  });

  test("the inspector is a pane at 1280px wide and a modal drawer at 1279px, with the dim layer over the sidebar", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await leaseOverSocket(host, "agent-dim");
      const [lease] = (await listLeases(host)) as [ListedLease];
      await page.setViewportSize({ height: 800, width: 1280 });
      await openLeases(page, host, `/leases/${encodeURIComponent(lease.id)}/`);
      await expect(pane(page)).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await page.setViewportSize({ height: 800, width: 1279 });

      await expect(page.getByRole("dialog", { name: /agent-dim/ })).toBeVisible();
      const covered = await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>(".sidebar-nav a");
        const box = link?.getBoundingClientRect();
        if (box === undefined) return undefined;
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top?.classList.contains("drawer-dim");
      });
      expect(covered).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/leases");
      await expect(summary(page)).toBeVisible();
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

  test("the toolbar puts the search box beside the filter chips, and the chips start at the table's edge", async ({
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

      expect(chips.x).toBeCloseTo(table.x, 0);
      expect(title.x - table.x).toBeCloseTo(4, 0);
      expect(search.x - (chips.x + chips.width)).toBeCloseTo(8, 0);
      expect(search.width).toBeCloseTo(290, 0);
    } finally {
      await host.dispose();
    }
  });

  test("the leases page has no horizontal scroll at 360px wide, shows the list and then the summary before a lease", async ({
    page,
  }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      const ci = await labelledToken(host, "ci-runner-3");
      const granted = await leaseOverHttp(host, ci.secret);
      await page.setViewportSize({ height: 740, width: 360 });
      await openLeases(page, host);
      await expect(leaseRow(page, granted.id)).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const table = await boxOf(page.locator("main .table-card"));
      expect((await boxOf(summary(page))).x).toBeCloseTo(table.x, 0);
      expect(await hasHorizontalScroll(page)).toBe(false);

      await leaseRow(page, granted.id).click();
      const drawer = page.getByRole("dialog", { name: /ci-runner-3/ });
      await expect(drawer).toBeVisible();
      await expect(fact(drawer, "Lease id")).toHaveText(granted.id);
      await expect(page.getByRole("tab")).toHaveCount(0);
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
      await expect(pane(page)).toContainText("ci-runner-3");
      await follow(pane(page).getByRole("button", { name: "Close lease" }));
      await expect.poll(() => new URL(page.url()).pathname).toBe("/leases");
      await expect(rowLink(page, granted.id)).toBeFocused();
    } finally {
      await host.dispose();
    }
  });
});
