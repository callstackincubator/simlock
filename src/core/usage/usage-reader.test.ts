import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteOpener } from "../../ports/index.js";
import { createUsageReader, type UsageReader, type UsageReaderDeps } from "./index.js";
import {
  capacity,
  readHistoryEvents,
  DAY,
  granted,
  HOUR,
  MIN,
  rejected,
  released,
  removeUsageRigs,
  requested,
  T0,
  usageRig,
  type UsageRig,
  type UsageRigOptions,
} from "../../history/testing.js";

const readers: UsageReader[] = [];
const rigs: UsageRig[] = [];

afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.stop()));
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
  await removeUsageRigs();
});

async function setup(options: UsageRigOptions & { readonly deps?: Partial<UsageReaderDeps> } = {}) {
  const rig = await usageRig(options);
  rigs.push(rig);
  const reader = createUsageReader(rig.deps(options.deps));
  readers.push(reader);
  const usage = async (from: number, to: number) => {
    const result = await reader.get({ from, to });
    expect(result.kind).toBe("figures");
    if (result.kind !== "figures") throw new Error(`expected figures, got ${result.kind}`);
    return result.usage;
  };
  return { reader, rig, usage };
}

const NONE = { count: 0, max: null, p50: null, p95: null };

describe("usage reader: requests, grants and samples", () => {
  it("counts a request granted, held and released as one request, one grant, and one sample each of wait, held and turnaround, with the milliseconds the events were stamped apart and no failure", async () => {
    const { rig, usage } = await setup();
    rig.emit("lease.requested", requested("R1"));
    rig.at(T0 + 400);
    rig.emit("lease.granted", granted("L1", "R1"));
    rig.at(T0 + 1_900);
    rig.emit("lease.released", released("L1"));

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals).toMatchObject({ granted: 1, requests: 1, bySource: { warm: 1 } });
    expect(totals.failures).toEqual({ byEvent: {} });
    expect(totals.wait).toEqual({ count: 1, max: 400, p50: 400, p95: 400 });
    expect(totals.held).toEqual({ count: 1, max: 1_500, p50: 1_500, p95: 1_500 });
    expect(totals.turnaround).toEqual({ count: 1, max: 1_900, p50: 1_900, p95: 1_900 });
  });

  it("reports wait p50, p95 and max by nearest rank over twenty known waits, and null with count 0 over none", async () => {
    const { rig, usage } = await setup();
    for (let index = 1; index <= 20; index += 1) {
      rig.emit("lease.requested", requested(`R${index}`));
    }
    for (let index = 1; index <= 20; index += 1) {
      rig.at(T0 + index * 1_000);
      rig.emit("lease.granted", granted(`L${index}`, `R${index}`));
    }

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals.wait).toEqual({ count: 20, max: 20_000, p50: 10_000, p95: 19_000 });
    expect(totals.held).toEqual(NONE);
    expect(totals.turnaround).toEqual(NONE);
    expect(totals.provisioning).toEqual(NONE);
    expect(totals.boot).toEqual(NONE);
  });

  it("counts rejections under their reason (timeout, no-wait, cancelled) and not under grants, and grants under warm, booted and provisioned by their source", async () => {
    const { rig, usage } = await setup();
    for (const id of ["A", "B", "C", "D", "E", "F"]) rig.emit("lease.requested", requested(id));
    rig.at(T0 + 5_000);
    rig.emit("lease.rejected", rejected("A", "timeout"));
    rig.emit("lease.rejected", rejected("B", "no-wait"));
    rig.emit("lease.rejected", rejected("C", "cancelled"));
    rig.emit("lease.granted", granted("L-D", "D", { source: "warm" }));
    rig.emit("lease.granted", granted("L-E", "E", { source: "booted" }));
    rig.emit("lease.granted", granted("L-F", "F", { source: "provisioned" }));

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals.requests).toBe(6);
    expect(totals.rejected).toEqual({
      byReason: { cancelled: 1, "no-wait": 1, timeout: 1 },
      total: 3,
    });
    expect(totals.granted).toBe(3);
    expect(totals.bySource).toMatchObject({ booted: 1, provisioned: 1, warm: 1 });
  });

  it("counts a request made before from and settled inside the window in no count, a lease open at to as a request and a grant with no held or turnaround sample, and a grant after to as a request only", async () => {
    const { rig, usage } = await setup({ at: T0 - 10 * MIN });
    rig.at(T0 - 5 * MIN);
    rig.emit("lease.requested", requested("BEFORE"));
    rig.at(T0 + MIN);
    rig.emit("lease.granted", granted("L-BEFORE", "BEFORE"));
    rig.at(T0 + 2 * MIN);
    rig.emit("lease.released", released("L-BEFORE"));
    rig.at(T0 + 10 * MIN);
    rig.emit("lease.requested", requested("OPEN"));
    rig.at(T0 + 10 * MIN + 2_000);
    rig.emit("lease.granted", granted("L-OPEN", "OPEN"));
    rig.at(T0 + 30 * MIN);
    rig.emit("lease.requested", requested("ENDS-LATE"));
    rig.at(T0 + 30 * MIN + 1_000);
    rig.emit("lease.granted", granted("L-LATE", "ENDS-LATE"));
    rig.at(T0 + 59 * MIN);
    rig.emit("lease.requested", requested("GRANTED-LATE"));
    rig.at(T0 + 61 * MIN);
    rig.emit("lease.granted", granted("L-GL", "GRANTED-LATE"));
    rig.at(T0 + 70 * MIN);
    rig.emit("lease.released", released("L-LATE"));

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals.requests).toBe(3);
    expect(totals.granted).toBe(2);
    expect(totals.wait).toEqual({ count: 2, max: 2_000, p50: 1_000, p95: 2_000 });
    expect(totals.held).toEqual(NONE);
    expect(totals.turnaround).toEqual(NONE);
  });

  it("takes a rejection's wait as a sample, counts a grant, a rejection and a release stamped exactly at to, and sees a rejection one millisecond after it in no count", async () => {
    const { rig, usage } = await setup();
    rig.emit("lease.requested", requested("R1"));
    rig.at(T0 + 3_000);
    rig.emit("lease.rejected", rejected("R1", "timeout"));
    rig.at(T0 + 59 * MIN);
    for (const id of ["R2", "R3", "G1", "G2"]) rig.emit("lease.requested", requested(id));
    rig.at(T0 + HOUR - 1_000);
    rig.emit("lease.granted", granted("L-G1", "G1"));
    rig.at(T0 + HOUR);
    rig.emit("lease.rejected", rejected("R2", "timeout"));
    rig.emit("lease.granted", granted("L-G2", "G2"));
    rig.emit("lease.released", released("L-G1"));
    rig.at(T0 + HOUR + 1);
    rig.emit("lease.rejected", rejected("R3", "timeout"));

    const { totals, requesters } = await usage(T0, T0 + HOUR);

    expect(totals.requests).toBe(5);
    expect(totals.rejected).toEqual({ byReason: { timeout: 2 }, total: 2 });
    expect(totals.granted).toBe(2);
    expect(totals.wait).toEqual({ count: 4, max: 60_000, p50: 59_000, p95: 60_000 });
    expect(totals.held).toEqual({ count: 1, max: 1_000, p50: 1_000, p95: 1_000 });
    expect(requesters).toEqual([
      { granted: 2, heldTotalMs: 1_000, id: "alice", rejected: 2, requests: 5 },
    ]);
  });

  it("counts a refused-at-admission rejection (already-leased) under rejected and not under requests, in the totals and in its requester's entry alike", async () => {
    const { rig, usage } = await setup();
    rig.emit("lease.requested", requested("R1"));
    rig.at(T0 + 100);
    rig.emit("lease.granted", granted("L1", "R1"));
    rig.at(T0 + 200);
    rig.emit(
      "lease.rejected",
      rejected("R2", "already-leased", { requester: "bob", requestSpec: { platform: "ios" } }),
    );

    const answer = await usage(T0, T0 + HOUR);

    expect(answer.totals.requests).toBe(1);
    expect(answer.totals.rejected).toEqual({ byReason: { "already-leased": 1 }, total: 1 });
    expect(answer.totals.wait.count).toBe(1);
    expect(answer.requesters).toEqual([
      { granted: 1, heldTotalMs: 0, id: "alice", rejected: 0, requests: 1 },
      { granted: 0, heldTotalMs: 0, id: "bob", rejected: 1, requests: 0 },
    ]);
  });

  it("on a worker counts a probe under probes and granted, not requests, with no wait or turnaround sample, a declined probe under declined and not rejected, and lists the granted probe's gw: requester with the grant and held time and no request", async () => {
    const { rig, usage } = await setup();
    const gateway = "gw:gw-1:tok_a";
    rig.emit("lease.requested", requested("P1", { fleetRequestId: "F1", requester: gateway }));
    rig.emit(
      "lease.requested",
      requested("P2", { fleetRequestId: "F2", requester: "gw:gw-1:tok_b" }),
    );
    rig.emit("lease.requested", requested("Q1"));
    rig.at(T0 + 100);
    rig.emit("lease.granted", granted("LQ", "Q1"));
    rig.at(T0 + 300);
    rig.emit("lease.granted", granted("LP", "P1", { requester: gateway, source: "booted" }));
    rig.at(T0 + 600);
    rig.emit("lease.declined", {
      fleetRequestId: "F2",
      reason: "no-wait",
      requestId: "P2",
      requestSpec: { platform: "ios" },
      requester: "gw:gw-1:tok_b",
    });
    rig.at(T0 + 700);
    rig.emit("lease.released", released("LQ"));
    rig.at(T0 + 1_300);
    rig.emit("lease.released", released("LP", gateway));

    const answer = await usage(T0, T0 + HOUR);

    expect(answer.totals).toMatchObject({
      declined: 1,
      granted: 2,
      probes: 2,
      requests: 1,
      bySource: { booted: 1, warm: 1 },
      rejected: { byReason: {}, total: 0 },
    });
    expect(answer.totals.wait).toEqual({ count: 1, max: 100, p50: 100, p95: 100 });
    expect(answer.totals.turnaround.count).toBe(1);
    expect(answer.requesters).toEqual([
      { granted: 1, heldTotalMs: 600, id: "alice", rejected: 0, requests: 1 },
      { granted: 1, heldTotalMs: 1_000, id: gateway, rejected: 0, requests: 0 },
    ]);
  });

  it("with fleet takes a fleet grant's held time from the row's heldMs, and answers no probes field in totals or worker entries", async () => {
    const { rig, usage } = await setup({ deps: { workers: () => [{ id: "w1" }] }, fleet: true });
    rig.emit("lease.requested", requested("G1", { requester: "tok_a" }));
    rig.relay("w1", "lease.granted", granted("WL1", "G1", { source: "booted" }), T0 + 2_000);
    rig.at(T0 + 3_000);
    rig.emit("request.granted", {
      leaseId: "G-G1",
      requestId: "G1",
      worker: "w1",
      workerLeaseId: "WL1",
    });
    rig.relay("w1", "lease.released", released("WL1", "gw:gw-1:tok_a"), T0 + 10_000);

    const answer = await usage(T0, T0 + HOUR);

    expect(answer.totals).toMatchObject({ bySource: { booted: 1 }, granted: 1, requests: 1 });
    expect(answer.totals.held).toEqual({ count: 1, max: 8_000, p50: 8_000, p95: 8_000 });
    expect(answer.totals.wait).toEqual({ count: 1, max: 3_000, p50: 3_000, p95: 3_000 });
    expect(answer.totals).not.toHaveProperty("probes");
    expect(answer.workers.length).toBeGreaterThan(0);
    for (const worker of answer.workers) expect(worker).not.toHaveProperty("probes");
  });

  it("with fleet counts a fleet grant whose worker has not yet told its source under unknown, which a worker never answers", async () => {
    const fleet = await setup({ deps: { workers: () => [{ id: "w1" }] }, fleet: true });
    fleet.rig.emit("lease.requested", requested("G1", { requester: "tok_a" }));
    fleet.rig.at(T0 + 1_000);
    fleet.rig.emit("request.granted", {
      leaseId: "G-G1",
      requestId: "G1",
      worker: "w1",
      workerLeaseId: "WL1",
    });
    const worker = await setup();
    worker.rig.emit("lease.requested", requested("R1"));
    worker.rig.emit("lease.granted", granted("L1", "R1"));

    const gateway = await fleet.usage(T0, T0 + HOUR);
    const local = await worker.usage(T0, T0 + HOUR);

    expect(gateway.totals.bySource).toEqual({ booted: 0, provisioned: 0, unknown: 1, warm: 0 });
    expect(local.totals.bySource).toEqual({ booted: 0, provisioned: 0, warm: 1 });
  });

  it("lists requesters by request count then id, with the token label of a known token, and none when the daemon has no token store", async () => {
    const labels = new Map([["tok_b", "ci-bot"]]);
    const labelled = await setup({ deps: { tokenLabels: async () => labels } });
    const unlabelled = await setup();
    for (const { rig } of [labelled, unlabelled]) {
      for (const [id, requester] of [
        ["R1", "tok_c"],
        ["R2", "tok_c"],
        ["R3", "tok_b"],
        ["R4", "tok_a"],
        ["R5", "tok_z"],
        ["R6", "tok_z"],
        ["R7", "tok_z"],
      ] as const) {
        rig.emit("lease.requested", requested(id, { requester }));
      }
    }

    const withLabels = await labelled.usage(T0, T0 + HOUR);
    const without = await unlabelled.usage(T0, T0 + HOUR);

    expect(withLabels.requesters.map((entry) => entry.id)).toEqual([
      "tok_z",
      "tok_c",
      "tok_a",
      "tok_b",
    ]);
    expect(withLabels.requesters.map((entry) => entry.label)).toEqual([
      undefined,
      undefined,
      undefined,
      "ci-bot",
    ]);
    expect(without.requesters.map((entry) => entry.label)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(without.requesters.every((entry) => !("label" in entry))).toBe(true);
  });

  it("answers the same figures after the prune has removed every event of the window, from the rows alone", async () => {
    const first = await setup();
    first.rig.emit("lease.requested", requested("R1"));
    first.rig.at(T0 + 400);
    first.rig.emit("lease.granted", granted("L1", "R1"));
    first.rig.at(T0 + 1_900);
    first.rig.emit("lease.released", released("L1"));
    const before = await first.usage(T0, T0 + HOUR);
    await first.rig.close();
    rigs.splice(rigs.indexOf(first.rig), 1);
    expect(await readHistoryEvents(first.rig.directory)).not.toEqual([]);

    const later = await setup({ at: T0 + 8 * DAY, directory: first.rig.directory });

    expect(await readHistoryEvents(first.rig.directory)).toEqual([]);
    expect(await later.usage(T0, T0 + HOUR)).toEqual(before);
    expect(before.totals.requests).toBe(1);
  });
});

