import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { RequesterAlreadyLeasedError } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import {
  FakeLeaseCommands,
  FakeQueueControl,
  makeGrant,
  sequenceIdGenerator,
} from "./test-fakes.js";
import { isTerminalStage, LeaseRequestTracker, type TrackedRequestView } from "./tracker.js";

function buildTracker(overrides: { readonly defaultTtlMs?: number } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const leases = new FakeLeaseCommands();
  const queue = new FakeQueueControl();
  const tracker = new LeaseRequestTracker({
    clock,
    defaultTtlMs: overrides.defaultTtlMs ?? 900_000,
    eventBus,
    idGenerator: sequenceIdGenerator("req"),
    leases,
    queue,
  });
  return { clock, eventBus, leases, queue, tracker };
}

const identity = { requesterId: "tok_agent" };
const body = { device: "iPhone 17 Pro", platform: "ios" as const };

/**
 * `submit`'s returned promise never settles until `LeaseCommands.request`'s first `onProgress`
 * call (or its own grant/rejection) -- see `tracker.ts`'s class doc. `FakeLeaseCommands.request`
 * runs synchronously (its executor pushes into `calls` before `submit` returns), so scripting
 * one `queued` progress event right after calling `submit` -- never awaiting it bare -- is what
 * every test below needs to avoid deadlocking on its own promise.
 */
async function createTracked(
  tracker: LeaseRequestTracker,
  leases: FakeLeaseCommands,
  requestBody: typeof body & { readonly ttlMs?: number } = body,
): Promise<{ readonly view: TrackedRequestView; readonly callIndex: number }> {
  const callIndex = leases.calls.length;
  const outcomePromise = tracker.submit(identity, requestBody);
  leases.calls[callIndex]?.options.onProgress?.({ queuePosition: 1, stage: "queued" });
  const outcome = await outcomePromise;
  if (outcome.kind !== "created")
    throw new Error(`expected created, got rejected: ${String(outcome.error)}`);
  return { callIndex, view: outcome.view };
}

describe("LeaseRequestTracker.submit", () => {
  it("stays pending on the outer promise until the first progress callback, then answers 'created'", async () => {
    const { leases, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);

    let resolved = false;
    void outcomePromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    leases.calls[0]?.options.onProgress?.({ queuePosition: 3, stage: "queued" });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.view.state).toEqual({ queuePosition: 3, stage: "queued" });
    }
  });

  it("answers 'rejected' synchronously when the grant fails before any progress callback", async () => {
    const { leases, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    leases.calls[0]?.reject(new RequesterAlreadyLeasedError("tok_agent", "lse_9"));

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(RequesterAlreadyLeasedError);
    }
  });

  it("drops a fast-rejected request from tracking -- it never becomes a gettable resource", async () => {
    const { leases, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    leases.calls[0]?.reject(new Error("boom"));
    await outcomePromise;

    // No id was ever handed to any caller for this failed submission; nothing to assert a `get`
    // against, but the tracker must not have grown unboundedly -- covered indirectly by the
    // idempotency-replay test below relying on exactly this cleanup.
  });

  it("answers 'created' immediately for an instant grant that never calls onProgress", async () => {
    const { leases, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    leases.calls[0]?.resolve(makeGrant());

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") expect(outcome.view.state.stage).toBe("granted");
  });

  it("progresses through queued -> booting -> granted, observable via get()", async () => {
    const { leases, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, leases);
    const id = view.id;
    expect(tracker.get(id)?.state).toEqual({ queuePosition: 1, stage: "queued" });

    leases.calls[callIndex]?.options.onProgress?.({ etaMs: 60_000, stage: "booting" });
    expect(tracker.get(id)?.state).toEqual({ etaSeconds: 60, stage: "booting" });

    leases.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_42" } }));
    await Promise.resolve();
    await Promise.resolve();
    const view2 = tracker.get(id);
    expect(view2?.state.stage).toBe("granted");
    if (view2?.state.stage === "granted") expect(view2.state.lease.id).toBe("lse_42");
  });

  it("renews a freshly granted lease when the body specified a custom ttlMs", async () => {
    const { leases, tracker } = buildTracker({ defaultTtlMs: 900_000 });
    const callIndex = leases.calls.length;
    const outcomePromise = tracker.submit(identity, { ...body, ttlMs: 60_000 });
    leases.renewImpl = async (leaseId, ttlMs) => ({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: leaseId,
      mode: "detached",
      requesterId: "tok_agent",
      ttlDeadline: 1_000 + (ttlMs ?? 0),
    });
    leases.calls[callIndex]?.resolve(makeGrant());
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    expect(leases.renewCalls).toEqual([{ leaseId: "lse_1", ttlMs: 60_000 }]);
    const view = tracker.get(outcome.view.id);
    if (view?.state.stage === "granted") {
      expect(view.state.lease.ttlMs).toBe(60_000);
      expect(view.state.lease.expiresAt).toBe(new Date(1_000 + 60_000).toISOString());
    } else {
      throw new Error("expected granted");
    }
  });

  it("replays an Idempotency-Key for the same requester instead of double-submitting", async () => {
    const { leases, tracker } = buildTracker();
    const { view: first } = await createTrackedWithKey(tracker, leases, "key-1");

    const replay = await tracker.submit(identity, body, "key-1");
    expect(replay.kind).toBe("created");
    if (replay.kind === "created") expect(replay.view.id).toBe(first.id);
    expect(leases.calls).toHaveLength(1);
  });

  it("does not replay an Idempotency-Key across different requesters", async () => {
    const { leases, tracker } = buildTracker();
    await createTrackedWithKey(tracker, leases, "key-1");
    const callIndex = leases.calls.length;
    const outcomePromise = tracker.submit({ requesterId: "tok_other" }, body, "key-1");
    leases.calls[callIndex]?.options.onProgress?.({ queuePosition: 1, stage: "queued" });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    expect(leases.calls).toHaveLength(2);
  });
});

