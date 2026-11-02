import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus, type EventMap, type EventName } from "../../../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  NodeFilesystem,
  NodeSqliteOpener,
} from "../../../ports/index.js";
import {
  createEventHistory,
  HISTORY_DB_NAME,
  type HistoryProjectionDefinition,
  type EventHistoryHandle,
} from "../../index.js";
import {
  type MinuteBucket,
  openUsageReads,
  type RequestRow,
  USAGE_PROJECTION,
  type UsageReads,
  type UsageValue,
} from "./index.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_760_605_920_000;
const ALL = Number.MAX_SAFE_INTEGER;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

interface RigOptions {
  readonly directory?: string;
  readonly at?: number;
  readonly fleet?: boolean;
  readonly eventRetention?: number;
  readonly metricsRetention?: number;
  readonly projections?: readonly HistoryProjectionDefinition[];
  readonly start?: boolean;
}

interface Rig {
  readonly directory: string;
  readonly path: string;
  readonly clock: FakeClock;
  readonly bus: EventBus;
  readonly logs: MemoryLogSink;
  readonly history: EventHistoryHandle;
  at(timestamp: number): void;
  emit<Event extends EventName>(event: Event, payload: EventMap[Event]): void;
  relay(workerId: string, event: string, payload: Record<string, unknown>, at?: number): void;
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  let directory = options.directory;
  if (directory === undefined) {
    directory = await mkdtemp(join(tmpdir(), "simlock-usage-"));
    directories.push(directory);
  }
  const clock = new FakeClock(options.at ?? T0);
  let nextId = 0;
  const bus = new EventBus(clock, 10_000, undefined, {
    generate: () => `${options.at ?? T0}_${(nextId += 1)}`,
  });
  const logs = new MemoryLogSink();
  const history = createEventHistory({
    bus,
    clock,
    config: { maxBytes: 256 * 1024 * 1024, retention: options.eventRetention ?? 7 * DAY },
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    logger: new JsonLinesLogger({ clock, sink: logs }),
    projectionOptions: {
      fleet: options.fleet ?? false,
      metricsRetentionMs: options.metricsRetention ?? 90 * DAY,
    },
    projections: options.projections ?? [USAGE_PROJECTION],
    sqlite: new NodeSqliteOpener(),
  });
  if (options.start !== false) await history.start();
  let relayed = 0;
  return {
    at: (timestamp) => clock.advance(timestamp - clock.now()),
    bus,
    clock,
    directory,
    emit: (event, payload) => {
      bus.emit(event, payload, "test");
    },
    history,
    logs,
    path: join(directory, HISTORY_DB_NAME),
    relay: (workerId, event, payload, at) => {
      relayed += 1;
      bus.republish({
        event: event as EventName,
        id: `evt_relay_${options.at ?? T0}_${relayed}`,
        module: "gateway",
        payload: { ...payload, workerId } as never,
        timestamp: at ?? clock.now(),
      });
    },
  };
}

async function readWith<T>(rigged: { readonly path: string }, read: (reads: UsageReads) => T) {
  const database = await new NodeSqliteOpener().open(rigged.path, { readOnly: true });
  try {
    return read(openUsageReads(database));
  } finally {
    database.close();
  }
}

async function count(rigged: { readonly path: string }, sql: string): Promise<number> {
  const database = await new NodeSqliteOpener().open(rigged.path, { readOnly: true });
  try {
    return Number(database.prepare(sql).get()?.n);
  } finally {
    database.close();
  }
}

async function execOn(path: string, ...statements: string[]): Promise<void> {
  const database = await new NodeSqliteOpener().open(path, { readOnly: false });
  try {
    for (const statement of statements) database.exec(statement);
  } finally {
    database.close();
  }
}

const rowsOf = (rigged: Rig) =>
  readWith(rigged, (reads) => reads.requestRows({ from: 0, to: ALL }));
const factsOf = (rigged: Rig) =>
  readWith(rigged, (reads) => reads.deviceFacts({ from: 0, to: ALL }));
const buckets = (
  rigged: Rig,
  query: {
    readonly from: number;
    readonly to: number;
    readonly platform: string;
    readonly workerId?: string;
    readonly bucketMs?: number;
  },
) => readWith(rigged, (reads) => reads.minuteBuckets({ bucketMs: MIN, workerId: "", ...query }));

function row(rows: readonly RequestRow[], requestId: string): RequestRow {
  const found = rows.find((candidate) => candidate.requestId === requestId);
  if (found === undefined) throw new Error(`no request row for ${requestId}`);
  return found;
}

const requested = (requestId: string, over: Partial<EventMap["lease.requested"]> = {}) => ({
  requestId,
  requestSpec: { model: "iPhone 16", platform: "ios" },
  requester: "alice",
  waitPolicy: "wait",
  ...over,
});
const granted = (
  leaseId: string,
  requestId: string,
  over: Partial<EventMap["lease.granted"]> = {},
): EventMap["lease.granted"] => ({
  deviceId: `dev-${leaseId}`,
  leaseId,
  platform: "ios",
  requestId,
  requester: "alice",
  source: "warm",
  ...over,
});
const released = (leaseId: string, reason: "explicit" | "killed" | "device-lost" = "explicit") => ({
  deviceId: `dev-${leaseId}`,
  leaseId,
  ownerId: "alice",
  reason,
});
const rejected = (
  requestId: string,
  reason: EventMap["lease.rejected"]["reason"],
  over: Partial<EventMap["lease.rejected"]> = {},
): EventMap["lease.rejected"] => ({
  reason,
  requestId,
  requestSpec: { platform: "ios" },
  requester: "alice",
  ...over,
});
const figures = (running: number, reserved: number, maxRunning: number) => ({
  maxRunning,
  reserved,
  running,
  warm: 0,
});
const capacity = (input: {
  readonly ios?: readonly [number, number, number];
  readonly android?: readonly [number, number, number];
  readonly global?: readonly [number, number, number];
  readonly ram?: readonly [number, number];
}): EventMap["capacity.changed"] => ({
  android: figures(...(input.android ?? [0, 0, 4])),
  global: figures(...(input.global ?? [0, 0, 8])),
  ios: figures(...(input.ios ?? [0, 0, 4])),
  ...(input.ram === undefined
    ? {}
    : { ramBudget: { limitBytes: input.ram[1], usedBytes: input.ram[0] } }),
});

function figure(bucket: MinuteBucket | undefined, name: UsageValue) {
  return bucket?.[name];
}