describe("usage reader: device facts", () => {
  it("reports provisioning and boot p50, p95 and max from device.provisioned and device.ready, and counts quarantined, crashRecovered, quarantineRecovered, lost (each of its three events), declined and failures.byEvent[device.recovery-failed], one event of each", async () => {
    const { rig, usage } = await setup();
    rig.emit("device.provisioned", {
      deviceId: "d1",
      driver: "fake",
      duration: 90_000,
      spec: { platform: "ios" },
    });
    rig.emit("device.provisioned", {
      deviceId: "d2",
      driver: "fake",
      duration: 30_000,
      spec: { platform: "ios" },
    });
    rig.emit("device.ready", { bootDuration: 20_000, deviceId: "d1", platform: "ios" });
    rig.emit("device.quarantined", {
      deviceId: "d3",
      kind: "purge-failed",
      maxRetries: 3,
      nextRetryAt: T0 + MIN,
      platform: "ios",
    });
    rig.emit("device.recovered", {
      attempts: 1,
      deviceId: "d4",
      duration: 5_000,
      leaseId: "L4",
      platform: "ios",
    });
    rig.emit("device.quarantine-recovered", {
      attempts: 2,
      deviceId: "d3",
      platform: "ios",
      strategy: "erase",
    });
    rig.emit("device.recovery-failed", {
      attempts: 3,
      deviceId: "d5",
      error: "boom",
      leaseId: "L5",
      platform: "ios",
      reason: "crash",
    });
    rig.emit("device.quarantine-abandoned", { attempts: 3, deviceId: "d6", platform: "ios" });
    rig.emit("device.quarantine-stranded", {
      attempts: 3,
      deviceId: "d7",
      error: "gone",
      platform: "ios",
    });
    rig.emit("lease.declined", {
      fleetRequestId: "F1",
      reason: "no-wait",
      requestId: "P1",
      requestSpec: { platform: "ios" },
      requester: "gw:gw-1:tok_a",
    });

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals.provisioning).toEqual({ count: 2, max: 90_000, p50: 30_000, p95: 90_000 });
    expect(totals.boot).toEqual({ count: 1, max: 20_000, p50: 20_000, p95: 20_000 });
    expect(totals.incidents).toEqual({
      crashRecovered: 1,
      lost: 3,
      quarantineRecovered: 1,
      quarantined: 1,
    });
    expect(totals.declined).toBe(1);
    expect(totals.failures.byEvent).toEqual({ "device.recovery-failed": 1 });
  });
});

