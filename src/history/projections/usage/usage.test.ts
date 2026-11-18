import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  MIN,
  T0,
  directories,
  type Rig,
  rig,
  rowsOf,
  factsOf,
  buckets,
  row,
  requested,
  granted,
  released,
  rejected,
  figure,
} from "./test-usage.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

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