describe("usage projection: request rows", () => {
  it("a request granted, held and released gives one row with requestedAt, grantedAt, source, leaseId, endedAt, heldMs and endReason explicit; an expired lease gives endReason expired", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("R1"));
    r.at(T0 + 38_000);
    r.emit("lease.granted", granted("L1", "R1", { source: "booted" }));
    r.at(T0 + 138_000);
    r.emit("lease.released", released("L1"));
    r.emit("lease.requested", requested("R2"));
    r.emit("lease.granted", granted("L2", "R2"));
    r.at(T0 + 200_000);
    r.emit("lease.expired", { deviceId: "dev-L2", leaseId: "L2", ownerId: "alice" });

    const rows = await rowsOf(r);

    expect(rows).toHaveLength(2);
    expect(row(rows, "R1")).toMatchObject({
      endReason: "explicit",
      endedAt: T0 + 138_000,
      grantedAt: T0 + 38_000,
      heldMs: 100_000,
      leaseId: "L1",
      platform: "ios",
      probe: false,
      requestedAt: T0,
      requester: "alice",
      source: "booted",
    });
    expect(row(rows, "R2")).toMatchObject({
      endReason: "expired",
      endedAt: T0 + 200_000,
      heldMs: 62_000,
    });
    await r.history.stop();
  });

  it("a rejected request's row has rejectedAt and reason; an admission refusal gets its own row with refusedAtAdmission and requestedAt equal to rejectedAt; a class request has no model", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("R1"));
    r.emit(
      "lease.requested",
      requested("R2", { requestSpec: { class: "tablet", platform: "android" } }),
    );
    r.at(T0 + 5_000);
    r.emit("lease.rejected", rejected("R1", "no-wait"));
    r.at(T0 + 9_000);
    r.emit(
      "lease.rejected",
      rejected("R3", "already-leased", { requestSpec: { platform: "android" } }),
    );

    const rows = await rowsOf(r);

    expect(rows).toHaveLength(3);
    expect(row(rows, "R1")).toMatchObject({
      reason: "no-wait",
      rejectedAt: T0 + 5_000,
      model: "iPhone 16",
    });
    expect(row(rows, "R1").refusedAtAdmission).toBeUndefined();
    expect(row(rows, "R3")).toMatchObject({
      platform: "android",
      reason: "already-leased",
      refusedAtAdmission: true,
      rejectedAt: T0 + 9_000,
      requestedAt: T0 + 9_000,
    });
    expect(row(rows, "R2").platform).toBe("android");
    expect(row(rows, "R2").model).toBeUndefined();
    await r.history.stop();
  });

  it("a field already set is not changed by a later event, and an event for an unknown request or lease changes no row", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("R1"));
    r.at(T0 + 1_000);
    r.emit("lease.granted", granted("L1", "R1", { source: "warm" }));
    r.at(T0 + 2_000);
    r.emit("lease.granted", granted("L1b", "R1", { source: "booted" }));
    r.at(T0 + 3_000);
    r.emit("lease.rejected", rejected("R1", "timeout"));
    r.at(T0 + 4_000);
    r.emit("lease.released", released("L1"));
    r.at(T0 + 5_000);
    r.emit("lease.released", released("L1", "killed"));
    r.relay("w1", "lease.requested", requested("R9"), T0 + 6_000);
    r.relay("w1", "lease.requested", requested("R9", { requester: "eve" }), T0 + 8_000);
    r.emit("lease.granted", granted("LX", "R-unknown"));
    r.emit("lease.released", released("L-unknown"));

    const rows = await rowsOf(r);

    expect(rows.map((candidate) => candidate.requestId).sort()).toEqual(["R1", "R9"]);
    expect(row(rows, "R1")).toMatchObject({
      endReason: "explicit",
      endedAt: T0 + 4_000,
      grantedAt: T0 + 1_000,
      leaseId: "L1",
      source: "warm",
    });
    expect(row(rows, "R1").rejectedAt).toBeUndefined();
    expect(row(rows, "R9").requester).toBe("alice");
    await r.history.stop();
  });

  it("a relayed payload with an over-long string, a negative number, an unknown source or no requestId writes the event row, and the row field is absent or no row changes; an unknown event name changes no projection row", async () => {
    const r = await rig({ fleet: false });
    r.relay("w1", "lease.requested", requested("R-ok"), T0);
    r.relay("w1", "lease.requested", requested("R-long", { requester: "x".repeat(500) }), T0 + 1);
    r.relay("w1", "lease.granted", granted("L-ok", "R-ok", { source: "mystery" as never }), T0 + 2);
    r.relay(
      "w1",
      "device.provisioned",
      { deviceId: "d1", driver: "fake", duration: -5, spec: { platform: "ios" } },
      T0 + 3,
    );
    r.relay(
      "w1",
      "device.provisioned",
      { deviceId: "d2", driver: "fake", duration: 1_200, spec: { platform: "ios" } },
      T0 + 4,
    );
    r.relay("w1", "lease.requested", { ...requested("x"), requestId: undefined }, T0 + 5);
    r.relay(
      "w1",
      "mystery.thing",
      { deviceId: "d9", requestId: "R-mystery", leaseId: "L9" },
      T0 + 6,
    );

    const rows = await rowsOf(r);
    const facts = await factsOf(r);
    const stored = await r.history.replay({ sinceTs: 0 });

    expect(rows.map((candidate) => candidate.requestId).sort()).toEqual(["R-long", "R-ok"]);
    expect(row(rows, "R-long").requester).toBe("x".repeat(200));
    expect(row(rows, "R-ok").leaseId).toBe("L-ok");
    expect(row(rows, "R-ok").source).toBeUndefined();
    expect(facts.map((fact) => [fact.deviceId, fact.durationMs])).toEqual([
      ["d1", undefined],
      ["d2", 1_200],
    ]);
    expect(stored).toHaveLength(7);
    await r.history.stop();
  });

  it("on a worker, a probe's row has probe set, is not counted in waiting, and its lease.declined sets rejectedAt, reason and declined", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("P1", { fleetRequestId: "F1" }));
    r.at(T0 + 10_000);
    r.emit("lease.requested", requested("Q1"));
    r.at(T0 + 20_000);
    r.emit("lease.declined", {
      fleetRequestId: "F1",
      reason: "no-wait",
      requestId: "P1",
      requestSpec: { platform: "ios" },
      requester: "alice",
    });

    const rows = await rowsOf(r);
    const waiting = await buckets(r, { from: T0, platform: "ios", to: T0 + MIN });

    expect(row(rows, "P1")).toMatchObject({
      declined: true,
      probe: true,
      reason: "no-wait",
      rejectedAt: T0 + 20_000,
    });
    expect(row(rows, "Q1").probe).toBe(false);
    expect(waiting).toHaveLength(1);
    expect(figure(waiting[0], "waiting")).toEqual({ integral: 50_000, peak: 1 });
    await r.history.stop();
  });
});

