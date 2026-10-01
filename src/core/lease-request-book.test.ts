import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import {
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
  type LeaseRequestLimits,
} from "./lease-request-book.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import type { LeaseProgress } from "./wait-queue.js";

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

  it("settles every open record as failed in one write, leaving settled ones alone", async () => {
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

describe("LeaseRequestBook callers", () => {
  it("stops reporting progress to a requester's callers once they are detached, and keeps telling the record's watchers", async () => {
    const clock = new FakeClock(1_000);
    const book = new LeaseRequestBook<{ readonly lease: { readonly id: string } }>({
      decisions: new SerializedDecision(),
      describeFailure: () => failure,
      store: new InMemoryLeaseRequestStore({
        clock,
        idGenerator: { generate: () => "1" },
        limits: { maxRecords: 10, retentionMs: 60_000 },
      }),
    });
    const heard: LeaseProgress[] = [];
    let report: ((progress: LeaseProgress) => void) | undefined;
    const { id } = await book.admit(
      request,
      { onProgress: (progress) => heard.push(progress), ownerId: "agent", requesterId: "agent" },
      (_id, onProgress) => {
        report = onProgress;
        return new Promise(() => undefined);
      },
    );
    let watched = 0;
    book.watch(id, () => (watched += 1));

    book.detachCallers("agent");
    report?.({ queuePosition: 1, stage: "queued" });

    expect(heard).toEqual([]);
    expect(watched).toBe(1);
    expect(book.get(id)?.progress).toEqual({ queuePosition: 1, stage: "queued" });
  });
});
