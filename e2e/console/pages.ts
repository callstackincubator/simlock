import type { Locator, Page } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type Fleet,
  NAV,
  type RunningDaemon,
  settled,
  signIn,
  startFleet,
} from "./fixtures.js";
import { endingItem, events, leases, stubJson, stubReplay, waitingItem } from "./stubs.js";

export const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
export const LEASE = [
  "lease",
  "--platform",
  "ios",
  "--device",
  "iPhone 16",
  "--os",
  "18.4",
] as const;

export interface Pages {
  readonly views: readonly { readonly label: string; readonly path: string }[];
  readonly worker: string;
  readonly device: string;
  readonly lease: string;
  readonly request: string;
  readonly event: string;
}

export interface World {
  readonly fleet: Fleet;
  readonly host: RunningDaemon;
  readonly pages: Pages;
  dispose(): Promise<void>;
}

// why: a gateway with one worker, `worker-a`, holding one lease for `console-views`: every kind of
// page the console has has something to show, and the worker's actions are offered because the
// daemon is a gateway.
export async function startWorld(): Promise<World> {
  const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "worker-a" }]);
  try {
    const host = fleet.gateway;
    const granted = await host.cli([...LEASE, "--agent-id", "console-views", "--detach"]);
    expect(granted.code, granted.stderr).toBe(0);
    const lease = (granted.json as { lease: { id: string } }).lease.id;
    const listed = await host.cli(["worker", "list", "--json"]);
    const [worker] = (listed.json as { workers: { id: string; leases: { deviceId: string }[] }[] })
      .workers;
    const workerPath = `/fleet/${encodeURIComponent(worker?.id ?? "")}`;
    const replay = await fetch(new URL("/v1/events?since=1h", host.url), {
      headers: { Authorization: `Bearer ${host.tokens.operator}` },
    });
    const first = (
      (await replay.json()) as { events: { event: string; id: string }[] }
    ).events.find((entry) => entry.event === "lease.granted");
    return {
      dispose: () => disposeFleet(fleet),
      fleet,
      host,
      pages: {
        device: `${workerPath}/${encodeURIComponent(worker?.leases[0]?.deviceId ?? "")}?tab=devices`,
        event: `/activity/${encodeURIComponent(first?.id ?? "")}`,
        lease: `/leases/${encodeURIComponent(lease)}/`,
        request: "/queue/req_none",
        views: NAV.map((entry) => ({ label: entry.label, path: entry.path })),
        worker: workerPath,
      },
    };
  } catch (error: unknown) {
    await disposeFleet(fleet);
    throw error;
  }
}

export function every(pages: Pages): readonly string[] {
  return [
    ...pages.views.map((view) => view.path),
    pages.worker,
    pages.device,
    pages.lease,
    pages.request,
    pages.event,
  ];
}

// why: a lease opens in a pane beside the table, a drawer below 1280px wide, and every other item in a drawer.
export function inspector(page: Page): Locator {
  return page.getByRole("region", { exact: true, name: "Lease" }).or(page.getByRole("dialog"));
}

// why: an open drawer hides the page behind it from assistive technology.
export function opensDrawer(path: string): boolean {
  return /^\/(leases|queue|activity|inbox)\/./.test(path) || /^\/fleet\/[^/?]+\/./.test(path);
}

export async function openSignedIn(page: Page, host: RunningDaemon): Promise<void> {
  await page.goto(host.url);
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

export async function visit(page: Page, host: RunningDaemon, path: string): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  // why: an open drawer hides the page behind it from assistive technology, so there the heading is found by hidden role too.
  await expect(
    page
      .locator("#main")
      .getByRole("heading", { includeHidden: opensDrawer(path) })
      .first(),
  ).toBeVisible();
  await expect(page.locator("#main")).not.toContainText("Loading…");
  await settled(page);
}

export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

function feedOf(page: Page): Locator {
  return page.getByRole("region", { name: "Event feed" });
}