describe("usage projection: a gateway", () => {
  const dispatch = async (r: Rig, id: string, workerLeaseId: string, grantAt: number) => {
    r.at(grantAt);
    r.emit("request.granted", { leaseId: `G-${id}`, requestId: id, worker: "w1", workerLeaseId });
  };

  it("a row takes its grant, worker and workerLeaseId from the own request.granted, ignoring relayed lease.requested, lease.queued, lease.rejected, lease.declined and an earlier relayed lease.granted; a worker-failed rejection sets the worker and a timeout one none", async () => {
    const r = await rig({ fleet: true });
    r.emit("lease.requested", requested("G1"));
    r.emit("lease.requested", requested("G2"));
    r.emit("lease.requested", requested("G3"));
    r.relay("w1", "lease.requested", requested("W1", { fleetRequestId: "G1" }), T0 + 1_000);
    r.relay("w1", "lease.queued", { queuePosition: 1, requestId: "G1" }, T0 + 2_000);
    r.relay("w1", "lease.rejected", rejected("G1", "no-wait"), T0 + 3_000);
    r.relay(
      "w1",
      "lease.declined",
      {
        fleetRequestId: "G1",
        reason: "no-wait",
        requestId: "G1",
        requestSpec: { platform: "ios" },
        requester: "alice",
      },
      T0 + 4_000,
    );
    r.relay("w1", "lease.granted", granted("WL1", "G1"), T0 + 5_000);
    await dispatch(r, "G1", "WL1", T0 + 20_000);
    r.at(T0 + 30_000);
    r.emit(
      "lease.rejected",
      rejected("G2", "worker-failed", { code: "PROVISION_FAILED", worker: "w2" }),
    );
    r.emit("lease.granted", granted("OWN-L", "G3"));
    r.emit("lease.rejected", rejected("G3", "timeout", { worker: "w3" }));

    const rows = await rowsOf(r);

    expect(rows.map((candidate) => candidate.requestId).sort()).toEqual(["G1", "G2", "G3"]);
    expect(row(rows, "G1")).toMatchObject({
      grantedAt: T0 + 20_000,
      leaseId: "G-G1",
      workerId: "w1",
      workerLeaseId: "WL1",
    });
    expect(row(rows, "G1").rejectedAt).toBeUndefined();
    expect(row(rows, "G2")).toMatchObject({
      reason: "worker-failed",
      rejectedAt: T0 + 30_000,
      workerId: "w2",
    });
    expect(row(rows, "G3")).toMatchObject({ reason: "timeout" });
    expect(row(rows, "G3").grantedAt).toBeUndefined();
    expect(row(rows, "G3").workerId).toBeUndefined();
    await r.history.stop();
  });

  it("source and heldMs come from the held relayed lease matching workerId and workerLeaseId, by the worker's clock, whether the relayed grant arrives before or after request.granted; with no relayed grant source is absent; a relayed end deletes the held lease", async () => {
    const r = await rig({ fleet: true });
    for (const id of ["A", "B", "C"]) r.emit("lease.requested", requested(id));
    r.relay("w1", "lease.granted", granted("WL-A", "A", { source: "booted" }), T0 + 15_000);
    await dispatch(r, "A", "WL-A", T0 + 20_000);
    await dispatch(r, "B", "WL-B", T0 + 30_000);
    r.relay("w1", "lease.granted", granted("WL-B", "B", { source: "provisioned" }), T0 + 41_000);
    await dispatch(r, "C", "WL-C", T0 + 50_000);
    r.relay("w1", "lease.released", released("WL-A"), T0 + 75_000);
    r.relay(
      "w1",
      "lease.expired",
      { deviceId: "dev-WL-B", leaseId: "WL-B", ownerId: "alice" },
      T0 + 101_000,
    );
    r.emit("lease.requested", requested("D"));
    await dispatch(r, "D", "WL-A", T0 + 110_000);

    const rows = await rowsOf(r);

    expect(row(rows, "A")).toMatchObject({
      endReason: "explicit",
      endedAt: T0 + 75_000,
      grantedAt: T0 + 20_000,
      heldMs: 60_000,
      source: "booted",
    });
    expect(row(rows, "B")).toMatchObject({
      endReason: "expired",
      heldMs: 60_000,
      source: "provisioned",
    });
    expect(row(rows, "C").source).toBeUndefined();
    expect(row(rows, "D").source).toBeUndefined();
    await r.history.stop();
  });

  it("a relayed lease with an over-long id, an unknown source or no leaseId joins by the cut id and leaves source absent", async () => {
    const r = await rig({ fleet: true });
    const long = "L".repeat(500);
    r.emit("lease.requested", requested("A"));
    r.relay("w1", "lease.granted", granted(long, "A", { source: "mystery" as never }), T0 + 15_000);
    r.relay("w1", "lease.granted", { ...granted("X", "A"), leaseId: undefined }, T0 + 16_000);
    await dispatch(r, "A", long, T0 + 20_000);
    r.relay("w1", "lease.released", released(long), T0 + 75_000);

    const rows = await rowsOf(r);

    expect(row(rows, "A")).toMatchObject({
      endReason: "explicit",
      heldMs: 60_000,
      workerLeaseId: "L".repeat(200),
    });
    expect(row(rows, "A").source).toBeUndefined();
    await r.history.stop();
  });

  it("an open request is rejected daemon-restarted at the own next daemon.started; a relayed daemon.started closes nothing", async () => {
    const first = await rig({ fleet: true });
    first.emit("lease.requested", requested("G1"));
    first.emit("lease.requested", requested("G2"));
    first.at(T0 + 10_000);
    first.emit("lease.rejected", rejected("G2", "no-wait"));
    await first.history.stop();

    const second = await rig({ at: T0 + 5 * MIN, directory: first.directory, fleet: true });
    second.relay("w1", "daemon.started", { configSnapshot: {}, version: "1" });
    const open = await rowsOf(second);
    second.emit("daemon.started", { configSnapshot: {}, version: "1" });
    const closed = await rowsOf(second);

    expect(row(open, "G1").rejectedAt).toBeUndefined();
    expect(row(closed, "G1")).toMatchObject({
      reason: "daemon-restarted",
      rejectedAt: T0 + 5 * MIN,
    });
    expect(row(closed, "G2")).toMatchObject({ reason: "no-wait", rejectedAt: T0 + 10_000 });
    await second.history.stop();
  });
});

