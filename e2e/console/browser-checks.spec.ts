import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, signIn, test } from "./fixtures.js";
import { eachState, startWorld } from "./pages.js";
import { staticWorker, stubJson, waitingItem } from "./stubs.js";

// why: a Content-Security-Policy violation and a <style> element are things only a browser engine
// reports, and every state of every page has to be looked at for them.
async function watchCsp(page: Page): Promise<() => Promise<void>> {
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
  return async () => {
    expect(errors).toEqual([]);
  };
}

test.describe("what only a browser engine reports, on every page and open surface", () => {
  test("no page, menu, dialog, toast or search reports a Content-Security-Policy violation or sets a <style> element", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const world = await startWorld();
    try {
      const noErrors = await watchCsp(page);
      const response = await page.goto(world.host.url);
      expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
      await eachState(page, world, async (state) => {
        const chart = page.locator(".chart svg").first();
        if ((await chart.count()) > 0 && (await page.getByRole("dialog").count()) === 0) {
          await chart.hover();
          await expect(page.locator(".chart-tip")).toBeVisible();
        }
        const found = await page.evaluate(() => ({
          styles: document.querySelectorAll("style").length,
          violations: (window as unknown as { cspViolations: string[] }).cspViolations,
        }));
        expect(found, state).toEqual({ styles: 0, violations: [] });
      });
      await noErrors();
    } finally {
      await world.dispose();
    }
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`every page, and the menu, dialog, toast and search open, pass an automated WCAG AA check with colour contrast (${colorScheme})`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      const world = await startWorld();
      try {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await eachState(page, world, async (state) => {
          const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          expect(
            results.passes.map((rule) => rule.id),
            state,
          ).toContain("color-contrast");
          expect(
            results.violations.map((violation) => ({
              id: violation.id,
              targets: violation.nodes.map((node) => node.target.join(" ")),
            })),
            state,
          ).toEqual([]);
        });
      } finally {
        await world.dispose();
      }
    });
  }

  test("a drawer slides in and a load bar's fill moves over the duration tokens, and neither moves under prefers-reduced-motion", async ({
    browserName,
    gateway,
    page,
  }) => {
    await stubJson(page, "/v1/workers", () => ({
      workers: [
        staticWorker({ id: "wrk_motion", label: "motion-a", leased: true, limit: 20, load: false }),
      ],
    }));
    await stubJson(page, "/v1/inbox", () => ({ items: [waitingItem("req_motion", 125_000)] }));
    const drawerPath = `/inbox/${encodeURIComponent("request/req_motion/waiting")}`;
    // why: a browser writes the token's `120ms` as `.12s`, so both are compared as milliseconds.
    const asMs = (value: string) =>
      value.trim().endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
    const motion = async () => {
      await page.goto(new URL("/fleet/wrk_motion", gateway.url).toString());
      const fill = page.locator(".load-bar-fill").first();
      await expect(fill).toBeVisible();
      const bar = await fill.evaluate((element) => ({
        duration: getComputedStyle(element).transitionDuration,
        property: getComputedStyle(element).transitionProperty,
      }));
      await page.goto(new URL(drawerPath, gateway.url).toString());
      const drawer = page.locator(".drawer");
      await expect(drawer).toBeVisible();
      const slide = await drawer.evaluate((element) => ({
        duration: getComputedStyle(element).animationDuration,
        name: getComputedStyle(element).animationName,
      }));
      return {
        bar: { ms: asMs(bar.duration), property: bar.property },
        drawer: { ms: asMs(slide.duration), name: slide.name },
      };
    };

    await page.goto(gateway.url);
    await signIn(page, gateway.tokens.operator);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(await motion()).toEqual({
      bar: { ms: 120, property: "width" },
      drawer: { ms: 220, name: "drawer-in" },
    });

    // why: emulated in Chromium alone, the one engine whose reduced-motion emulation was verified
    // on the machine that wrote this test.
    test.skip(browserName !== "chromium", "reduced-motion emulation is checked in Chromium");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await motion()).toEqual({
      bar: { ms: 0, property: "width" },
      drawer: { ms: 0, name: "none" },
    });
  });
});
