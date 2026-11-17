import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { type EventMap } from "../../../bus/index.js";
import { type UsageValue } from "./index.js";
import {
  MIN,
  T0,
  directories,
  rig,
  rowsOf,
  factsOf,
  buckets,
  row,
  requested,
  granted,
  released,
  rejected,
  capacity,
  figure,
} from "./test-usage.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
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