describe("usage reader: scopes", () => {
  it("leaves a device fact stamped before from out of the incidents and the samples", async () => {
    const { rig, usage } = await setup({ at: T0 - 10 * MIN });
    rig.at(T0 - 5 * MIN);
    rig.emit("device.ready", { bootDuration: 20_000, deviceId: "d1", platform: "ios" });
    rig.emit("device.quarantine-abandoned", { attempts: 3, deviceId: "d6", platform: "ios" });
    rig.at(T0 + MIN);
    rig.emit("device.ready", { bootDuration: 10_000, deviceId: "d2", platform: "ios" });

    const { totals } = await usage(T0, T0 + HOUR);

    expect(totals.boot).toEqual({ count: 1, max: 10_000, p50: 10_000, p95: 10_000 });
    expect(totals.incidents.lost).toBe(0);
  });

  it("splits figures by platform and by worker: on a worker an iOS and an Android request land in their platform entries; on a gateway the platform entries read the * rows of that platform and two workers' devices land in their worker entries", async () => {
    const worker = await setup({ deps: { workers: () => [{ id: "w-self" }] } });
    worker.rig.emit("lease.requested", requested("I1"));
    worker.rig.emit(
      "lease.requested",
      requested("A1", { requestSpec: { model: "Pixel 9", platform: "android" } }),
    );
    worker.rig.emit(
      "lease.requested",
      requested("A2", { requestSpec: { model: "Pixel 9", platform: "android" } }),
    );
    const gateway = await setup({
      deps: { workers: () => [{ id: "w1" }, { id: "w2" }] },
      fleet: true,
    });
    gateway.rig.relay("w1", "capacity.changed", capacity({ global: [1, 0, 8], ios: [1, 0, 4] }));
    gateway.rig.relay("w2", "capacity.changed", capacity({ global: [2, 0, 8], ios: [2, 0, 4] }));

    const single = await worker.usage(T0, T0 + HOUR);
    const fleet = await gateway.usage(T0, T0 + HOUR);

    expect(single.platforms.ios.requests).toBe(1);
    expect(single.platforms.android.requests).toBe(2);
    expect(single.totals.requests).toBe(3);
    expect(single.workers.map((entry) => [entry.id, entry.requests])).toEqual([["w-self", 3]]);
    expect(fleet.platforms.ios.utilisation.slots).toMatchObject({ max: 8, peak: 3 });
    expect(fleet.platforms.android.utilisation.slots.peak).toBe(0);
    const byWorker = Object.fromEntries(
      fleet.workers.map((entry) => [entry.id, entry.utilisation.slots.peak]),
    );
    expect(byWorker).toEqual({ w1: 1, w2: 2 });
  });

  it("on a gateway takes the totals' slots peak from the * rows: two workers peaking at 2 each, a minute apart, give 2, not 4, in the totals and in the series alike", async () => {
    const { rig, usage } = await setup({
      deps: { workers: () => [{ id: "w1" }, { id: "w2" }] },
      fleet: true,
    });
    rig.relay("w1", "capacity.changed", capacity({ global: [2, 0, 8] }), T0);
    rig.relay("w1", "capacity.changed", capacity({ global: [0, 0, 8] }), T0 + MIN);
    rig.relay("w2", "capacity.changed", capacity({ global: [2, 0, 8] }), T0 + MIN);
    rig.relay("w2", "capacity.changed", capacity({ global: [0, 0, 8] }), T0 + 2 * MIN);

    const answer = await usage(T0, T0 + HOUR);

    expect(answer.totals.utilisation.slots.peak).toBe(2);
    expect(answer.series.slice(0, 3).map((point) => point.slotsUsed)).toEqual([2, 2, 0]);
    expect(Object.fromEntries(answer.workers.map((w) => [w.id, w.utilisation.slots.peak]))).toEqual(
      { w1: 2, w2: 2 },
    );
  });

  it("the gateway lists every registry worker with its label and a worker id the rows name that the registry lacks, and counts a fleet request with no worker in totals and its platform only", async () => {
    const { rig, usage } = await setup({
      deps: { workers: () => [{ id: "w1", label: "mac-mini-1" }, { id: "w2" }] },
      fleet: true,
    });
    rig.emit("lease.requested", requested("G1"));
    rig.emit("lease.requested", requested("G2"));
    rig.emit("lease.requested", requested("G3"));
    rig.relay("w1", "lease.granted", granted("WL1", "G1"), T0 + 1_000);
    rig.at(T0 + 2_000);
    rig.emit("request.granted", {
      leaseId: "G-G1",
      requestId: "G1",
      worker: "w1",
      workerLeaseId: "WL1",
    });
    rig.relay("w9", "lease.granted", granted("WL9", "G3"), T0 + 3_000);
    rig.at(T0 + 4_000);
    rig.emit("request.granted", {
      leaseId: "G-G3",
      requestId: "G3",
      worker: "w9",
      workerLeaseId: "WL9",
    });

    const answer = await usage(T0, T0 + HOUR);

    expect(answer.workers.map((entry) => [entry.id, entry.label, entry.requests])).toEqual([
      ["w1", "mac-mini-1", 1],
      ["w2", undefined, 0],
      ["w9", undefined, 1],
    ]);
    expect(answer.totals.requests).toBe(3);
    expect(answer.platforms.ios.requests).toBe(3);
    expect(answer.workers.reduce((sum, entry) => sum + entry.requests, 0)).toBe(2);
  });

  it("the worker answers one worker entry, itself, with its instance id, its label or none, and the slots it used as the totals have them", async () => {
    const labelled = await setup({
      deps: { workers: () => [{ id: "instance-1", label: "lab-a" }] },
    });
    const plain = await setup({ deps: { workers: () => [{ id: "instance-1" }] } });
    labelled.rig.emit("lease.requested", requested("R1"));
    labelled.rig.emit("capacity.changed", capacity({ global: [2, 0, 8] }));
    plain.rig.emit("lease.requested", requested("R1"));

    const named = await labelled.usage(T0, T0 + HOUR);
    const anonymous = await plain.usage(T0, T0 + HOUR);

    expect(named.workers.map((entry) => [entry.id, entry.label, entry.requests])).toEqual([
      ["instance-1", "lab-a", 1],
    ]);
    expect(named.totals.utilisation.slots.peak).toBe(2);
    expect(named.workers[0]?.utilisation).toEqual(named.totals.utilisation);
    expect(anonymous.workers).toHaveLength(1);
    expect(anonymous.workers[0]).toMatchObject({ id: "instance-1", requests: 1 });
    expect(anonymous.workers[0]).not.toHaveProperty("label");
  });
});

