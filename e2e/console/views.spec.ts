import type { Page } from "@playwright/test";

import { expect, NAV, type RunningDaemon, settled, signIn, startDaemon, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface Pages {
  readonly views: readonly { readonly label: string; readonly path: string }[];
  readonly worker: string;
  readonly device: string;
  readonly lease: string;
  readonly request: string;
  readonly event: string;
}

async function takeLease(host: RunningDaemon, agent: string): Promise<string> {
  const granted = await host.cli([...LEASE, "--agent-id", agent, "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

async function hostWithLease(
  captureCommand?: string,
): Promise<{ readonly host: RunningDaemon; readonly pages: Pages }> {
  const host = await startDaemon("worker", {
    driverScript: {
      ios: {
        ...IOS,
        ...(captureCommand === undefined ? {} : { screenCaptureCommand: captureCommand }),
      },
    },
    ...(captureCommand === undefined
      ? {}
      : { config: { capabilities: { stream: { enabled: true } } } }),
  });
  const lease = await takeLease(host, "console-views");
  const listed = await host.cli(["worker", "list", "--json"]);
  const [worker] = (listed.json as { workers: { id: string; leases: { deviceId: string }[] }[] })
    .workers;
  const workerPath = `/fleet/${encodeURIComponent(worker?.id ?? "")}`;
  const replay = await fetch(new URL("/v1/events?since=1h", host.url), {
    headers: { Authorization: `Bearer ${host.tokens.operator}` },
  });
  const granted = (
    (await replay.json()) as { events: { event: string; id: string }[] }
  ).events.find((entry) => entry.event === "lease.granted");
  return {
    host,
    pages: {
      device: `${workerPath}/${encodeURIComponent(worker?.leases[0]?.deviceId ?? "")}?tab=devices`,
      event: `/activity/${encodeURIComponent(granted?.id ?? "")}`,
      lease: `/leases/${encodeURIComponent(lease)}/`,
      request: "/queue/req_none",
      views: NAV.map((entry) => ({ label: entry.label, path: entry.path })),
      worker: workerPath,
    },
  };
}

function every(pages: Pages): readonly string[] {
  return [
    ...pages.views.map((view) => view.path),
    pages.worker,
    pages.device,
    pages.lease,
    pages.request,
    pages.event,
  ];
}

async function openSignedIn(page: Page, host: RunningDaemon): Promise<void> {
  await page.goto(host.url);
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

// why: an open drawer hides the page behind it from assistive technology.
function opensDrawer(path: string): boolean {
  return /^\/(leases|queue|activity|inbox)\/./.test(path) || /^\/fleet\/[^/?]+\/./.test(path);
}

async function visit(page: Page, host: RunningDaemon, path: string): Promise<void> {
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

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("every view", () => {
  test("every view has no horizontal page scroll at 360px wide", async ({ page }) => {
    const { host, pages } = await hostWithLease();
    try {
      await page.setViewportSize({ height: 740, width: 360 });
      await openSignedIn(page, host);
      const nav = page.getByRole("navigation", { name: "Console" });
      await expect(nav.getByRole("button", { name: "Open menu" })).toBeVisible();

      for (const path of every(pages)) {
        await visit(page, host, path);
        expect(await hasHorizontalScroll(page), path).toBe(false);
      }
    } finally {
      await host.dispose();
    }
  });

  test("every view is usable with the keyboard alone", async ({ browserName, page }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const { host, pages } = await hostWithLease();
    try {
      await openSignedIn(page, host);
      // why: a drawer traps the keyboard inside itself, so the lease and device pages are left out
      // of this order.
      for (const path of every(pages).filter((candidate) => !opensDrawer(candidate))) {
        await visit(page, host, path);
        // why: a radio group is one stop, at its checked radio, and nothing inside a closed
        // disclosure is a stop, so those are left out of the order Tab should follow; neither is
        // a disabled control.
        const stops = await page.evaluate(() => {
          const candidates = document.querySelectorAll<HTMLElement>(
            "#main a[href], #main button, #main input, #main summary, #main [tabindex]:not([tabindex='-1'])",
          );
          const kept = [...candidates].filter((element) => {
            if (element.matches(":disabled")) return false;
            if (element instanceof HTMLInputElement && element.type === "radio") {
              return element.checked;
            }
            const closed = element.closest("details:not([open])");
            return closed === null || element.tagName === "SUMMARY";
          });
          kept.forEach((element, index) => element.setAttribute("data-stop", String(index)));
          return kept.length;
        });
        await page.keyboard.press(tab);
        await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#main")).toBeFocused();
        const visited: string[] = [];
        for (let step = 0; step < stops; step += 1) {
          await page.keyboard.press(tab);
          visited.push(
            await page.evaluate(() => document.activeElement?.getAttribute("data-stop") ?? "-"),
          );
        }
        expect(visited, path).toEqual(Array.from({ length: stops }, (_, index) => String(index)));
      }

      await visit(page, host, "/");
      await expect(page.locator("#main .chart")).toHaveCount(1);
      const chart = page.locator(".chart [tabindex='0']").first();
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".chart-tip")).toContainText("leases held");
      // why: the chart's numbers are a table only a screen reader reads; it holds no stop for the keyboard.
      await expect(page.getByRole("table", { name: "Leases held" })).toBeAttached();
      await visit(page, host, "/activity");
      await page.getByRole("radio", { name: "1 h" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("radio", { name: "6 h" })).toBeChecked();
      await visit(page, host, pages.lease);
      await page.getByRole("button", { name: "Close lease" }).click();
      await expect(page).toHaveURL(/\/leases$/);
    } finally {
      await host.dispose();
    }
  });

  test("clicking a chart shows no outline, tabbing to it does", async ({ browserName, page }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const { host } = await hostWithLease();
    try {
      await openSignedIn(page, host);
      for (const [path, title, index] of [
        ["/", "Leases held", 0],
        ["/usage", "Device slots in use, last hour", 0],
        ["/activity", "Activity", 0],
      ] as const) {
        await visit(page, host, path);
        if (path === "/") await expect(page.locator("#main .chart")).toHaveCount(1);
        const chart = page.locator("#main .chart").nth(index);
        const heading = page.getByRole("heading", { name: title, exact: true });
        const ring = () => chart.evaluate((element) => getComputedStyle(element).outlineStyle);
        const focused = () =>
          chart.evaluate((element) => {
            const active = document.activeElement;
            return {
              inChart: active !== null && element.contains(active),
              own: active === null ? "" : getComputedStyle(active).outlineStyle,
            };
          });

        // why: a click on text inside the page focuses `main` (its skip-link target), so Tab
        // starts from the top of the page and reaches the chart after the controls above it.
        await heading.click();
        for (let step = 0; step < 20 && !(await focused()).inChart; step += 1) {
          await page.keyboard.press(tab);
        }
        expect(await focused(), `${path} tabbed`).toEqual({ inChart: true, own: "none" });
        expect(await ring(), `${path} tabbed`).toBe("solid");
        await page.keyboard.press("ArrowLeft");
        await expect(chart.locator(".chart-tip")).toBeVisible();

        await heading.click();
        expect(await ring(), `${path} left`).toBe("none");
        await chart.locator("svg").first().click();
        expect(await focused(), `${path} clicked`).toEqual({ inChart: true, own: "none" });
        expect(await ring(), `${path} clicked`).toBe("none");
      }
    } finally {
      await host.dispose();
    }
  });

  test("a long lease id wraps inside the inspector and its full id is in its title", async ({
    page,
  }) => {
    const { host, pages } = await hostWithLease();
    try {
      const id = decodeURIComponent(pages.lease.replace(/^\/leases\/|\/$/g, ""));
      await openSignedIn(page, host);
      for (const width of [1280, 1024, 768, 360]) {
        await page.setViewportSize({ height: 800, width });
        await visit(page, host, pages.lease);
        const shown = page.locator(".lease-facts .lease-id", { hasText: id });
        await expect(shown).toHaveAttribute("title", id);
        const shape = await shown.evaluate((element) => ({
          inside: element.scrollWidth <= element.clientWidth,
          readable: element.clientWidth >= 96,
        }));
        expect(shape, `${width}px`).toEqual({ inside: true, readable: true });
      }
    } finally {
      await host.dispose();
    }
  });
});
