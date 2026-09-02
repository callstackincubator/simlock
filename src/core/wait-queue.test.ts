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
  return queue.create(request satisfies DeviceRequest, { mode: "held", requesterId, ...options });
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

  it("attaches and detaches queued progress without changing the request outcome", () => {
    const received: LeaseProgress[] = [];
    const reattached: LeaseProgress[] = [];
    const { queue } = createQueue();
    const waiter = queue.create(request, {
      mode: "held",
      onProgress: (progress) => received.push(progress),
      requesterId: "agent",
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
