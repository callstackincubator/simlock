import { readdir } from "node:fs/promises";

import type { Page, Route } from "@playwright/test";

import { fetchFull } from "./full-fetch.js";

export interface RenderCase {
  readonly name: string;
  readonly path: string;
  readonly order: number;
}

export async function renderCases(): Promise<readonly RenderCase[]> {
  const files = await readdir(new URL("./render-cases/", import.meta.url));
  const modules = await Promise.all(
    files
      .filter((file) => file.endsWith(".ts"))
      .map(async (file) => {
        const loaded = (await import(`./render-cases/${file}`)) as {
          default: readonly RenderCase[];
        };
        return loaded.default;
      }),
  );
  return modules.flat().toSorted((a, b) => a.order - b.order);
}

const NOW = Date.parse("2026-10-02T18:20:00.000Z");
const names = [
  "mac-studio-01",
  "mac-studio-02",
  "mac-mini-ci-01",
  "mac-mini-ci-02",
  "mac-mini-ci-03",
  "mbp-lab-03",
  "Szymons-MacBook-Pro.local",
  "phone-rack-01",
];
const holders = [
  "claude-code:checkout-flow",
  "codex:8c1e2f4a-0b7d-4e21-9c3a-5f6d7e8a9b0c",
  "cursor:nav-redesign",
  "pi:release",
  "ci-nightly",
  "mcp:48213",
  "release-bot",
  "cursor/settings-a11y",
  "claude-code:onboarding-copy",
  "codex:cache",
  "ci/smoke",
  "claude-code:push",
  "codex:i18n",
  "claude-code:3f2a9c1e-7b44-4d0e-a2f1-0c9d8e7f91c4",
];

function lease(index: number, requesterId = holders[index]) {
  return {
    id: `lse_${index + 1}`,
    deviceId: `dev_${index + 1}`,
    workerId: `wrk_${(index % 8) + 1}`,
    requesterId,
    ownerId: "tok_agent",
    grantedAt: NOW - (index + 2) * 60_000,
    lastRenewedAt: NOW - 60_000,
    ttlDeadline: NOW + 600_000,
    ttlMs: 900_000,
    idChosenByRequester: false,
  };
}

function capacity(limit: number, running: number) {
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

function worker(index: number) {
  const held = holders.map((_, n) => n).filter((n) => n % 8 === index);
  const limit = index === 1 ? 20 : 6;
  return {
    id: `wrk_${index + 1}`,
    label: names[index],
    connection: index === 6 ? "disconnected" : "connected",
    drained: index === 5,
    lastSeenAt: NOW - (index === 6 ? 14 * 60_000 : 2_000),
    health: "running",
    version: "0.6.0",
    capacity: {
      ios: capacity(limit, held.length),
      android: capacity(0, 0),
      global: { maxRunning: limit, overLimit: false, reserved: 0, running: held.length, warm: 0 },
    },
    load: {
      cpu: { busyPercent: 38, cores: 8, limited: false },
      disk: { freeBytes: (index === 3 ? 9 : 52) * 2 ** 30, totalBytes: 100 * 2 ** 30 },
      memory: {
        availableBytes: 12 * 2 ** 30,
        limited: false,
        swapUsedBytes: 0,
        totalBytes: 32 * 2 ** 30,
      },
      readAt: NOW,
    },
    leases: held.map((n) => lease(n)),
    devices: held.map((n) => ({
      id: `dev_${n + 1}`,
      physical: false,
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
      state: "leased",
    })),
  };
}

// why: the reference's fictitious building row has no supported wire state; this is its ready DATA replacement.
const baselineNames = [
  "ios-18.4-iphone16",
  "ios-18.4-iphone16pro",
  "ios-18.4-ipadair11",
  "ios-17.5-iphone15",
  "android-35-pixel9",
  "android-35-pixel9pro",
  "android-35-pixel8",
  "android-34-pixel8",
  "android-35-pixeltablet",
];
const baselines = baselineNames.map((name, index) => ({
  name,
  workerId: `wrk_${(index % 4) + 1}`,
  version: 1,
  platform: index < 4 ? "ios" : "android",
  model: index < 4 ? "iPhone 16" : "Pixel 8",
  osVersion: index < 4 ? "18.4" : "15",
  mode: "full",
  savedAt: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
  sizeBytes: (index + 3) * 2 ** 30,
  ...(index === 3 ? { staleReason: "Runtime was replaced" } : {}),
}));

const events = Array.from({ length: 60 }, (_, index) => ({
  id: `evt_${index + 1}`,
  seq: 60 - index,
  timestamp: NOW - index * 60_000,
  event: index % 2 === 0 ? "lease.granted" : "device.ready",
  payload: { leaseId: "lse_1", workerId: "wrk_1", deviceId: "dev_1" },
}));

type Scenario = "populated" | "empty" | "long" | "refused";

function bodyFor(path: string, scenario: Scenario): unknown | undefined {
  if (path === "/v1/workers") return { workers: names.map((_, index) => worker(index)) };
  if (path === "/v1/leases") {
    const records = scenario === "empty" ? [] : holders.map((_, index) => lease(index));
    return { leases: scenario === "long" ? [lease(0, "x".repeat(256))] : records };
  }
  if (path === "/v1/leases/lse_1") {
    return {
      lease: {
        id: "lse_1",
        deviceId: "dev_1",
        udid: "fixture-device",
        device: "iPhone 16",
        workerId: "wrk_1",
        createdAt: new Date(NOW - 120_000).toISOString(),
        expiresAt: new Date(NOW + 600_000).toISOString(),
      },
    };
  }
  if (path === "/v1/baselines") return { baselines };
  if (path === "/v1/events") return { events };
  if (path === "/v1/inbox") return { items: [] };
  if (path === "/v1/lease-requests") return { requests: [] };
  return undefined;
}

async function respond(route: Route, scenario: Scenario): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  const response = await fetchFull(route);
  const headers: Record<string, string> = {
    ...response.headers(),
    date: new Date(NOW).toUTCString(),
  };
  delete headers.etag;
  const body = bodyFor(pathname, scenario);
  if (pathname === "/v1/leases" && scenario === "refused" && response.ok()) {
    await route.fulfill({
      response,
      headers,
      status: 403,
      json: { error: { code: "FIXTURE_REFUSED", message: "Fixture route refused" } },
    });
  } else if (pathname === "/v1/identity" && response.ok()) {
    const identity = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, headers, json: { ...identity, name: "Render operator" } });
  } else if (pathname === "/v1/stats" && response.ok()) {
    const stats = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      headers,
      json: {
        ...stats,
        coversFrom: NOW - 3_600_000,
        partial: false,
        window: { from: NOW - 3_600_000, to: NOW },
        series: Array.from({ length: 60 }, (_, index) => ({
          at: NOW - (59 - index) * 60_000,
          leasesHeld: 8 + (index % 7),
          queueDepth: index % 3,
          slotsUsed: 10 + (index % 7),
          slotsMax: 20,
          waiting: index % 3,
        })),
      },
    });
  } else if (
    body !== undefined &&
    (response.ok() || (pathname === "/v1/leases/lse_1" && response.status() === 404))
  ) {
    await route.fulfill({ response, headers, status: 200, json: body });
  } else {
    await route.fulfill({ response, headers });
  }
}

export async function renderFixture(page: Page, scenario: Scenario = "populated"): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.route(
    (url) =>
      url.pathname.startsWith("/v1/") &&
      url.pathname !== "/v1/events/stream" &&
      !url.pathname.startsWith("/v1/stream/"),
    (route) => respond(route, scenario),
  );
}
