import type { Locator, Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  expect,
  joinOldWorker,
  type RunningDaemon,
  signIn,
  signInWithKeyboard,
  startDaemon,
  test,
} from "./fixtures.js";

/** why: What `GET /v1/workers` says, as far as these tests read. */
interface WorkerView {
  readonly id: string;
}

async function workers(daemon: RunningDaemon): Promise<readonly WorkerView[]> {
  const listed = await daemon.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: WorkerView[] }).workers;
}

/**
 * why: Waits, asking every 20 ms, until the daemon's own `worker list` (over its socket, so a joined worker without HTTP answers too) says what `predicate`
 * looks for. The console's second starts there: it cannot show a fact before its daemon has it.
 */
async function untilTheDaemonSays(
  daemon: RunningDaemon,
  predicate: (views: readonly WorkerView[]) => boolean,
): Promise<void> {
  await waitFor(async () => predicate(await workers(daemon)), {
    interval: 20,
    label: "the daemon's own worker views",
    timeout: 30_000,
  });
}

async function openInbox(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  // why: a phone folds the navigation into a menu, so the page is opened by its address.
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(new URL("/inbox", daemon.url).href);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

function rows(page: Page): Locator {
  return page.locator("main").getByRole("list").getByRole("link");
}

function item(page: Page, condition: string, subject: string): Locator {
  return rows(page)
    .filter({ has: page.getByRole("img", { exact: true, name: condition }) })
    .filter({ hasText: subject });
}

/** why: Whether the page itself scrolls sideways. */
async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test.describe("the Inbox view", () => {
  test("the Inbox view has no horizontal scroll at 360px wide", async ({ page }) => {
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, {
        id: "wrk_with_a_long_id_that_does_not_fit_on_a_phone_0123456789",
        label: "aworkerwithalabelfartoolongforonelineonaphonewithnohyphensinit",
      });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      await page.setViewportSize({ height: 740, width: 360 });

      await openInbox(page, gateway);

      await expect(rows(page)).toHaveCount(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
      // why: a panel clips what overflows it, so the page never scrolls; the row itself must fit.
      const box = await rows(page).boundingBox();
      expect(box?.width ?? Infinity).toBeLessThanOrEqual(360);
      await rows(page).click();
      await expect(page.getByRole("heading", { level: 2, name: /^aworkerwith/ })).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });

  test("the Inbox view is usable with the keyboard alone", async ({ browserName, page }) => {
    // why: Safari moves focus to links with Option-Tab; plain Tab reaches only form controls there.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const gateway = await startDaemon("gateway");
    let hangUp = () => {};
    try {
      hangUp = await joinOldWorker(gateway, { id: "wrk_old", label: "old-worker" });
      await untilTheDaemonSays(gateway, (views) => views.length === 1);
      /** why: Tabs forward until `link` has focus, and follows it with Enter. */
      const follow = async (link: Locator) => {
        for (let step = 0; step < 20; step += 1) {
          if (await link.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press(tab);
        }
        await expect(link).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await page.goto(gateway.url);
      await signInWithKeyboard(page, gateway.tokens.operator, tab);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      await follow(
        page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: /^Inbox/ }),
      );
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

      await follow(item(page, "incompatible", "old-worker"));
      await expect(page.getByRole("heading", { level: 2, name: "old-worker" })).toBeVisible();

      await follow(page.getByRole("link", { name: "Open worker" }));
      await expect(page).toHaveURL(/\/fleet\/wrk_old$/);
    } finally {
      hangUp();
      await gateway.dispose();
    }
  });
});