// why: a lease's inspector holds its Release, which asks first; the daemon never answering the
// release makes the error toast, and the second Release makes the dialog.
async function openActionSurfaces(
  page: Page,
  host: RunningDaemon,
  check: (state: string) => Promise<void>,
): Promise<void> {
  await visit(page, host, "/leases");
  const row = page.locator("main tbody tr").filter({ hasText: "console-views" });
  const release = page
    .getByRole("region", { exact: true, name: "Lease" })
    .getByRole("button", { exact: true, name: "Release" });
  const dialog = page.getByRole("alertdialog", { name: "Release console-views's lease?" });
  await page.route("**/v1/leases/*", (route) =>
    route.request().method() === "DELETE" ? route.abort() : route.continue(),
  );
  await row.click();
  await release.click();
  await dialog.getByRole("button", { name: "Release lease" }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText("The daemon did not answer."),
  ).toBeVisible();
  await settled(page);
  await check("toast");

  await release.click();
  await expect(dialog).toBeVisible();
  await settled(page);
  await check("dialog");
  await page.keyboard.press("Escape");
  await page.unroute("**/v1/leases/*");
}

async function openSearch(
  page: Page,
  host: RunningDaemon,
  check: (state: string) => Promise<void>,
): Promise<void> {
  await visit(page, host, "/fleet");
  await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search pages, items and actions" }).fill("console");
  await expect(page.getByRole("option", { name: /console-views/ }).first()).toBeVisible();
  await settled(page);
  await check("search");
  await page.keyboard.press("Escape");
}

async function openPhoneMenu(
  page: Page,
  host: RunningDaemon,
  check: (state: string) => Promise<void>,
): Promise<void> {
  await page.setViewportSize({ height: 844, width: 390 });
  await visit(page, host, "/");
  await page.getByRole("button", { name: "Open menu" }).click();
  await settled(page);
  await check("phone menu");
  await page.getByRole("button", { name: "Close menu" }).click();
  await page.setViewportSize({ height: 800, width: 1280 });
}

// why: the pages and states a real-browser check has to look at once each: every page of the
// console over the real daemon, the Inbox and Overview with an Inbox the daemon cannot make
// quickly, the pagers and the feed over lists too long to make quickly, and then a menu, a toast,
// a dialog, the search and the phone menu open. `check` is called with a name for each.
export async function eachState(
  page: Page,
  world: World,
  check: (state: string) => Promise<void>,
): Promise<void> {
  const { host, pages } = world;
  await openSignedIn(page, host);
  for (const path of every(pages)) {
    await visit(page, host, path);
    if (opensDrawer(path)) await expect(inspector(page)).toBeVisible();
    await check(path);
  }

  await stubJson(page, "/v1/inbox", () => ({
    items: [
      waitingItem("req_busy", 125_000),
      endingItem("lse_busy", 60_000, { holder: "tok_busy", model: "dev_busy" }),
    ],
  }));
  for (const [path, region] of [
    ["/inbox", "Needs a look"],
    ["/", "Ending soon"],
  ] as const) {
    await visit(page, host, path);
    await expect(page.getByRole("region", { name: region })).toBeVisible();
    await check(`${path} with an Inbox`);
    if (path === "/inbox") {
      await page
        .getByRole("button", { name: /^Actions for/ })
        .first()
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await settled(page);
      await check("an Inbox row's menu");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  }
  await visit(page, host, `/inbox/${encodeURIComponent("request/req_busy/waiting")}`);
  await expect(inspector(page)).toBeVisible();
  await check("an Inbox item's drawer");

  await page.unrouteAll({ behavior: "wait" });
  await stubJson(page, "/v1/leases", () => ({ leases: leases(300) }));
  await stubReplay(page, events(1_000));
  await visit(page, host, "/leases?page=12");
  await expect(page.locator(".pager").first()).toBeVisible();
  await check("a pager");
  await visit(page, host, "/activity");
  await expect(feedOf(page).getByRole("listitem").first()).toBeVisible();
  await feedOf(page).evaluate((box) => {
    box.scrollTop = box.scrollHeight / 3;
  });
  await settled(page);
  await check("a scrolled feed");
  await page.unrouteAll({ behavior: "wait" });

  await openActionSurfaces(page, host, check);
  await openSearch(page, host, check);
  await openPhoneMenu(page, host, check);
}
