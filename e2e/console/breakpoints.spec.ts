import { mkdir } from "node:fs/promises";

import type { Locator, Page, TestInfo } from "@playwright/test";

import {
  disposeFleet,
  expect,
  joinOldWorker,
  signIn,
  startDaemon,
  startFleet,
  test as base,
  type RunningDaemon,
} from "./fixtures.js";
import {
  eachState,
  hasHorizontalScroll,
  IOS,
  labelledToken,
  leaseOverHttp,
  startWorld,
} from "./pages.js";
import { renderCases, renderFixture } from "./render-fixtures.js";
import { pad, staticWorker, stubJson, waitingItem } from "./stubs.js";

const LIGHT_DIRECTORY = "docs/internal/console-redesign/current/light";
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1279, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 767, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];

interface Leased {
  readonly host: RunningDaemon;
  readonly lease: string;
}

// why: one worker host holding one lease for a token labelled `ci-runner-3`, shared by the lease
// page's geometry checks, which only look.
const test = base.extend<object, { leased: Leased }>({
  leased: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here, even an empty one.
    async ({}, use) => {
      const host = await startDaemon("worker", { driverScript: { ios: IOS } });
      try {
        const lease = await leaseOverHttp(host, await labelledToken(host, "ci-runner-3"));
        await use({ host, lease });
      } finally {
        await host.dispose();
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

// why: sideways page scroll, and anything drawn past the right edge of the card that holds it, are the
// two ways a narrow window breaks a page; a list that scrolls inside its own box does not widen the
// card. A page's title never sits on top of its actions, and no card reaches past the window.
async function problemsOf(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) {
      found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    }
    for (const card of document.querySelectorAll("#main .card, #main .panel, #main section")) {
      if (card.scrollWidth > card.clientWidth + 1) {
        found.push(
          `${card.tagName.toLowerCase()}.${String(card.className).slice(0, 40)} overflows`,
        );
      }
    }
    const head = document.querySelector("#main .page-head");
    const title = head?.querySelector("h1")?.getBoundingClientRect();
    const actions = head?.querySelector(".page-actions")?.getBoundingClientRect();
    if (
      title !== undefined &&
      actions !== undefined &&
      title.left < actions.right &&
      title.right > actions.left &&
      title.top < actions.bottom &&
      title.bottom > actions.top
    ) {
      found.push("the title and the page actions overlap");
    }
    for (const panel of document.querySelectorAll("#main .panel")) {
      const rect = panel.getBoundingClientRect();
      if (rect.left < 0 || rect.right > root.clientWidth) {
        found.push(`panel.${String(panel.className).slice(0, 40)} reaches past the window`);
      }
    }
    return found;
  });
}

async function shoot(
  page: Page,
  scheme: string,
  name: string,
  width: number,
  out: string,
): Promise<void> {
  const light = scheme === "light" && width === 1440;
  if (!light && (width === 1440 || width === 360)) return;
  const path = light ? `${LIGHT_DIRECTORY}/${name}.png` : `${out}/${scheme}-${name}-${width}.png`;
  await page.screenshot({ path, animations: "disabled" });
}

async function sweep(
  page: Page,
  gatewayUrl: string,
  scheme: string,
  out: string,
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const entry of await renderCases()) {
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto(new URL(entry.path, gatewayUrl).href);
      await expect(page.locator("#main")).not.toContainText("Loading…");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const label = `${scheme} ${entry.name} ${size.width}x${size.height}`;
      for (const problem of await problemsOf(page)) problems.push(`${label}: ${problem}`);
      await shoot(page, scheme, entry.name, size.width, out);
    }
  }
  return problems;
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`every page fits the window from 1440 to 360 pixels wide: no sideways scroll, no card past the edge, no title on its actions (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(540_000);
    const gateway = await startDaemon("gateway");
    try {
      const context = await browser.newContext({
        viewport: SIZES[0]!,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await renderFixture(page);
      await page.goto(gateway.url);
      await signIn(page, gateway.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await mkdir(LIGHT_DIRECTORY, { recursive: true });
      expect(await sweep(page, gateway.url, colorScheme, testInfo.outputDir)).toEqual([]);
      await context.close();
    } finally {
      await gateway.dispose();
    }
  });
}

const SHELL_CASES = [
  { theme: "dark", session: "token", count: 0 },
  { theme: "light", session: "token", count: 1 },
  { theme: "dark", session: "proxy", count: 1 },
  { theme: "light", session: "proxy", count: 0 },
] as const;

type ShellCase = (typeof SHELL_CASES)[number];

async function expectNavIcons(nav: Locator): Promise<void> {
  for (const [selector, path, size] of [
    [
      "a[href='/']",
      "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
      "16px",
    ],
    ["a[href='/inbox']", "M2 9l2-6h8l2 6v4H2zM2 9h3.5l1 2h3l1-2H14", "16px"],
    ["a[href='/fleet']", "M2 3h12v4H2zM2 9h12v4H2zM4.5 5h.01M4.5 11h.01", "16px"],
    [".sidebar-search", "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5L14 14", "14px"],
    ["a[href='/leases']", "M5 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 9l6-6M11 5l2 2", "16px"],
    ["a[href='/baselines']", "M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3", "16px"],
    ["a[href='/usage']", "M2 14h12M4.5 14V8M8 14V3M11.5 14v-4", "16px"],
    [".sign-out", "M6 2H3v12h3M7 8h7M11 5l3 3-3 3", "14px"],
  ] as const) {
    const icon = nav.locator(`${selector} .icon`);
    await expect(icon.locator("path")).toHaveAttribute("d", path);
    expect(
      await icon.evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          style.width,
          style.height,
          style.strokeWidth,
          style.strokeLinecap,
          style.strokeLinejoin,
        ];
      }),
    ).toEqual([size, size, "1.4px", "round", "round"]);
  }
}

async function expectNavChrome(nav: Locator, entry: ShellCase): Promise<void> {
  await expect(nav.locator(".sidebar-search")).toHaveCSS("font-size", "13px");
  if (entry.theme === "dark") {
    await expect(nav.locator(".sidebar-search kbd")).toHaveCSS(
      "border-top-color",
      "rgb(58, 58, 65)",
    );
  }
  await expect(nav.locator(".account-avatar")).toBeVisible();
  if (entry.session === "proxy") {
    await expect(nav.locator(".signed-in-as")).toHaveAttribute("title", "Alice");
  }
  expect(await nav.boundingBox(), entry.theme).toEqual({
    x: 12,
    y: 12,
    width: 200,
    height: 876,
  });
  expect((await nav.locator(".sidebar-top").boundingBox())?.height).toBe(24);
  expect((await nav.locator(".sidebar-account").boundingBox())?.height).toBeCloseTo(51.34, 1);
}

async function expectPageMetrics(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      cardRadius: style(".panel").borderRadius,
      cardHeader: style(".panel-header").height,
      titleSize: style("h1").fontSize,
      navHeight: style(".nav-item").height,
      navRadius: style(".nav-item").borderRadius,
    };
  });
  expect(geometry).toEqual({
    cardRadius: "10px",
    cardHeader: "38px",
    titleSize: "21px",
    navHeight: "32px",
    navRadius: "8px",
  });
  await expect(page.locator(".stat-body").first()).toHaveCSS("border-radius", "10px");
  await expect(page.locator(".stat-label").first()).toHaveCSS("font-size", "10.5px");
  await expect(page.locator(".stat-value").first()).toHaveCSS("font-size", "28px");
  await expect(page.locator(".stat-value").first()).toHaveCSS("font-family", /Geist Mono/);
  await expect(page.locator(".stat-unit").first()).toHaveCSS("font-size", "12px");
}

async function captureShell(page: Page, testInfo: TestInfo, entry: ShellCase): Promise<void> {
  const captureDir = "docs/internal/console-redesign/current";
  await mkdir(captureDir, { recursive: true });
  const capturePath = `${captureDir}/shell-${entry.theme}-${entry.session}.png`;
  await page.screenshot({ path: capturePath, animations: "disabled" });
  await testInfo.attach(`shell-${entry.theme}-${entry.session}`, {
    path: capturePath,
    contentType: "image/png",
  });
}

async function expectInboxCount(page: Page, nav: Locator, entry: ShellCase): Promise<void> {
  const inbox = nav.getByRole("link", { name: /^Inbox/ });
  await expect(inbox.locator(".nav-count")).toHaveCount(entry.count);
  if (entry.count) await expect(inbox.locator(".nav-count")).toHaveText("1 item");
  if (entry.session === "proxy") await expect(page.getByText("Signed in as Alice")).toBeVisible();
}

// why: the label is hidden by style when the sidebar is collapsed, which no DOM can show; the link
// keeps its name from its title, and the account block keeps its distance from the bottom.
async function expectCollapsedIcons(nav: Locator): Promise<void> {
  const label = nav.getByText("Fleet", { exact: true });
  const accountBottomGap = () =>
    nav.evaluate((element) => {
      const account = element.querySelector(".sidebar-account")!.getBoundingClientRect();
      return element.getBoundingClientRect().bottom - account.bottom;
    });
  await expect(label).toBeVisible();
  expect(await accountBottomGap()).toBe(11);

  await nav.getByRole("button", { name: "Collapse sidebar" }).click();

  await expect(label).toBeHidden();
  await expect(nav.getByRole("link", { name: "Fleet" })).toBeVisible();
  expect(await accountBottomGap()).toBe(11);

  await nav.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(label).toBeVisible();
  expect(await accountBottomGap()).toBe(11);
}

test("an operator opens the console and sees the floating shell, page header and card at their reference geometry, icons and colours", async ({
  daemon,
  page,
  proxied,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let signedIn = false;
  for (const entry of SHELL_CASES) {
    await page.unrouteAll({ behavior: "wait" });
    await page.emulateMedia({ colorScheme: entry.theme, reducedMotion: "reduce" });
    await stubJson(page, "/v1/inbox", () => ({
      items: entry.count ? [waitingItem("req_shell", 125_000)] : [],
    }));
    await page.goto(entry.session === "proxy" ? proxied.url : daemon.url);
    // why: the token is kept for the tab, so only the first token case signs in.
    if (entry.session === "token" && !signedIn) {
      await signIn(page, daemon.tokens.operator);
      signedIn = true;
    }
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.locator(".connection")).toHaveText("Connected");
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    await expectNavIcons(nav);
    await expectNavChrome(nav, entry);
    await expectPageMetrics(page);
    await captureShell(page, testInfo, entry);
    await expectInboxCount(page, nav, entry);
    await expectCollapsedIcons(nav);
  }
});

async function openPage(
  page: Page,
  daemon: RunningDaemon,
  path: string,
  title: string,
  signedIn: boolean,
) {
  await page.goto(new URL(path, daemon.url).toString());
  if (!signedIn) await signIn(page, daemon.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

function lastContentOf(page: Page, index: number): Locator {
  if (index === 0) return page.getByRole("link", { name: "layout-a", exact: true });
  if (index === 1) return page.getByRole("region", { name: "Worker events" });
  return page.getByRole("region", { name: "Events on this worker" });
}

async function expectShellGeometry(page: Page, nav: Locator, path: string): Promise<void> {
  for (const [height, navHeight] of [
    [900, 876],
    [500, 476],
  ] as const) {
    await page.setViewportSize({ width: 1440, height });
    expect(await nav.boundingBox(), `${path} ${height} navigation`).toEqual({
      x: 12,
      y: 12,
      width: 200,
      height: navHeight,
    });
    const geometry = await page.evaluate(() => {
      const main = document.querySelector("main")!.getBoundingClientRect();
      const head = document.querySelector(".page-head")!.getBoundingClientRect();
      return {
        mainX: main.x,
        mainWidth: main.width,
        headX: head.x,
        headY: head.y,
        headWidth: head.width,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry, `${path} ${height} content geometry`).toEqual({
      mainX: 212,
      mainWidth: 1228,
      headX: 224,
      headY: 12,
      headWidth: 1204,
      scrollWidth: 1440,
    });
  }
}

async function expectScrollsAndStaysReachable(
  page: Page,
  nav: Locator,
  target: Locator,
  path: string,
  index: number,
  title: string,
): Promise<void> {
  expect(await page.evaluate(() => window.scrollY), `${path} starts at top`).toBe(0);
  // why: a wheel over the worker page's event log scrolls the log, so the pointer rests on its side card.
  await page.mouse.move(index === 2 ? 400 : 1000, 250);
  await page.mouse.wheel(0, 5000);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: `${path} scrolls` })
    .toBeGreaterThan(0);
  await expect(target, `${path} last content is not clipped`).toBeInViewport({ ratio: 1 });
  const box = await target.boundingBox();
  expect(box, `${path} last content`).not.toBeNull();
  expect(box!.y, `${path} last content top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${path} last content bottom`).toBeLessThanOrEqual(500);
  const scrolledNav = await nav.boundingBox();
  expect(scrolledNav!.x, `${path} scrolled navigation x`).toBe(12);
  expect(scrolledNav!.y, `${path} scrolled navigation y`).toBeCloseTo(12, 0);
  expect(scrolledNav!.width, `${path} scrolled navigation width`).toBe(200);
  await expect(
    nav.getByRole("link", { name: "Overview", exact: true }),
    `${path} navigation remains reachable`,
  ).toBeInViewport({ ratio: 1 });
  await page.mouse.wheel(0, -5000);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: `${path} scrolls back to the top`,
    })
    .toBe(0);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
    `${path} heading is reachable again`,
  ).toBeInViewport({ ratio: 1 });
}

function workerList(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    staticWorker({
      id: `wrk_${pad(index + 1)}`,
      label: `worker-${pad(index + 1)}`,
      load: false,
    }),
  );
}

test("the shell keeps its reference geometry and scrolls the Overview, Fleet and worker pages", async ({
  gateway,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const single = [staticWorker({ id: "wrk_layout_a", label: "layout-a", load: false })];
  let workers: Record<string, unknown>[] = single;
  await stubJson(page, "/v1/workers", () => ({ workers }));
  const pages = [
    { path: "/", title: "Overview" },
    { path: "/fleet", title: "Fleet" },
    { path: "/fleet/wrk_layout_a", title: "layout-a" },
  ];
  for (const [index, { path, title }] of pages.entries()) {
    workers = path === "/fleet" ? workerList(30) : single;
    await openPage(page, gateway, path, title, index > 0);
    if (index === 0) await expect(page.getByText("Wait p95", { exact: true })).toBeVisible();
    const target = lastContentOf(page, index);
    await expect(target).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "Console" });
    await expectShellGeometry(page, nav, path);
    await expectScrollsAndStaysReachable(page, nav, target, path, index, title);
  }
});

test("a worker page has no breadcrumb, and its Warm pool tab draws a 1px --border line between the facts and the table", async ({
  page,
}) => {
  const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
  try {
    const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
    const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
    await openPage(page, fleet.gateway, `/fleet/${id}?tab=warm-pool`, "layout-a", false);

    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
    const panel = page.getByRole("region", { name: "Warm pool facts", exact: true });
    await expect(panel.locator(".facts")).toBeVisible();
    const line = await panel.locator(".table-card").evaluate((card) => {
      const style = getComputedStyle(card);
      const probe = document.createElement("span");
      probe.style.color = "var(--border)";
      document.body.append(probe);
      const border = getComputedStyle(probe).color;
      probe.remove();
      return { border, color: style.borderTopColor, width: style.borderTopWidth };
    });
    expect(line.width).toBe("1px");
    expect(line.color).toBe(line.border);
  } finally {
    await disposeFleet(fleet);
  }
});

test("a fleet tile's ⋯ lies inside the tile with its 14px padding to the right edge, and an Inbox row's button has 8px above and below", async ({
  page,
}) => {
  const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
  try {
    const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
    const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
    // why: this machine's own disk or CPU may already be over a threshold, which would turn the
    // tile into a card with no ⋯; the worker is listed with no load reading instead.
    await stubJson(page, "/v1/workers", () => ({
      workers: [staticWorker({ id, label: "layout-a", load: false })],
    }));
    await openPage(page, fleet.gateway, "/fleet", "Fleet", false);
    const menu = page.locator(".fleet-tile").getByRole("button", { name: /^Actions for/ });
    const box = await menu.evaluate((button) => {
      const tile = button.closest(".fleet-tile")?.getBoundingClientRect();
      const own = button.getBoundingClientRect();
      return {
        left: own.left,
        right: own.right,
        tileLeft: tile?.left ?? 0,
        tileRight: tile?.right ?? 0,
      };
    });
    expect(box.left).toBeGreaterThanOrEqual(box.tileLeft);
    expect(box.tileRight - box.right).toBe(15);

    expect((await fleet.gateway.cli(["worker", "drain", id])).code).toBe(0);
    await page.unrouteAll({ behavior: "wait" });
    await openPage(page, fleet.gateway, "/inbox", "Inbox", true);
    const undrain = page.getByRole("button", { name: "Undrain", exact: true });
    const gaps = await undrain.evaluate((button) => {
      const row = button.closest("li")?.getBoundingClientRect();
      const own = button.getBoundingClientRect();
      return { bottom: (row?.bottom ?? 0) - own.bottom, top: own.top - (row?.top ?? 0) };
    });
    expect(gaps).toEqual({ bottom: 8, top: 8 });
  } finally {
    await disposeFleet(fleet);
  }
});

test("a toast's close button lies beside its text, inside the toast, and a one-line toast centres both", async ({
  page,
}) => {
  const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "layout-a" }]);
  try {
    const listed = await fleet.gateway.cli(["worker", "list", "--json"]);
    const id = (listed.json as { workers: { id: string }[] }).workers[0]?.id ?? "";
    await openPage(page, fleet.gateway, `/fleet/${id}`, "layout-a", false);

    const measure = (title: string) =>
      page
        .locator(".toast")
        .filter({ has: page.getByText(title, { exact: true }) })
        .evaluate((toast) => {
          const box = toast.getBoundingClientRect();
          const close = toast.querySelector(".toast-close")?.getBoundingClientRect();
          const title = toast.querySelector(".toast-title");
          if (close === undefined || title === null) throw new Error("toast has no parts");
          const range = document.createRange();
          range.selectNodeContents(title);
          const text = range.getBoundingClientRect();
          return {
            closeInside:
              close.left >= box.left &&
              close.right <= box.right &&
              close.top >= box.top &&
              close.bottom <= box.bottom,
            centres: Math.abs(close.top + close.height / 2 - (text.top + text.height / 2)),
            overlap: text.right > close.left && text.left < close.right && text.bottom > close.top,
            hasAction: toast.querySelector(".toast-action") !== null,
          };
        });

    await page.getByRole("button", { name: "Drain", exact: true }).click();
    await expect(page.getByText("layout-a drained", { exact: true })).toBeVisible();
    const drained = await measure("layout-a drained");
    expect(drained.hasAction).toBe(true);
    expect(drained.closeInside).toBe(true);
    expect(drained.overlap).toBe(false);

    await page.getByRole("button", { name: "Undrain", exact: true }).click();
    await expect(page.getByText("layout-a takes leases again", { exact: true })).toBeVisible();
    const undrained = await measure("layout-a takes leases again");
    expect(undrained.hasAction).toBe(false);
    expect(undrained.closeInside).toBe(true);
    expect(undrained.overlap).toBe(false);
    expect(undrained.centres).toBeLessThanOrEqual(4);
  } finally {
    await disposeFleet(fleet);
  }
});

test("the worker page's ring gauges sit above its cards", async ({ gateway, page }) => {
  await stubJson(page, "/v1/workers", () => ({
    workers: [staticWorker({ id: "wrk_rings", label: "rings-a" })],
  }));
  await page.goto(new URL("/fleet/wrk_rings", gateway.url).href);
  await signIn(page, gateway.tokens.operator);
  const gauges = page.getByRole("group", { name: "Load and leases" });
  await expect(gauges.locator(".worker-gauge").filter({ hasText: "CPU" })).toContainText(
    /\d+% busy/,
  );
  const grid = await page.locator(".worker-grid").boundingBox();
  const rings = await gauges.boundingBox();
  expect(rings?.y, "the rings sit above the cards").toBeLessThan(grid?.y ?? 0);
});

// why: from 1280px wide the inspector is a pane beside the table; below that a lease opens as a dialog.
function pane(page: Page): Locator {
  return page.getByRole("region", { exact: true, name: "Lease" });
}

function summary(page: Page): Locator {
  return page.getByRole("region", { exact: true, name: "Lease summary" });
}

function leaseRow(page: Page, id: string): Locator {
  return page
    .locator("main tbody tr")
    .filter({ has: page.locator(`a[href^="/leases/${encodeURIComponent(id)}/"]`) });
}

function fact(container: Locator, label: string): Locator {
  return container
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

async function openLeases(page: Page, host: RunningDaemon, path = "/leases"): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  await signIn(page, host.tokens.operator);
  // why: a drawer hides the page behind it from assistive technology, so a direct load finds the heading by hidden role too.
  await expect(
    page.getByRole("heading", { includeHidden: true, level: 1, name: "Leases" }),
  ).toBeVisible();
}

async function boxOf(locator: Locator): Promise<{ x: number; width: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box");
  return box;
}

test.describe("the leases page", () => {
  test("a lease row opens its inspector in the summary's place and the table does not move", async ({
    leased,
    page,
  }) => {
    await openLeases(page, leased.host);

    await expect(summary(page)).toBeVisible();
    // why: the page slides in once when it opens; measure after it has settled.
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const before = await boxOf(page.locator("main .table-card"));
    const summaryBox = await boxOf(summary(page));

    await leaseRow(page, leased.lease).click();

    await expect(pane(page)).toContainText("ci-runner-3");
    expect(await boxOf(page.locator("main .table-card"))).toEqual(before);
    expect(await boxOf(pane(page))).toMatchObject({ width: summaryBox.width, x: summaryBox.x });
    expect(summaryBox.width).toBe(420);
  });

  test("the inspector is a pane at 1280px wide and a modal drawer at 1279px, with the dim layer over the sidebar", async ({
    leased,
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openLeases(page, leased.host, `/leases/${encodeURIComponent(leased.lease)}/`);
    await expect(pane(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.setViewportSize({ height: 800, width: 1279 });

    await expect(page.getByRole("dialog", { name: /ci-runner-3/ })).toBeVisible();
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
  });

  test("a long lease id wraps inside the inspector with its full id in its title, and at 360px the list comes before the summary, the drawer fills the width and the page has no sideways scroll", async ({
    leased,
    page,
  }) => {
    const path = `/leases/${encodeURIComponent(leased.lease)}/`;
    await openLeases(page, leased.host, path);
    for (const width of [1280, 1024, 768, 360]) {
      await page.setViewportSize({ height: 800, width });
      await page.goto(new URL(path, leased.host.url).toString());
      const shown = page.locator(".lease-facts .lease-id", { hasText: leased.lease });
      await expect(shown).toHaveAttribute("title", leased.lease);
      const shape = await shown.evaluate((element) => ({
        inside: element.scrollWidth <= element.clientWidth,
        readable: element.clientWidth >= 96,
      }));
      expect(shape, `${width}px`).toEqual({ inside: true, readable: true });
    }

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // why: the page reserves a scrollbar gutter, so the page is narrower than the 360px viewport.
    const available = await page.evaluate(
      () => document.documentElement.getBoundingClientRect().width,
    );
    expect((await drawer.boundingBox())?.width).toBeCloseTo(available, 0);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.goto(new URL("/leases", leased.host.url).toString());
    await expect(leaseRow(page, leased.lease)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const table = await boxOf(page.locator("main .table-card"));
    expect((await boxOf(summary(page))).x).toBeCloseTo(table.x, 0);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await leaseRow(page, leased.lease).click();
    const opened = page.getByRole("dialog", { name: /ci-runner-3/ });
    await expect(opened).toBeVisible();
    await expect(fact(opened, "Lease id")).toHaveText(leased.lease);
    await expect(page.getByRole("tab")).toHaveCount(0);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test("the toolbar puts the search box beside the filter chips, and the chips start at the table's edge", async ({
    leased,
    page,
  }) => {
    await openLeases(page, leased.host);

    const title = await boxOf(page.getByRole("heading", { level: 1, name: "Leases" }));
    const chips = await boxOf(page.getByRole("group", { name: "Filter leases" }));
    const search = await boxOf(page.getByRole("searchbox", { name: "Search leases" }));
    const table = await boxOf(page.locator("main .table-card"));

    expect(chips.x).toBeCloseTo(table.x, 0);
    expect(title.x - table.x).toBeCloseTo(4, 0);
    expect(search.x - (chips.x + chips.width)).toBeCloseTo(8, 0);
    expect(search.width).toBeCloseTo(290, 0);
  });
});

test("every page and open surface fits 360px wide with the sidebar folded into a menu, even with the longest ids, labels and payloads", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const world = await startWorld();
  let hangUp = () => {};
  try {
    const { host, pages } = world;
    await page.setViewportSize({ height: 740, width: 360 });
    await page.goto(host.url);
    await signIn(page, host.tokens.agent);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    const nav = page.getByRole("navigation", { name: "Console" });
    await eachState(
      page,
      world,
      async (state) => {
        if (state === "/") await expect(nav.getByRole("link", { name: "Fleet" })).toBeHidden();
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
          ),
        );
        expect(await hasHorizontalScroll(page), state).toBe(false);
      },
      { height: 740, width: 360 },
    );

    // why: a worker whose id and label do not fit a phone, as an Inbox row and in its drawer.
    hangUp = await joinOldWorker(host, {
      id: "wrk_with_a_long_id_that_does_not_fit_on_a_phone_0123456789",
      label: "aworkerwithalabelfartoolongforonelineonaphonewithnohyphensinit",
    });
    await page.goto(new URL("/inbox", host.url).toString());
    const row = page
      .locator("main")
      .getByRole("list")
      .getByRole("link")
      .filter({ hasText: "aworkerwith" });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    expect(await hasHorizontalScroll(page)).toBe(false);
    // why: a panel clips what overflows it, so the page never scrolls; the row itself must fit.
    expect((await row.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(360);
    await row.click();
    await expect(page.getByRole("heading", { level: 2, name: /^aworkerwith/ })).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    // why: a request waiting under a requester id too long for a phone, and its drawer.
    await stubJson(page, "/v1/lease-requests", () => ({
      requests: [
        {
          createdAt: Date.now() - 30_000,
          id: "req_long",
          queuePosition: 1,
          requesterId: "an-agent-with-a-rather-long-requester-id-0123456789",
          spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
          stage: "queued",
        },
      ],
    }));
    await page.goto(new URL("/queue", host.url).toString());
    await expect(page.locator("main tbody tr")).toHaveCount(1);
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.locator("main tbody tr").getByRole("link").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.unrouteAll({ behavior: "wait" });

    // why: the daemon.started event carries the longest payload the daemon writes.
    const replay = await fetch(new URL("/v1/events?since=1h", host.url), {
      headers: { Authorization: `Bearer ${host.tokens.operator}` },
    });
    const started = ((await replay.json()) as { events: { event: string; id: string }[] }).events
      .filter((event) => event.event === "daemon.started")
      .at(0);
    await page.goto(new URL(`/activity/${encodeURIComponent(started?.id ?? "")}`, host.url).href);
    await expect(page.getByRole("heading", { level: 2, name: "daemon.started" })).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.goto(new URL(pages.worker, host.url).href);
    await expect(page.locator(".worker-device").first()).toBeVisible();
    for (const tab of ["Warm pool", "Devices"]) {
      await page.getByRole("tab", { name: tab }).click();
      expect(await hasHorizontalScroll(page), tab).toBe(false);
    }
  } finally {
    hangUp();
    await world.dispose();
  }
});
