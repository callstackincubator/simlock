import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { inboxItems } from "./inbox.js";
import type {
  statusDeviceSchema,
  statusLeaseSchema,
  tokenRecordSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./schemas.js";

type WorkerView = z.infer<typeof workerViewSchema>;
type Device = z.infer<typeof statusDeviceSchema>;
type Lease = z.infer<typeof statusLeaseSchema>;
type Token = z.infer<typeof tokenRecordSchema>;
type Waiting = z.infer<typeof waitingRequestSchema>;

const NOW = Date.parse("2026-10-02T12:00:00Z");
const GIB = 1024 ** 3;

function worker(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return { connection: "connected", drained: false, id, lastSeenAt: NOW, ...overrides };
}

function device(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    physical: false,
    servesDefaultMode: true,
    spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
    state: "ready",
    ...overrides,
  };
}

function lease(id: string, leftMs: number, overrides: Partial<Lease> = {}): Lease {
  return {
    deviceId: "dev_leased",
    grantedAt: NOW - 60_000,
    id,
    idChosenByRequester: false,
    lastRenewedAt: NOW - 30_000,
    ownerId: "tok_1",
    requesterId: "tok_1",
    ttlDeadline: NOW + leftMs,
    ttlMs: 900_000,
    ...overrides,
  };
}

function request(id: string, waitedMs: number): Waiting {
  return {
    createdAt: NOW - waitedMs,
    id,
    queuePosition: 1,
    requesterId: "agent-b",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
  };
}

function ramBudget(overLimit: boolean) {
  const entry = {
    atRamBudget: false,
    limit: 4,
    maxRunning: 4,
    overLimit: false,
    reserved: 0,
    running: 1,
    used: 1,
    warm: 0,
  };
  return {
    android: entry,
    global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
    ios: entry,
    ramBudget: { limitBytes: 12 * GIB, overLimit, usedBytes: 13 * GIB },
  };
}

const TOKENS: Token[] = [
  { createdAt: NOW - 1_000_000, id: "tok_1", label: "ci-runner-3", role: "agent" },
];

