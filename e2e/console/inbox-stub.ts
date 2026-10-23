import type { Page, Route } from "@playwright/test";

import { fetchFull } from "./full-fetch.js";

/** why: an Inbox item the daemon cannot make quickly (a request that waited minutes, a lease about to end), in the shape `GET /v1/inbox` sends. */
export type StubbedItem = (now: number) => Record<string, unknown>;

export function waitingItem(id: string, waitedMs: number): StubbedItem {
  return (now) => ({
    condition: "waiting",
    group: "Needs a look",
    key: `request/${id}/waiting`,
    request: {
      createdAt: now - waitedMs,
      id,
      queuePosition: 1,
      requesterId: id,
      spec: { platform: "ios" },
      stage: "queued",
    },
  });
}

export function drainedWorkerItem(id: string): StubbedItem {
  return (now) => ({
    condition: "drained",
    group: "Needs a look",
    key: `${id}/drained`,
    worker: {
      connection: "connected",
      drained: true,
      heldLeases: 0,
      id,
      lastSeenAt: now,
      leasedDevices: 0,
    },
  });
}

export function endingItem(
  id: string,
  leftMs: number,
  names: { readonly holder?: string; readonly model?: string } = {},
): StubbedItem {
  return (now) => ({
    condition: "ending",
    group: "Heads-up",
    key: `lease/${id}/ending`,
    lease: {
      deviceId: "dev_stub",
      grantedAt: now - 60_000,
      holder: names.holder ?? "tok_stub",
      id,
      idChosenByRequester: false,
      lastRenewedAt: now - 30_000,
      model: names.model ?? "dev_stub",
      ownerId: "tok_stub",
      requesterId: "tok_stub",
      ttlDeadline: now + leftMs,
      ttlMs: 900_000,
    },
  });
}

/**
 * why: the items are added to what the daemon says, each counted from the daemon's own clock (its
 * Date header); `items()` is read at every answer, so a test can empty the list.
 */
export async function addInboxItems(
  page: Page,
  items: () => readonly StubbedItem[],
): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/inbox",
    async (route: Route) => {
      const response = await fetchFull(route);
      const now = new Date(response.headers().date ?? "").getTime();
      const body = (await response.json()) as { items: unknown[] };
      await route.fulfill({
        json: { items: [...body.items, ...items().map((item) => item(now))] },
        response,
      });
    },
  );
}
