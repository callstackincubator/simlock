import type { Page } from "@playwright/test";

// why: a stub is a hand-written body the page is given in place of the daemon's answer, so a state
// the daemon cannot make quickly (a request that waited minutes, three hundred leases) can be drawn.
// It never reads the daemon's own answer, so it needs no hardening against the daemon going away.
export async function stubJson(
  page: Page,
  pathname: string,
  body: () => unknown,
  status = 200,
): Promise<void> {
  await page.route(
    (url) => url.pathname === pathname,
    (route) =>
      route.fulfill({
        headers: { date: new Date().toUTCString() },
        json: body(),
        status,
      }),
  );
}

export function pad(n: number): string {
  return String(n).padStart(4, "0");
}

// why: a request that has waited two minutes and a lease about to end fill the Inbox's groups and the
// Overview's panel, and neither can be had quickly from a real daemon.
export function waitingItem(id: string, waitedMs: number): Record<string, unknown> {
  return {
    condition: "waiting",
    group: "Needs a look",
    key: `request/${id}/waiting`,
    request: {
      createdAt: Date.now() - waitedMs,
      id,
      queuePosition: 1,
      requesterId: id,
      spec: { platform: "ios" },
      stage: "queued",
    },
  };
}

export function endingItem(
  id: string,
  leftMs: number,
  names: { readonly holder: string; readonly model: string },
): Record<string, unknown> {
  const now = Date.now();
  return {
    condition: "ending",
    group: "Heads-up",
    key: `lease/${id}/ending`,
    lease: {
      deviceId: "dev_stub",
      grantedAt: now - 60_000,
      holder: names.holder,
      id,
      idChosenByRequester: false,
      lastRenewedAt: now - 30_000,
      model: names.model,
      ownerId: "tok_stub",
      requesterId: "tok_stub",
      ttlDeadline: now + leftMs,
      ttlMs: 900_000,
    },
  };
}

export function leases(count: number): unknown[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `dev_${pad(index + 1)}`,
    grantedAt: now - 3_600_000 + index * 1_000,
    id: `lse_${pad(index + 1)}`,
    idChosenByRequester: false,
    lastRenewedAt: now - 60_000,
    ownerId: "tok_load",
    requesterId: "tok_load",
    ttlDeadline: now + 600_000,
    ttlMs: 900_000,
  }));
}

// why: `count` events, one every 300 ms back from a second ago, newest first; `n` numbers them.
export function events(count: number): unknown[] {
  const newest = Date.now() - 1_000;
  return Array.from({ length: count }, (_, index) => ({
    event: "load.generated",
    id: `evt_load_${count - index}`,
    module: "load",
    payload: { n: count - index },
    seq: count - index,
    timestamp: newest - index * 300,
  }));
}

// why: a page before the last hour answers with no events, so the stubbed list ends where it did
// before Activity scrolled back.
export async function stubReplay(page: Page, replay: readonly unknown[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/events",
    (route) => {
      const since = new URL(route.request().url()).searchParams.has("since");
      return route.fulfill({
        headers: { date: new Date().toUTCString() },
        json: { events: since ? replay : [] },
      });
    },
  );
}

const GIB = 2 ** 30;

function capacityOf(limit: number, running: number) {
  return {
    atRamBudget: false,
    limit,
    maxRunning: limit,
    overLimit: false,
    reserved: 0,
    running,
    used: running,
    warm: 0,
  };
}

export interface StaticWorker {
  readonly id: string;
  readonly label: string;
  readonly connection?: string;
  readonly drained?: boolean;
  // why: how many iOS slots the worker has, which sets whether the page draws squares or a meter.
  readonly limit?: number;
  // why: a worker holding one lease on one device.
  readonly leased?: boolean;
  // why: no load reading at all, as a worker that has not been read yet; otherwise how full memory
  // is and the pressure word macOS reports, if any.
  readonly load?: false | { readonly usedPercent: number; readonly pressure?: string };
}

// why: a worker as the gateway lists it, written out by hand, so a page's colours and sizes are
// those of the real component over a reading the test chose, on any machine.
export function staticWorker(options: StaticWorker): Record<string, unknown> {
  const now = Date.now();
  const limit = options.limit ?? 6;
  const device = {
    id: `dev_${options.id}`,
    physical: false,
    servesDefaultMode: true,
    spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
    state: options.leased === true ? "leased" : "ready",
  };
  const loaded = options.load === false ? undefined : (options.load ?? { usedPercent: 40 });
  return {
    capabilities: [],
    capacity: {
      android: capacityOf(0, 0),
      global: {
        maxRunning: limit,
        overLimit: false,
        reserved: 0,
        running: options.leased === true ? 1 : 0,
        warm: 0,
      },
      ios: capacityOf(limit, options.leased === true ? 1 : 0),
    },
    connection: options.connection ?? "connected",
    devices: [device],
    drained: options.drained ?? false,
    health: "running",
    id: options.id,
    label: options.label,
    lastSeenAt: now - 2_000,
    leases:
      options.leased === true
        ? [
            {
              deviceId: device.id,
              grantedAt: now - 3_600_000,
              id: `lse_${options.id}`,
              idChosenByRequester: false,
              lastRenewedAt: now - 60_000,
              ownerId: "tok_agent",
              requesterId: "console-e2e",
              ttlDeadline: now + 600_000,
              ttlMs: 900_000,
            },
          ]
        : [],
    ...(loaded === undefined
      ? {}
      : {
          load: {
            cpu: { busyPercent: 38, cores: 8, limited: false },
            disk: { freeBytes: 52 * GIB, totalBytes: 100 * GIB },
            memory: {
              availableBytes: Math.round(32 * GIB * ((100 - loaded.usedPercent) / 100)),
              limited: false,
              swapUsedBytes: 0,
              totalBytes: 32 * GIB,
              ...(loaded.pressure === undefined ? {} : { pressure: loaded.pressure }),
            },
            readAt: now,
          },
        }),
    version: "0.6.0",
  };
}
