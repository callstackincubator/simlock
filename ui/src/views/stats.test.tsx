import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Stat, StatCards } from "../layout";
import { attentionItems, attentionStats } from "./attention-model";
import { type ConsoleEvent, eventsStats, timeOfDay } from "./events-model";
import { type LeaseRecord, leasesStats } from "./leases-model";
import { type WaitingRequest, waitingStats } from "./waiting-model";
import { type WorkerDevice, type WorkerView, workersStats } from "./workers-model";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const MINUTE = 60_000;

/** Each stat card as `label | value | caption`, read from the markup the view renders. */
function cards(stats: readonly Stat[]): string[] {
  const html = renderToStaticMarkup(<StatCards stats={stats} />);
  return [...html.matchAll(/<li class="stat">(.*?)<\/li>/g)].map(([, inner = ""]) =>
    [...inner.matchAll(/<p class="stat-(?:label|value|caption)">(.*?)<\/p>/g)]
      .map(([, text = ""]) => text.replace(/&#x27;/g, "'"))
      .join(" | "),
  );
}

function capacity(running: number) {
  const entry = { limit: 4, maxRunning: 4, overLimit: false, reserved: 0, running, used: running };
  return {
    android: { ...entry, running: 0, used: 0, warm: 0 },
    global: { maxRunning: 4, overLimit: false, reserved: 0, running, warm: 0 },
    ios: { ...entry, warm: 0 },
  };
}

function device(id: string, state: string, overrides: Partial<WorkerDevice> = {}): WorkerDevice {
  return {
    id,
    mode: "full",
    spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
    state,
    ...overrides,
  } as WorkerDevice;
}

function lease(id: string, requesterId: string, ttlDeadline: number): LeaseRecord {
  return {
    deviceId: `dev_${id}`,
    grantedAt: NOW - MINUTE,
    id,
    lastRenewedAt: NOW - MINUTE,
    ownerId: requesterId,
    requesterId,
    ttlDeadline,
    ttlMs: 15 * MINUTE,
  };
}

function worker(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function waitingRequest(id: string, createdAt: number): WaitingRequest {
  return {
    createdAt,
    id,
    requesterId: `agent-${id}`,
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
  } as WaitingRequest;
}

describe("the stat cards", () => {
  it("each view shows its stat cards with the numbers its data gives", () => {
    const fleet = [
      worker("wrk_a", {
        capacity: capacity(2),
        devices: [device("d1", "leased"), device("d2", "leased"), device("d3", "shutdown")],
        leases: [lease("l1", "agent-1", NOW + MINUTE), lease("l2", "agent-2", NOW + MINUTE)],
        waiting: [
          { createdAt: NOW, id: "r1", requesterId: "agent-3" },
          { createdAt: NOW, id: "r2", requesterId: "agent-4" },
        ] as WorkerView["waiting"],
      }),
      worker("wrk_b", {
        capacity: capacity(1),
        devices: [device("d4", "quarantined")],
        drained: true,
        leases: [lease("l3", "agent-1", NOW + MINUTE)],
      }),
      // Never read: its devices count as not running, as its card says "Not reported".
      worker("wrk_c", { connection: "disconnected", devices: [device("d5", "ready")] }),
    ];
    expect(cards(workersStats(fleet))).toEqual([
      "Workers | 2 | connected of 3",
      "Devices | 3 | running of 5",
      "Leases | 3 | held now",
      "Waiting | 2 | requests in the workers' queues",
    ]);

    // Two holders between three leases; one expires in 15 minutes exactly, one in 14, one in 16.
    const leases = [
      lease("l1", "agent-1", NOW + 15 * MINUTE),
      lease("l2", "agent-1", NOW + 14 * MINUTE),
      lease("l3", "agent-2", NOW + 16 * MINUTE),
    ];
    expect(cards(leasesStats(leases, NOW))).toEqual([
      "Leases | 3 | held now",
      "Holders | 2 | holding at least one lease",
      "Expiring soon | 2 | expire within 15 minutes unless renewed",
    ]);

    const requests = [
      waitingRequest("r1", NOW - 30_000),
      waitingRequest("r2", NOW - 90_000),
      waitingRequest("r3", NOW - 5_000),
    ];
    expect(cards(waitingStats(requests, NOW))).toEqual([
      "Requests waiting | 3 | for a device",
      "Longest wait | 1 min 30 s | the oldest request so far",
    ]);
    expect(cards(waitingStats([], NOW))).toEqual([
      "Requests waiting | 0 | for a device",
      "Longest wait | — | no request is waiting",
    ]);

    // wrk_b: drained, and its device d4 quarantined; wrk_c: disconnected; wrk_a: nothing.
    expect(cards(attentionStats(attentionItems(fleet)))).toEqual([
      "Items | 3 | need attention now",
      "Workers affected | 2 | with at least one item",
      "Devices affected | 1 | quarantined or stalled",
    ]);

    const newest: ConsoleEvent = {
      event: "lease.granted",
      payload: {},
      seq: 2,
      timestamp: NOW - 5_000,
    };
    const older: ConsoleEvent = {
      event: "device.ready",
      payload: {},
      seq: 1,
      timestamp: NOW - 9_000,
    };
    expect(cards(eventsStats([newest, older], 2, true))).toEqual([
      "Events shown | 2 | in the last hour",
      `Newest | ${timeOfDay(newest.timestamp)} | lease.granted`,
    ]);
    expect(cards(eventsStats([older], 2, false))).toEqual([
      "Events shown | 1 | of 2 in the last hour",
      `Newest | ${timeOfDay(older.timestamp)} | device.ready`,
    ]);
    expect(cards(eventsStats([], 0, true))).toEqual([
      "Events shown | 0 | in the last hour",
      "Newest | — | no event to show",
    ]);
  });
});