describe("usage projection: minute rows", () => {
  it("a relayed platform that is not ios or android mints no platform key: a capacity key, a request spec and a device platform of another value change no minute row and leave the platform absent", async () => {
    const r = await rig({ fleet: false });
    const others = ["tv", "all", "IOS"];
    others.forEach((platform, index) => {
      r.relay(
        "w1",
        "capacity.changed",
        { [platform]: { running: 1, reserved: 1, maxRunning: 4 } } as never,
        T0 + index * 10,
      );
      r.relay(
        "w1",
        "lease.requested",
        requested(`R-${platform}`, { requestSpec: { platform } }),
        T0 + index * 10 + 1,
      );
      r.relay(
        "w1",
        "device.ready",
        { deviceId: `d-${platform}`, bootDuration: 900, platform } as never,
        T0 + index * 10 + 2,
      );
    });

    const rows = await rowsOf(r);
    const facts = await factsOf(r);

    for (const platform of ["tv", "IOS", "ios", "android"]) {
      expect(await buckets(r, { from: T0, platform, to: T0 + MIN })).toEqual([]);
    }
    const all = await buckets(r, { from: T0, platform: "all", to: T0 + MIN });
    expect(all).toHaveLength(1);
    expect(figure(all[0], "waiting")?.peak).toBe(3);
    for (const name of ["slotsUsed", "slotsMax"] as const) {
      expect(figure(all[0], name)).toBeUndefined();
    }
    for (const platform of others) expect(row(rows, `R-${platform}`).platform).toBe("");
    expect(facts.map((fact) => [fact.deviceId, fact.durationMs, fact.platform])).toEqual(
      others.map((platform) => [`d-${platform}`, 900, undefined]),
    );
    await r.history.stop();
  });

  it("slotsUsed is running plus reserved and slotsMax per platform and on all; RAM used and limit and queue depth (both lines summed) only on all", async () => {
    const r = await rig();
    r.emit(
      "capacity.changed",
      capacity({ android: [0, 0, 3], global: [1, 1, 6], ios: [1, 1, 4], ram: [100, 1_000] }),
    );
    r.emit("queue.changed", { depth: 3 });
    r.emit("queue.changed", { depth: 2, physical: true });
    r.at(T0 + 3 * MIN);
    r.emit("queue.changed", { depth: 1, physical: true });
    r.at(T0 + 5 * MIN);
    r.emit(
      "capacity.changed",
      capacity({ android: [0, 0, 3], global: [1, 1, 6], ios: [1, 1, 4], ram: [100, 1_000] }),
    );

    const ios = await buckets(r, { from: T0, platform: "ios", to: T0 + MIN });
    const all = await buckets(r, { from: T0, platform: "all", to: T0 + MIN });

    expect(ios).toHaveLength(1);
    expect(figure(ios[0], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    expect(figure(ios[0], "slotsMax")).toEqual({ integral: 4 * MIN, peak: 4 });
    for (const name of ["ramUsedBytes", "ramLimitBytes", "queueDepth"] as const) {
      expect(figure(ios[0], name)).toBeUndefined();
    }
    expect(figure(all[0], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    expect(figure(all[0], "slotsMax")).toEqual({ integral: 6 * MIN, peak: 6 });
    expect(figure(all[0], "ramUsedBytes")).toEqual({ integral: 100 * MIN, peak: 100 });
    expect(figure(all[0], "ramLimitBytes")).toEqual({ integral: 1_000 * MIN, peak: 1_000 });
    expect(figure(all[0], "queueDepth")).toEqual({ integral: 5 * MIN, peak: 5 });
    await r.history.stop();
  });

  it("peak, last and integral of a value that steps twice in a minute are the highest, the final and the time-weighted sum; an all row's peak is the highest total at one moment, not the sum of platform peaks", async () => {
    const r = await rig();
    r.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
    r.at(T0 + 15_000);
    r.emit("capacity.changed", capacity({ ios: [3, 0, 4] }));
    r.at(T0 + 30_000);
    r.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
    r.at(T0 + 2 * MIN);
    r.emit("lease.requested", requested("R1"));
    r.emit("lease.requested", requested("R2", { requestSpec: { platform: "android" } }));
    r.emit("lease.granted", granted("L1", "R1"));
    r.at(T0 + 2 * MIN + 10_000);
    r.emit("lease.released", released("L1"));
    r.at(T0 + 2 * MIN + 20_000);
    r.emit("lease.granted", granted("L2", "R2", { platform: "android" }));

    const first = await buckets(r, { from: T0, platform: "ios", to: T0 + 2 * MIN });
    const held = (platform: string) =>
      buckets(r, { from: T0 + 2 * MIN, platform, to: T0 + 3 * MIN });

    expect(figure(first[0], "slotsUsed")).toEqual({ integral: 15_000 + 45_000 + 60_000, peak: 3 });
    expect(figure(first[1], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    expect(figure((await held("all"))[0], "leasesHeld")?.peak).toBe(1);
    expect(figure((await held("ios"))[0], "leasesHeld")?.peak).toBe(1);
    expect(figure((await held("android"))[0], "leasesHeld")?.peak).toBe(1);
    await r.history.stop();
  });

  it("leasesHeld by lease.granted's platform and waiting per platform rise and fall with grants, ends and rejections, across two minutes", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("R1"));
    r.at(T0 + 30_000);
    r.emit("lease.granted", granted("L1", "R1"));
    r.at(T0 + 40_000);
    r.emit("lease.requested", requested("R2"));
    r.at(T0 + 50_000);
    r.emit("lease.rejected", rejected("R2", "no-wait"));
    r.at(T0 + MIN + 30_000);
    r.emit("lease.released", released("L1"));

    const ios = await buckets(r, { from: T0, platform: "ios", to: T0 + 2 * MIN });
    const android = await buckets(r, { from: T0, platform: "android", to: T0 + 2 * MIN });

    expect(ios).toHaveLength(2);
    expect(figure(ios[0], "waiting")).toEqual({ integral: 40_000, peak: 1 });
    expect(figure(ios[0], "leasesHeld")).toEqual({ integral: 30_000, peak: 1 });
    expect(figure(ios[1], "waiting")).toEqual({ integral: 0, peak: 0 });
    expect(figure(ios[1], "leasesHeld")).toEqual({ integral: 30_000, peak: 1 });
    expect(
      android.flatMap((bucket) => [figure(bucket, "waiting"), figure(bucket, "leasesHeld")]),
    ).toEqual([]);
    await r.history.stop();
  });

  it("a step stamped before its key's last step counts at the last step's time, on a relayed row and on a * row", async () => {
    const r = await rig({ fleet: true });
    r.relay("w1", "capacity.changed", capacity({ global: [1, 0, 4], ios: [1, 0, 4] }), T0 + 10_000);
    r.relay("w1", "capacity.changed", capacity({ global: [3, 0, 4], ios: [3, 0, 4] }), T0 + 5_000);
    r.relay("w2", "capacity.changed", capacity({ global: [0, 0, 4], ios: [0, 0, 4] }), T0 + 20_000);
    r.relay("w1", "capacity.changed", capacity({ global: [1, 0, 4], ios: [1, 0, 4] }), T0 + 30_000);
    r.relay("w2", "capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }), T0 + 25_000);

    const own = await buckets(r, { from: T0, platform: "all", to: T0 + MIN, workerId: "w1" });
    const fleet = await buckets(r, { from: T0, platform: "all", to: T0 + MIN, workerId: "*" });

    expect(figure(own[0], "slotsUsed")).toEqual({ integral: 3 * 20_000 + 1 * 30_000, peak: 3 });
    expect(figure(fleet[0], "slotsUsed")).toEqual({
      integral: 150_000,
      peak: 3,
    });
    await r.history.stop();
  });

  it("on a gateway, the * row sums the workers' slots, RAM and leases and holds only the gateway's own queue depth and waiting; after worker.disconnected that worker leaves the sums", async () => {
    const r = await rig({ fleet: true });
    r.relay(
      "w1",
      "capacity.changed",
      capacity({ global: [1, 0, 4], ios: [1, 0, 2], ram: [100, 1_000] }),
    );
    r.relay(
      "w2",
      "capacity.changed",
      capacity({ global: [2, 0, 4], ios: [2, 0, 2], ram: [200, 1_000] }),
    );
    r.relay("w1", "lease.granted", granted("WL1", "X1"));
    r.relay("w2", "lease.granted", granted("WL2", "X2", { platform: "android" }));
    r.at(T0 + 10_000);
    r.relay("w1", "queue.changed", { depth: 9 });
    r.relay("w1", "lease.requested", requested("W-req"));
    r.at(T0 + 20_000);
    r.emit("queue.changed", { depth: 4 });
    r.emit("lease.requested", requested("G1"));
    r.at(T0 + MIN);
    r.emit("worker.disconnected", { leaseCount: 1, workerId: "w1" });

    const first = (platform: string, workerId = "*") =>
      buckets(r, { from: T0, platform, to: T0 + MIN, workerId });
    const later = (platform: string, workerId = "*") =>
      buckets(r, { from: T0 + MIN, platform, to: T0 + 2 * MIN, workerId });
    const peakOf = async (query: ReturnType<typeof first>, value: UsageValue) =>
      figure((await query)[0], value)?.peak;

    expect(await peakOf(first("all"), "slotsUsed")).toBe(3);
    expect(await peakOf(first("all"), "slotsMax")).toBe(8);
    expect(await peakOf(first("all"), "ramUsedBytes")).toBe(300);
    expect(await peakOf(first("all"), "ramLimitBytes")).toBe(2_000);
    expect(await peakOf(first("all"), "leasesHeld")).toBe(2);
    expect(await peakOf(first("ios"), "slotsUsed")).toBe(3);
    expect(await peakOf(first("ios"), "leasesHeld")).toBe(1);
    expect(await peakOf(first("all"), "queueDepth")).toBe(4);
    expect(await peakOf(first("all"), "waiting")).toBe(1);
    expect(await peakOf(first("all", "w1"), "queueDepth")).toBe(9);
    expect(figure((await later("all"))[0], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    expect(figure((await later("all"))[0], "ramUsedBytes")).toEqual({
      integral: 200 * MIN,
      peak: 200,
    });
    expect(figure((await later("all"))[0], "leasesHeld")).toEqual({ integral: MIN, peak: 1 });
    expect(await later("all", "w1")).toEqual([]);
    await r.history.stop();
  });

  it("a worker that reconnects after worker.disconnected counts its held leases in the * row again", async () => {
    const r = await rig({ fleet: true });
    r.relay("w1", "capacity.changed", capacity({ global: [1, 0, 4], ios: [1, 0, 2] }), T0);
    r.relay("w1", "lease.granted", granted("WL1", "X1"), T0 + 1_000);
    r.at(T0 + MIN);
    r.emit("worker.disconnected", { leaseCount: 1, workerId: "w1" });
    r.at(T0 + 2 * MIN);
    r.relay(
      "w1",
      "capacity.changed",
      capacity({ global: [1, 0, 4], ios: [1, 0, 2] }),
      T0 + 2 * MIN,
    );

    const star = (minute: number) =>
      buckets(r, {
        from: T0 + minute * MIN,
        platform: "ios",
        to: T0 + (minute + 1) * MIN,
        workerId: "*",
      });

    expect(figure((await star(0))[0], "leasesHeld")).toMatchObject({ peak: 1 });
    expect(figure((await star(1))[0], "leasesHeld")).toEqual({ integral: 0, peak: 0 });
    expect(figure((await star(2))[0], "leasesHeld")).toEqual({ integral: MIN, peak: 1 });
    await r.history.stop();
  });

  it("daemon.stopping ends the carried levels until the next daemon.started, and on a gateway worker.disconnected ends that worker's levels, so no buckets appear in the gap", async () => {
    const r = await rig({ fleet: true });
    r.emit("capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }));
    r.relay("w1", "capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }));
    r.at(T0 + 4 * MIN + 30_000);
    r.emit("lease.requested", requested("R1"));
    r.at(T0 + 5 * MIN);
    r.emit("worker.disconnected", { leaseCount: 0, workerId: "w1" });
    r.at(T0 + 6 * MIN);
    r.emit("daemon.stopping", { reason: "signal" });
    r.at(T0 + 9 * MIN);
    r.emit("daemon.started", { configSnapshot: {}, version: "1" });
    r.emit("capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }));
    r.at(T0 + 11 * MIN + 30_000);
    r.emit("daemon.stopping", { reason: "signal" });

    const carried = await buckets(r, { from: T0, platform: "ios", to: T0 + 12 * MIN });
    const worker = await buckets(r, {
      from: T0,
      platform: "ios",
      to: T0 + 12 * MIN,
      workerId: "w1",
    });

    expect(carried.map((bucket) => (bucket.start - T0) / MIN)).toEqual([
      0, 1, 2, 3, 4, 5, 9, 10, 11,
    ]);
    expect(carried.slice(0, 8).every((bucket) => bucket.knownMs === MIN)).toBe(true);
    expect(carried[8]).toMatchObject({ knownMs: 30_000 });
    expect(figure(carried[8], "slotsUsed")).toEqual({ integral: 2 * 30_000, peak: 2 });
    expect(worker.map((bucket) => (bucket.start - T0) / MIN)).toEqual([0, 1, 2, 3, 4]);
    await r.history.stop();
  });

  it("a value is carried across minutes with no row, from before from, and a first value mid-minute counts from its step", async () => {
    const r = await rig();
    r.at(T0 + 4 * MIN + 30_000);
    r.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
    r.at(T0 + 9 * MIN);
    r.emit("lease.requested", requested("R1"));

    const whole = await buckets(r, { from: T0, platform: "ios", to: T0 + 9 * MIN });
    const later = await buckets(r, { from: T0 + 6 * MIN, platform: "ios", to: T0 + 8 * MIN });

    expect(whole.map((bucket) => bucket.start - T0)).toEqual([4, 5, 6, 7, 8].map((m) => m * MIN));
    expect(whole[0]).toMatchObject({ knownMs: 30_000 });
    expect(figure(whole[0], "slotsUsed")).toEqual({ integral: 60_000, peak: 2 });
    expect(later).toHaveLength(2);
    expect(figure(later[1], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    await r.history.stop();
  });

  it("nothing is carried over a crash's downtime", async () => {
    const first = await rig();
    first.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
    first.at(T0 + 30_000);
    first.emit("lease.requested", requested("R1"));
    await first.history.stop();

    const second = await rig({ at: T0 + 10 * MIN, directory: first.directory });
    second.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
    second.emit("daemon.started", { configSnapshot: {}, version: "1" });
    second.emit("lease.requested", requested("R2"));
    second.at(T0 + 12 * MIN);
    second.emit("lease.requested", requested("R3"));

    const read = await buckets(second, { from: T0, platform: "ios", to: T0 + 13 * MIN });

    expect(read.map((bucket) => (bucket.start - T0) / MIN)).toEqual([0, 10, 11, 12]);
    await second.history.stop();
  });

  it("a start catch-up reads one run in seq order, so a relayed event stamped before the run's own start does not begin a new run", async () => {
    const r = await rig({ fleet: true, start: false });
    r.at(T0 + 2_000);
    r.emit("daemon.started", { configSnapshot: {}, version: "1" });
    r.relay("w1", "capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }), T0 + 1_500);
    await r.history.start();
    r.at(T0 + 3 * MIN);
    r.relay("w1", "capacity.changed", capacity({ global: [2, 0, 4], ios: [2, 0, 4] }));

    const read = await buckets(r, { from: T0, platform: "ios", to: T0 + 4 * MIN, workerId: "*" });

    expect(read.map((bucket) => (bucket.start - T0) / MIN)).toEqual([0, 1, 2, 3]);
    await r.history.stop();
  });

  it("a key the next run has not stepped by its daemon.started is closed there, not carried over the downtime", async () => {
    const first = await rig();
    first.emit("capacity.changed", capacity({ android: [1, 0, 3], ios: [2, 0, 4] }));
    await first.history.stop();

    const second = await rig({ at: T0 + 10 * MIN, directory: first.directory });
    const { android: _unreported, ...iosOnly } = capacity({ ios: [2, 0, 4] });
    second.emit("capacity.changed", iosOnly as EventMap["capacity.changed"]);
    second.emit("daemon.started", { configSnapshot: {}, version: "1" });
    second.at(T0 + 12 * MIN);
    second.emit("capacity.changed", iosOnly as EventMap["capacity.changed"]);

    const read = await buckets(second, { from: T0, platform: "android", to: T0 + 13 * MIN });

    expect(read.map((bucket) => (bucket.start - T0) / MIN)).toEqual([0]);
    await second.history.stop();
  });

  it("after a restart, open requests and held leases are restored, leasesHeld and waiting get a step at daemon.started, and every row written before the stop is unchanged", async () => {
    const first = await rig();
    first.emit("lease.requested", requested("R1"));
    first.emit("lease.granted", granted("L1", "R1"));
    first.emit("lease.requested", requested("R2"));
    first.emit("lease.requested", requested("R3"));
    first.at(T0 + 20_000);
    first.emit("lease.rejected", rejected("R3", "no-wait"));
    first.emit("daemon.stopping", { reason: "signal" });
    const rowsBefore = await rowsOf(first);
    const minutesBefore = await buckets(first, { from: T0, platform: "ios", to: T0 + MIN });
    await first.history.stop();

    const second = await rig({ at: T0 + 10 * MIN, directory: first.directory });
    second.emit("capacity.changed", capacity({ ios: [2, 0, 4], ram: [5, 9] }));
    second.emit("queue.changed", { depth: 3 });
    second.emit("daemon.started", { configSnapshot: {}, version: "1" });
    second.at(T0 + 10 * MIN + 30_000);
    second.emit("lease.released", released("L1"));
    second.emit("lease.rejected", rejected("R2", "daemon-restarted"));

    const rows = await rowsOf(second);
    const minutes = await buckets(second, {
      from: T0 + 10 * MIN,
      platform: "ios",
      to: T0 + 11 * MIN,
    });

    expect(row(rows, "R1")).toMatchObject({
      endedAt: T0 + 10 * MIN + 30_000,
      endReason: "explicit",
      heldMs: 10 * MIN + 30_000,
    });
    expect(row(rows, "R2")).toMatchObject({ reason: "daemon-restarted" });
    expect(row(rows, "R3")).toEqual(row(rowsBefore, "R3"));
    expect(figure(minutes[0], "leasesHeld")).toEqual({ integral: 30_000, peak: 1 });
    expect(figure(minutes[0], "waiting")).toEqual({ integral: 30_000, peak: 1 });
    expect(await buckets(second, { from: T0, platform: "ios", to: T0 + MIN })).toEqual(
      minutesBefore,
    );
    const after = await buckets(second, {
      from: T0 + 10 * MIN,
      platform: "all",
      to: T0 + 12 * MIN,
    });
    expect(after.map((bucket) => figure(bucket, "ramUsedBytes")?.peak)).toEqual([5, 5]);
    expect(after.map((bucket) => figure(bucket, "queueDepth")?.peak)).toEqual([3, 3]);
    const slots = await buckets(second, {
      from: T0 + 10 * MIN,
      platform: "ios",
      to: T0 + 12 * MIN,
    });
    expect(slots.map((bucket) => figure(bucket, "slotsUsed")?.peak)).toEqual([2, 2]);
    await second.history.stop();
  });
});

describe("usage projection: device facts", () => {
  it("one device fact row per listed device event and per lease.declined, with durationMs, platform from the event (absent when the event has none) and workerId on a relayed one; a device.ready with bootDuration 0 writes none", async () => {
    const r = await rig({ fleet: true });
    r.emit("device.provisioned", {
      deviceId: "d1",
      driver: "fake",
      duration: 1_200,
      spec: { platform: "android" },
    });
    r.at(T0 + 1_000);
    r.emit("device.ready", { bootDuration: 3_400, deviceId: "d1", platform: "ios" });
    r.at(T0 + 2_000);
    r.emit("device.ready", { bootDuration: 0, deviceId: "d1", platform: "ios" });
    r.at(T0 + 3_000);
    r.emit("device.quarantined", {
      deviceId: "d2",
      kind: "stalled",
      maxRetries: 3,
      nextRetryAt: T0 + HOUR,
      platform: "ios",
    });
    r.at(T0 + 4_000);
    r.emit("device.recovered", {
      attempts: 1,
      deviceId: "d3",
      duration: 900,
      leaseId: "L",
      platform: "android",
    });
    r.at(T0 + 5_000);
    r.emit("device.quarantine-recovered", {
      attempts: 2,
      deviceId: "d4",
      platform: "ios",
      strategy: "erase",
    });
    r.at(T0 + 6_000);
    r.emit("device.recovery-failed", {
      attempts: 3,
      deviceId: "d5",
      error: "e",
      leaseId: "L",
      platform: "ios",
      reason: "r",
    });
    r.at(T0 + 7_000);
    r.emit("device.quarantine-abandoned", { attempts: 3, deviceId: "d6", platform: "android" });
    r.at(T0 + 8_000);
    r.emit("device.quarantine-stranded", {
      attempts: 3,
      deviceId: "d7",
      error: "e",
      platform: "ios",
    });
    r.at(T0 + 9_000);
    r.emit("device.ready", { bootDuration: 2_000, deviceId: "d8" } as never);
    r.at(T0 + 10_000);
    r.relay("w1", "device.ready", { bootDuration: 5_000, deviceId: "d9", platform: "android" });
    r.at(T0 + 11_000);
    r.emit("lease.declined", {
      fleetRequestId: "F",
      reason: "no-wait",
      requestId: "P",
      requestSpec: { platform: "android" },
      requester: "alice",
    });
    r.emit("lease.requested", requested("P", { fleetRequestId: "F" }));

    const facts = await factsOf(r);

    expect(facts).toMatchObject([
      {
        at: T0,
        deviceId: "d1",
        durationMs: 1_200,
        kind: "device.provisioned",
        platform: "android",
      },
      { at: T0 + 1_000, deviceId: "d1", durationMs: 3_400, kind: "device.ready", platform: "ios" },
      { at: T0 + 3_000, deviceId: "d2", kind: "device.quarantined", platform: "ios" },
      {
        at: T0 + 4_000,
        deviceId: "d3",
        durationMs: 900,
        kind: "device.recovered",
        platform: "android",
      },
      { at: T0 + 5_000, deviceId: "d4", kind: "device.quarantine-recovered", platform: "ios" },
      { at: T0 + 6_000, deviceId: "d5", kind: "device.recovery-failed", platform: "ios" },
      { at: T0 + 7_000, deviceId: "d6", kind: "device.quarantine-abandoned", platform: "android" },
      { at: T0 + 8_000, deviceId: "d7", kind: "device.quarantine-stranded", platform: "ios" },
      { at: T0 + 9_000, deviceId: "d8", durationMs: 2_000, kind: "device.ready" },
      {
        at: T0 + 10_000,
        deviceId: "d9",
        durationMs: 5_000,
        kind: "device.ready",
        platform: "android",
        workerId: "w1",
      },
      { at: T0 + 11_000, kind: "lease.declined", platform: "android" },
    ]);
    expect(facts[8]?.platform).toBeUndefined();
    expect(facts[0]?.workerId).toBeUndefined();
    await r.history.stop();
  });
});

describe("usage reads", () => {
  it("history.usage.oldestTs() is the earliest of the three tables' times, each table the earliest in one case, and undefined when all are empty", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly expected: number | undefined;
      readonly act: (r: Rig) => void;
    }> = [
      { act: () => undefined, expected: undefined, name: "empty" },
      {
        act: (r) => {
          r.at(T0 + 1_000);
          r.emit("lease.requested", requested("R1", { fleetRequestId: "F1" }));
          r.at(T0 + 5_000);
          r.emit("device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" });
          r.at(T0 + 2 * MIN);
          r.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
        },
        expected: T0 + 1_000,
        name: "request rows",
      },
      {
        act: (r) => {
          r.at(T0 + 90_000);
          r.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
          r.at(T0 + 100_000);
          r.emit("lease.requested", requested("R1"));
          r.at(T0 + 110_000);
          r.emit("device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" });
        },
        expected: T0 + MIN,
        name: "minute rows",
      },
      {
        act: (r) => {
          r.at(T0 + 10_000);
          r.emit("device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" });
          r.at(T0 + MIN + 20_000);
          r.emit("lease.requested", requested("R1"));
          r.at(T0 + 3 * MIN);
          r.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
        },
        expected: T0 + 10_000,
        name: "device fact rows",
      },
    ];
    for (const scenario of cases) {
      const r = await rig();
      scenario.act(r);
      expect(await readWith(r, (reads) => reads.oldestTs()), scenario.name).toBe(scenario.expected);
      await r.history.stop();
    }
  });

  it("history.usage.requestRows and deviceFacts return rows with from <= time < to (one at from in, one at to out), in their stated order", async () => {
    const r = await rig();
    r.at(T0 - 1);
    r.emit("lease.requested", requested("before"));
    r.emit("device.ready", { bootDuration: 1, deviceId: "d-before", platform: "ios" });
    r.at(T0);
    r.emit("lease.requested", requested("b"));
    r.emit("lease.requested", requested("a"));
    r.emit("device.ready", { bootDuration: 1, deviceId: "d-1", platform: "ios" });
    r.at(T0 + 500);
    r.emit("device.ready", { bootDuration: 1, deviceId: "d-2", platform: "ios" });
    r.at(T0 + 1_000);
    r.emit("lease.requested", requested("at-to"));
    r.emit("device.ready", { bootDuration: 1, deviceId: "d-to", platform: "ios" });

    const requests = await readWith(r, (reads) => reads.requestRows({ from: T0, to: T0 + 1_000 }));
    const facts = await readWith(r, (reads) => reads.deviceFacts({ from: T0, to: T0 + 1_000 }));

    expect(requests.map((candidate) => candidate.requestId)).toEqual(["a", "b"]);
    expect(facts.map((fact) => fact.deviceId)).toEqual(["d-1", "d-2"]);
    await r.history.stop();
  });

  it("history.usage.minuteBuckets returns, per bucket, the largest minute peak, the summed integral and summed knownMs for the asked key only", async () => {
    const r = await rig();
    r.emit("capacity.changed", capacity({ android: [7, 0, 9], ios: [1, 0, 4] }));
    r.at(T0 + MIN + 30_000);
    r.emit("capacity.changed", capacity({ android: [7, 0, 9], ios: [4, 0, 4] }));
    r.at(T0 + 2 * MIN + 10_000);
    r.emit("capacity.changed", capacity({ android: [7, 0, 9], ios: [2, 0, 4] }));

    const wide = await buckets(r, {
      bucketMs: 5 * MIN,
      from: T0,
      platform: "ios",
      to: T0 + 10 * MIN,
    });
    const later = await buckets(r, { from: T0 + 3 * MIN, platform: "ios", to: T0 + 5 * MIN });

    expect(wide).toHaveLength(2);
    expect(wide[0]).toMatchObject({ knownMs: 5 * MIN, start: T0 });
    expect(figure(wide[0], "slotsUsed")).toEqual({
      integral: 90_000 + 4 * 40_000 + 2 * 170_000,
      peak: 4,
    });
    expect(figure(wide[1], "slotsUsed")).toEqual({ integral: 2 * 5 * MIN, peak: 2 });
    expect(later.map((bucket) => bucket.start)).toEqual([T0 + 3 * MIN, T0 + 4 * MIN]);
    expect(figure(later[0], "slotsUsed")).toEqual({ integral: 2 * MIN, peak: 2 });
    expect(figure(later[0], "ramUsedBytes")).toBeUndefined();
    await r.history.stop();
  });

  it("the four reads in one read transaction see the same commit while the writer commits between them", async () => {
    const r = await rig();
    r.emit("lease.requested", requested("R1"));
    const database = await new NodeSqliteOpener().open(r.path, { readOnly: true });
    const reads = openUsageReads(database);
    try {
      database.exec("BEGIN");
      const before = reads.requestRows({ from: 0, to: ALL }).length;
      const minutes = { bucketMs: MIN, from: T0, platform: "ios", to: T0 + MIN, workerId: "" };
      const minutesBefore = reads.minuteBuckets(minutes);
      r.at(T0 + 1_000);
      r.emit("lease.requested", requested("R2"));
      r.emit("device.ready", { bootDuration: 1, deviceId: "d", platform: "ios" });
      r.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
      const during = {
        facts: reads.deviceFacts({ from: 0, to: ALL }).length,
        oldest: reads.oldestTs(),
        requests: reads.requestRows({ from: 0, to: ALL }).length,
      };
      const minutesDuring = reads.minuteBuckets(minutes);
      database.exec("COMMIT");

      expect(before).toBe(1);
      expect(during).toEqual({ facts: 0, oldest: T0, requests: 1 });
      expect(minutesDuring).toEqual(minutesBefore);
      expect(figure(minutesBefore[0], "slotsUsed")).toBeUndefined();
      expect(reads.requestRows({ from: 0, to: ALL })).toHaveLength(2);
      expect(figure(reads.minuteBuckets(minutes)[0], "slotsUsed")).toBeDefined();
    } finally {
      database.close();
    }
    await r.history.stop();
  });
});

describe("usage projection: versions", () => {
  const versioned = (
    version: number,
    migrations: readonly string[],
  ): HistoryProjectionDefinition => ({
    check: () => true,
    create: (database) => ({
      apply: (envelope) => {
        if (version === 1) {
          database.prepare("INSERT INTO kept (id) VALUES (?)").run(envelope.id);
        }
      },
      prune: () => undefined,
      rebuild: () => undefined,
    }),
    migrations,
    name: "kept",
    version,
  });
  const CREATE = "CREATE TABLE kept (id TEXT)";
  const ADD = "ALTER TABLE kept ADD COLUMN extra INTEGER DEFAULT 7";

  it("a stored version below the code's is migrated and keeps its rows", async () => {
    const first = await rig({ projections: [versioned(1, [CREATE])] });
    first.emit("daemon.stopping", { reason: "a" });
    await first.history.stop();

    const second = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, ADD])],
    });
    const database = await new NodeSqliteOpener().open(second.path, { readOnly: true });
    try {
      const kept = database.prepare("SELECT id, extra FROM kept").all();
      expect(kept).toHaveLength(1);
      expect(kept[0]?.extra).toBe(7);
    } finally {
      database.close();
    }
    await second.history.stop();
  });

  it("a migration that throws, or a stored version above the code's, makes start() reject naming the projection and versions, with every row kept", async () => {
    const first = await rig({ projections: [versioned(1, [CREATE])] });
    first.emit("daemon.stopping", { reason: "a" });
    await first.history.stop();

    const broken = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, "ALTER TABLE missing ADD COLUMN x INTEGER"])],
      start: false,
    });
    await expect(broken.history.start()).rejects.toThrow(/kept.*1.*2/s);
    await broken.history.stop();
    const accepted = await rig({
      directory: first.directory,
      projections: [versioned(3, [CREATE, ADD, ADD.replace("extra", "more")])],
    });
    accepted.emit("daemon.stopping", { reason: "b" });
    await accepted.history.stop();

    const newer = await rig({
      directory: first.directory,
      projections: [versioned(2, [CREATE, ADD])],
      start: false,
    });
    await expect(newer.history.start()).rejects.toThrow(/kept.*3.*2/s);
    await newer.history.stop();

    expect(await count(first, "SELECT count(*) AS n FROM kept")).toBe(1);
  });
});