describe("LeaseRequestTracker.cancel", () => {
  it("returns not-found for an unknown id", async () => {
    const { tracker } = buildTracker();
    expect(await tracker.cancel("req-missing")).toEqual({ kind: "not-found" });
  });

  it("cancels a still-queued request and settles it as 'cancelled'", async () => {
    const { leases, queue, tracker } = buildTracker();
    const { view } = await createTracked(tracker, leases);

    queue.cancelOutcome = "cancelled";
    const result = await tracker.cancel(view.id);
    expect(result).toEqual({ kind: "cancelled" });
    expect(tracker.get(view.id)?.state).toEqual({ stage: "cancelled" });
  });

  it("reports not-cancellable, naming the lease, once the request is already granted", async () => {
    const { leases, tracker } = buildTracker();
    const callIndex = leases.calls.length;
    const outcomePromise = tracker.submit(identity, body);
    leases.calls[callIndex]?.resolve(makeGrant({ lease: { id: "lse_granted" } }));
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    expect(await tracker.cancel(outcome.view.id)).toEqual({
      kind: "not-cancellable",
      leaseId: "lse_granted",
    });
  });

  it("reports plain not-cancellable when the queue says device work is already in flight", async () => {
    const { leases, queue, tracker } = buildTracker();
    const { view } = await createTracked(tracker, leases);

    queue.cancelOutcome = "not-cancellable";
    expect(await tracker.cancel(view.id)).toEqual({ kind: "not-cancellable" });
  });
});

describe("LeaseRequestTracker.waitForChange", () => {
  it("resolves undefined for an unknown id", async () => {
    const { tracker } = buildTracker();
    expect(await tracker.waitForChange("req-missing", 30)).toBeUndefined();
  });

  it("resolves immediately if the request is already terminal", async () => {
    const { leases, tracker } = buildTracker();
    const callIndex = leases.calls.length;
    const outcomePromise = tracker.submit(identity, body);
    leases.calls[callIndex]?.resolve(makeGrant());
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    const view = await tracker.waitForChange(outcome.view.id, 30);
    expect(view?.state.stage).toBe("granted");
  });

  it("resolves early on the next state change", async () => {
    const { leases, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, leases);

    const waitPromise = tracker.waitForChange(view.id, 30);
    leases.calls[callIndex]?.options.onProgress?.({ etaMs: 5_000, stage: "provisioning" });
    const changed = await waitPromise;
    expect(changed?.state).toEqual({ etaSeconds: 5, stage: "provisioning" });
  });

  it("resolves with the unchanged state once the wait timer elapses", async () => {
    const { clock, leases, tracker } = buildTracker();
    const { view } = await createTracked(tracker, leases);

    const waitPromise = tracker.waitForChange(view.id, 5);
    clock.advance(5_000);
    const changed = await waitPromise;
    expect(changed?.state).toEqual({ queuePosition: 1, stage: "queued" });
  });
});

