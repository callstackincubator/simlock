import type { Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { expect, NAV_LABELS, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";

/**
 * What every view shares: the tab bar, a page that fits a phone, the keyboard, the CSP, and the
 * charts. Each test starts its own single host and holds a lease on it, so every view has rows,
 * a chart with a change in it, and a details page to open.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

/** Every page a test visits: the five views, then a worker's page and a lease's page. */
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

/** The daemon's own count of the leases it holds, as an operator reads it over HTTP. */
async function leasesHeld(host: RunningDaemon): Promise<number> {
  const response = await fetch(new URL("/v1/leases", host.url), {
    headers: { Authorization: `Bearer ${host.tokens.operator}` },
  });
  return ((await response.json()) as { leases: unknown[] }).leases.length;
}

/** A single host holding one lease, and the pages of the console it has. */
async function hostWithLease(): Promise<{ readonly host: RunningDaemon; readonly pages: Pages }> {
  const host = await startDaemon("worker", { driverScript: { ios: IOS } });
  const lease = await takeLease(host, "console-views");
  const listed = await host.cli(["worker", "list", "--json"]);
  const [worker] = (listed.json as { workers: { id: string }[] }).workers;
  return {
    host,
    pages: {
      lease: `/leases/${encodeURIComponent(lease)}/`,
      views: NAV_LABELS.map((label) => ({ label, path: `/${label.toLowerCase()}` })),
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
  await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
}

/** Opens `path` in the signed-in tab and waits until its content, not "Loading…", shows. */
async function visit(page: Page, host: RunningDaemon, path: string): Promise<void> {
  await page.goto(new URL(path, host.url).toString());
  await expect(page.locator("#main h1")).toBeVisible();
  await expect(page.locator("#main")).not.toContainText("Loading…");
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
      // The tab bar is wider than a phone: it scrolls sideways inside itself instead.
      const tabs = page.getByRole("navigation", { name: "Console" });
      expect(await tabs.evaluate((nav) => nav.scrollWidth > nav.clientWidth)).toBe(true);

      for (const path of every(pages)) {
        await visit(page, host, path);
        // The minute-by-minute tables open too, where a view has a chart.
        for (const summary of await page.locator("#main summary").all()) await summary.click();
        expect(await hasHorizontalScroll(page), path).toBe(false);
      }
    } finally {
      await host.dispose();
    }
  });

  test("every view is usable with the keyboard alone", async ({ browserName, page }) => {
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const { host, pages } = await hostWithLease();
    try {
      await openSignedIn(page, host);
      for (const path of every(pages)) {
        await visit(page, host, path);
        // Every control in the view, in the order Tab should visit them: a radio group is one
        // stop, at its checked radio; nothing inside a closed disclosure is a stop.
        const stops = await page.evaluate(() => {
          const candidates = document.querySelectorAll<HTMLElement>(
            "#main a[href], #main button, #main input, #main summary, #main [tabindex]:not([tabindex='-1'])",
          );
          const kept = [...candidates].filter((element) => {
            if (element instanceof HTMLInputElement && element.type === "radio") {
              return element.checked;
            }
            const closed = element.closest("details:not([open])");
            return closed === null || element.tagName === "SUMMARY";
          });
          kept.forEach((element, index) => element.setAttribute("data-stop", String(index)));
          return kept.length;
        });
        // The skip link moves focus to the view; Tab then walks every control in it, in order.
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

      // Each kind of control works from the keyboard. A chart: arrow keys step through its
      // minutes and show each one's count.
      await visit(page, host, "/workers");
      const chart = page.locator(".chart [tabindex='0']").first();
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".chart-tip")).toContainText("leases held");
      // A disclosure: Enter opens the minute-by-minute table.
      await page.locator("#main summary").first().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("columnheader", { name: "Leases held" })).toBeVisible();
      // The radio group on Events: an arrow key picks the next filter.
      await visit(page, host, "/events");
      await page.getByRole("radio", { name: "All" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("radio", { name: "Leases" })).toBeChecked();
      // A link: Enter follows it, here from the lease to back to all leases.
      await visit(page, host, pages.lease);
      await page.getByRole("link", { name: "All leases" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/leases$/);
    } finally {
      await host.dispose();
    }
  });

  test("the tab bar moves between views and the page URL follows", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    const tabs = page.getByRole("navigation", { name: "Console" });
    await expect(tabs.getByRole("link")).toHaveText([...NAV_LABELS]);

    for (const label of NAV_LABELS) {
      await tabs.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/${label.toLowerCase()}$`));
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
      await expect(tabs.locator("[aria-current='page']")).toHaveText(label);
    }

    // The browser's back and forward move the tab bar with the URL.
    await page.goBack();
    await expect(page).toHaveURL(/\/attention$/);
    await expect(tabs.locator("[aria-current='page']")).toHaveText(/^Attention/);
    await page.goForward();
    await expect(page).toHaveURL(/\/events$/);
    await expect(tabs.locator("[aria-current='page']")).toHaveText("Events");
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
      // The page is served under the policy this test holds it to.
      expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();

      for (const path of every(pages)) {
        await visit(page, host, path);
        // Draw everything a chart draws: its tooltip, and the table under it.
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

  test("a long lease id stays on one line and its full id is in its title", async ({ page }) => {
    const { host, pages } = await hostWithLease();
    try {
      const id = decodeURIComponent(pages.lease.replace(/^\/leases\/|\/$/g, ""));
      await openSignedIn(page, host);
      for (const width of [1280, 360]) {
        await page.setViewportSize({ height: 800, width });
        await visit(page, host, "/leases");
        const link = page.getByRole("link", { name: id, exact: true });
        await expect(link).toHaveAttribute("title", id);
        const shape = await link.evaluate((element) => ({
          cut: element.scrollWidth > element.clientWidth,
          lines: Math.round(
            element.getBoundingClientRect().height /
              parseFloat(getComputedStyle(element).lineHeight),
          ),
        }));
        expect(shape, `${width}px`).toEqual({ cut: true, lines: 1 });
      }
      // The details page has the whole id.
      await page.getByRole("link", { name: id, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: id })).toHaveText(id);
    } finally {
      await host.dispose();
    }
  });

  test("a lease taken with the CLI raises the lease chart within a second", async ({ page }) => {
    const host = await startDaemon("worker", { driverScript: { ios: IOS } });
    try {
      await openSignedIn(page, host);
      const summary = page.locator(".chart-summary");
      const area = page.locator(".chart .recharts-area-curve");
      await expect(summary).toHaveText(/^Now 0;/);
      const before = await area.getAttribute("d");

      await takeLease(host, "chart-riser");
      await waitFor(async () => (await leasesHeld(host)) === 1, {
        interval: 20,
        label: "the daemon's own lease list",
        timeout: 10_000,
      });

      await expect(summary).toHaveText(/^Now 1; highest 1 at/, { timeout: 1_000 });
      await expect(area).not.toHaveAttribute("d", before ?? "", { timeout: 1_000 });
    } finally {
      await host.dispose();
    }
  });
});
