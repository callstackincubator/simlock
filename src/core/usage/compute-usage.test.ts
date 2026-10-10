import { describe, expect, it } from "vitest";

import type { EventEnvelope, EventMap, EventName } from "../../bus/index.js";
import { computeUsage, seriesBucketMs, type UsageOptions } from "./compute-usage.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_000_000_000;
const WINDOW = { from: T0, to: T0 + HOUR };
const WORKER: UsageOptions = { fleet: false, workers: [{ id: "self" }] };
const FLEET: UsageOptions = { fleet: true };

let sequence = 0;

/** One envelope; `extra` is merged into the payload, which is how a relayed event gets its `workerId`. */
function at(timestamp: number, event: EventName, payload: Record<string, unknown>): EventEnvelope {
  sequence += 1;
  return {
    event,
    id: `evt_${sequence}`,
    module: "test",
    payload: payload as unknown as EventMap[EventName],
    seq: sequence,
    timestamp,
  } as EventEnvelope;
}

const requested = (ts: number, requestId: string, requester = "agent-a", platform = "ios") =>
  at(ts, "lease.requested", {
    requestId,
    requestSpec: { platform },
    requester,
    waitPolicy: "wait",
  });

const granted = (
  ts: number,
  requestId: string,
  leaseId: string,
  source = "warm",
  requester = "agent-a",
  extra: Record<string, unknown> = {},
) =>
  at(ts, "lease.granted", {
    deviceId: `dev-${leaseId}`,
    leaseId,
    requestId,
    requester,
    source,
    ...extra,
  });

const released = (ts: number, leaseId: string, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.released", {
    deviceId: `dev-${leaseId}`,
    leaseId,
    ownerId: "owner",
    reason: "explicit",
    ...extra,
  });

const rejected = (
  ts: number,
  requestId: string,
  reason: string,
  requester = "agent-a",
  extra: Record<string, unknown> = {},
) =>
  at(ts, "lease.rejected", {
    reason,
    requestId,
    requestSpec: { platform: "ios" },
    requester,
    ...extra,
  });

const figures = (running: number, reserved: number, maxRunning: number, warm = 0) => ({
  maxRunning,
  reserved,
  running,
  warm,
});

const capacity = (
  ts: number,
  global: ReturnType<typeof figures>,
  ramBudget?: { usedBytes: number; limitBytes: number },
  extra: Record<string, unknown> = {},
) =>
  at(ts, "capacity.changed", {
    android: figures(0, 0, global.maxRunning),
    global,
    ios: global,
    ...(ramBudget === undefined ? {} : { ramBudget }),
    ...extra,
  });

const queueChanged = (ts: number, depth: number, extra: Record<string, unknown> = {}) =>
  at(ts, "queue.changed", { depth, ...extra });

/** The gateway's own record that it handed a fleet request's grant to its caller (ADR 0021 §4). */
const handed = (ts: number, requestId: string, worker: string, workerLeaseId: string) =>
  at(ts, "request.granted", { leaseId: `gw-${workerLeaseId}`, requestId, worker, workerLeaseId });

/** A worker's refusal of a gateway's dispatch, as the worker records it (ADR 0021 §2). */
const declined = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "lease.declined", {
    fleetRequestId: "f",
    reason: "no-wait",
    requestId: "worker-side",
    requestSpec: { platform: "ios" },
    requester: "gw:g1:agent-a",
    ...extra,
  });

const restarted = (ts: number, extra: Record<string, unknown> = {}) =>
  at(ts, "daemon.started", { configSnapshot: {}, version: "0", ...extra });

/** A worker's `lease.requested` for a gateway's dispatch: it carries the fleet request id. */
const probe = (ts: number, requestId: string, requester = "gw:g1:a") =>
  at(ts, "lease.requested", {
    fleetRequestId: `f-${requestId}`,
    requestId,
    requestSpec: { platform: "ios" },
    requester,
    waitPolicy: "noWait",
  });