describe("usage reader: concurrent reads", () => {
  it("a ledger read and a plain read of one window, started together, each answer as asked: the ledger has requests, the plain one has none", async () => {
    const { reader, rig } = await setup();
    rig.emit("lease.requested", requested("R1"));
    const window = { from: T0, to: T0 + HOUR };

    const [withLedger, plain] = await Promise.all([
      reader.get({ ...window, includeLedger: true }),
      reader.get(window),
    ]);

    if (withLedger.kind !== "figures" || plain.kind !== "figures") throw new Error("no figures");
    expect(withLedger.usage.requests).toHaveLength(1);
    expect(plain.usage).not.toHaveProperty("requests");
  });
});

describe("usage reader: the window", () => {
  const OFF = 12_345;

  it("picks 1 min for 1 h, 5 min for 6 h, 15 min for 24 h, 1 h for 7 d, 6 h for 30 d and 1 day for 90 d, floors from to it, and leaves to as asked", async () => {
    const { usage } = await setup();
    const to = T0 + 100 * DAY;

    for (const [span, width] of [
      [HOUR, MIN],
      [6 * HOUR, 5 * MIN],
      [24 * HOUR, 15 * MIN],
      [7 * DAY, HOUR],
      [30 * DAY, 6 * HOUR],
      [90 * DAY, DAY],
    ] as const) {
      const from = to - span + OFF;

      const answer = await usage(from, to);

      expect(answer.bucketMs, `${span}`).toBe(width);
      expect(answer.window, `${span}`).toEqual({ from: Math.floor(from / width) * width, to });
    }
  });

  it("picks 5 min for a 200-minute window starting at :30 s, which 1 min would cut into 201 points, and accepts exactly 90 days whose from is off a bucket boundary though the floored window is longer", async () => {
    const { usage } = await setup();
    const from = T0 + 30_000;

    const short = await usage(from, from + 200 * MIN);
    const long = await usage(T0 + OFF, T0 + OFF + 90 * DAY);

    expect(short.bucketMs).toBe(5 * MIN);
    expect(short.series).toHaveLength(41);
    expect(long.bucketMs).toBe(DAY);
    expect(long.window.to - long.window.from).toBeGreaterThan(90 * DAY);
    expect(long.series).toHaveLength(Math.ceil((long.window.to - long.window.from) / DAY));
  });
});