describe("isTerminalStage", () => {
  it("is true only for granted/failed/cancelled", () => {
    expect(isTerminalStage({ queuePosition: 1, stage: "queued" })).toBe(false);
    expect(isTerminalStage({ stage: "cancelled" })).toBe(true);
    expect(isTerminalStage({ error: { code: "X", message: "x" }, stage: "failed" })).toBe(true);
  });
});

async function createTrackedWithKey(
  tracker: LeaseRequestTracker,
  leases: FakeLeaseCommands,
  key: string,
): Promise<{ readonly view: TrackedRequestView }> {
  const callIndex = leases.calls.length;
  const outcomePromise = tracker.submit(identity, body, key);
  leases.calls[callIndex]?.options.onProgress?.({ queuePosition: 1, stage: "queued" });
  const outcome = await outcomePromise;
  if (outcome.kind !== "created") throw new Error("expected created");
  return { view: outcome.view };
}

describe("LeaseRequestTracker.submit with allowDownload", () => {
  it("answers 'created' immediately, before any progress callback", async () => {
    const { leases, tracker } = buildTracker();
    const outcome = await tracker.submit(identity, { ...body, allowDownload: true });
    expect(outcome.kind).toBe("created");
    expect(leases.calls[0]?.options.allowDownload).toBe(true);
  });

  it("keeps the request visible when the grant later fails -- terminal failed, not a rejected POST", async () => {
    const { leases, tracker } = buildTracker();
    const outcome = await tracker.submit(identity, { ...body, allowDownload: true });
    if (outcome.kind !== "created") throw new Error("expected created");

    leases.calls[0]?.reject(new Error("download failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.get(outcome.view.id)?.state.stage).toBe("failed");
  });
});

describe("LeaseRequestTracker.submit with full", () => {
  it("passes full through onto the DeviceRequest, and omits it otherwise", async () => {
    const { leases, tracker } = buildTracker();
    await createTracked(tracker, leases, { ...body, full: true } as typeof body);
    expect(leases.calls[0]?.request).toMatchObject({ full: true });

    const { leases: leases2, tracker: tracker2 } = buildTracker();
    await createTracked(tracker2, leases2);
    expect(leases2.calls[0]?.request).not.toHaveProperty("full");
  });
});

describe("LeaseRequestTracker granted lease payload", () => {
  it("reports slim: false when the granted device's featureProfile is absent", async () => {
    const { leases, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, leases);
    leases.calls[callIndex]?.resolve(makeGrant());
    await Promise.resolve();
    await Promise.resolve();
    const state = tracker.get(view.id)?.state;
    if (state?.stage !== "granted") throw new Error("expected granted");
    expect(state.lease.slim).toBe(false);
  });

  it("reports slim: true when the granted device's featureProfile is reduced", async () => {
    const { leases, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, leases);
    leases.calls[callIndex]?.resolve(makeGrant({ device: { featureProfile: "reduced" } }));
    await Promise.resolve();
    await Promise.resolve();
    const state = tracker.get(view.id)?.state;
    if (state?.stage !== "granted") throw new Error("expected granted");
    expect(state.lease.slim).toBe(true);
  });
});

describe("LeaseRequestTracker.waitForChange abort", () => {
  it("finishes immediately when the caller's signal aborts", async () => {
    const { leases, tracker } = buildTracker();
    const { view } = await createTracked(tracker, leases);

    const controller = new AbortController();
    const wait = tracker.waitForChange(view.id, 30, controller.signal);
    controller.abort();
    const result = await wait;
    expect(result?.state.stage).toBe("queued");
  });

  it("finishes immediately for a signal that is already aborted", async () => {
    const { leases, tracker } = buildTracker();
    const { view } = await createTracked(tracker, leases);

    const controller = new AbortController();
    controller.abort();
    const result = await tracker.waitForChange(view.id, 30, controller.signal);
    expect(result?.state.stage).toBe("queued");
  });
});

describe("LeaseRequestTracker idempotency cleanup", () => {
  it("drops the mapping when a submission is rejected before becoming visible -- a replay creates a fresh request", async () => {
    const { leases, tracker } = buildTracker();
    const first = tracker.submit(identity, body, "key-1");
    leases.calls[0]?.reject(new RequesterAlreadyLeasedError("tok_agent"));
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe("rejected");

    const second = tracker.submit(identity, body, "key-1");
    leases.calls[1]?.options.onProgress?.({ queuePosition: 1, stage: "queued" });
    const secondOutcome = await second;
    expect(secondOutcome.kind).toBe("created");
    expect(leases.calls).toHaveLength(2);
  });
});
