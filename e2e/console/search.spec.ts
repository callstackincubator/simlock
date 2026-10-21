import type { Page } from "@playwright/test";

import { expect, signIn, test } from "./fixtures.js";

async function openConsole(page: Page, token: string, path = "/"): Promise<void> {
  await page.goto(path);
  await signIn(page, token);
  await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeVisible();
}

test.describe("the search box", () => {
  test("⌘K and Ctrl+K open the dialog and focus the box, the sidebar button opens it too, and Escape closes it and returns focus", async ({
    daemon,
    page,
  }) => {
    await openConsole(page, daemon.tokens.operator);
    const dialog = page.getByRole("dialog", { name: "Search" });
    const box = dialog.getByRole("combobox", { name: "Search pages, items and actions" });

    for (const shortcut of ["Meta+k", "Control+k"]) {
      await page.keyboard.press(shortcut);
      await expect(dialog).toBeVisible();
      await expect(box).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    const button = page.getByRole("button", { name: "Search or jump to…" });
    await button.click();
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
});