describe("usage reader: minute figures", () => {
  const A = Math.floor(T0 / (15 * MIN)) * (15 * MIN);

  it("ends each series point at its bucket's end and the last at to, gives it the peak of each field over the bucket (minutes peaking at 2 and 4 -> 4), carries a value into a bucket with no row, gives null in every field to a bucket after a gap marker with no row since, and ramUsedBytes only where a row has it", async () => {
    const { rig, usage } = await setup({ at: A });
    rig.emit("capacity.changed", capacity({ global: [2, 0, 8], ram: [100, 1_000] }));
    rig.at(A + MIN);
    rig.emit("capacity.changed", capacity({ global: [4, 0, 8], ram: [100, 1_000] }));
    rig.at(A + 2 * MIN);
    rig.emit("capacity.changed", capacity({ global: [3, 0, 8], ram: [100, 1_000] }));
    rig.at(A + 40 * MIN);
    rig.emit("daemon.stopping", { reason: "test" });
    const to = A + 24 * HOUR - 7 * MIN;

    const answer = await usage(A, to);

    expect(answer.bucketMs).toBe(15 * MIN);
    expect(answer.series).toHaveLength(96);
    expect(answer.series.map((point) => point.at).slice(0, 3)).toEqual([
      A + 15 * MIN,
      A + 30 * MIN,
      A + 45 * MIN,
    ]);
    expect(answer.series.at(-1)?.at).toBe(to);
    expect(answer.series[0]).toEqual({
      at: A + 15 * MIN,
      leasesHeld: null,
      queueDepth: null,
      ramUsedBytes: 100,
      slotsMax: 8,
      slotsUsed: 4,
      waiting: null,
    });
    expect(answer.series[1]).toMatchObject({ ramUsedBytes: 100, slotsMax: 8, slotsUsed: 3 });
    expect(answer.series[2]).toMatchObject({ slotsUsed: 3 });
    expect(answer.series[3]).toEqual({
      at: A + 60 * MIN,
      leasesHeld: null,
      queueDepth: null,
      slotsMax: null,
      slotsUsed: null,
      waiting: null,
    });
    expect(answer.series[95]).not.toHaveProperty("ramUsedBytes");
  });

  it("leaves the minute still running at to out of the slots figures", async () => {
    const { rig, usage } = await setup();
    rig.emit("capacity.changed", capacity({ global: [1, 0, 8] }));
    rig.at(T0 + MIN + 10_000);
    rig.emit("capacity.changed", capacity({ global: [3, 0, 8] }));

    const { totals } = await usage(T0, T0 + MIN + 30_000);

    expect(totals.utilisation.slots.peak).toBe(1);
  });

  it("reports a time-weighted slots, RAM and queue mean from the integrals (1 slot for 45 s, 3 for 15 s -> 1.5), ram.limitBytes from ramLimitBytes, and leaves utilisation.ram out when no row in the window has ramUsedBytes", async () => {
    const { rig, usage } = await setup({ at: A });
    rig.emit("capacity.changed", capacity({ global: [1, 0, 8] }));
    rig.emit("queue.changed", { depth: 2 });
    rig.at(A + 30_000);
    rig.emit("queue.changed", { depth: 0 });
    rig.at(A + 45_000);
    rig.emit("capacity.changed", capacity({ global: [3, 0, 8] }));
    rig.at(A + 10 * MIN);
    rig.emit("capacity.changed", capacity({ global: [3, 0, 8], ram: [20, 100] }));
    rig.at(A + 10 * MIN + 30_000);
    rig.emit("capacity.changed", capacity({ global: [3, 0, 8], ram: [60, 100] }));

    const slots = await usage(A, A + MIN);
    const ram = await usage(A + 10 * MIN, A + 11 * MIN);

    expect(slots.totals.utilisation.slots).toEqual({ max: 8, mean: 1.5, peak: 3 });
    expect(slots.totals.queue).toEqual({ meanDepth: 1, peakDepth: 2 });
    expect(slots.totals.utilisation).not.toHaveProperty("ram");
    expect(ram.totals.utilisation.ram).toEqual({ limitBytes: 100, meanBytes: 40, peakBytes: 60 });
  });
});

