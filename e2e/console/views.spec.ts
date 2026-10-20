import type { Page } from "@playwright/test";

import {
  expect,
  NAV,
  NAV_LABELS,
  openFromNav,
  type RunningDaemon,
  settled,
  signIn,
  startDaemon,
  test,
} from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface Pages {
  readonly views: readonly { readonly label: string; readonly path: string }[];
  readonly worker: string;
  readonly lease: string;
}

async function takeLease(host: RunningDaemon, agent: string): Promise<string> {
  const granted = await host.cli([...LEASE, "--agent-id", agent, "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  return (granted.json as { lease: { id: string } }).lease.id;
}

async function hostWithLease(): Promise<{ readonly host: RunningDaemon; readonly pages: Pages }> {
  const host = await startDaemon("worker", { driverScript: { ios: IOS } });
  const lease = await takeLease(host, "console-views");
  const listed = await host.cli(["worker", "list", "--json"]);
  const [worker] = (listed.json as { workers: { id: string }[] }).workers;
  return {
    host,
    pages: {
      lease: `/leases/${encodeURIComponent(lease)}/`,
      views: NAV.map((entry) => ({ label: entry.label, path: entry.path })),
      worker: `/workers/${encodeURIComponent(worker?.id ?? "")}`,
    },
  };
}

function every(pages: Pages): readonly string[] {
  return [...pages.views.map((view) => view.path), pages.worker, pages.lease];
}

async function openSignedIn(page: Page, host: RunningDaemon): Promise<void> {
  await page.goto(host.url);
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

async function visit(page: Page, host: RunningDaemon, path: string): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  await expect(page.locator("#main").getByRole("heading").first()).toBeVisible();
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
        for (const summary of await page.locator("#main summary").all()) await summary.click();
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
      for (const path of every(pages)) {
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
      await expect(page.locator("#main .chart")).toHaveCount(3);
      const chart = page.locator(".chart [tabindex='0']").first();
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".chart-tip")).toContainText("leases held");
      await page.locator("#main summary").first().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("columnheader", { name: "Leases held" })).toBeVisible();
      await visit(page, host, "/events");
      await page.getByRole("radio", { name: "All" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();
      await visit(page, host, pages.lease);
      await page
        .getByRole("navigation", { name: "Breadcrumb" })
        .getByRole("link", { name: "Leases" })
        .focus();
      await page.keyboard.press("Enter");
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
        ["/", "Leases held, last hour", 0],
        ["/", "Requests in the queue, last hour", 1],
        ["/", "Device slots in use, last hour", 2],
        ["/events", "Events", 0],
      ] as const) {
        await visit(page, host, path);
        if (path === "/") await expect(page.locator("#main .chart")).toHaveCount(3);
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

  test("the sidebar moves between pages and the page URL follows", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    const tabs = page.getByRole("navigation", { name: "Console" });
    await expect(tabs.getByRole("link")).toHaveText([...NAV_LABELS]);

    for (const entry of NAV) {
      await openFromNav(page, entry.label);
      await expect(page).toHaveURL(new RegExp(`${entry.path}$`));
      await expect(page.getByRole("heading", { level: 1, name: entry.label })).toBeVisible();
      await expect(tabs.locator("[aria-current='page']")).toHaveText(entry.label);
    }

    const [before, last] = NAV.slice(-2);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${before?.path}$`));
    await expect(tabs.locator("[aria-current='page']")).toHaveText(new RegExp(`^${before?.label}`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${last?.path}$`));
    await expect(tabs.locator("[aria-current='page']")).toHaveText(last?.label ?? "");
  });

  test("no view reports a Content-Security-Policy violation", async ({ page }) => {
    const { host, pages } = await hostWithLease();
    try {
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { cspViolations: string[] }).cspViolations = seen;
        document.addEventListener("securitypolicyviolation", (event) => {
          seen.push(`${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      const errors: string[] = [];
      page.on("console", (message) => {
        if (/content.security.policy/i.test(message.text())) errors.push(message.text());
      });
      const response = await page.goto(host.url);
      expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      for (const path of every(pages)) {
        await visit(page, host, path);
        const chart = page.locator(".chart svg").first();
        if ((await chart.count()) > 0) {
          await chart.hover();
          await expect(page.locator(".chart-tip")).toBeVisible();
          await page.locator("#main summary").first().click();
        }
        const found = await page.evaluate(() => ({
          styles: document.querySelectorAll("style").length,
          violations: (window as unknown as { cspViolations: string[] }).cspViolations,
        }));
        expect(found, path).toEqual({ styles: 0, violations: [] });
      }
      expect(errors).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test("the overview's tiles show the numbers the daemon gives", async ({ page }) => {
    const { host } = await hostWithLease();
    try {
      const tiles = () =>
        page
          .getByRole("list", { name: "Fleet at a glance" })
          .getByRole("listitem")
          .evaluateAll((items) =>
            items.map((item) =>
              [...item.querySelectorAll(".stat-label, .stat-value, .stat-unit")]
                .map((part) => part.textContent)
                .join(" | "),
            ),
          );
      const response = await fetch(new URL("/v1/workers", host.url), {
        headers: { Authorization: `Bearer ${host.tokens.operator}` },
      });
      const { workers } = (await response.json()) as {
        workers: { capacity?: { ios: { limit: number }; android: { limit: number } } }[];
      };
      const limit = workers.reduce(
        (sum, worker) =>
          sum + (worker.capacity?.ios.limit ?? 0) + (worker.capacity?.android.limit ?? 0),
        0,
      );
      await openSignedIn(page, host);

      await expect
        .poll(async () => (await tiles()).slice(0, 4))
        .toEqual([
          `Utilisation | ${Math.round((100 * 1) / limit)} | %`,
          `Leases | 1 | of ${limit}`,
          "Waiting | 0 | none",
          "Workers | 1 | of 1 up",
        ]);
      const stats = (await (
        await fetch(new URL("/v1/stats?since=1h", host.url), {
          headers: { Authorization: `Bearer ${host.tokens.operator}` },
        })
      ).json()) as { totals: { granted: number; wait: { p95: number | null } } };
      const wait = stats.totals.wait.p95;
      await expect
        .poll(async () => (await tiles()).slice(4))
        .toEqual([
          `Granted | ${stats.totals.granted} | last hour`,
          `Wait p95 | ${
            wait === null
              ? "—"
              : wait < 1_000
                ? `${Math.round(wait)} ms`
                : `${Math.floor(wait / 1_000)} s`
          } | last hour`,
        ]);
      await page.getByRole("link", { name: /^Leases 1/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
    } finally {
      await host.dispose();
    }
  });

  test("a long lease id stays on one line and its full id is in its title", async ({ page }) => {
    const { host, pages } = await hostWithLease();
    try {
      const id = decodeURIComponent(pages.lease.replace(/^\/leases\/|\/$/g, ""));
      await openSignedIn(page, host);
      for (const width of [1280, 1024, 768, 360]) {
        await page.setViewportSize({ height: 800, width });
        await visit(page, host, pages.lease);
        const shown = page.locator("#main .id", { hasText: id });
        await expect(shown).toHaveAttribute("title", id);
        const shape = await shown.evaluate((element) => ({
          lines: Math.round(
            element.getBoundingClientRect().height /
              parseFloat(getComputedStyle(element).lineHeight),
          ),
          readable: element.clientWidth >= 96,
        }));
        expect(shape, `${width}px`).toEqual({ lines: 1, readable: true });
      }
    } finally {
      await host.dispose();
    }
  });
});
