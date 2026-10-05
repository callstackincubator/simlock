import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import {
  IdempotencyConflictError,
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
  type LeaseRequestLimits,
  type LeaseRequestStore,
} from "./lease-request-book.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { RequestCancelledError } from "./wait-queue.js";

const statePath = "/home/agent/.simlock/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const failure = { code: "NO_CAPACITY", message: "No device capacity is currently available" };

async function loadRegistry(
  options: {
    readonly clock?: FakeClock;
    readonly filesystem?: MemoryFilesystem;
    readonly limits?: LeaseRequestLimits;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus: new EventBus(clock),
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    ...(options.limits === undefined ? {} : { leaseRequestLimits: options.limits }),
    statePath,
  });
  return { clock, filesystem, registry };
}

async function storedRequestIds(filesystem: MemoryFilesystem): Promise<string[]> {
  const state = JSON.parse(await filesystem.readFile(statePath)) as {
    readonly leaseRequests: readonly { readonly id: string }[];
  };
  return state.leaseRequests.map((record) => record.id);
}

function newRequest(requesterId: string) {
  return { ownerId: requesterId, request, requesterId };
}

describe("Registry lease requests", () => {
  it("drops a settled record from reads once the retention window passes, and from disk at the next write", async () => {
    const { clock, filesystem, registry } = await loadRegistry({
      limits: { maxRecords: 100, retentionMs: 60_000 },
    });
    const settled = await registry.createLeaseRequest(newRequest("first"));
    await registry.settleLeaseRequest(settled.id, { failure, state: "failed" });

    clock.advance(59_999);
    expect(registry.leaseRequests().map((record) => record.id)).toEqual([settled.id]);

    clock.advance(1);
    expect(registry.leaseRequests()).toEqual([]);
    const next = await registry.createLeaseRequest(newRequest("second"));
    expect(await storedRequestIds(filesystem)).toEqual([next.id]);
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
    const { filesystem, registry } = await loadRegistry({
      limits: { maxRecords: 3, retentionMs: 60_000 },
    });
    const open = await registry.createLeaseRequest(newRequest("open"));
    const oldestSettled = await registry.createLeaseRequest(newRequest("settled-1"));
    const newerSettled = await registry.createLeaseRequest(newRequest("settled-2"));
    await registry.settleLeaseRequest(oldestSettled.id, { failure, state: "failed" });
    await registry.settleLeaseRequest(newerSettled.id, { failure, state: "failed" });

    const fourth = await registry.createLeaseRequest(newRequest("fourth"));
    expect(await storedRequestIds(filesystem)).toEqual([open.id, newerSettled.id, fourth.id]);

    // Every other record left is open or newer: the cap evicts the last settled one, then
    // admits past the cap rather than touch an open record.
    const fifth = await registry.createLeaseRequest(newRequest("fifth"));
    const sixth = await registry.createLeaseRequest(newRequest("sixth"));
    expect(await storedRequestIds(filesystem)).toEqual([open.id, fourth.id, fifth.id, sixth.id]);
  });

  it("loads a state file written before lease requests were stored", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(statePath, JSON.stringify({ devices: [], leases: [] }));

    const { registry } = await loadRegistry({ filesystem });
    expect(registry.leaseRequests()).toEqual([]);

    const created = await registry.createLeaseRequest(newRequest("agent"));
    expect(await storedRequestIds(filesystem)).toEqual([created.id]);
  });

  it("loads a stored class request after a reload, with its class and no model", async () => {
    const { clock, filesystem, registry } = await loadRegistry();
    const created = await registry.createLeaseRequest({
      ownerId: "agent",
      request: { class: "phone", platform: "ios" },
      requesterId: "agent",
    });

    const { registry: reloaded } = await loadRegistry({ clock, filesystem });

    expect(reloaded.leaseRequests().map((record) => [record.id, record.request])).toEqual([
      [created.id, { class: "phone", platform: "ios" }],
    ]);
  });

  it("reads a stored request back after a reload, result included", async () => {
    const { clock, filesystem, registry } = await loadRegistry();
    const created = await registry.createLeaseRequest({
      ...newRequest("agent"),
      idempotencyKey: "key-1",
    });
    await registry.settleLeaseRequest(created.id, { failure, state: "failed" });

    const { registry: reloaded } = await loadRegistry({ clock, filesystem });

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

  it("drops a lease-request record that does not parse and loads the rest", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const valid = {
      createdAt: 1_000,
      id: "req_valid",
      ownerId: "agent",
      request,
      requesterId: "agent",
      state: "open",
    };
    // A `granted` record without its grant: the state promises a result that is not there.
    const broken = { ...valid, id: "req_broken", settledAt: 1_000, state: "granted" };
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({ devices: [], leaseRequests: [broken, valid], leases: [] }),
    );

    const { registry } = await loadRegistry({ filesystem });

    expect(registry.leaseRequests().map((record) => record.id)).toEqual(["req_valid"]);
  });

  it("loads a stored request's image tag, and drops a record whose image tag is not a string", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const record = (id: string, imageTag: unknown) => ({
      createdAt: 1_000,
      id,
      ownerId: "agent",
      request: { ...request, imageTag },
      requesterId: "agent",
      state: "open",
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leaseRequests: [record("req_tagged", "google_apis"), record("req_broken", 7)],
        leases: [],
      }),
    );

    const { registry } = await loadRegistry({ filesystem });

    expect(registry.leaseRequests().map((loaded) => [loaded.id, loaded.request])).toEqual([
      ["req_tagged", { ...request, imageTag: "google_apis" }],
    ]);
  });

  it("loads a granted record stored before mode existed with its grant's device as full, without featureProfile", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const grant = (id: string, device: Record<string, unknown>) => ({
      createdAt: 1_000,
      grant: {
        device: {
          driverDeviceId: "udid",
          id: "dev_1",
          spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
          ...device,
        },
        environment: {},
        lease: { id: "lse_1" },
        timing: {},
      },
      id,
      ownerId: "agent",
      request,
      requesterId: "agent",
      settledAt: 1_000,
      state: "granted",
    });
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leaseRequests: [
          grant("req_legacy", { featureProfile: "reduced" }),
          grant("req_slim", { mode: "slim" }),
          grant("req_unknown", { mode: "reduced" }),
        ],
        leases: [],
      }),
    );

    const { registry } = await loadRegistry({ filesystem });

    const devices = registry.leaseRequests().map((record) => [record.id, record.grant?.device]);
    expect(devices.map(([id]) => id)).toEqual(["req_legacy", "req_slim"]);
    expect(devices[0]?.[1]).toMatchObject({ mode: "full" });
    expect(devices[0]?.[1]).not.toHaveProperty("featureProfile");
    expect(devices[1]?.[1]).toMatchObject({ mode: "slim" });
  });

  it("drops a full key stored before ADR 0007 from a request and from its grant's device spec, and does not write it back", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [],
        leaseRequests: [
          {
            createdAt: 1_000,
            grant: {
              device: {
                driverDeviceId: "udid",
                id: "dev_1",
                mode: "full",
                spec: { ...spec, full: true },
              },
              environment: {},
              lease: { id: "lse_1" },
              timing: {},
            },
            id: "req_legacy",
            ownerId: "agent",
            request: { ...request, full: true },
            requesterId: "agent",
            settledAt: 1_000,
            state: "granted",
          },
        ],
        leases: [],
      }),
    );

    const { registry } = await loadRegistry({ filesystem });
    const [loaded] = registry.leaseRequests();
    expect(loaded?.request).toEqual(request);
    expect(loaded?.grant?.device.spec).toEqual(spec);

    await registry.createLeaseRequest(newRequest("other"));
    const written = JSON.parse(await filesystem.readFile(statePath)) as {
      readonly leaseRequests: readonly {
        readonly id: string;
        readonly request: unknown;
        readonly grant?: { readonly device: { readonly spec: unknown } };
      }[];
    };
    const stored = written.leaseRequests.find((record) => record.id === "req_legacy");
    expect(stored?.request).toEqual(request);
    expect(stored?.grant?.device.spec).toEqual(spec);
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

