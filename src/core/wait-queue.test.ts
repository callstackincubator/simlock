import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "../ports/index.js";
import type { DeviceRequest } from "./driver.js";
import {
  ForeignWaiterError,
  QueueTimeoutError,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  WaitQueue,
  type LeaseGrant,
  type LeaseProgress,
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
    expect(() => other.attachProgress(waiter, () => undefined)).toThrow(ForeignWaiterError);
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

  it("tracks pending requesters and rejects duplicate requesters", async () => {
    const { queue } = createQueue();
    const waiter = createWaiter(queue, "agent");

    expect(queue.hasPendingRequester("agent")).toBe(true);
    expect(() => createWaiter(queue, "agent")).toThrow(RequesterAlreadyLeasedError);
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

  it("re-arms only the time actually remaining on a re-enqueue before the deadline, so the total wait never exceeds the original timeoutMs", async () => {
    const { clock, queue } = createQueue();
    const waiter = createWaiter(queue, "agent", { timeoutMs: 100 });

    queue.enqueue(waiter);
    clock.advance(30);
    queue.markProcessing(waiter);
    clock.advance(20); // t=50: still well before the t=100 deadline
    expect(queue.enqueue(waiter)).toBe(true); // re-queued, e.g. a stale-view NO_CAPACITY
    expect(waiter.state).toBe("queued");

    // If this cycle had re-armed a fresh 100ms window, the waiter would still be pending here
    // (t=50 + 49ms = 99ms of its own window, or 149ms of total elapsed time either way). It
    // does not: the original deadline was t=100, and only 50ms of elapsed time remain from it.
    clock.advance(49);
    expect(waiter.state).toBe("queued");
    clock.advance(1); // t=100: the original deadline, reached exactly once, not once per cycle
    await expect(waiter.promise).rejects.toEqual(expect.any(QueueTimeoutError));
    expect(queue.depth).toBe(0);
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

  it("attaches and detaches queued progress without changing the request outcome", () => {
    const received: LeaseProgress[] = [];
    const reattached: LeaseProgress[] = [];
    const { queue } = createQueue();
    const waiter = queue.create(request, {
      onProgress: (progress) => received.push(progress),
      requesterId: "agent",
      ownerId: "agent",
    });

    queue.enqueue(waiter);
    expect(queue.detachProgress("agent")).toBe(true);
    queue.notifyProgress(waiter, { etaMs: 20, stage: "booting" });
    expect(queue.attachProgress(waiter, (progress) => reattached.push(progress))).toBe(true);
    queue.notifyProgress(waiter, { etaMs: 20, stage: "booting" });

    expect(received).toEqual([{ queuePosition: 1, stage: "queued" }]);
    expect(reattached).toEqual([{ etaMs: 20, stage: "booting" }]);
    expect(queue.resolve(waiter, grant())).toBe(true);
    expect(waiter.state).toBe("granted");
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