describe("usage reader: coverage", () => {
  it("sets coversFrom to the oldest row and partial true when that row is inside the window, partial false when it is before from, and covers any window with no rows", async () => {
    const { rig, usage } = await setup();
    rig.emit("lease.requested", requested("R1"));
    const empty = await setup({ at: T0 + 3 * DAY });

    const inside = await usage(T0 - HOUR, T0 + HOUR);
    const before = await usage(T0 + 10 * MIN, T0 + HOUR);
    const none = await empty.usage(T0, T0 + HOUR);

    expect(inside).toMatchObject({ coversFrom: T0, partial: true });
    expect(before).toMatchObject({ coversFrom: T0 + 10 * MIN, partial: false });
    expect(none).toMatchObject({ coversFrom: T0, partial: false });
  });

  it("answers not-kept with the oldest time when to is 1 ms before the oldest row, and figures when to is that row's time", async () => {
    const { reader, rig } = await setup();
    rig.emit("lease.requested", requested("R1"));

    const early = await reader.get({ from: T0 - 2 * HOUR, to: T0 - 1 });
    const exact = await reader.get({ from: T0 - 2 * HOUR, to: T0 });

    expect(early).toEqual({ kind: "not-kept", oldestTs: T0 });
    expect(exact.kind).toBe("figures");
  });
});