describe("computeUsage", () => {
  it("counts a request granted, held and released as one request, one grant, and one sample in wait, held and turnaround with the expected milliseconds", () => {
    const usage = computeUsage(
      [requested(T0 + 1_000, "r1"), granted(T0 + 3_000, "r1", "l1"), released(T0 + 13_000, "l1")],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.wait).toEqual({ count: 1, max: 2_000, p50: 2_000, p95: 2_000 });
    expect(usage.totals.held).toEqual({ count: 1, max: 10_000, p50: 10_000, p95: 10_000 });
    expect(usage.totals.turnaround).toEqual({ count: 1, max: 12_000, p50: 12_000, p95: 12_000 });
    expect(usage.platforms.ios.requests).toBe(1);
    expect(usage.platforms.android.requests).toBe(0);
  });

  it("ends a lease's held time at its expiry as at its release", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1"),
        granted(T0 + 2_000, "r1", "l1"),
        at(T0 + 9_000, "lease.expired", { deviceId: "dev-l1", leaseId: "l1", ownerId: "owner" }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.held).toEqual({ count: 1, max: 7_000, p50: 7_000, p95: 7_000 });
    expect(usage.totals.turnaround.p50).toBe(8_000);
  });

  it("reports p50, p95 and max of a set of twenty known waits", () => {
    const events: EventEnvelope[] = [];
    for (let index = 1; index <= 20; index += 1) {
      // Request `index` waits index * 100 ms: 100, 200, ... 2000.
      events.push(requested(T0 + index * 10_000, `r${index}`, `agent-${index}`));
      events.push(granted(T0 + index * 10_000 + index * 100, `r${index}`, `l${index}`));
    }

    const { wait } = computeUsage(events, WINDOW, WORKER).totals;

    expect(wait).toEqual({ count: 20, max: 2_000, p50: 1_000, p95: 1_900 });
  });

  it("reports a percentile over no samples as null", () => {
    const { wait, held } = computeUsage([], WINDOW, WORKER).totals;

    expect(wait).toEqual({ count: 0, max: null, p50: null, p95: null });
    expect(held).toEqual({ count: 0, max: null, p50: null, p95: null });
  });

  it("counts a rejected request under its reason and not under grants", () => {
    const usage = computeUsage(
      [requested(T0 + 1_000, "r1"), rejected(T0 + 6_000, "r1", "timeout")],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: { timeout: 1 }, total: 1 });
    expect(usage.totals.wait.p50).toBe(5_000);
    expect(usage.totals.turnaround.count).toBe(0);
  });

  it("attributes grants to warm, booted and provisioned from lease.granted.source", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1", "a"),
        granted(T0 + 2_000, "r1", "l1", "warm", "a"),
        requested(T0 + 1_000, "r2", "b"),
        granted(T0 + 2_000, "r2", "l2", "booted", "b"),
        requested(T0 + 1_000, "r3", "c"),
        granted(T0 + 2_000, "r3", "l3", "provisioned", "c"),
        requested(T0 + 1_000, "r4", "d"),
        granted(T0 + 2_000, "r4", "l4", "provisioned", "d"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.granted).toBe(4);
    expect(usage.totals.bySource).toEqual({ booted: 1, provisioned: 2, warm: 1 });
  });

  it("reads provisioning and boot durations from device.provisioned and device.ready", () => {
    const usage = computeUsage(
      [
        at(T0 + 1_000, "device.provisioned", {
          deviceId: "d1",
          driver: "fake",
          duration: 90_000,
          spec: { platform: "ios" },
        }),
        at(T0 + 2_000, "device.ready", { bootDuration: 20_000, deviceId: "d1" }),
        at(T0 + 3_000, "device.provisioned", {
          deviceId: "d2",
          driver: "fake",
          duration: 30_000,
          spec: { platform: "android" },
        }),
        at(T0 + 4_000, "device.ready", { bootDuration: 40_000, deviceId: "d2" }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.provisioning).toEqual({ count: 2, max: 90_000, p50: 30_000, p95: 90_000 });
    expect(usage.totals.boot).toEqual({ count: 2, max: 40_000, p50: 20_000, p95: 40_000 });
    expect(usage.platforms.ios.provisioning.p50).toBe(90_000);
    expect(usage.platforms.android.boot.p50).toBe(40_000);
  });

  it("derives peak and time-weighted mean slot utilisation from capacity.changed steps, including the step in force before the window starts", () => {
    const usage = computeUsage(
      [
        capacity(T0 - 1_000, figures(1, 0, 4)),
        capacity(T0 + 10 * MINUTE, figures(3, 1, 4)),
        capacity(T0 + 30 * MINUTE, figures(0, 0, 4)),
      ],
      WINDOW,
      WORKER,
    );

    // 1 slot for 10 minutes, 4 for 20, 0 for 30: (10 + 80 + 0) / 60.
    expect(usage.totals.utilisation.slots).toEqual({ max: 4, mean: 1.5, peak: 4 });
  });

  it("reports RAM utilisation when capacity.changed carries ramBudget and omits it otherwise", () => {
    const withRam = computeUsage(
      [
        capacity(T0 - 1_000, figures(0, 0, 4), { limitBytes: 1_000, usedBytes: 100 }),
        capacity(T0 + 30 * MINUTE, figures(1, 0, 4), { limitBytes: 1_000, usedBytes: 500 }),
      ],
      WINDOW,
      WORKER,
    );
    const withoutRam = computeUsage([capacity(T0 - 1_000, figures(0, 0, 4))], WINDOW, WORKER);

    expect(withRam.totals.utilisation.ram).toEqual({
      limitBytes: 1_000,
      meanBytes: 300,
      peakBytes: 500,
    });
    expect(withoutRam.totals.utilisation).not.toHaveProperty("ram");
  });

  it("derives peak and mean queue depth from queue.changed", () => {
    const usage = computeUsage(
      [
        queueChanged(T0 - 1_000, 0),
        queueChanged(T0 + 10 * MINUTE, 2),
        queueChanged(T0 + 40 * MINUTE, 0),
      ],
      WINDOW,
      WORKER,
    );

    // 0 for 10 minutes, 2 for 30, 0 for 20: 60 / 60.
    expect(usage.totals.queue).toEqual({ meanDepth: 1, peakDepth: 2 });
  });

  it("counts quarantined, crashRecovered, quarantineRecovered and lost from the named device events and nothing else", () => {
    const usage = computeUsage(
      [
        at(T0 + 1_000, "device.quarantined", { deviceId: "d1", maxRetries: 3, nextRetryAt: 0 }),
        at(T0 + 2_000, "device.recovered", {
          attempts: 1,
          deviceId: "d2",
          duration: 5,
          leaseId: "l",
        }),
        at(T0 + 3_000, "device.quarantine-recovered", {
          attempts: 1,
          deviceId: "d1",
          strategy: "erase",
        }),
        at(T0 + 4_000, "device.recovery-failed", {
          attempts: 3,
          deviceId: "d3",
          error: "x",
          leaseId: "l",
          reason: "attempts-exhausted",
        }),
        at(T0 + 5_000, "device.quarantine-abandoned", { attempts: 3, deviceId: "d4" }),
        at(T0 + 6_000, "device.quarantine-stranded", { attempts: 3, deviceId: "d5", error: "x" }),
        // Facts that sit next to those and are not any of the four.
        at(T0 + 7_000, "device.crash-detected", {
          deviceId: "d2",
          leaseId: "l",
          observed: "stopped",
          platform: "ios",
        }),
        at(T0 + 8_000, "device.deleted", { deviceId: "d4", initiator: "x" }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.incidents).toEqual({
      crashRecovered: 1,
      lost: 3,
      quarantineRecovered: 1,
      quarantined: 1,
    });
  });

  it("counts a request whose lease.requested is before from and whose grant is inside the window under neither requests nor grants", () => {
    const usage = computeUsage(
      [
        requested(T0 - 5_000, "r1"),
        granted(T0 + 1_000, "r1", "l1"),
        released(T0 + 5_000, "l1"),
        // A request inside the window, so the window is seen counting at all.
        requested(T0 + 6_000, "r2", "agent-b"),
        granted(T0 + 6_500, "r2", "l2", "booted", "agent-b"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.bySource).toEqual({ booted: 1, provisioned: 0, warm: 0 });
    expect(usage.totals.wait).toMatchObject({ count: 1, p50: 500 });
    expect(usage.totals.held.count).toBe(0);
    expect(usage.requesters.map((requester) => requester.id)).toEqual(["agent-b"]);
  });

  it("gives no held or turnaround sample for a lease still open at to, and counts its request and grant", () => {
    const usage = computeUsage(
      [
        requested(WINDOW.to - 10_000, "r1"),
        granted(WINDOW.to - 5_000, "r1", "l1"),
        // The end falls after the window: it is not seen.
        released(WINDOW.to + 5_000, "l1"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.wait.count).toBe(1);
    expect(usage.totals.held.count).toBe(0);
    expect(usage.totals.turnaround.count).toBe(0);
  });

  it("counts a rejection with no preceding lease.requested under rejected and not under requests", () => {
    const usage = computeUsage(
      [rejected(T0 + 1_000, "r-refused", "already-leased")],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: { "already-leased": 1 }, total: 1 });
    expect(usage.totals.wait.count).toBe(0);
  });

  it("counts a killed rejection that names no request spec, with no preceding lease.requested, under rejected", () => {
    const usage = computeUsage(
      [
        at(T0 + 1_000, "lease.rejected", {
          reason: "killed",
          requestId: "r-killed",
          requester: "agent-a",
        }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: { killed: 1 }, total: 1 });
    expect(usage.platforms.ios.rejected.total).toBe(0);
    expect(usage.platforms.android.rejected.total).toBe(0);
  });

  it("counts a request from before from that is rejected inside the window under neither requests nor rejections", () => {
    const usage = computeUsage(
      [
        requested(T0 - 5_000, "r1"),
        rejected(T0 + 1_000, "r1", "timeout"),
        // A request inside the window, so the window is seen counting at all.
        requested(T0 + 2_000, "r2", "agent-b"),
        rejected(T0 + 3_000, "r2", "cancelled", "agent-b"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.rejected).toEqual({ byReason: { cancelled: 1 }, total: 1 });

    // The history a window is read from holds nothing from before it, so a rejection whose
    // request is not there is told from one refused at admission by its reason.
    const unseen = computeUsage(
      [
        rejected(T0 + 1_000, "r-old", "timeout"),
        rejected(T0 + 2_000, "r-old-2", "boot-timeout"),
        rejected(T0 + 3_000, "r-refused", "already-leased", "agent-b"),
      ],
      WINDOW,
      WORKER,
    );
    expect(unseen.totals.rejected).toEqual({ byReason: { "already-leased": 1 }, total: 1 });
  });

  it("reports null series points and excludes them from peak and mean before the first step when no step precedes the window", () => {
    const usage = computeUsage(
      [capacity(T0 + 30 * MINUTE, figures(2, 0, 4)), queueChanged(T0 + 30 * MINUTE, 3)],
      WINDOW,
      WORKER,
    );

    expect(usage.series).toHaveLength(60);
    // Point 28 ends at the 29th minute, point 29 at the 30th, where the first step lands.
    expect(usage.series[28]).toMatchObject({ queueDepth: null, slotsMax: null, slotsUsed: null });
    expect(usage.series[29]).toMatchObject({ queueDepth: 3, slotsMax: 4, slotsUsed: 2 });
    expect(usage.totals.utilisation.slots).toEqual({ max: 4, mean: 2, peak: 2 });
    expect(usage.totals.queue).toEqual({ meanDepth: 3, peakDepth: 3 });
  });

  it("reports slots, RAM, queue depth and waiting requests in each series point as they stand at the bucket's end", () => {
    const usage = computeUsage(
      [
        capacity(T0 - 1_000, figures(1, 0, 4), { limitBytes: 1_000, usedBytes: 250 }),
        queueChanged(T0 - 1_000, 0),
        requested(T0 + 90 * SECOND, "r1"),
        queueChanged(T0 + 90 * SECOND, 1),
        granted(T0 + 150 * SECOND, "r1", "l1"),
        queueChanged(T0 + 150 * SECOND, 0),
      ],
      { from: T0, to: T0 + 5 * MINUTE },
      WORKER,
    );

    expect(usage.bucketMs).toBe(MINUTE);
    expect(usage.series.map((point) => point.at)).toEqual(
      [1, 2, 3, 4, 5].map((n) => T0 + n * MINUTE),
    );
    expect(usage.series.map((point) => point.waiting)).toEqual([0, 1, 0, 0, 0]);
    expect(usage.series.map((point) => point.queueDepth)).toEqual([0, 1, 0, 0, 0]);
    expect(usage.series[0]).toMatchObject({ ramUsedBytes: 250, slotsMax: 4, slotsUsed: 1 });
  });

  it("groups by platform and by workerId", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1", "a", "ios"),
        granted(T0 + 2_000, "w1-r", "l1", "warm", "gw:g1:a", { workerId: "w1" }),
        handed(T0 + 2_100, "r1", "w1", "l1"),
        requested(T0 + 3_000, "r2", "b", "android"),
        granted(T0 + 4_000, "w2-r", "l2", "provisioned", "gw:g1:b", { workerId: "w2" }),
        handed(T0 + 4_100, "r2", "w2", "l2"),
        at(T0 + 4_500, "device.provisioned", {
          deviceId: "dev-l2",
          driver: "fake",
          duration: 7_000,
          spec: { platform: "android" },
          workerId: "w2",
        }),
      ],
      WINDOW,
      { ...FLEET, workers: [{ id: "w1", label: "mac-1" }] },
    );

    expect(usage.platforms.ios).toMatchObject({ granted: 1, requests: 1 });
    expect(usage.platforms.android).toMatchObject({ granted: 1, requests: 1 });
    expect(usage.platforms.android.provisioning.p50).toBe(7_000);
    expect(usage.workers.map((worker) => [worker.id, worker.label, worker.granted])).toEqual([
      ["w1", "mac-1", 1],
      ["w2", undefined, 1],
    ]);
    expect(usage.workers[1]?.provisioning.p50).toBe(7_000);
    expect(usage.workers[1]).not.toHaveProperty("label");
    expect(usage.workers[0]?.provisioning.count).toBe(0);
    expect(usage.totals.granted).toBe(2);
  });

  it("with fleet: true counts a fleet request once, from the gateway's own events, and attributes its grant to the worker of its request.granted", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        // The worker's own copy of the same request, relayed from a worker the grant is not on.
        at(T0 + 1_300, "lease.requested", {
          fleetRequestId: "gw-r1",
          requestId: "w-r1",
          requestSpec: { platform: "ios" },
          requester: "gw:g1:agent-a",
          waitPolicy: "noWait",
          workerId: "w9",
        }),
        // A grant on that other worker under the same lease id: not the one the request got.
        granted(T0 + 3_900, "w9-r", "l1", "warm", "gw:g1:agent-b", { workerId: "w9" }),
        granted(T0 + 4_000, "w-r1", "l1", "booted", "gw:g1:agent-a", { workerId: "w1" }),
        handed(T0 + 4_200, "gw-r1", "w1", "l1"),
        released(T0 + 9_000, "l1", { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.bySource).toEqual({ booted: 1, provisioned: 0, unknown: 0, warm: 0 });
    expect(usage.workers).toHaveLength(1);
    expect(usage.workers[0]).toMatchObject({ granted: 1, id: "w1", requests: 1 });
  });

  it("with fleet: true ignores relayed lease.requested, lease.queued, queue.changed, lease.rejected and lease.declined as request facts", () => {
    const usage = computeUsage(
      [
        queueChanged(T0 + 1_000, 1),
        at(T0 + 1_500, "queue.changed", { depth: 9, workerId: "w1" }),
        at(T0 + 2_000, "lease.requested", {
          requestId: "w-r1",
          requestSpec: { platform: "ios" },
          requester: "gw:g1:ghost",
          waitPolicy: "noWait",
          workerId: "w1",
        }),
        at(T0 + 2_100, "lease.queued", { queuePosition: 1, requestId: "w-r1", workerId: "w1" }),
        rejected(T0 + 2_200, "w-r1", "no-wait", "gw:g1:ghost", { workerId: "w1" }),
        declined(T0 + 2_300, { requestId: "w-r1", workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: {}, total: 0 });
    expect(usage.totals.queue.peakDepth).toBe(1);
    expect(usage.requesters).toEqual([]);
  });

  it("with fleet: true does not count a relayed lease.granted carrying a request's fleetRequestId as its outcome when the gateway rejected it", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        granted(T0 + 1_500, "w-r1", "l1", "warm", "gw:g1:agent-a", {
          fleetRequestId: "gw-r1",
          workerId: "w1",
        }),
        // The grant came too late: the gateway had settled the request as a timeout.
        rejected(T0 + 1_200, "gw-r1", "timeout", "agent-a"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.granted).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: { timeout: 1 }, total: 1 });
    expect(usage.totals.bySource).toEqual({ booted: 0, provisioned: 0, unknown: 0, warm: 0 });
  });

  it("with fleet: true does not let a stale worker's relayed refusal reject a request another worker granted", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        rejected(T0 + 1_100, "w1-r", "no-wait", "gw:g1:agent-a", { workerId: "w1" }),
        granted(T0 + 1_400, "w2-r", "l1", "warm", "gw:g1:agent-a", { workerId: "w2" }),
        handed(T0 + 1_500, "gw-r1", "w2", "l1"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.rejected.total).toBe(0);
    expect(
      usage.workers.map((worker) => [worker.id, worker.granted, worker.rejected.total]),
    ).toEqual([["w2", 1, 0]]);
  });

  it("with fleet: true does not close an open fleet request at a relayed worker daemon.started", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        at(T0 + 2_000, "daemon.started", { configSnapshot: {}, version: "0", workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.rejected.total).toBe(0);
    expect(usage.totals.wait.count).toBe(0);
    expect(usage.series.at(-1)?.waiting).toBe(1);
  });

  it("with fleet: true settles a request as rejected from the gateway's own lease.rejected, and a worker-failed one under its worker", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1", "a"),
        rejected(T0 + 2_000, "gw-r1", "timeout", "a"),
        requested(T0 + 3_000, "gw-r2", "b"),
        rejected(T0 + 3_500, "gw-r2", "worker-failed", "b", { code: "INTERNAL", worker: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(2);
    expect(usage.totals.granted).toBe(0);
    expect(usage.totals.rejected).toEqual({
      byReason: { timeout: 1, "worker-failed": 1 },
      total: 2,
    });
    expect(usage.workers).toHaveLength(1);
    expect(usage.workers[0]).toMatchObject({
      id: "w1",
      rejected: { byReason: { "worker-failed": 1 }, total: 1 },
      requests: 1,
      wait: { count: 1, p50: 500 },
    });
  });

  it("with fleet: true counts a fleet request under the worker its request.granted or worker-failed rejection names, with its wait and turnaround, and a timeout rejection under no worker", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "g1", "a"),
        granted(T0 + 1_800, "w1-r", "l1", "warm", "gw:g1:a", { workerId: "w1" }),
        handed(T0 + 2_000, "g1", "w1", "l1"),
        released(T0 + 7_800, "l1", { workerId: "w1" }),
        requested(T0 + 3_000, "g2", "b"),
        rejected(T0 + 3_400, "g2", "worker-failed", "b", {
          code: "WORKER_UNREACHABLE",
          worker: "w2",
        }),
        requested(T0 + 4_000, "g3", "c"),
        rejected(T0 + 9_000, "g3", "timeout", "c"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.workers.map((worker) => worker.id)).toEqual(["w1", "w2"]);
    expect(usage.workers[0]).toMatchObject({
      granted: 1,
      requests: 1,
      turnaround: { count: 1, p50: 7_000 },
      wait: { count: 1, p50: 1_000 },
    });
    expect(usage.workers[1]).toMatchObject({
      granted: 0,
      rejected: { total: 1 },
      requests: 1,
      wait: { count: 1, p50: 400 },
    });
    expect(usage.totals).toMatchObject({
      granted: 1,
      rejected: { byReason: { timeout: 1, "worker-failed": 1 }, total: 2 },
      requests: 3,
      wait: { count: 3 },
    });
    expect(usage.workers.reduce((total, worker) => total + worker.requests, 0)).toBe(2);
  });

  it("with fleet: true measures a fleet wait from the gateway's lease.requested to its request.granted, ignoring a relayed lease.granted stamped earlier", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        granted(T0 + 800, "w-r1", "l1", "warm", "gw:g1:agent-a", { workerId: "w1" }),
        handed(T0 + 3_000, "gw-r1", "w1", "l1"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.wait).toEqual({ count: 1, max: 2_000, p50: 2_000, p95: 2_000 });
  });

  it("with fleet: true takes the grant source and held time from the relayed lease.granted whose workerId and leaseId match the request.granted's worker and workerLeaseId, and counts source unknown with no held sample when it is missing", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "g1", "a"),
        // The same lease id on w1 and w2, and other leases on w2: only (w2, l1) is the one g1 names.
        granted(T0 + 1_050, "w2-r0", "l0", "warm", "gw:g1:z", { workerId: "w2" }),
        granted(T0 + 1_100, "w1-r", "l1", "warm", "gw:g1:a", { workerId: "w1" }),
        granted(T0 + 1_200, "w2-r", "l1", "provisioned", "gw:g1:a", { workerId: "w2" }),
        granted(T0 + 1_300, "w2-r2", "l2", "booted", "gw:g1:y", { workerId: "w2" }),
        handed(T0 + 1_500, "g1", "w2", "l1"),
        released(T0 + 4_000, "l0", { workerId: "w2" }),
        released(T0 + 6_200, "l1", { workerId: "w2" }),
        released(T0 + 7_300, "l2", { workerId: "w2" }),
        released(T0 + 9_000, "l1", { workerId: "w1" }),
        requested(T0 + 2_000, "g2", "b"),
        handed(T0 + 2_400, "g2", "w3", "l9"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.bySource).toEqual({ booted: 0, provisioned: 1, unknown: 1, warm: 0 });
    expect(usage.totals.granted).toBe(2);
    expect(usage.totals.held).toEqual({ count: 1, max: 5_000, p50: 5_000, p95: 5_000 });
    expect(usage.totals.turnaround).toEqual({ count: 1, max: 5_500, p50: 5_500, p95: 5_500 });
    expect(usage.totals.wait.count).toBe(2);
    expect(usage.requesters.map((requester) => [requester.id, requester.heldTotalMs])).toEqual([
      ["a", 5_000],
      ["b", 0],
    ]);
  });

  it("gives a lease id chosen again after its release the end of its own lease on a worker, not the later one's", () => {
    const usage = computeUsage(
      [
        requested(T0 + 100_000, "r1"),
        granted(T0 + 120_000, "r1", "ci-1"),
        released(T0 + 130_000, "ci-1"),
        requested(T0 + 140_000, "r2"),
        granted(T0 + 150_000, "r2", "ci-1"),
        released(T0 + 190_000, "ci-1"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.held).toEqual({ count: 2, max: 40_000, p50: 10_000, p95: 40_000 });
  });

  it("with fleet: true gives two fleet requests granted on one worker under one lease id each their own source and held time", () => {
    const usage = computeUsage(
      [
        requested(T0 + 100_000, "g1", "a"),
        granted(T0 + 120_000, "w-r1", "ci-1", "warm", "gw:g1:a", { workerId: "w1" }),
        handed(T0 + 120_100, "g1", "w1", "ci-1"),
        released(T0 + 130_000, "ci-1", { workerId: "w1" }),
        requested(T0 + 140_000, "g2", "b"),
        granted(T0 + 150_000, "w-r2", "ci-1", "booted", "gw:g1:b", { workerId: "w1" }),
        handed(T0 + 150_100, "g2", "w1", "ci-1"),
        released(T0 + 190_000, "ci-1", { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.bySource).toEqual({ booted: 1, provisioned: 0, unknown: 0, warm: 1 });
    expect(usage.totals.held).toEqual({ count: 2, max: 40_000, p50: 10_000, p95: 40_000 });
    expect(usage.requesters.map((requester) => [requester.id, requester.heldTotalMs])).toEqual([
      ["a", 10_000],
      ["b", 40_000],
    ]);
  });

  it("with fleet: true counts each relayed lease.declined under its worker's and platform's declined, two declines of one request as two", () => {
    const usage = computeUsage(
      [
        declined(T0 + 1_000, { workerId: "w1" }),
        declined(T0 + 2_000, { workerId: "w1" }),
        declined(T0 + 3_000, { requestSpec: { platform: "android" }, workerId: "w2" }),
        declined(T0 - 1_000, { workerId: "w1" }),
        // The gateway's own events have no decline of this kind: nothing counts for no worker.
        declined(T0 + 4_000),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.declined).toBe(3);
    expect(usage.platforms.ios.declined).toBe(2);
    expect(usage.platforms.android.declined).toBe(1);
    expect(usage.workers.map((worker) => [worker.id, worker.declined])).toEqual([
      ["w1", 2],
      ["w2", 1],
    ]);
    expect(usage.totals.requests).toBe(0);
  });

  it("with fleet: true ends a request with no outcome at the gateway's next daemon.started as rejected daemon-restarted, and leaves one with no later start open", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gone", "a"),
        restarted(T0 + 5_000),
        requested(T0 + 6_000, "open", "b"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(2);
    expect(usage.totals.rejected).toEqual({ byReason: { "daemon-restarted": 1 }, total: 1 });
    expect(usage.totals.wait).toEqual({ count: 1, max: 4_000, p50: 4_000, p95: 4_000 });
    expect(usage.workers).toEqual([]);
    expect(usage.series.slice(0, 7).map((point) => point.waiting)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(usage.series.at(-1)?.waiting).toBe(1);
  });

  it("with fleet: true answers no probes field in totals, platforms or worker entries", () => {
    const usage = computeUsage(
      [capacity(T0 + 1_000, figures(0, 0, 2), undefined, { workerId: "w1" })],
      WINDOW,
      FLEET,
    );

    expect(usage.totals).not.toHaveProperty("probes");
    expect(usage.platforms.ios).not.toHaveProperty("probes");
    expect(usage.workers[0]).not.toHaveProperty("probes");
    expect(usage.totals.bySource).toHaveProperty("unknown", 0);
  });

  it("on a worker counts a lease.requested carrying fleetRequestId under probes, not requests, its grant under granted, its lease.declined under declined by the decline's timestamp, and gives it no wait sample", () => {
    const usage = computeUsage(
      [
        probe(T0 + 1_000, "p1"),
        granted(T0 + 2_000, "p1", "l1", "booted", "gw:g1:a", { fleetRequestId: "f-p1" }),
        released(T0 + 8_000, "l1"),
        probe(T0 + 3_000, "p2"),
        declined(T0 + 3_100, { requestId: "p2" }),
        // A decline of a probe made before the window counts by its own timestamp.
        declined(T0 + 4_000, { requestId: "old-probe" }),
        requested(T0 + 5_000, "local", "agent-b"),
        granted(T0 + 5_500, "local", "l2", "warm", "agent-b"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals).toMatchObject({
      declined: 2,
      granted: 2,
      probes: 2,
      rejected: { total: 0 },
      requests: 1,
    });
    expect(usage.totals.bySource).toEqual({ booted: 1, provisioned: 0, warm: 1 });
    expect(usage.totals.bySource).not.toHaveProperty("unknown");
    expect(usage.totals.wait).toEqual({ count: 1, max: 500, p50: 500, p95: 500 });
    expect(usage.totals.held).toMatchObject({ count: 1, p50: 6_000 });
    expect(usage.workers[0]).toMatchObject({ declined: 2, probes: 2, requests: 1 });
    expect(usage.platforms.ios).toMatchObject({ declined: 2, probes: 2 });
  });

  it("on a worker gives a probe no turnaround sample and lists its gw: requester with its grant and held time and no request", () => {
    const usage = computeUsage(
      [
        probe(T0 + 1_000, "p1"),
        granted(T0 + 2_000, "p1", "l1", "warm", "gw:g1:a", { fleetRequestId: "f-p1" }),
        released(T0 + 8_000, "l1"),
        // A probe that was declined is nothing of its requester's.
        probe(T0 + 9_000, "p2", "gw:g1:b"),
        declined(T0 + 9_100, { requestId: "p2" }),
        requested(T0 + 10_000, "local", "agent-b"),
        granted(T0 + 10_400, "local", "l2", "warm", "agent-b"),
        released(T0 + 12_400, "l2"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.turnaround).toEqual({ count: 1, max: 2_400, p50: 2_400, p95: 2_400 });
    expect(usage.requesters).toEqual([
      { granted: 1, heldTotalMs: 2_000, id: "agent-b", rejected: 0, requests: 1 },
      { granted: 1, heldTotalMs: 6_000, id: "gw:g1:a", rejected: 0, requests: 0 },
    ]);
  });

  it("on a worker counts no rejection for a probe, which a worker declines and never rejects", () => {
    const usage = computeUsage(
      [probe(T0 + 1_000, "p1"), rejected(T0 + 1_500, "p1", "no-wait", "gw:g1:a")],
      WINDOW,
      WORKER,
    );

    expect(usage.totals).toMatchObject({ probes: 1, rejected: { byReason: {}, total: 0 } });
    expect(usage.requesters).toEqual([]);
  });

  it("lists workers by id whichever order the events name them in", () => {
    const usage = computeUsage(
      [
        capacity(T0 + 1_000, figures(0, 0, 2), undefined, { workerId: "w2" }),
        capacity(T0 + 2_000, figures(0, 0, 2), undefined, { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.workers.map((worker) => worker.id)).toEqual(["w1", "w2"]);
  });

  it("on a worker leaves a probe between its lease.requested and its grant out of series[].waiting", () => {
    const usage = computeUsage(
      [
        // A probe made before the window and still open at its start is not waiting either.
        probe(T0 - 30_000, "old"),
        probe(T0 + 10_000, "p1"),
        granted(T0 + 100_000, "p1", "l1", "warm", "gw:g1:a", { fleetRequestId: "f-p1" }),
        requested(T0 + 20_000, "local", "agent-b"),
        granted(T0 + 130_000, "local", "l2", "warm", "agent-b"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.series.slice(0, 3).map((point) => point.waiting)).toEqual([1, 1, 0]);
  });

  it("sets partial and coversFrom when the oldest event is inside the window", () => {
    const partial = computeUsage(
      [requested(T0 + 5 * MINUTE, "r1"), requested(T0 + 9 * MINUTE, "r2", "b")],
      WINDOW,
      WORKER,
    );
    const whole = computeUsage(
      [capacity(T0 - 1_000, figures(0, 0, 2)), requested(T0 + 5 * MINUTE, "r1")],
      WINDOW,
      WORKER,
    );
    const stated = computeUsage([requested(T0 + 5 * MINUTE, "r1")], WINDOW, {
      ...WORKER,
      oldestTs: T0 - DAY,
    });
    const empty = computeUsage([], WINDOW, WORKER);

    expect(partial).toMatchObject({ coversFrom: T0 + 5 * MINUTE, partial: true });
    expect(whole).toMatchObject({ coversFrom: T0, partial: false });
    expect(stated).toMatchObject({ coversFrom: T0, partial: false });
    expect(empty).toMatchObject({ coversFrom: T0, partial: false });
  });

  it("picks 1-minute buckets for one hour, 15-minute buckets for one day and 1-hour buckets for seven days, and never more than 200 points for a 90-day window", () => {
    expect(seriesBucketMs(HOUR)).toBe(MINUTE);
    expect(seriesBucketMs(DAY)).toBe(15 * MINUTE);
    expect(seriesBucketMs(7 * DAY)).toBe(HOUR);

    const ninety = computeUsage([], { from: T0, to: T0 + 90 * DAY }, WORKER);
    expect(ninety.bucketMs).toBe(DAY);
    expect(ninety.series).toHaveLength(90);
    // The edges: 200 minutes is the last window one minute serves, 201 moves to five.
    expect(seriesBucketMs(200 * MINUTE)).toBe(MINUTE);
    expect(seriesBucketMs(200 * MINUTE + 1)).toBe(5 * MINUTE);
    expect(seriesBucketMs(1_000 * MINUTE)).toBe(5 * MINUTE);
    expect(seriesBucketMs(1_000 * MINUTE + 1)).toBe(15 * MINUTE);
    expect(seriesBucketMs(3_000 * MINUTE)).toBe(15 * MINUTE);
    expect(seriesBucketMs(3_000 * MINUTE + 1)).toBe(HOUR);
    expect(seriesBucketMs(200 * HOUR)).toBe(HOUR);
    expect(seriesBucketMs(200 * HOUR + 1)).toBe(6 * HOUR);
    expect(seriesBucketMs(1_200 * HOUR)).toBe(6 * HOUR);
    expect(seriesBucketMs(1_200 * HOUR + 1)).toBe(DAY);
  });

  it("lists requesters by request count with the label the caller supplied", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1", "tok_b"),
        granted(T0 + 2_000, "r1", "l1", "warm", "tok_b"),
        released(T0 + 7_000, "l1"),
        requested(T0 + 3_000, "r2", "tok_a"),
        requested(T0 + 4_000, "r3", "tok_a"),
        rejected(T0 + 5_000, "r3", "timeout", "tok_a"),
        requested(T0 + 6_000, "r4", "tok_a"),
      ],
      WINDOW,
      { ...WORKER, labels: { tok_b: "ci-bot" } },
    );

    expect(usage.requesters).toStrictEqual([
      { granted: 0, heldTotalMs: 0, id: "tok_a", rejected: 1, requests: 3 },
      { granted: 1, heldTotalMs: 5_000, id: "tok_b", label: "ci-bot", rejected: 0, requests: 1 },
    ]);
  });

  it("gives a worker one entry for itself, named by the workerId it is given", () => {
    const usage = computeUsage(
      [requested(T0 + 1_000, "r1"), granted(T0 + 2_000, "r1", "l1")],
      WINDOW,
      { fleet: false, workers: [{ id: "wrk_me", label: "my-mac" }] },
    );

    expect(usage.workers).toHaveLength(1);
    expect(usage.workers[0]).toMatchObject({
      granted: 1,
      id: "wrk_me",
      label: "my-mac",
      requests: 1,
    });
  });

  it("counts every `*-failed` event in the window by its event name under failures.byEvent, by the event's timestamp", () => {
    const usage = computeUsage(
      [
        at(T0 + 1_000, "device.purge-failed", {
          attemptedStrategy: "erase",
          deviceId: "d1",
          duration: 1,
          error: "x",
          leaseId: "l",
        }),
        at(T0 + 2_000, "device.purge-failed", {
          attemptedStrategy: "erase",
          deviceId: "d2",
          duration: 1,
          error: "x",
          leaseId: "l",
        }),
        at(T0 + 3_000, "component.install-failed", {
          componentId: "26.4",
          durationMs: 1,
          error: "x",
          platform: "ios",
        }),
        at(T0 + 4_000, "device.recovery-failed", { deviceId: "d3", leaseId: "l" }),
        at(T0 + 5_000, "device.some-new-failed" as EventName, { deviceId: "d3" }),
        at(WINDOW.from - 1, "device.purge-failed", { deviceId: "d9" }),
        at(WINDOW.to + 1, "device.purge-failed", { deviceId: "d9" }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.failures.byEvent).toEqual({
      "component.install-failed": 1,
      "device.purge-failed": 2,
      "device.recovery-failed": 1,
      "device.some-new-failed": 1,
    });
    expect(usage.totals.incidents.lost).toBe(1);
  });

  it("sorts events supplied out of order and leaves the caller's array exactly as it was", () => {
    const events = [
      released(T0 + 13_000, "l1"),
      granted(T0 + 3_000, "r1", "l1"),
      requested(T0 + 1_000, "r1"),
    ];
    const before = events.map((event) => event.id);

    const usage = computeUsage(events, WINDOW, WORKER);

    expect(events.map((event) => event.id)).toEqual(before);
    expect(usage.totals.wait).toEqual({ count: 1, max: 2_000, p50: 2_000, p95: 2_000 });
    expect(usage.totals.held).toEqual({ count: 1, max: 10_000, p50: 10_000, p95: 10_000 });
    // The oldest event is the earliest one by time, not the first one given.
    expect(usage.coversFrom).toBe(T0 + 1_000);
  });

  it("names the one worker `local` when it is given no workers", () => {
    const usage = computeUsage([capacity(T0 + MINUTE, figures(1, 0, 2))], WINDOW, {
      fleet: false,
    });

    expect(usage.workers.map((worker) => worker.id)).toEqual(["local"]);
  });

  it("counts a grant whose source is none of warm, booted and provisioned under no source", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1"),
        granted(T0 + 2_000, "r1", "l1", "teleported"),
        requested(T0 + 3_000, "r2"),
        granted(T0 + 4_000, "r2", "l2", "warm"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.granted).toBe(2);
    expect(usage.totals.bySource).toEqual({ booted: 0, provisioned: 0, warm: 1 });
  });

  it("keeps durations and incidents out of failures.byEvent when device events of every kind are present", () => {
    const usage = computeUsage(
      [
        at(T0 + 1_000, "device.provisioned", {
          deviceId: "d1",
          driver: "fake",
          duration: 90_000,
          spec: { platform: "ios" },
        }),
        at(T0 + 2_000, "device.ready", { bootDuration: 20_000, deviceId: "d1" }),
        at(T0 + 3_000, "device.quarantined", { deviceId: "d1", reason: "x" }),
        at(T0 + 4_000, "device.purge-failed", {
          attemptedStrategy: "erase",
          deviceId: "d1",
          duration: 1,
          error: "x",
          leaseId: "l",
        }),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.failures.byEvent).toEqual({ "device.purge-failed": 1 });
    expect(usage.totals.incidents.quarantined).toBe(1);
    expect(usage.totals.boot.count).toBe(1);
    expect(usage.totals.provisioning.count).toBe(1);
  });

  it("gives each worker only its own capacity steps and each platform only its own entry in them", () => {
    const usage = computeUsage(
      [
        capacity(T0 - 1_000, figures(1, 0, 2), undefined, {
          android: figures(0, 0, 1),
          ios: figures(1, 0, 2),
          workerId: "w1",
        }),
        capacity(T0 - 1_000, figures(3, 0, 6), undefined, {
          android: figures(3, 0, 5),
          ios: figures(0, 0, 1),
          workerId: "w2",
        }),
      ],
      WINDOW,
      FLEET,
    );
    const byId = Object.fromEntries(usage.workers.map((worker) => [worker.id, worker]));

    expect(byId.w1?.utilisation.slots).toEqual({ max: 2, mean: 1, peak: 1 });
    expect(byId.w2?.utilisation.slots).toEqual({ max: 6, mean: 3, peak: 3 });
    expect(usage.totals.utilisation.slots).toEqual({ max: 8, mean: 4, peak: 4 });
    expect(usage.platforms.ios.utilisation.slots).toEqual({ max: 3, mean: 1, peak: 1 });
    expect(usage.platforms.android.utilisation.slots).toEqual({ max: 6, mean: 3, peak: 3 });
  });

  it("reports slots.max as the highest total across the window, from stretches that last, and null when no step is known", () => {
    const usage = computeUsage(
      [
        capacity(T0 + 10 * MINUTE, figures(0, 0, 2)),
        capacity(T0 + 20 * MINUTE, figures(0, 0, 9)),
        // Two steps at one instant: the 9 holds for no time at all.
        capacity(T0 + 30 * MINUTE, figures(0, 0, 4)),
        capacity(T0 + 30 * MINUTE, figures(0, 0, 4)),
        capacity(T0 + 30 * MINUTE, figures(0, 0, 3)),
      ],
      { from: T0, to: T0 + 40 * MINUTE },
      WORKER,
    );
    const none = computeUsage([], WINDOW, WORKER);

    expect(usage.totals.utilisation.slots.max).toBe(9);
    expect(none.totals.utilisation.slots).toEqual({ max: null, mean: null, peak: null });
  });

  it("does not let a zero-length stretch between two steps at one instant set slots.max", () => {
    const usage = computeUsage(
      [
        capacity(T0 - 1_000, figures(0, 0, 2)),
        capacity(T0 + 10 * MINUTE, figures(0, 0, 50)),
        capacity(T0 + 10 * MINUTE, figures(0, 0, 3)),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.utilisation.slots.max).toBe(3);
  });

  it("orders requesters by requests descending, then by id ascending whichever order they arrive in", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "r1", "b"),
        requested(T0 + 2_000, "r2", "a"),
        requested(T0 + 3_000, "r3", "c"),
        requested(T0 + 4_000, "r4", "c"),
        requested(T0 + 5_000, "r5", "d"),
        requested(T0 + 6_000, "r6", "d"),
        requested(T0 + 7_000, "r7", "e"),
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.requesters.map((entry) => [entry.id, entry.requests])).toEqual([
      ["c", 2],
      ["d", 2],
      ["a", 1],
      ["b", 1],
      ["e", 1],
    ]);
  });

  it("counts a rejection refused before admission under rejected for its requester and not under requests", () => {
    const usage = computeUsage(
      [
        rejected(T0 + 1_000, "r1", "already-leased", "gw-tok"),
        requested(T0 + 2_000, "r2", "gw-tok"),
      ],
      WINDOW,
      { ...WORKER, labels: { "gw-tok": "ci" } },
    );

    expect(usage.requesters).toEqual([
      { granted: 0, heldTotalMs: 0, id: "gw-tok", label: "ci", rejected: 1, requests: 1 },
    ]);
    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.rejected).toEqual({ byReason: { "already-leased": 1 }, total: 1 });
  });

  it("carries queue depth on a worker's own row and none on a gateway's worker rows", () => {
    const events = [
      queueChanged(T0 - 1_000, 2),
      capacity(T0 - 1_000, figures(0, 0, 2), undefined, { workerId: "w1" }),
    ];

    const worker = computeUsage(events, WINDOW, WORKER);
    const fleet = computeUsage(events, WINDOW, { ...FLEET, workers: [{ id: "w1" }] });

    expect(worker.workers[0]?.queue).toEqual({ meanDepth: 2, peakDepth: 2 });
    expect(fleet.workers[0]?.queue).toEqual({ meanDepth: null, peakDepth: null });
  });

  it("counts a request made before the window and still waiting at its start in the series' waiting, though in no total", () => {
    const usage = computeUsage(
      [
        requested(T0 - 30_000, "old", "agent-a"),
        // Answered before the window opened (the history says so): not waiting at its start.
        requested(T0 - 40_000, "done", "agent-b"),
        queueChanged(T0 - 30_000, 1),
        granted(T0 + 90_000, "old", "l1"),
      ],
      WINDOW,
      { ...WORKER, answeredBefore: new Set(["done"]) },
    );

    expect(usage.series.slice(0, 3).map((point) => point.waiting)).toEqual([1, 0, 0]);
    expect(usage.series[0]?.queueDepth).toBe(1);
    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.granted).toBe(0);
  });

  it("with fleet: true counts a request made before the window until the gateway's request.granted for it", () => {
    const usage = computeUsage(
      [
        requested(T0 - 30_000, "gw-old", "agent-a"),
        // A relayed grant for the same requester is not the gateway's answer.
        granted(T0 + 30_000, "w-0", "l0", "warm", "gw:g1:agent-a", { workerId: "w1" }),
        handed(T0 + 90_000, "gw-old", "w1", "l1"),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.series.slice(0, 3).map((point) => point.waiting)).toEqual([1, 0, 0]);
    expect(usage.totals.granted).toBe(0);
  });

  it("with fleet: true counts a request made before the window as waiting at its start unless the history says it was answered by then", () => {
    const events = [
      requested(T0 - 30_000, "gw-waits", "agent-a"),
      requested(T0 - 20_000, "gw-done", "agent-b"),
    ];

    const usage = computeUsage(events, WINDOW, { ...FLEET, answeredBefore: new Set(["gw-done"]) });

    expect(usage.series[0]?.waiting).toBe(1);
  });

  it("with fleet: true stops counting a request the gateway lost at a stop as waiting from the start that followed it, whether before the window or inside it", () => {
    const before = computeUsage(
      [requested(T0 - 60_000, "gw-lost"), restarted(T0 - 30_000)],
      WINDOW,
      FLEET,
    );
    const inside = computeUsage(
      [requested(T0 - 60_000, "gw-lost"), restarted(T0 + 90_000)],
      WINDOW,
      FLEET,
    );

    expect(before.series.slice(0, 3).map((point) => point.waiting)).toEqual([0, 0, 0]);
    expect(inside.series.slice(0, 3).map((point) => point.waiting)).toEqual([1, 0, 0]);
    expect(inside.totals.rejected.total).toBe(0);
  });

  it("counts a request as waiting from the instant it is made until the instant it settles, per series point", () => {
    const usage = computeUsage(
      [
        // Refused before admission: no request, so it never waits.
        rejected(T0 + 10_000, "x", "killed", "z"),
        // Made first of all, settled last.
        requested(T0 + 20_000, "c", "c"),
        // Made, never settled.
        requested(T0 + 30_000, "open", "o"),
        // Made on a bucket end, settled on a bucket end.
        requested(T0 + MINUTE, "a", "a"),
        granted(T0 + 2 * MINUTE, "a", "la", "warm", "a"),
        // Made after a, settled before it.
        requested(T0 + 70_000, "b", "b"),
        granted(T0 + 100_000, "b", "lb", "warm", "b"),
        rejected(T0 + 5 * MINUTE + 30_000, "c", "timeout", "c"),
      ],
      WINDOW,
      WORKER,
    );
    const waiting = usage.series.slice(0, 7).map((point) => point.waiting);

    // Ends at 1m, 2m, ... 7m: c, open and a (made at exactly 1m) wait at 1m; b is made, and b and
    // a settle (a at exactly 2m), by 2m; c settles at 5m30s.
    expect(waiting).toEqual([3, 2, 2, 2, 2, 1, 1]);
    expect(usage.series.at(-1)?.waiting).toBe(1);
  });
});
