import type { Page, Route } from "@playwright/test";

import { fetchFull } from "./full-fetch.js";

// why: the daemon's own response is kept so its headers (its `Date` among them) stay real, and it is always fetched in full, so a stub never meets a 304.
export async function answer(page: Page, pathname: string, body: () => unknown): Promise<void> {
  await page.route(
    (url) => url.pathname === pathname,
    async (route: Route) => {
      const response = await fetchFull(route);
      await route.fulfill({ json: body(), response });
    },
  );
}

export function pad(n: number): string {
  return String(n).padStart(4, "0");
}

export function leases(count: number): unknown[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `dev_${pad(index + 1)}`,
    grantedAt: now - 3_600_000 + index * 1_000,
    id: `lse_${pad(index + 1)}`,
    lastRenewedAt: now - 60_000,
    idChosenByRequester: false,
    ownerId: "tok_load",
    requesterId: "tok_load",
    ttlDeadline: now + 600_000,
    ttlMs: 900_000,
  }));
}
