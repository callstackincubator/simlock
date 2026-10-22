import type { Page } from "@playwright/test";

import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

type WorkerFields = Record<string, unknown>;

// why: the real fleet never has a newer release to offer, so the list says what the update fields
// would, as actions.spec.ts does for `drained`.
async function showWorkerFields(page: Page, fields: () => WorkerFields): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/workers",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { workers: Record<string, unknown>[] };
      await route.fulfill({
        json: { ...body, workers: body.workers.map((view) => ({ ...view, ...fields() })) },
        response,
      });
    },
  );
}

async function openFleet(page: Page, gateway: RunningDaemon): Promise<void> {
  await page.goto(new URL("/fleet", gateway.url).toString());
  await signIn(page, gateway.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
}

test.describe("the console updates a worker", () => {
  test("Update… sends an empty body and the toast names the version", async ({ page }) => {
    const fleet = await startFleet([{ driverScript: { ios: IOS }, label: "upd-a" }]);
    try {
      await showWorkerFields(page, () => ({
        latestVersion: "0.4.0",
        lastUpdateFailure: null,
        update: null,
        version: "0.3.0",
      }));
      const posts: string[] = [];
      await page.route("**/v1/workers/*/update", async (route) => {
        posts.push(route.request().postData() ?? "");
        await route.fulfill({
          json: {
            started: true,
            upToDate: false,
            update: { stage: "waiting", leases: 0, from: "0.3.0", to: "0.4.0" },
            version: "0.3.0",
          },
          status: 202,
        });
      });
      await openFleet(page, fleet.gateway);
      const row = page.locator("main tbody tr").filter({ hasText: "upd-a" });
      await expect(row).toContainText("simlock 0.3.0 · 0.4.0 available");
      await row.getByRole("button", { name: "Actions for upd-a" }).click();
      await page.getByRole("menuitem", { name: "Update…" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Update upd-a from 0.3.0 to 0.4.0?" });
      await expect(dialog).toContainText(
        "It has no leases, so it installs at once. It restarts by itself.",
      );
      await dialog.getByRole("button", { name: "Update", exact: true }).click();
      await expect(page.getByText("Updating upd-a to 0.4.0")).toBeVisible();
      expect(posts).toEqual(["{}"]);
    } finally {
      await disposeFleet(fleet);
    }
  });
});
