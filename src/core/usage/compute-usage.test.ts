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
const FLEET: UsageOptions = { fleet: true, requesterPrefix: "gw:g1:" };

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
        at(T0 + 1_500, "request.dispatched", {
          model: "m",
          platform: "ios",
          queuedMs: 0,
          reason: "warm-hit",
          requestId: "r1",
          requesterId: "a",
          stage: "s",
          workerId: "w1",
        }),
        granted(T0 + 2_000, "w1-r", "l1", "warm", "gw:g1:a", { workerId: "w1" }),
        requested(T0 + 3_000, "r2", "b", "android"),
        at(T0 + 3_500, "request.dispatched", {
          model: "m",
          platform: "android",
          queuedMs: 0,
          reason: "free-capacity",
          requestId: "r2",
          requesterId: "b",
          stage: "s",
          workerId: "w2",
        }),
        granted(T0 + 4_000, "w2-r", "l2", "provisioned", "gw:g1:b", { workerId: "w2" }),
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
    expect(usage.workers[0]?.provisioning.count).toBe(0);
    expect(usage.totals.granted).toBe(2);
  });

  it("with fleet: true counts a fleet request once, from the gateway's own events, and attributes its grant to the worker named by request.dispatched", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        at(T0 + 1_100, "request.dispatched", {
          model: "m",
          platform: "ios",
          queuedMs: 100,
          reason: "warm-hit",
          requestId: "gw-r1",
          requesterId: "agent-a",
          stage: "s",
          workerId: "w1",
        }),
        // The worker's own copy of the same request.
        at(T0 + 1_300, "lease.requested", {
          requestId: "w-r1",
          requestSpec: { platform: "ios" },
          requester: "gw:g1:agent-a",
          waitPolicy: "noWait",
          workerId: "w1",
        }),
        granted(T0 + 4_000, "w-r1", "l1", "booted", "gw:g1:agent-a", { workerId: "w1" }),
        released(T0 + 9_000, "l1", { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.bySource.booted).toBe(1);
    expect(usage.totals.wait.p50).toBe(3_000);
    expect(usage.totals.held.p50).toBe(5_000);
    expect(usage.workers).toHaveLength(1);
    expect(usage.workers[0]).toMatchObject({ granted: 1, id: "w1", requests: 1 });
  });

  it("with fleet: true ignores relayed lease.requested, lease.queued and queue.changed, and a relayed lease.rejected that matches no dispatched request", () => {
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
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: {}, total: 0 });
    expect(usage.totals.queue.peakDepth).toBe(1);
  });

  it("with fleet: true settles a dispatched request as rejected, with the worker's reason, from the relayed lease.rejected of the worker it was dispatched to", () => {
    const dispatched = (workerId: string) =>
      at(T0 + 2_000, "request.dispatched", {
        model: "m",
        platform: "ios",
        queuedMs: 0,
        reason: "free-capacity",
        requestId: "gw-r1",
        requesterId: "agent-a",
        stage: "s",
        workerId,
      });
    const base = [requested(T0 + 1_000, "gw-r1")];

    const usage = computeUsage(
      [
        ...base,
        dispatched("w1"),
        // Another worker's rejection for the same requester is not this request's outcome.
        rejected(T0 + 2_500, "w2-r", "no-wait", "gw:g1:agent-a", { workerId: "w2" }),
        rejected(T0 + 3_000, "w1-r", "boot-timeout", "gw:g1:agent-a", { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.granted).toBe(0);
    expect(usage.totals.rejected).toEqual({ byReason: { "boot-timeout": 1 }, total: 1 });
    expect(usage.workers[0]).toMatchObject({ id: "w1", rejected: { total: 1 } });
    expect(usage.workers).toHaveLength(1);
  });

  it("with fleet: true does not join a requester's second dispatch's grant to its first request, which stays open", () => {
    const dispatched = (ts: number, requestId: string) =>
      at(ts, "request.dispatched", {
        model: "m",
        platform: "ios",
        queuedMs: 0,
        reason: "free-capacity",
        requestId,
        requesterId: "agent-a",
        stage: "s",
        workerId: "w1",
      });

    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        dispatched(T0 + 1_100, "gw-r1"),
        requested(T0 + 10_000, "gw-r2"),
        dispatched(T0 + 10_100, "gw-r2"),
        granted(T0 + 12_000, "w-r2", "l2", "warm", "gw:g1:agent-a", { workerId: "w1" }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.requests).toBe(2);
    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.wait).toEqual({ count: 1, max: 2_000, p50: 2_000, p95: 2_000 });
  });

  it("with fleet: true joins a grant the worker emitted before the gateway announced the dispatch", () => {
    const usage = computeUsage(
      [
        requested(T0 + 1_000, "gw-r1"),
        // A warm grant reaches the gateway ahead of the response that announces the dispatch.
        granted(T0 + 1_400, "w-r1", "l1", "warm", "gw:g1:agent-a", { workerId: "w1" }),
        at(T0 + 1_500, "request.dispatched", {
          model: "m",
          platform: "ios",
          queuedMs: 0,
          reason: "warm-hit",
          requestId: "gw-r1",
          requesterId: "agent-a",
          stage: "s",
          workerId: "w1",
        }),
      ],
      WINDOW,
      FLEET,
    );

    expect(usage.totals.granted).toBe(1);
    expect(usage.totals.wait.p50).toBe(400);
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

    expect(usage.requesters).toEqual([
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

  it("counts failures that carry no reason of their own by event name under errors.byCode", () => {
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
      ],
      WINDOW,
      WORKER,
    );

    expect(usage.totals.errors.byCode).toEqual({
      "component.install-failed": 1,
      "device.purge-failed": 2,
    });
  });
});