describe("usage projection: rebuild", () => {
  async function seed(r: Rig, requests: number): Promise<void> {
    for (let index = 0; index < requests; index += 1) {
      r.at(T0 + index);
      r.emit("lease.requested", requested(`R${index}`));
      if (index % 7 === 0) r.emit("lease.granted", granted(`L${index}`, `R${index}`));
    }
    r.emit("device.ready", { bootDuration: 10, deviceId: "d", platform: "ios" });
    r.emit("capacity.changed", capacity({ ios: [2, 0, 4] }));
  }
  const breakMinuteTable = (path: string) =>
    execOn(path, "ALTER TABLE minute_rows DROP COLUMN knownMs");

  it("a failed check rebuilds in batches with other work running between them: rows older than the oldest event are kept, the rest equal the live rows, an event emitted mid-rebuild is projected once, and status() gives rebuiltAt after; a start with nothing to fix gives neither field", async () => {
    const first = await rig({ eventRetention: DAY });
    first.at(T0 - 2 * DAY);
    first.emit("lease.requested", requested("OLD"));
    first.at(T0);
    await seed(first, 2_100);
    const live = {
      facts: await factsOf(first),
      minutes: await buckets(first, { from: T0, platform: "ios", to: T0 + 5 * MIN }),
      requests: (await rowsOf(first)).filter((candidate) => candidate.requestId !== "OLD"),
    };
    await first.history.stop();
    await breakMinuteTable(first.path);

    const second = await rig({
      at: T0 + MIN,
      directory: first.directory,
      eventRetention: DAY,
      start: false,
    });
    let between = 0;
    const ticker = setInterval(() => undefined, 1);
    const tick = (): void => {
      const status = second.history.status();
      if (status.opened && status.rebuiltAt === undefined) {
        between += 1;
        if (between === 1) second.emit("lease.requested", requested("MID"));
      }
      if (status.rebuiltAt === undefined) setImmediate(tick);
    };
    setImmediate(tick);
    await second.history.start();
    clearInterval(ticker);

    const requests = await rowsOf(second);
    expect(second.history.status().rebuiltAt).toBe(T0 + MIN);
    expect(between).toBeGreaterThanOrEqual(2);
    expect(requests.filter((candidate) => candidate.requestId === "MID")).toHaveLength(1);
    expect(requests.filter((candidate) => candidate.requestId === "OLD")).toHaveLength(1);
    expect(requests.filter((candidate) => !["MID", "OLD"].includes(candidate.requestId))).toEqual(
      live.requests,
    );
    expect(await factsOf(second)).toEqual(live.facts);
    const withMid = live.minutes.map((bucket) =>
      bucket.start < T0 + MIN
        ? bucket
        : {
            // why: the first run was never stopped, so the second run (MID is its first event) carries none of its other levels over the downtime.
            knownMs: bucket.knownMs,
            start: bucket.start,
            waiting: {
              integral: (bucket.waiting?.integral ?? 0) + MIN,
              peak: (bucket.waiting?.peak ?? 0) + 1,
            },
          },
    );
    expect(await buckets(second, { from: T0, platform: "ios", to: T0 + 5 * MIN })).toEqual(withMid);
    await second.history.stop();

    const third = await rig({ at: T0 + 2 * MIN, directory: first.directory, eventRetention: DAY });
    expect(third.history.status()).not.toHaveProperty("rebuiltAt");
    expect(third.history.status()).not.toHaveProperty("rebuildFailed");
    await third.history.stop();
  });

  it("a stop mid-rebuild leaves the mark and the next start rebuilds", async () => {
    const first = await rig();
    await seed(first, 2_100);
    const live = await rowsOf(first);
    await first.history.stop();
    await breakMinuteTable(first.path);

    const second = await rig({ at: T0 + MIN, directory: first.directory, start: false });
    const starting = second.history.start();
    const stopping = new Promise<void>((resolve) => {
      const wait = (): void => {
        const status = second.history.status();
        if (status.opened && status.rebuiltAt === undefined)
          void second.history.stop().then(resolve);
        else setImmediate(wait);
      };
      setImmediate(wait);
    });
    await Promise.all([starting, stopping]);

    const third = await rig({ at: T0 + 2 * MIN, directory: first.directory });
    expect(third.history.status().rebuiltAt).toBe(T0 + 2 * MIN);
    expect(await rowsOf(third)).toEqual(live);
    await third.history.stop();
  });

  it("a rebuild that throws leaves no rows for the events' window, rebuildFailed true, writing true, no rebuiltAt, one error, and later events are still written", async () => {
    const first = await rig();
    await seed(first, 2_100);
    await first.history.stop();
    await breakMinuteTable(first.path);
    await execOn(
      first.path,
      "CREATE TRIGGER refuse BEFORE INSERT ON request_rows WHEN NEW.requestId = 'R1500' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );

    const second = await rig({ at: T0 + MIN, directory: first.directory });
    second.emit("lease.requested", requested("LATER"));
    const status = second.history.status();
    const stored = await second.history.replay({ sinceTs: 0 });

    expect(status).toMatchObject({ rebuildFailed: true, writing: true });
    expect(status).not.toHaveProperty("rebuiltAt");
    expect(second.logs.records.filter((record) => record.level === "error")).toHaveLength(1);
    expect(await rowsOf(second)).toEqual([]);
    expect(
      stored.some(
        (envelope) =>
          envelope.payload && (envelope.payload as { requestId?: string }).requestId === "LATER",
      ),
    ).toBe(true);
    await second.history.stop();
  });
});

describe("usage projection: prune", () => {
  it("prune deletes request, minute, device fact and held lease rows older than metrics.retention and keeps one at the cutoff, at start and one hour later", async () => {
    const retention = 10 * DAY;
    const cutoff = T0;
    const first = await rig({
      at: cutoff - 5 * MIN,
      eventRetention: DAY,
      fleet: true,
      metricsRetention: retention,
    });
    const mark = (at: number, name: string): void => {
      first.at(at);
      first.emit("lease.requested", requested(`R-${name}`));
      first.emit("device.ready", { bootDuration: 5, deviceId: `d-${name}`, platform: "ios" });
      first.relay("w1", "lease.granted", granted(`L-${name}`, `X-${name}`));
      first.emit("daemon.stopping", { reason: name });
      first.emit("capacity.changed", capacity({ ios: [1, 0, 4] }));
    };
    mark(cutoff - 1_000, "old");
    mark(cutoff, "edge");
    mark(cutoff + HOUR, "new");
    await first.history.stop();

    const second = await rig({
      at: cutoff + retention,
      directory: first.directory,
      eventRetention: DAY,
      fleet: true,
      metricsRetention: retention,
    });
    const heldSource = async (name: string, workerLeaseId: string) => {
      second.emit("lease.requested", requested(`Q-${name}`));
      second.emit("request.granted", {
        leaseId: `G-${name}`,
        requestId: `Q-${name}`,
        worker: "w1",
        workerLeaseId,
      });
      return row(await rowsOf(second), `Q-${name}`).source;
    };
    const minutesOf = async () =>
      (
        await buckets(second, {
          from: cutoff - 2 * MIN,
          platform: "ios",
          to: cutoff + HOUR + MIN,
          workerId: "*",
        })
      ).map((bucket) => bucket.start);
    const afterStart = {
      facts: (await factsOf(second)).map((fact) => fact.deviceId),
      minutes: await minutesOf(),
      requests: (await rowsOf(second)).map((candidate) => candidate.requestId),
    };
    const startSources = [
      await heldSource("start-old", "L-old"),
      await heldSource("start-edge", "L-edge"),
      await heldSource("start-new", "L-new"),
    ];
    second.clock.advance(HOUR);
    const afterHour = {
      facts: (await factsOf(second)).map((fact) => fact.deviceId),
      minutes: await minutesOf(),
      requests: (await rowsOf(second))
        .map((candidate) => candidate.requestId)
        .filter((requestId) => requestId.startsWith("R-")),
    };
    const hourSources = [
      await heldSource("hour-edge", "L-edge"),
      await heldSource("hour-new", "L-new"),
    ];

    expect(afterStart.requests).toEqual(["R-edge", "R-new"]);
    expect(afterStart.facts).toEqual(["d-edge", "d-new"]);
    expect(afterStart.minutes).toEqual([cutoff, cutoff + HOUR]);
    expect(startSources).toEqual([undefined, "warm", "warm"]);
    expect(afterHour).toEqual({
      facts: ["d-new"],
      minutes: [cutoff + HOUR],
      requests: ["R-new"],
    });
    expect(hourSources).toEqual([undefined, "warm"]);
    await second.history.stop();
  });
});
