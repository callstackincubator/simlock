import type { Page } from "@playwright/test";

// why: the console reads each route on its own interval (leases every 10 s, workers every 15 s,
// stats every 60 s) and again when the operator comes back to the tab, so a spec that changes what
// the daemon answers and wants the page to show it at once hides the tab and shows it again, which
// is that return.
export async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const show = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    show("hidden");
    show("visible");
  });
}
