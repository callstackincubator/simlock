import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, NAV, NAV_LABELS, openFromNav, settled, signIn, test } from "./fixtures.js";

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the shell", () => {
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
    await expect(nav.getByRole("link", { name: "Workers" })).toBeHidden();
    for (const label of NAV_LABELS) {
      await openFromNav(page, label);
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Workers" })).toBeHidden();
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

    await page.keyboard.press(tab);
    await expect(page.getByLabel("Operator token")).toBeFocused();
    await page.keyboard.type(daemon.tokens.operator);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const controls = await page
      .locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.closest("#main") === null)
          .filter((element) => element.getClientRects().length > 0)
          .map(
            (element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
          ),
      );
    const visited: string[] = [];
    for (let step = 0; step < controls.length; step += 1) {
      await page.keyboard.press(tab);
      visited.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            "",
        ),
      );
    }
    expect(controls).toEqual(["Skip to content", ...NAV_LABELS, "Sign out", "Collapse sidebar"]);
    expect(visited).toEqual(controls);

    // why: focus is on the sidebar toggle; walk back past Sign out to the last page link, then open
    // each page with Enter on the way up.
    await pressTimes(back, 2);
    for (const [index, entry] of [...NAV].reverse().entries()) {
      if (index > 0) await page.keyboard.press(back);
      await expect(page.getByRole("link", { name: entry.label, exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`${entry.path === "/" ? "/" : entry.path}$`));
      await expect(page.getByRole("heading", { level: 1, name: entry.label })).toBeVisible();
    }

    await page.keyboard.press(back);
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    await page.getByRole("button", { name: "Sign out" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Operator token")).toBeVisible();
  });

  test("the sidebar collapses to icons on request, keeps every link's name, and stays collapsed on every page and after a reload", async ({
    daemon,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    const nav = page.getByRole("navigation", { name: "Console" });
    const label = nav.getByText("Workers", { exact: true });
    await expect(label).toBeVisible();

    await nav.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(label).toBeHidden();
    await expect(nav.getByRole("link", { name: "Workers" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await nav.getByRole("link", { name: "Leases" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
    await expect(label).toBeHidden();
    await page.reload();
    await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(label).toBeHidden();

    await nav.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(label).toBeVisible();
  });

  test("a window narrower than 1280px starts with the sidebar collapsed until the operator chooses", async ({
    daemon,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1100 });
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    const nav = page.getByRole("navigation", { name: "Console" });

    await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await nav.getByRole("button", { name: "Expand sidebar" }).click();
    await page.reload();
    await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
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
    expect(await background()).toBe("rgb(248, 248, 247)");
    expect(await text()).toBe("rgb(17, 17, 16)");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the shell passes an automated WCAG AA contrast check in both themes (${colorScheme})`, async ({
      daemon,
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      const audit = async () => {
        await settled(page);
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
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
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      expect(await audit()).toEqual([]);
    });
  }
});
