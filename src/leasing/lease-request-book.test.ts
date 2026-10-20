import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry, openTestState } from "../core/testing.js";
import type { StateDatabase } from "../state/index.js";
import {
  IdempotencyConflictError,
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
} from "./lease-request-book.js";
import {
  type LeaseRequestLimits,
  type LeaseRequestStore,
  SerializedDecision,
} from "../core/index.js";
import { RequestCancelledError } from "./wait-queue.js";

const request = {
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
} as const;
const failure = { code: "NO_CAPACITY", message: "No device capacity is currently available" };

async function loadRegistry(
  options: {
    readonly clock?: FakeClock;
    readonly state?: StateDatabase;
    readonly limits?: LeaseRequestLimits;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const state = options.state ?? (await openTestState());
  let nextId = 0;
  const registry = await loadTestRegistry({
    clock,
    eventBus: new EventBus(clock),
    idGenerator: { generate: () => `${nextId++}` },
    ...(options.limits === undefined ? {} : { leaseRequestLimits: options.limits }),
    state,
  });
  return { clock, registry, state };
}

async function storedRequestIds(clock: FakeClock, state: StateDatabase): Promise<string[]> {
  const { registry } = await loadRegistry({ clock, state });
  return registry.leaseRequests().map((record) => record.id);
}

function newRequest(requesterId: string) {
  return { ownerId: requesterId, request, requesterId };
}

describe("Registry lease requests", () => {
  it("drops a settled record from reads once the retention window passes, and from the stored state at the next write", async () => {
    const { clock, registry, state } = await loadRegistry({
      limits: { maxRecords: 100, retentionMs: 60_000 },
    });
    const settled = await registry.createLeaseRequest(newRequest("first"));
    await registry.settleLeaseRequest(settled.id, { failure, state: "failed" });

    clock.advance(59_999);
    expect(registry.leaseRequests().map((record) => record.id)).toEqual([settled.id]);

    clock.advance(1);
    expect(registry.leaseRequests()).toEqual([]);
    const next = await registry.createLeaseRequest(newRequest("second"));
    expect(await storedRequestIds(clock, state)).toEqual([next.id]);
  });

  it("keeps an open record past the retention window", async () => {
    const { clock, registry } = await loadRegistry({
      limits: { maxRecords: 100, retentionMs: 60_000 },
    });
    const open = await registry.createLeaseRequest(newRequest("waiting"));

    clock.advance(10 * 60_000);
    await registry.createLeaseRequest(newRequest("other"));

    expect(registry.leaseRequests().map((record) => record.id)).toContain(open.id);
  });

  it("evicts the oldest settled record at the cap, and never an open one", async () => {
    const { clock, registry, state } = await loadRegistry({
      limits: { maxRecords: 3, retentionMs: 60_000 },
    });
    const open = await registry.createLeaseRequest(newRequest("open"));
    const oldestSettled = await registry.createLeaseRequest(newRequest("settled-1"));
    const newerSettled = await registry.createLeaseRequest(newRequest("settled-2"));
    await registry.settleLeaseRequest(oldestSettled.id, { failure, state: "failed" });
    await registry.settleLeaseRequest(newerSettled.id, { failure, state: "failed" });

    const fourth = await registry.createLeaseRequest(newRequest("fourth"));
    expect(await storedRequestIds(clock, state)).toEqual([open.id, newerSettled.id, fourth.id]);

    // Every other record left is open or newer: the cap evicts the last settled one, then
    // admits past the cap rather than touch an open record.
    const fifth = await registry.createLeaseRequest(newRequest("fifth"));
    const sixth = await registry.createLeaseRequest(newRequest("sixth"));
    expect(await storedRequestIds(clock, state)).toEqual([open.id, fourth.id, fifth.id, sixth.id]);
  });

  it("loads a stored class request after a reload, with its class and no model", async () => {
    const { clock, registry, state } = await loadRegistry();
    const created = await registry.createLeaseRequest({
      ownerId: "agent",
      request: { class: "phone", platform: "ios" },
      requesterId: "agent",
    });

    const { registry: reloaded } = await loadRegistry({ clock, state });

    expect(reloaded.leaseRequests().map((record) => [record.id, record.request])).toEqual([
      [created.id, { class: "phone", platform: "ios" }],
    ]);
  });

  it("reads a stored request back after a reload, result included", async () => {
    const { clock, registry, state } = await loadRegistry();
    const created = await registry.createLeaseRequest({
      ...newRequest("agent"),
      idempotencyKey: "key-1",
    });
    await registry.settleLeaseRequest(created.id, { failure, state: "failed" });

    const { registry: reloaded } = await loadRegistry({ clock, state });

    expect(reloaded.leaseRequests()).toEqual([
      {
        createdAt: 1_000,
        failure,
        id: created.id,
        idempotencyKey: "key-1",
        ownerId: "agent",
        request,
        requesterId: "agent",
        settledAt: 1_000,
        state: "failed",
      },
    ]);
  });

  it("settles every open record as failed, leaving settled ones alone", async () => {
    const { registry } = await loadRegistry();
    const open = await registry.createLeaseRequest(newRequest("open"));
    const done = await registry.createLeaseRequest(newRequest("done"));
    await registry.settleLeaseRequest(done.id, { state: "cancelled" });
    const restarted = { code: "INTERNAL", message: "restarted" };

    const settled = await registry.failOpenLeaseRequests(restarted);

    expect(settled.map((record) => record.id)).toEqual([open.id]);
    expect(registry.leaseRequests().map((record) => [record.id, record.state])).toEqual([
      [open.id, "failed"],
      [done.id, "cancelled"],
    ]);
  });
});

type Grant = { readonly lease: { readonly id: string } };

function bookOver(store: LeaseRequestStore<Grant>) {
  return new LeaseRequestBook<Grant>({
    decisions: new SerializedDecision(),
    describeFailure: (error) => ({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }),
    store,
  });
}

function memoryStore(): InMemoryLeaseRequestStore<Grant> {
  let next = 0;
  return new InMemoryLeaseRequestStore({
    clock: new FakeClock(1_000),
    idGenerator: { generate: () => `${next++}` },
    limits: { maxRecords: 100, retentionMs: 60_000 },
  });
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

const keyed = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" } as const;

const granted = (id: string) => ({ promise: Promise.resolve({ lease: { id } }) });

describe("LeaseRequestBook", () => {
  it.each([
    ["a different osVersion", { ...request, osVersion: "18.0" }],
    ["no osVersion where one was named", { model: request.model, platform: request.platform }],
    ["a mode where none was named", { ...request, mode: "full" as const }],
    ["an image tag where none was named", { ...request, imageTag: "google_apis" }],
  ])("refuses a repeat naming %s as an idempotency conflict", async (_label, different) => {
    const book = bookOver(memoryStore());
    await book.admit(request, keyed, () => granted("lse_1"));
    await settled();

    expect(() => book.replay(different, keyed)).toThrow(IdempotencyConflictError);
  });

  it("refuses the same idempotency key sent with and without physical as an idempotency conflict", async () => {
    const withoutPhysical = {
      model: request.model,
      osVersion: request.osVersion,
      platform: "ios",
    } as const;
    const physicalFlag = { physical: true } as const;
    const withPhysical = { ...withoutPhysical, ...physicalFlag };
    const book = bookOver(memoryStore());
    await book.admit(withoutPhysical, keyed, () => granted("lse_1"));
    await settled();

    await expect(book.replay(withoutPhysical, keyed)).resolves.toMatchObject({
      lease: { id: "lse_1" },
    });
    expect(() => book.replay(withPhysical, keyed)).toThrow(IdempotencyConflictError);

    const physicalBook = bookOver(memoryStore());
    await physicalBook.admit(withPhysical, keyed, () => granted("lse_2"));
    await settled();

    expect(() => physicalBook.replay(withoutPhysical, keyed)).toThrow(IdempotencyConflictError);
  });

  it("says an open request holds its leaseId, and a settled or cancelled one, or one that sent none, does not", async () => {
    const book = bookOver(memoryStore());
    let finish: (grant: { lease: { id: string } }) => void = () => undefined;
    await book.admit(request, { ...keyed, leaseId: "waits" }, () => ({
      promise: new Promise((resolve) => {
        finish = resolve;
      }),
    }));
    await book.admit(
      request,
      { idempotencyKey: "key-2", ownerId: "other", requesterId: "other", leaseId: "gone" },
      () => ({ promise: Promise.reject(new RequestCancelledError("req_x")) }),
    );
    await book.admit(request, { ownerId: "third", requesterId: "third" }, () => ({
      promise: new Promise(() => undefined),
    }));
    await settled();

    expect([
      book.holdsLeaseId("waits"),
      book.holdsLeaseId("gone"),
      book.holdsLeaseId("third"),
      book.holdsLeaseId("never-sent"),
    ]).toEqual([true, false, false, false]);

    finish({ lease: { id: "waits" } });
    await settled();
    expect(book.holdsLeaseId("waits")).toBe(false);
  });

  it.each([
    ["leaseId", "myid"],
    ["fleetRequestId", "req_gw1"],
  ])(
    "stores the %s a request sent beside it, and no such key for a request that sent none",
    async (field, value) => {
      const store = memoryStore();
      const book = bookOver(store);
      await book.admit(request, { ownerId: "a", requesterId: "a", [field]: value }, () =>
        granted("lse_1"),
      );
      await book.admit(request, { ownerId: "b", requesterId: "b" }, () => granted("lse_2"));

      const [withId, without] = store.leaseRequests();
      expect(withId).toMatchObject({ [field]: value, request });
      expect(without).not.toHaveProperty(field);
    },
  );

  it("names the lease ID in the message of an idempotency conflict over it", async () => {
    const book = bookOver(memoryStore());
    await book.admit(request, { ...keyed, leaseId: "myid" }, () => granted("myid"));
    await settled();

    expect(() => book.replay(request, keyed)).toThrow(/different device request or lease ID/);
  });

  it.each([
    ["Registry", async () => (await loadRegistry()).registry],
    ["InMemoryLeaseRequestStore", async () => memoryStore()],
  ])(
    "%s writes a result onto an open record once, leaving a settled record as it is and settling nothing for an unknown id",
    async (_name, open) => {
      const store: LeaseRequestStore<Grant> = await open();
      const created = await store.createLeaseRequest(newRequest("agent"));
      const waiting = await store.createLeaseRequest(newRequest("waiting"));
      await store.settleLeaseRequest(created.id, { failure, state: "failed" });

      const again = await store.settleLeaseRequest(created.id, { state: "cancelled" });
      const unknown = await store.settleLeaseRequest("req_missing", { state: "cancelled" });

      expect([again, unknown]).toEqual([undefined, undefined]);
      expect(store.leaseRequests()).toMatchObject([
        { failure, id: created.id, state: "failed" },
        { id: waiting.id, state: "open" },
      ]);
    },
  );

  it("stores a request under the id its owner minted before admission, and mints no other", async () => {
    const store = memoryStore();
    const book = bookOver(store);

    const admitted = await book.admit(request, keyed, () => granted("lse_1"), "req_minted");

    expect(admitted.id).toBe("req_minted");
    expect(store.leaseRequests().map((record) => record.id)).toEqual(["req_minted"]);
  });

  it("lists an open request only while a wait drives it, never one left open with nothing behind it", async () => {
    const store = memoryStore();
    const book = bookOver(store);
    // An open record no wait drives, as a restarted daemon finds one before settling it.
    const orphan = await store.createLeaseRequest({
      ownerId: "agent",
      request,
      requesterId: "lost",
    });
    const { id } = await book.admit(request, keyed, () => ({ promise: new Promise(() => {}) }));

    expect(book.waiting([{ id: orphan.id }, { id, queuePosition: 1 }])).toEqual([
      { createdAt: 1_000, id: orphan.id, requesterId: "lost", spec: request, stage: "starting" },
      {
        createdAt: 1_000,
        id,
        queuePosition: 1,
        requesterId: "agent",
        spec: request,
        stage: "queued",
      },
    ]);
    expect(book.waiting([{ id, queuePosition: 1 }])).toEqual([
      {
        createdAt: 1_000,
        id,
        queuePosition: 1,
        requesterId: "agent",
        spec: request,
        stage: "queued",
      },
    ]);
  });

  it("replays a repeat naming the same mode", async () => {
    const book = bookOver(memoryStore());
    await book.admit({ ...request, mode: "slim" }, keyed, () => granted("lse_1"));
    await settled();

    await expect(book.replay({ ...request, mode: "slim" }, keyed)).resolves.toEqual({
      lease: { id: "lse_1" },
    });
  });

  it("replays a cancelled request as cancelled", async () => {
    const book = bookOver(memoryStore());
    const { id, started } = await book.admit(request, keyed, () => ({
      promise: Promise.reject(new RequestCancelledError("req_0")),
    }));
    await started.promise.catch(() => undefined);
    await settled();

    expect(book.get(id)?.record.state).toBe("cancelled");
    await expect(book.replay(request, keyed)).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it("stores a request whose start throws as failed, rethrows, and gives a repeat that failure", async () => {
    const store = memoryStore();
    const book = bookOver(store);

    await expect(
      book.admit(request, keyed, () => {
        throw new Error("the queue refused it");
      }),
    ).rejects.toThrow("the queue refused it");
    await settled();

    expect(store.leaseRequests()[0]).toMatchObject({
      failure: { message: "the queue refused it" },
      state: "failed",
    });
    await expect(book.replay(request, keyed)).rejects.toMatchObject({
      message: "the queue refused it",
      name: "ReplayedLeaseRequestError",
    });
  });

  it("refuses to replay a stored open request that nothing in this process is driving", async () => {
    const store = memoryStore();
    await store.createLeaseRequest({ ...keyed, request });

    expect(() => bookOver(store).replay(request, keyed)).toThrow("nothing is driving it");
  });

  it("stops telling callers and watchers about progress once the wait has settled", async () => {
    const book = bookOver(memoryStore());
    const heard: unknown[] = [];
    let report: ((progress: { stage: "queued"; queuePosition: number }) => void) | undefined;
    let finish: ((grant: Grant) => void) | undefined;
    const { id } = await book.admit(
      request,
      { ...keyed, onProgress: (progress) => heard.push(progress) },
      (_id, onProgress) => {
        report = onProgress;
        return { promise: new Promise<Grant>((resolve) => (finish = resolve)) };
      },
    );
    let watched = 0;
    book.watch(id, () => (watched += 1));
    finish?.({ lease: { id: "lse_1" } });
    await settled();
    const watchedAtSettlement = watched;

    report?.({ queuePosition: 1, stage: "queued" });

    expect(heard).toEqual([]);
    expect(watched).toBe(watchedAtSettlement);
    expect(book.get(id)?.progress).toBeUndefined();
  });

  it("keeps answering a repeat from the settled wait when its result cannot be written, and takes no new watchers", async () => {
    const inner = memoryStore();
    const store: LeaseRequestStore<Grant> = {
      createLeaseRequest: (input) => inner.createLeaseRequest(input),
      leaseRequests: () => inner.leaseRequests(),
      settleLeaseRequest: () => Promise.reject(new Error("disk full")),
    };
    const book = bookOver(store);
    const { id } = await book.admit(request, keyed, () => granted("lse_1"));
    await settled();

    expect(inner.leaseRequests()[0]?.state).toBe("open");
    await expect(book.replay(request, keyed)).resolves.toEqual({ lease: { id: "lse_1" } });
    expect(book.get(id)?.record.state).toBe("granted");
    expect(book.watch(id, () => undefined)).toBeUndefined();
  });
});