describe("usage reader: the ledger", () => {
  async function ledgerSetup(options: Parameters<typeof setup>[0] = {}) {
    const made = await setup(options);
    const ledger = async (from: number, to: number) => {
      const result = await made.reader.get({ from, includeLedger: true, to });
      if (result.kind !== "figures") throw new Error(`expected figures, got ${result.kind}`);
      return result.usage;
    };
    return { ...made, ledger };
  }

  it("usage.get with includeLedger lists one entry per request in the window, by requestedAt then requestId, with the timestamps and waitMs, heldMs and turnaroundMs of a granted and released request", async () => {
    const { ledger, rig } = await ledgerSetup();
    rig.emit("lease.requested", requested("B"));
    rig.emit("lease.requested", requested("A"));
    rig.at(T0 + 400);
    rig.emit("lease.granted", granted("LB", "B"));
    rig.at(T0 + 1_900);
    rig.emit("lease.released", released("LB"));
    rig.at(T0 + 5_000);
    rig.emit("lease.requested", requested("0-LAST"));

    const { requests } = await ledger(T0, T0 + HOUR);

    expect(requests?.map((entry) => entry.requestId)).toEqual(["A", "B", "0-LAST"]);
    expect(requests?.find((entry) => entry.requestId === "B")).toMatchObject({
      endReason: "explicit",
      endedAt: T0 + 1_900,
      grantedAt: T0 + 400,
      heldMs: 1_500,
      outcome: "granted",
      platform: "ios",
      probe: false,
      requestedAt: T0,
      requester: "alice",
      source: "warm",
      turnaroundMs: 1_900,
      waitMs: 400,
    });
  });

  it("usage.get's ledger marks a request still waiting at to as open, one granted after to as open with no grantedAt, source or workerId, a lease open at to as granted with no endedAt, endReason, heldMs or turnaroundMs, a rejection as rejected with its rejectedAt and reason, one after to as open with no rejectedAt or reason, and a declined probe on a worker as declined", async () => {
    const { ledger, rig } = await ledgerSetup();
    const entryOf = async () => {
      const { requests } = await ledger(T0, T0 + HOUR);
      return (id: string) => requests?.find((entry) => entry.requestId === id);
    };
    rig.emit("lease.requested", requested("WAITING"));
    rig.at(T0 + 5 * MIN);
    rig.emit("lease.requested", requested("REJ"));
    rig.emit("lease.rejected", rejected("REJ", "no-wait"));
    rig.emit(
      "lease.requested",
      requested("PROBE", { fleetRequestId: "F1", requester: "gw:gw-1:tok_a" }),
    );
    rig.emit("lease.declined", {
      fleetRequestId: "F1",
      reason: "no-wait",
      requestId: "PROBE",
      requestSpec: { platform: "ios" },
      requester: "gw:gw-1:tok_a",
    });
    rig.at(T0 + 10 * MIN);
    rig.emit("lease.requested", requested("HELD"));
    rig.emit("lease.granted", granted("L-HELD", "HELD"));
    rig.at(T0 + 59 * MIN);
    rig.emit("lease.requested", requested("LATE"));
    rig.emit("lease.requested", requested("REJ-LATE"));
    rig.at(T0 + 61 * MIN);
    rig.emit("lease.granted", granted("L-LATE", "LATE"));
    rig.emit("lease.rejected", rejected("REJ-LATE", "no-wait"));
    rig.at(T0 + 70 * MIN);
    rig.emit("lease.released", released("L-HELD"));

    const entry = await entryOf();

    expect(entry("WAITING")).toMatchObject({ outcome: "open" });
    expect(entry("LATE")).toMatchObject({ outcome: "open" });
    for (const absent of ["grantedAt", "source", "workerId"]) {
      expect(entry("LATE"), absent).not.toHaveProperty(absent);
    }
    expect(entry("HELD")).toMatchObject({ grantedAt: T0 + 10 * MIN, outcome: "granted" });
    for (const absent of ["endedAt", "endReason", "heldMs", "turnaroundMs"]) {
      expect(entry("HELD"), absent).not.toHaveProperty(absent);
    }
    expect(entry("REJ")).toMatchObject({
      outcome: "rejected",
      reason: "no-wait",
      rejectedAt: T0 + 5 * MIN,
    });
    expect(entry("REJ-LATE")).toMatchObject({ outcome: "open" });
    for (const absent of ["rejectedAt", "reason"]) {
      expect(entry("REJ-LATE"), absent).not.toHaveProperty(absent);
    }
    expect(entry("PROBE")).toMatchObject({ outcome: "declined", probe: true, reason: "no-wait" });
  });

  it("the gateway's ledger shows the workerId of a worker-failed rejection once it is made, and none while the rejection is after to", async () => {
    const { ledger, rig } = await ledgerSetup({ fleet: true });
    rig.emit("lease.requested", requested("F-IN"));
    rig.emit("lease.requested", requested("F-LATE"));
    rig.at(T0 + 5 * MIN);
    rig.emit("lease.rejected", rejected("F-IN", "worker-failed", { worker: "w1" }));
    rig.at(T0 + 61 * MIN);
    rig.emit("lease.rejected", rejected("F-LATE", "worker-failed", { worker: "w2" }));

    const { requests } = await ledger(T0, T0 + HOUR);
    const entry = (id: string) => requests?.find((found) => found.requestId === id);

    expect(entry("F-IN")).toMatchObject({ outcome: "rejected", workerId: "w1" });
    expect(entry("F-LATE")).toMatchObject({ outcome: "open" });
    expect(entry("F-LATE")).not.toHaveProperty("workerId");
  });

  it("usage.get's ledger agrees with its figures: entries granted equal totals.granted, and a request's waitMs is a sample in totals.wait", async () => {
    const { ledger, rig } = await ledgerSetup();
    rig.emit("lease.requested", requested("R1"));
    rig.emit("lease.requested", requested("R2"));
    rig.emit("lease.requested", requested("R3"));
    rig.at(T0 + 100);
    rig.emit("lease.granted", granted("L1", "R1"));
    rig.at(T0 + 300);
    rig.emit("lease.granted", granted("L2", "R2"));

    const answer = await ledger(T0, T0 + HOUR);

    const grantedEntries = answer.requests?.filter((entry) => entry.outcome === "granted") ?? [];
    expect(grantedEntries).toHaveLength(answer.totals.granted);
    expect(grantedEntries.map((entry) => entry.waitMs).sort()).toEqual([100, 300]);
    expect(answer.totals.wait).toEqual({ count: 2, max: 300, p50: 100, p95: 300 });
  });

  it("usage.get's ledger carries the token label of a known requester and none for an unknown one, and lists a probe (probe: true) and a refused-at-admission rejection as entries", async () => {
    const { ledger, rig } = await ledgerSetup({
      deps: { tokenLabels: async () => new Map([["tok_b", "ci-bot"]]) },
    });
    rig.emit("lease.requested", requested("KNOWN", { requester: "tok_b" }));
    rig.emit("lease.requested", requested("UNKNOWN", { requester: "tok_z" }));
    rig.emit(
      "lease.requested",
      requested("PROBE", { fleetRequestId: "F1", requester: "gw:gw-1:tok_a" }),
    );
    rig.at(T0 + 300);
    rig.emit("lease.granted", granted("LP", "PROBE", { requester: "gw:gw-1:tok_a" }));
    rig.emit("lease.rejected", rejected("ADMIT", "already-leased", { requester: "tok_b" }));

    const { requests } = await ledger(T0, T0 + HOUR);
    const entry = (id: string) => requests?.find((candidate) => candidate.requestId === id);

    expect(entry("KNOWN")).toMatchObject({ label: "ci-bot" });
    expect(entry("UNKNOWN")).not.toHaveProperty("label");
    expect(entry("PROBE")).toMatchObject({ outcome: "granted", probe: true });
    expect(entry("PROBE")).not.toHaveProperty("waitMs");
    expect(entry("ADMIT")).toMatchObject({
      outcome: "rejected",
      probe: false,
      reason: "already-leased",
      requester: "tok_b",
    });
    expect(entry("ADMIT")).not.toHaveProperty("waitMs");
  });

  async function seededReader(rows: number) {
    const rig = await usageRig();
    rigs.push(rig);
    await rig.close();
    const database = await new NodeSqliteOpener().open(rig.historyPath, { readOnly: false });
    try {
      database.exec("BEGIN");
      const insert = database.prepare(
        `INSERT INTO request_rows (requestId, requester, platform, requestedAt, grantedAt, source,
           leaseId, heldMs, endedAt, endReason, probe)
         VALUES (?, 'tok_a', 'ios', ?, ?, 'warm', ?, 5000, ?, 'explicit', 0)`,
      );
      for (let index = 1; index <= rows; index += 1) {
        const at = T0 + index * 1_000;
        insert.run(`R${String(index).padStart(6, "0")}`, at, at + 400, `L${index}`, at + 5_400);
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const reader = createUsageReader(rig.deps({ opened: () => true }));
    readers.push(reader);
    return async () => {
      const result = await reader.get({ from: T0, includeLedger: true, to: T0 + 2 * DAY });
      if (result.kind !== "figures") throw new Error(`expected figures, got ${result.kind}`);
      return result.usage;
    };
  }

  it("usage.get's ledger over 100,001 requests holds the newest 100,000 with ledgerTruncated: true, and over exactly 100,000 holds them all with no ledgerTruncated", async () => {
    const over = await (await seededReader(100_001))();
    const exact = await (await seededReader(100_000))();

    expect(over.requests).toHaveLength(100_000);
    expect(over.requests?.[0]?.requestId).toBe("R000002");
    expect(over.requests?.at(-1)?.requestId).toBe("R100001");
    expect(over.ledgerTruncated).toBe(true);
    expect(exact.requests).toHaveLength(100_000);
    expect(exact.requests?.[0]?.requestId).toBe("R000001");
    expect(exact).not.toHaveProperty("ledgerTruncated");
  }, 60_000);
});