describe("the inbox rules", () => {
  it("turn fleet data into items: each worker, device, waiting and ending condition, with its group, order, key and subject", () => {
    const failure = {
      at: NOW - 120_000,
      from: "0.3.0",
      message: "EACCES",
      stage: "installing",
      to: "0.4.0",
    } as const;
    const workers: WorkerView[] = [
      worker("wrk_ok", { capacity: ramBudget(false), lastUpdateFailure: null }),
      worker("wrk_gone", { connection: "disconnected", drained: true, leases: [lease("l1", 1e6)] }),
      worker("wrk_old", { connection: "incompatible" }),
      worker("wrk_upd", {
        devices: [device("dev_leased", { state: "leased" }), device("dev_idle")],
        label: "mac-07",
        lastUpdateFailure: failure,
      }),
      worker("wrk_ram", { capacity: ramBudget(true) }),
      worker("wrk_dev", {
        devices: [
          device("dev_ready"),
          device("dev_q", { state: "quarantined" }),
          device("dev_stuck", { state: "reclaiming", stalled: true, transitionAgeMs: 300_000 }),
          device("dev_busy", { state: "provisioning", transitionAgeMs: 2_000 }),
          device("dev_phone", {
            absentReason: "locked",
            physical: true,
            state: "absent",
          }),
        ],
        drained: true,
        label: "mac-08",
      }),
      worker("wrk_lost", {
        connection: "disconnected",
        devices: [
          device("dev_lost", { state: "reclaiming", stalled: true, transitionAgeMs: 5_000 }),
        ],
      }),
    ];
    const requests = [
      request("req_old", 60_001),
      request("req_edge", 60_000),
      request("req_new", 59_000),
      request("req_longest", 90_000),
      request("req_tie_b", 70_000),
      request("req_tie_a", 70_000),
    ];
    const leases = [
      lease("lse_far", 360_000),
      lease("lse_edge", 300_000),
      lease("lse_near", 240_000, { requesterId: "gw:g1:tok_1", workerId: "wrk_upd" }),
      lease("lse_now", 10_000, { deviceId: "dev_gone", requesterId: "gw:g1:agent-9" }),
    ];

    const items = inboxItems(workers, { leases, now: NOW, requests, tokens: TOKENS });

    expect(items.map((item) => [item.key, item.group, item.condition])).toEqual([
      ["wrk_gone/disconnected", "Broken", "disconnected"],
      ["wrk_gone/drained", "Needs a look", "drained"],
      ["wrk_old/incompatible", "Broken", "incompatible"],
      ["wrk_upd/update-failed", "Needs a look", "update failed"],
      ["wrk_ram/ram", "Needs a look", "over RAM budget"],
      ["wrk_dev/drained", "Needs a look", "drained"],
      ["wrk_dev/dev_q/quarantined", "Broken", "quarantined"],
      ["wrk_dev/dev_stuck/stalled", "Needs a look", "stalled"],
      ["wrk_dev/dev_phone/absent", "Needs a look", "absent"],
      ["wrk_lost/disconnected", "Broken", "disconnected"],
      ["wrk_lost/dev_lost/stalled", "Needs a look", "stalled"],
      ["request/req_longest/waiting", "Needs a look", "waiting"],
      ["request/req_tie_a/waiting", "Needs a look", "waiting"],
      ["request/req_tie_b/waiting", "Needs a look", "waiting"],
      ["request/req_old/waiting", "Needs a look", "waiting"],
      ["lease/lse_now/ending", "Heads-up", "ending"],
      ["lease/lse_near/ending", "Heads-up", "ending"],
    ]);
    const byKey = (key: string) => items.find((item) => item.key === key);
    expect(byKey("wrk_gone/drained")).toMatchObject({
      worker: { heldLeases: 1, id: "wrk_gone", leasedDevices: 0 },
    });
    expect(byKey("wrk_upd/update-failed")).toMatchObject({
      worker: { heldLeases: 0, label: "mac-07", lastUpdateFailure: failure, leasedDevices: 1 },
    });
    expect(byKey("wrk_ram/ram")).toMatchObject({ limitBytes: 12 * GIB, usedBytes: 13 * GIB });
    expect(byKey("wrk_dev/dev_stuck/stalled")).toMatchObject({
      device: {
        id: "dev_stuck",
        stateEnteredAt: NOW - 300_000,
        workerId: "wrk_dev",
        workerLabel: "mac-08",
      },
    });
    expect(byKey("wrk_dev/dev_q/quarantined")).toMatchObject({
      device: { id: "dev_q", workerId: "wrk_dev" },
    });
    expect(byKey("wrk_dev/dev_phone/absent")).toMatchObject({
      device: { absentReason: "locked", id: "dev_phone" },
    });
    expect(byKey("request/req_old/waiting")).toMatchObject({
      request: { createdAt: NOW - 60_001, id: "req_old", requesterId: "agent-b" },
    });
    expect(byKey("lease/lse_near/ending")).toMatchObject({
      lease: {
        holder: "ci-runner-3",
        id: "lse_near",
        model: "iPhone 16",
        ttlDeadline: NOW + 240_000,
      },
    });
    expect(byKey("lease/lse_now/ending")).toMatchObject({
      lease: { holder: "agent-9", model: "dev_gone" },
    });
    expect(byKey("wrk_lost/dev_lost/stalled")).not.toHaveProperty("device.stateEnteredAt");
    expect(
      inboxItems([worker("wrk_solo", { devices: [device("dev_leased")] })], {
        leases: [lease("lse_solo", 10_000)],
        now: NOW,
      }).map((item) => item.condition === "ending" && item.lease.model),
    ).toEqual(["iPhone 16"]);
  });
});
