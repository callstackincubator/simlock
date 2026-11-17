import { readdir } from "node:fs/promises";

import type { APIResponse, Page, Route } from "@playwright/test";

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
    capabilities: [{ name: "stream", state: "available" }],
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

// why: only the Overview shows the queue, the problems and the leases about to end; every other page's
// case keeps its empty queue and Inbox and its leases as they were.
function leasesBody(scenario: Scenario, onOverview: boolean): unknown {
  const records = scenario === "empty" ? [] : holders.map((_, index) => lease(index));
  if (onOverview) {
    for (const [index, left] of [
      [4, 252_000],
      [6, 156_000],
    ] as const) {
      const record = records[index];
      if (record !== undefined) records[index] = { ...record, ttlDeadline: NOW + left };
    }
  }
  return { leases: scenario === "long" ? [lease(0, "x".repeat(256))] : records };
}

function leaseBody(): unknown {
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

function inboxBody(onOverview: boolean): unknown {
  if (!onOverview) return { items: [] };
  const [first, second, third] = [6, 5, 3].map(worker);
  return {
    items: [
      { condition: "disconnected", group: "Broken", key: "wrk_7/disconnected", worker: first },
      { condition: "drained", group: "Needs a look", key: "wrk_6/drained", worker: second },
      { condition: "over RAM budget", group: "Needs a look", key: "wrk_4/ram", worker: third },
    ],
  };
}

function requestsBody(onOverview: boolean): unknown {
  if (!onOverview) return { requests: [] };
  const asked = (id: number, requesterId: string, waitedMs: number, platform: string) => ({
    createdAt: NOW - waitedMs,
    id: `req_${id}`,
    queuePosition: id,
    requesterId,
    spec: { model: platform === "ios" ? "iPhone 16" : "Pixel 9", osVersion: "18.4", platform },
    stage: "queued",
  });
  return {
    requests: [
      asked(1, "codex:pr-1447-forms", 41_000, "ios"),
      asked(2, "ci/ui-shard-4", 22_000, "ios"),
      asked(3, "claude-code:widget-fix", 6_000, "android"),
    ],
  };
}

const BODIES: Readonly<Record<string, (scenario: Scenario, onOverview: boolean) => unknown>> = {
  "/v1/workers": () => ({ workers: names.map((_, index) => worker(index)) }),
  "/v1/leases": leasesBody,
  "/v1/leases/lse_1": leaseBody,
  "/v1/baselines": () => ({ baselines }),
  "/v1/events": () => ({ events }),
  "/v1/inbox": (_, onOverview) => inboxBody(onOverview),
  "/v1/lease-requests": (_, onOverview) => requestsBody(onOverview),
};

function bodyFor(path: string, scenario: Scenario, onOverview: boolean): unknown | undefined {
  return BODIES[path]?.(scenario, onOverview);
}

function statsBody(stats: Record<string, unknown>): unknown {
  return {
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
  };
}

function servesBody(pathname: string, response: APIResponse): boolean {
  return response.ok() || (pathname === "/v1/leases/lse_1" && response.status() === 404);
}

type Override = { status?: number; json: unknown };

async function identityOverride(response: APIResponse): Promise<Override> {
  const identity = (await response.json()) as Record<string, unknown>;
  return { json: { ...identity, name: "Render operator" } };
}

async function statsOverride(response: APIResponse): Promise<Override> {
  return { json: statsBody((await response.json()) as Record<string, unknown>) };
}

function refusedOverride(): Override {
  return {
    status: 403,
    json: { error: { code: "FIXTURE_REFUSED", message: "Fixture route refused" } },
  };
}

async function overrideFor(
  pathname: string,
  scenario: Scenario,
  response: APIResponse,
  onOverview: boolean,
): Promise<Override | undefined> {
  if (response.ok()) {
    if (pathname === "/v1/leases" && scenario === "refused") return refusedOverride();
    if (pathname === "/v1/identity") return identityOverride(response);
    if (pathname === "/v1/stats") return statsOverride(response);
  }
  const body = bodyFor(pathname, scenario, onOverview);
  if (body !== undefined && servesBody(pathname, response)) return { status: 200, json: body };
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
  const frame = route.request().frame().url();
  const onOverview = new URL(frame, "http://localhost").pathname === "/";
  const override = await overrideFor(pathname, scenario, response, onOverview);
  await route.fulfill({ response, headers, ...override });
}

// why: the fixture daemon has no capture program, so the browser answers a stream request itself with
// the capture envelope (a meta frame, then one JPEG a tenth of a second) of a checkout screen drawn on
// the spot, and holds the body open like a live stream.
function fakeStreams(): void {
  const fetchDaemon = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    if (!url.pathname.startsWith("/v1/stream/workers/")) return fetchDaemon(input, init);
    const [width, height] = [720, 1560];
    const canvas = new OffscreenCanvas(width, height);
    const draw = canvas.getContext("2d")!;
    draw.fillStyle = "#f6f6f8";
    draw.fillRect(0, 0, width, height);
    draw.fillStyle = "#111";
    draw.font = "600 32px sans-serif";
    draw.fillText("18:17", 60, 100);
    draw.font = "700 56px sans-serif";
    draw.fillText("Checkout", 44, 270);
    draw.font = "32px sans-serif";
    [
      ["Email", "ada@example.com"],
      ["Card", "•••• 4242"],
      ["Expiry", "12 / 29"],
      ["Postcode", ""],
    ].forEach(([label, value], index) => {
      const top = 380 + index * 130;
      draw.fillStyle = "#fff";
      draw.fillRect(36, top, 648, 104);
      draw.strokeStyle = "#e3e3e8";
      draw.strokeRect(36, top, 648, 104);
      draw.fillStyle = "#555";
      draw.fillText(label!, 66, top + 62);
      draw.fillStyle = "#111";
      draw.textAlign = "right";
      draw.fillText(value!, 654, top + 62);
      draw.textAlign = "left";
    });
    draw.fillStyle = "#111";
    draw.fillRect(36, 940, 648, 112);
    draw.fillStyle = "#fff";
    draw.textAlign = "center";
    draw.fillText("Pay $42.00", 360, 1008);
    const jpeg = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer(),
    );
    const envelope = (tag: number, payload: Uint8Array) => {
      const out = new Uint8Array(5 + payload.length);
      new DataView(out.buffer).setUint32(0, payload.length + 1);
      out[4] = tag;
      out.set(payload, 5);
      return out;
    };
    const meta = new TextEncoder().encode(
      JSON.stringify({ codec: "mjpeg", fps: 10, height, width }),
    );
    // why: the stream's figures are read off the browser's clock, so a capture that must repeat
    // exactly runs on a clock that moves 100 ms with each frame, and sends ten frames and no more.
    const base = performance.now();
    let frames = 0;
    performance.now = () => base + frames * 100;
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(envelope(0x05, meta));
        timer = setInterval(() => {
          frames += 1;
          (window as unknown as { streamFrames: number }).streamFrames = frames;
          controller.enqueue(envelope(0x03, jpeg));
          if (frames === 10) clearInterval(timer);
        }, 50);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return new Response(body, { headers: { "content-type": "application/octet-stream" } });
  };
}

