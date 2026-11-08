import { mkdir } from "node:fs/promises";

import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, NAV, NAV_LABELS, openFromNav, settled, signIn, test } from "./fixtures.js";
import { addInboxItems, waitingItem } from "./inbox-stub.js";
import { returnToTab } from "./tab.js";

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
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

async function expectReconnectAndSignOut(
  page: Page,
  nav: Locator,
  entry: ShellCase,
): Promise<void> {
  await nav.getByRole("link", { name: "Fleet", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
  await page.context().setOffline(true);
  await returnToTab(page);
  try {
    await expect(page.locator(".connection")).toHaveText(/^Reconnecting/);
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
    await returnToTab(page);
  }
  await expect(page.locator(".connection")).toHaveText("Connected", { timeout: 30_000 });
  if (entry.session === "token") {
    await nav.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Operator token")).toBeVisible();
  }
}

async function shellControls(page: Page): Promise<string[]> {
  return page
    .locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.closest("#main") === null)
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""),
    );
}

async function exerciseControl(page: Page, label: string): Promise<void> {
  if (label === "Collapse sidebar") {
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeFocused();
  }
  if (label === "Search or jump to…") {
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key);
      await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
      await expect(page.locator(".palette")).toHaveCSS("border-radius", "10px");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeFocused();
    }
  }
}

async function tabThrough(page: Page, tab: string, count: number): Promise<string[]> {
  const visited: string[] = [];
  for (let step = 0; step < count; step += 1) {
    await page.keyboard.press(tab);
    const label = await page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent?.trim() ??
        "",
    );
    visited.push(label);
    await exerciseControl(page, label);
  }
  return visited;
}

async function openPagesBackwards(page: Page, back: string): Promise<void> {
  for (const [index, entry] of [...NAV].reverse().entries()) {
    if (index > 0) await page.keyboard.press(back);
    await expect(page.getByRole("link", { name: entry.label, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${entry.path === "/" ? "/" : entry.path}$`));
    await expect(page.getByRole("heading", { level: 1, name: entry.label })).toBeVisible();
  }
}

test.describe("the shell", () => {
  test("an operator opens the console and sees the floating shell, page header and card with keyboard navigation", async ({
    daemon,
    page,
    proxied,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const entry of SHELL_CASES) {
      await page.unrouteAll({ behavior: "wait" });
      await page.emulateMedia({ colorScheme: entry.theme, reducedMotion: "reduce" });
      await addInboxItems(page, () => (entry.count ? [waitingItem("req_shell", 125_000)] : []));
      await page.goto(entry.session === "proxy" ? proxied.url : daemon.url);
      if (entry.session === "token") await signIn(page, daemon.tokens.operator);
      const nav = page.getByRole("navigation", { name: "Console" });
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await expect(page.locator(".connection")).toHaveText("Connected");
      await settled(page);
      await expectNavIcons(nav);
      await expectNavChrome(nav, entry);
      await expectPageMetrics(page);
      await captureShell(page, testInfo, entry);
      await expectInboxCount(page, nav, entry);
      await expectReconnectAndSignOut(page, nav, entry);
    }
  });

  test("the shell has no horizontal scroll at 360px wide, its sidebar folded into a menu", async ({
    daemon,
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await page.goto("/");
    await signIn(page, daemon.tokens.agent);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    await signIn(page, daemon.tokens.operator);
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(nav.getByRole("link", { name: "Fleet" })).toBeHidden();
    for (const label of NAV_LABELS) {
      await openFromNav(page, label);
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Fleet" })).toBeHidden();
      expect(await hasHorizontalScroll(page)).toBe(false);
    }
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test("every control in the shell is reachable and usable with the keyboard alone", async ({
    browserName,
    daemon,
    page,
  }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const back = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
    const pressTimes = async (key: string, times: number) => {
      for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
    };
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto("/");
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await expect(page.getByLabel("Operator token")).toBeEnabled();

    await page.keyboard.press(tab);
    await expect(page.getByLabel("Operator token")).toBeFocused();
    await page.keyboard.type(daemon.tokens.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const controls = await shellControls(page);
    const visited = await tabThrough(page, tab, controls.length);
    expect(controls).toEqual([
      "Skip to content",
      "Collapse sidebar",
      "Search or jump to…",
      ...NAV_LABELS,
      "Sign out",
    ]);
    expect(visited).toEqual(controls);

    // why: focus is on Sign out; walk back to the last page link, then open each page on the way up.
    await pressTimes(back, 1);
    await openPagesBackwards(page, back);

    await pressTimes(back, 3);
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    await page.getByRole("button", { name: "Sign out" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Operator token")).toBeVisible();
  });

  test("the shell follows the dark and the light system setting", async ({ daemon, page }) => {
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const text = () => page.evaluate(() => getComputedStyle(document.body).color);
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    await page.emulateMedia({ colorScheme: "dark" });
    expect(await background()).toBe("rgb(12, 12, 14)");
    expect(await text()).toBe("rgb(236, 236, 234)");

    await page.emulateMedia({ colorScheme: "light" });
    expect(await background()).toBe("rgb(248, 248, 247)");
    expect(await text()).toBe("rgb(17, 17, 16)");
  });
});
