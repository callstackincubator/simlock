import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, NAV_LABELS, signIn, test } from "./fixtures.js";

/** Whether the page itself scrolls sideways; a scrolling region inside it does not count. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the shell", () => {
  test("the shell has no horizontal scroll at 360px wide", async ({ daemon, page }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await page.goto("/");
    await signIn(page, daemon.tokens.agent);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    await signIn(page, daemon.tokens.operator);
    for (const label of NAV_LABELS) {
      await page.getByRole("link", { name: label }).click();
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
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
    // Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const back = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
    const pressTimes = async (key: string, times: number) => {
      for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
    };
    await page.goto("/");

    await page.keyboard.press(tab);
    await expect(page.getByLabel("Operator token")).toBeFocused();
    await page.keyboard.type(daemon.tokens.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Every focusable control in the shell, then the order Tab visits them in.
    const controls = await page
      .locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
    const visited: string[] = [];
    for (let step = 0; step < controls.length; step += 1) {
      await page.keyboard.press(tab);
      visited.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    expect(controls).toEqual(["Skip to content", "Sign out", ...NAV_LABELS]);
    expect(visited).toEqual(controls);

    // Each control does its job from the keyboard. Focus is on the last nav link, Events; walk
    // back through every nav link and open each one with Enter.
    for (const [index, label] of [...NAV_LABELS].reverse().entries()) {
      if (index > 0) await page.keyboard.press(back);
      await expect(page.getByRole("link", { name: label })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${label.toLowerCase()}$`));
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    }

    // Back past Sign out to the skip link, which moves focus to the view.
    await pressTimes(back, 2);
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    // Back from the view past the five nav links to Sign out.
    await pressTimes(back, 6);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
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
    expect(await background()).toBe("rgb(14, 14, 15)");
    expect(await text()).toBe("rgb(242, 242, 240)");

    await page.emulateMedia({ colorScheme: "light" });
    expect(await background()).toBe("rgb(255, 255, 255)");
    expect(await text()).toBe("rgb(14, 14, 15)");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the shell passes an automated WCAG AA contrast check in both themes (${colorScheme})`, async ({
      daemon,
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      const audit = async () => {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        // The contrast rule ran and found text to check: an empty violation list means something.
        expect(results.passes.map((rule) => rule.id)).toContain("color-contrast");
        return results.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
      };

      await page.goto("/");
      await signIn(page, daemon.tokens.agent);
      await expect(page.getByRole("alert")).toBeVisible();
      expect(await audit()).toEqual([]);

      await signIn(page, daemon.tokens.operator);
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      expect(await audit()).toEqual([]);
    });
  }
});