export async function renderFixture(page: Page, scenario: Scenario = "populated"): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(fakeStreams);
  // why: the real SSE body stays open, so route.fetch cannot replace its Date without buffering it.
  await page.addInitScript((date) => {
    const fetchDaemon = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetchDaemon(input, init);
      if (new URL(response.url, location.href).pathname === "/v1/events/stream") {
        const headers = new Headers(response.headers);
        if (headers.has("date")) headers.set("date", date);
        Object.defineProperty(response, "headers", { value: headers });
        if (response.ok && response.body !== null) {
          // why: the daemon's live event clock is independent of the frozen browser and replay fixture.
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let pending = "";
          const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                pending += decoder.decode(chunk, { stream: true });
                let end: number;
                while ((end = pending.indexOf("\n")) !== -1) {
                  let line = pending.slice(0, end);
                  pending = pending.slice(end + 1);
                  if (line.startsWith("data: ")) {
                    const ending = line.endsWith("\r") ? "\r" : "";
                    try {
                      const event: unknown = JSON.parse(line.slice(6));
                      if (
                        typeof event === "object" &&
                        event !== null &&
                        "timestamp" in event &&
                        typeof event.timestamp === "number"
                      ) {
                        line = `data: ${JSON.stringify({ ...event, timestamp: Date.parse(date) })}${ending}`;
                      }
                    } catch {
                      // why: non-JSON SSE data is passed through unchanged.
                    }
                  }
                  controller.enqueue(encoder.encode(`${line}\n`));
                }
              },
              flush(controller) {
                controller.enqueue(encoder.encode(pending + decoder.decode()));
              },
            }),
          );
          Object.defineProperty(response, "body", { value: body });
        }
      }
      return response;
    };
  }, new Date(NOW).toUTCString());
  await renderScenario(page, scenario);
}

export async function renderScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.route(
    (url) =>
      url.pathname.startsWith("/v1/") &&
      url.pathname !== "/v1/events/stream" &&
      !url.pathname.startsWith("/v1/stream/"),
    (route) => respond(route, scenario),
  );
}
