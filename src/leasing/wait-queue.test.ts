import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "../ports/index.js";
import { type DeviceRequest, type LeaseGrant, type LeaseProgress } from "../core/index.js";
import {
  ForeignWaiterError,
  QueueTimeoutError,
  RequestCancelledError,
  WaitQueue,
} from "./wait-queue.js";

const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function createQueue(onTimeout?: (waiter: import("./wait-queue.js").Waiter) => void) {
  const clock = new FakeClock(1_000);
  let nextId = 1;
  const queue = new WaitQueue({
    clock,
    idGenerator: { generate: () => `${nextId++}` },
    ...(onTimeout === undefined ? {} : { onTimeout }),
  });
  return { clock, queue };
}

function grant(): LeaseGrant {
  return {
    device: {} as LeaseGrant["device"],
    environment: {},
    lease: {} as LeaseGrant["lease"],
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReclaimMs: 0,
      estimatedReadyMs: 0,
    },
  };
}

function createWaiter(queue: WaitQueue, requesterId: string, options: { timeoutMs?: number } = {}) {
  return queue.create(request satisfies DeviceRequest, {
    ownerId: requesterId,
    requesterId,
    ...options,
  });
}

describe("WaitQueue", () => {
  it("refuses foreign waiters without disturbing their owning queue", async () => {
    const { queue: owner } = createQueue();
    const { queue: other } = createQueue();
    const waiter = createWaiter(owner, "owner");
    owner.enqueue(waiter);

    expect(() => other.enqueue(waiter)).toThrow(ForeignWaiterError);
    expect(() => other.markProcessing(waiter)).toThrow(ForeignWaiterError);
    expect(() => other.markNew(waiter)).toThrow(ForeignWaiterError);
    expect(() => other.isQueued(waiter)).toThrow(ForeignWaiterError);
    expect(() => other.notifyProgress(waiter, { etaMs: 10, stage: "booting" })).toThrow(
      ForeignWaiterError,
    );
    expect(() => other.resolve(waiter, grant())).toThrow(ForeignWaiterError);
    expect(() => other.reject(waiter, new Error("foreign"))).toThrow(ForeignWaiterError);

    expect(owner.depth).toBe(1);
    expect(owner.head).toBe(waiter);
    expect(owner.resolve(waiter, grant())).toBe(true);
    await expect(waiter.promise).resolves.toEqual(grant());
  });

  it("maintains FIFO order while processing entries leave the queue", () => {
    const { queue } = createQueue();
    const first = createWaiter(queue, "first");
    const second = createWaiter(queue, "second");
    const third = createWaiter(queue, "third");

    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);
    queue.markProcessing(first);

    expect(queue.head?.id).toBe(first.id);
    expect(queue.depth).toBe(3);
    expect(queue.resolve(first, grant())).toBe(true);
    expect(queue.head?.id).toBe(second.id);
    expect(queue.depth).toBe(2);
    expect(third.state).toBe("queued");
  });

  it("places a queued waiter by its index in the queue, counting the waiters ahead that are already being worked on", async () => {
    const { queue } = createQueue();
    const starting = createWaiter(queue, "starting");
    const second = createWaiter(queue, "second");
    const third = createWaiter(queue, "third");
    const unqueued = createWaiter(queue, "unqueued");
    for (const waiter of [starting, second, third]) queue.enqueue(waiter);
    queue.markProcessing(starting);
    queue.markProcessing(unqueued);

    expect(queue.places()).toEqual([
      { id: starting.id },
      { id: second.id, queuePosition: 2 },
      { id: third.id, queuePosition: 3 },
      { id: unqueued.id },
    ]);

    // The waiter ahead is granted: the ones behind it move up, and a settled one is gone.
    queue.resolve(starting, grant());
    await starting.promise;
    expect(queue.places()).toEqual([
      { id: second.id, queuePosition: 1 },
      { id: third.id, queuePosition: 2 },
      { id: unqueued.id },
    ]);
  });

  it("tracks a requester as pending until its waiter settles", async () => {
    const { queue } = createQueue();
    const waiter = createWaiter(queue, "agent");

    expect(queue.hasPendingRequester("agent")).toBe(true);
    queue.reject(waiter, new Error("not available"));
    await expect(waiter.promise).rejects.toThrow("not available");
    expect(queue.hasPendingRequester("agent")).toBe(false);
    expect(createWaiter(queue, "agent").id).toBe("req_2");
  });

  it("rejects only queued waiters when their queue timeout elapses", async () => {
    const timedOut = vi.fn();
    const { clock, queue } = createQueue(timedOut);
    const queued = createWaiter(queue, "queued", { timeoutMs: 10 });
    const processing = createWaiter(queue, "processing", { timeoutMs: 10 });
    queue.enqueue(queued);
    queue.markProcessing(processing);

    clock.advance(10);

    await expect(queued.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(queued.state).toBe("rejected");
    expect(processing.state).toBe("processing");
    expect(queue.isQueued(processing)).toBe(false);
    expect(queue.markNew(processing)).toBe(true);
    expect(processing.state).toBe("new");
    expect(queue.depth).toBe(0);
    expect(timedOut).toHaveBeenCalledWith(queued);
  });

  // Pre-existing gap, now routinely triggered by the gateway's own stale-view re-queue (round 2
  // review): a waiter cycling queued -> processing -> queued used to have `timeoutMs` re-armed
  // from zero on every return to `queued`, so the total wait before `QUEUE_TIMEOUT` could exceed
  // the caller's own budget by a multiple. These two tests pin the fixed behaviour: the budget is
  // one fixed deadline from the *first* enqueue, survives any number of cycles, and a re-enqueue
  // past that deadline settles immediately rather than granting another full window.
  it("rejects immediately on a re-enqueue past the original deadline, instead of granting a fresh timeoutMs window", async () => {
    const timedOut = vi.fn();
    const { clock, queue } = createQueue(timedOut);
    const waiter = createWaiter(queue, "agent", { timeoutMs: 100 });

    queue.enqueue(waiter);
    clock.advance(60); // still well inside the original 100ms budget
    queue.markProcessing(waiter);
    // The original timer (armed for the full 100ms at t=0) fires during this advance, at
    // t=100 -- but the waiter is `processing`, not `queued`, so `#armTimeout`'s own timer
    // callback does nothing here. Total elapsed is now 120ms, past the original deadline.
    clock.advance(60);
    expect(waiter.state).toBe("processing");

    // A stale-view (or worker retry) re-queue lands after the deadline already passed.
    expect(queue.enqueue(waiter)).toBe(false);

    await expect(waiter.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(waiter.state).toBe("rejected");
    expect(queue.depth).toBe(0);
    expect(timedOut).toHaveBeenCalledWith(waiter);
  });

  it("rejects QUEUE_TIMEOUT instead of marking processing past the original deadline", async () => {
    const timedOut = vi.fn();
    const { clock, queue } = createQueue(timedOut);
    const waiter = createWaiter(queue, "agent", { timeoutMs: 100 });

    queue.enqueue(waiter);
    clock.advance(60);
    queue.markProcessing(waiter);
    clock.advance(60);

    expect(queue.markProcessing(waiter)).toBe(false);

    await expect(waiter.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(waiter.state).toBe("rejected");
    expect(timedOut).toHaveBeenCalledWith(waiter);
  });

  // H5 (round 3 review): this test used to claim it proved a re-enqueue "re-arms only the time
  // actually remaining" -- but every assertion in it (the waiter's `state` at various clock
  // ticks, and when its promise finally rejects) would come out identical whether `#armTimeout`
  // actually cancelled the original timer and started a fresh one for the recomputed remainder,
  // or simply left that still-live timer alone. Both mechanisms hit the same fixed `deadlineAt`.
  // The `setTimer` spy below is what tells them apart: it asserts directly on the *mechanism* --
  // exactly one timer is ever armed across the whole `queued -> processing -> queued` cycle, not
  // two -- which is what `#armTimeout`'s own doc comment now documents as the only thing that
  // can happen (its `waiter.timer !== undefined` guard makes a genuine recompute-and-re-arm
  // unreachable through this class's public API). The externally observed timing this test also
  // pins is real and worth keeping; it just is not, on its own, evidence of which mechanism
  // produced it.
  it("leaves a still-live timer alone across a queued -> processing -> queued cycle, rather than cancelling and re-arming it, so the total wait never exceeds the original timeoutMs (H5, round 3 review)", async () => {
    const { clock, queue } = createQueue();
    const waiter = createWaiter(queue, "agent", { timeoutMs: 100 });
    const setTimerSpy = vi.spyOn(clock, "setTimer");
    const cancelSpy = vi.spyOn(clock, "cancel");

    queue.enqueue(waiter);
    expect(setTimerSpy).toHaveBeenCalledTimes(1); // the first (and, this test proves, only) arm
    clock.advance(30);
    queue.markProcessing(waiter);
    clock.advance(20); // t=50: still well before the t=100 deadline
    expect(queue.enqueue(waiter)).toBe(true); // re-queued, e.g. a stale-view NO_CAPACITY
    expect(waiter.state).toBe("queued");

    // The proof this test exists for: re-enqueuing well before the deadline armed nothing new
    // and cancelled nothing -- `#armTimeout`'s guard found the original timer still live and
    // returned immediately. A recompute-and-re-arm implementation would have cancelled that
    // timer and called `setTimer` a second time here, for the ~50ms actually remaining.
    expect(setTimerSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).not.toHaveBeenCalled();

    // If this cycle had re-armed a fresh 100ms window, the waiter would still be pending here
    // (t=50 + 49ms = 99ms of its own window, or 149ms of total elapsed time either way). It
    // does not: the original deadline was t=100, and only 50ms of elapsed time remain from it.
    clock.advance(49);
    expect(waiter.state).toBe("queued");
    clock.advance(1); // t=100: the original deadline, reached exactly once, not once per cycle
    await expect(waiter.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(queue.depth).toBe(0);
    // Still just the one timer, start to finish -- the fixed deadline was honoured by leaving it
    // running, not by any second arm.
    expect(setTimerSpy).toHaveBeenCalledTimes(1);
  });

  it("never delivers a progress push to a waiter that already settled, even the very same tick (P3, round 2 review)", async () => {
    // `enqueue` can reject synchronously once a waiter's deadline has already passed (the
    // re-arm-only-remaining-time fix above); a caller that unconditionally pushes progress right
    // after its own `enqueue` call (`LeaseAcquisitionCoordinator#defer` always does, for its
    // reclaim-wait notice) must not be able to deliver that push to a waiter `enqueue` just
    // rejected out from under it.
    const received: LeaseProgress[] = [];
    const { clock, queue } = createQueue();
    const waiter = queue.create(request satisfies DeviceRequest, {
      onProgress: (progress) => received.push(progress),
      ownerId: "agent",
      requesterId: "agent",
      timeoutMs: 100,
    });
    queue.enqueue(waiter);
    queue.markProcessing(waiter);
    clock.advance(150); // past the 100ms deadline while `processing`, same as the test above

    expect(queue.enqueue(waiter)).toBe(false); // rejects synchronously with QueueTimeoutError
    expect(waiter.state).toBe("rejected");
    received.length = 0; // only care about anything delivered *after* settlement

    queue.notifyProgress(waiter, { etaMs: 5_000, stage: "reclaiming" });

    await expect(waiter.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(received).toEqual([]);
  });

  it("settles waiters exactly once and cancels a settled waiter's timeout", async () => {
    const { clock, queue } = createQueue();
    const waiter = createWaiter(queue, "agent", { timeoutMs: 10 });
    const rejected = createWaiter(queue, "rejected");
    queue.enqueue(waiter);
    queue.enqueue(rejected);

    expect(queue.resolve(waiter, grant())).toBe(true);
    expect(queue.reject(waiter, new Error("late rejection"))).toBe(false);
    expect(queue.resolve(waiter, grant())).toBe(false);
    expect(queue.reject(rejected, new Error("first rejection"))).toBe(true);
    expect(queue.reject(rejected, new Error("late rejection"))).toBe(false);
    expect(queue.resolve(rejected, grant())).toBe(false);
    clock.advance(10);

    await expect(waiter.promise).resolves.toEqual(grant());
    await expect(rejected.promise).rejects.toThrow("first rejection");
    expect(waiter.state).toBe("granted");
    expect(rejected.state).toBe("rejected");
  });

  it("finds a pending waiter across queued and not-yet-queued states, for the single-request cancel path", async () => {
    const { queue } = createQueue();
    const queued = createWaiter(queue, "queued");
    const processing = createWaiter(queue, "processing");
    queue.enqueue(queued);
    queue.markProcessing(processing);

    expect(queue.findPendingWaiter("queued")).toBe(queued);
    expect(queue.findPendingWaiter("processing")).toBe(processing);
    expect(queue.findPendingWaiter("nobody")).toBeUndefined();

    expect(queue.reject(queued, new RequestCancelledError(queued.id))).toBe(true);
    await expect(queued.promise).rejects.toBeInstanceOf(RequestCancelledError);
    expect(queue.findPendingWaiter("queued")).toBeUndefined();
  });

  it("lists every waiter not yet granted or rejected, in arrival order", async () => {
    const { queue } = createQueue();
    const first = createWaiter(queue, "first");
    const second = createWaiter(queue, "second");
    const third = createWaiter(queue, "third");
    queue.enqueue(second);
    queue.markProcessing(third);

    expect(queue.pending()).toEqual([first, second, third]);

    queue.resolve(first, grant());
    queue.reject(second, new RequestCancelledError(second.id));
    await expect(second.promise).rejects.toBeInstanceOf(RequestCancelledError);

    expect(queue.pending()).toEqual([third]);
  });

  it("cancels every pending waiter and clears their pending requester state", async () => {
    const { queue } = createQueue();
    const first = createWaiter(queue, "first");
    const second = createWaiter(queue, "second");
    const processing = createWaiter(queue, "processing");
    queue.enqueue(first);
    queue.enqueue(second);
    queue.markProcessing(processing);

    expect(queue.cancelAll((waiter) => new Error(`cancelled ${waiter.id}`))).toEqual([
      first,
      second,
      processing,
    ]);
    expect(queue.depth).toBe(0);
    expect(queue.hasPendingRequester("first")).toBe(false);
    expect(queue.hasPendingRequester("second")).toBe(false);
    expect(queue.hasPendingRequester("processing")).toBe(false);
    await expect(first.promise).rejects.toThrow(`cancelled ${first.id}`);
    await expect(second.promise).rejects.toThrow(`cancelled ${second.id}`);
    await expect(processing.promise).rejects.toThrow(`cancelled ${processing.id}`);
  });
});

describe("WaitQueue depth changes", () => {
  function depthQueue() {
    const clock = new FakeClock(1_000);
    const depths: number[] = [];
    let nextId = 1;
    const queue = new WaitQueue({
      clock,
      idGenerator: { generate: () => `${nextId++}` },
      onDepthChange: (depth) => depths.push(depth),
    });
    return { clock, depths, queue };
  }

  it("reports the new depth when a waiter joins the queue and when it leaves by grant, rejection or timeout", () => {
    const { clock, depths, queue } = depthQueue();
    const granted = queue.create(request, { ownerId: "a", requesterId: "a" });
    const rejected = queue.create(request, { ownerId: "b", requesterId: "b" });
    const timedOut = queue.create(request, { ownerId: "c", requesterId: "c", timeoutMs: 5 });
    void rejected.promise.catch(() => undefined);
    void timedOut.promise.catch(() => undefined);

    queue.enqueue(granted);
    queue.enqueue(rejected);
    queue.enqueue(timedOut);
    queue.resolve(granted, grant());
    queue.reject(rejected, new RequestCancelledError(rejected.id));
    clock.advance(5);

    expect(depths).toEqual([1, 2, 3, 2, 1, 0]);
  });

  it("reports nothing for a waiter that never held a place, or for a repeated enqueue", () => {
    const { depths, queue } = depthQueue();
    const direct = queue.create(request, { ownerId: "a", requesterId: "a" });
    const queued = queue.create(request, { ownerId: "b", requesterId: "b" });
    void direct.promise.catch(() => undefined);

    queue.reject(direct, new RequestCancelledError(direct.id));
    queue.enqueue(queued);
    queue.enqueue(queued);

    expect(depths).toEqual([1]);
  });
});