describe("Registry lease-request load", () => {
  const valid = {
    createdAt: 1_000,
    id: "req_valid",
    ownerId: "agent",
    request,
    requesterId: "agent",
    state: "open",
  };

  async function loadWith(leaseRequests: unknown) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({ devices: [], leaseRequests, leases: [] }),
    );
    return loadRegistry({ filesystem });
  }

  it.each([
    ["a failed record whose failure has no code", { failure: { message: "x" }, state: "failed" }],
    ["a settled record without its settlement time", { settledAt: undefined, state: "cancelled" }],
    ["a request whose mode is neither slim nor full", { request: { ...request, mode: "fast" } }],
  ])("drops %s and loads the rest", async (_label, broken) => {
    const { registry } = await loadWith([
      { ...valid, id: "req_broken", settledAt: 1_000, ...broken },
      valid,
    ]);

    expect(registry.leaseRequests().map((record) => record.id)).toEqual(["req_valid"]);
  });

  it("loads with no requests, rather than failing the load, when the stored list is not a list", async () => {
    const { registry } = await loadWith({ not: "a list" });

    expect(registry.leaseRequests()).toEqual([]);
  });

  it("writes back a field it does not know on a stored request", async () => {
    const { filesystem, registry } = await loadWith([{ ...valid, fromANewerDaemon: 7 }]);

    await registry.createLeaseRequest(newRequest("other"));

    const state = JSON.parse(await filesystem.readFile(statePath)) as {
      readonly leaseRequests: readonly Record<string, unknown>[];
    };
    expect(state.leaseRequests[0]).toMatchObject({ fromANewerDaemon: 7, id: "req_valid" });
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
