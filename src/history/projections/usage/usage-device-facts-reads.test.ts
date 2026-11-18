import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteOpener } from "../../../ports/index.js";
import { openUsageReads } from "./index.js";
import {
  MIN,
  HOUR,
  T0,
  ALL,
  directories,
  type Rig,
  rig,
  readWith,
  factsOf,
  buckets,
  requested,
  capacity,
  figure,
} from "./test-usage.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
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
