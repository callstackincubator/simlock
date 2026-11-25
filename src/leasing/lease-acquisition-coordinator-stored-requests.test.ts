import { describe, expect, it } from "vitest";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { IdempotencyConflictError, LeaseRequestForbiddenError } from "./lease-request-book.js";
import { request, createHarness, flush } from "./test-lease-acquisition.js";
import { inspectCommits } from "./test-lease-acquisition-commits.js";

// why: drives the coordinator on its own, so a test can interleave its lifecycle, queue and clock in orders the leasing surface cannot force.
describe("LeaseAcquisitionCoordinator stored requests", () => {
  const keyed = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" } as const;

  async function holdTheOnlyDevice(harness: Awaited<ReturnType<typeof createHarness>>) {
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    return async () => {
      await harness.registry.beginRelease(held.lease.id);
      await harness.registry.transitionDevice(held.device.id, "ready", {
        event: "device.reclaimed",
        payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
      });
      harness.coordinator.kick();
      await flush();
    };
  }

  it("returns the first result to a repeated request under the same key and grants no second lease", async () => {
    const harness = await createHarness();
    const first = await harness.coordinator.request(request, keyed);

    const second = await harness.coordinator.request(request, keyed);

    expect(second.lease.id).toBe(first.lease.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it("attaches a repeat of an open request to the existing wait instead of starting a second one", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    const first = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const repeat = harness.coordinator.request(request, keyed);
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(
      harness.registry.leaseRequests().filter((record) => record.requesterId === "agent"),
    ).toHaveLength(1);

    await free();
    const [granted, repeated] = await Promise.all([first, repeat]);
    expect(repeated.lease.id).toBe(granted.lease.id);
  });

  it("tells a repeat joining an open wait where that wait stands now", async () => {
    const harness = await createHarness();
    await holdTheOnlyDevice(harness);
    void harness.coordinator.request(request, keyed).catch(() => undefined);
    await flush();

    const heard: unknown[] = [];
    void harness.coordinator
      .request(request, { ...keyed, onProgress: (progress) => heard.push(progress) })
      .catch(() => undefined);
    await flush();

    expect(heard).toEqual([{ queuePosition: 1, stage: "queued" }]);
  });

  it("stores a request before the wait queue sees it", async () => {
    const harness = await createHarness();
    const order: string[] = [];
    inspectCommits(harness, ({ requestRequesters }) => {
      if (requestRequesters.includes("agent") && !order.includes("stored")) order.push("stored");
    });
    const create = harness.queue.create.bind(harness.queue);
    harness.queue.create = (...args) => {
      order.push("queued");
      return create(...args);
    };

    await harness.coordinator.request(request, keyed);

    expect(order.slice(0, 2)).toEqual(["stored", "queued"]);
  });

  it("keeps a capacity failure terminal under the same key after capacity frees up", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", name: "ReplayedLeaseRequestError" });
    expect(harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("starts a fresh request for a new key once the prior one is terminal", async () => {
    const harness = await createHarness();
    const free = await holdTheOnlyDevice(harness);
    await expect(
      harness.coordinator.request(request, { ...keyed, noWait: true }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    await free();

    const granted = await harness.coordinator.request(request, {
      ...keyed,
      idempotencyKey: "key-2",
    });

    expect(granted.lease.requesterId).toBe("agent");
    // why: The grant and its stored result land in one commit; the flush lets the wait settle.
    await flush();
    expect(harness.registry.leaseRequests().map((record) => record.state)).toEqual([
      "granted",
      "failed",
      "granted",
    ]);
  });

  it("refuses the same key naming a different device as an idempotency conflict", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request({ ...request, model: "iPhone 17" }, keyed),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("refuses a repeat sent by a different principal", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, keyed);

    await expect(
      harness.coordinator.request(request, { ...keyed, ownerId: "someone-else" }),
    ).rejects.toBeInstanceOf(LeaseRequestForbiddenError);
  });

  it("stores one record for two concurrent requests under one key", async () => {
    const harness = await createHarness();

    const [first, second] = await Promise.all([
      harness.coordinator.request(request, keyed),
      harness.coordinator.request(request, keyed),
    ]);

    expect(harness.registry.leaseRequests()).toHaveLength(1);
    expect(second.lease.id).toBe(first.lease.id);
  });

  it("stores a request that carries no idempotency key, and names it on lease.requested", async () => {
    const harness = await createHarness();

    await harness.coordinator.request(request, { ownerId: "agent", requesterId: "agent" });
    await flush();

    expect(harness.registry.leaseRequests()).toMatchObject([
      { requesterId: "agent", state: "granted" },
    ]);
    const [stored] = harness.registry.leaseRequests();
    expect(
      harness.bus
        .replay()
        .filter((event) => event.event === "lease.requested")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId: stored?.id, requester: "agent" }]);
    expect(harness.registry.leaseRequests()[0]).not.toHaveProperty("idempotencyKey");
  });
});
