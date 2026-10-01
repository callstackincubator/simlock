import { describe, expect, it } from "vitest";

import { NoCapacityError, RequesterAlreadyLeasedError } from "../core/index.js";
import { RequestCancelledError } from "../core/wait-queue.js";
import { FakeClock } from "../ports/index.js";
import { FakeDispatcher, makeGrant, waitForDispatch } from "./test-fakes.js";
import { isTerminalStage, LeaseRequestTracker, type TrackedRequestView } from "./tracker.js";

function buildTracker() {
  const clock = new FakeClock(1_000);
  const dispatcher = new FakeDispatcher(clock);
  const tracker = new LeaseRequestTracker({
    clock,
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    requests: dispatcher.requests,
  });
  return { clock, dispatcher, tracker };
}

const identity = { requesterId: "tok_agent", role: "agent" as const };
const body = { device: "iPhone 17 Pro", platform: "ios" as const };

/**
 * `submit`'s returned promise never settles until the `lease.request` dispatch's first
 * `onProgress` call (or its own grant/rejection) -- see `tracker.ts`'s class doc.
 * `FakeDispatcher.dispatch` runs synchronously enough that it's recorded before `submit`
 * returns, but a caller must still pump the microtask queue for it to show up in `calls`.
 */
async function createTracked(
  tracker: LeaseRequestTracker,
  dispatcher: FakeDispatcher,
  requestBody: typeof body & { readonly ttlMs?: number } = body,
): Promise<{ readonly view: TrackedRequestView; readonly callIndex: number }> {
  const outcomePromise = tracker.submit(identity, requestBody);
  const call = await waitForDispatch(dispatcher, "lease.request");
  const callIndex = dispatcher.calls.indexOf(call);
  call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
  const outcome = await outcomePromise;
  if (outcome.kind !== "created")
    throw new Error(`expected created, got rejected: ${String(outcome.error)}`);
  return { callIndex, view: outcome.view };
}

describe("LeaseRequestTracker.submit", () => {
  it("stays pending on the outer promise until the first progress callback, then answers 'created'", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");

    let resolved = false;
    void outcomePromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    call.session.onProgress?.({ queuePosition: 3, stage: "queued" });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.view.state).toEqual({ queuePosition: 3, stage: "queued" });
    }
  });

  it("answers 'rejected' synchronously when the grant fails before any progress callback", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.reject(new RequesterAlreadyLeasedError("tok_agent", "lse_9"));

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(RequesterAlreadyLeasedError);
    }
  });

  it("drops a fast-rejected request from tracking -- it never becomes a gettable resource", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.reject(new Error("boom"));
    await outcomePromise;
  });

  it("answers 'created' immediately for an instant grant that never calls onProgress", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant());

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") expect(outcome.view.state.stage).toBe("granted");
  });

  it("progresses through queued -> booting -> granted, observable via get()", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, dispatcher);
    const id = view.id;
    expect(tracker.get(id)?.state).toEqual({ queuePosition: 1, stage: "queued" });

    const call = dispatcher.calls[callIndex];
    call?.session.onProgress?.({ etaMs: 60_000, stage: "booting" });
    expect(tracker.get(id)?.state).toEqual({ etaSeconds: 60, stage: "booting" });

    call?.resolve(makeGrant({ lease: { id: "lse_42" } }));
    await Promise.resolve();
    await Promise.resolve();
    const view2 = tracker.get(id);
    expect(view2?.state.stage).toBe("granted");
    if (view2?.state.stage === "granted") expect(view2.state.lease.id).toBe("lse_42");
  });

  it("passes a caller-supplied ttlMs directly on the lease.request input -- no separate renew call", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, { ...body, ttlMs: 60_000 });
    const call = await waitForDispatch(dispatcher, "lease.request");
    expect(call.input).toMatchObject({ ttlMs: 60_000 });

    call.resolve(
      makeGrant({ lease: { grantedAt: 1_000, id: "lse_1", ttlDeadline: 1_000 + 60_000 } }),
    );
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    expect(dispatcher.calls.filter((c) => c.operation === "lease.renew")).toHaveLength(0);
    const view = tracker.get(outcome.view.id);
    if (view?.state.stage === "granted") {
      expect(view.state.lease.ttlMs).toBe(60_000);
      expect(view.state.lease.expiresAt).toBe(new Date(1_000 + 60_000).toISOString());
    } else {
      throw new Error("expected granted");
    }
  });

  it("replays an Idempotency-Key for the same requester instead of double-submitting", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view: first } = await createTrackedWithKey(tracker, dispatcher, "key-1");

    const replay = await tracker.submit(identity, body, "key-1");
    expect(replay.kind).toBe("created");
    if (replay.kind === "created") expect(replay.view.id).toBe(first.id);
    expect(dispatcher.calls.filter((c) => c.operation === "lease.request")).toHaveLength(1);
  });

  it("does not replay an Idempotency-Key across different requesters", async () => {
    const { dispatcher, tracker } = buildTracker();
    await createTrackedWithKey(tracker, dispatcher, "key-1");
    const outcomePromise = tracker.submit(
      { requesterId: "tok_other", role: "agent" },
      body,
      "key-1",
    );
    const call = await waitForDispatch(dispatcher, "lease.request", 1);
    call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("created");
    expect(dispatcher.calls.filter((c) => c.operation === "lease.request")).toHaveLength(2);
  });
});

describe("LeaseRequestTracker.cancel", () => {
  it("returns not-found for an unknown id", async () => {
    const { tracker } = buildTracker();
    expect(await tracker.cancel("req-missing", identity)).toEqual({ kind: "not-found" });
  });

  it("cancels a still-queued request and settles it as 'cancelled'", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, dispatcher);

    // What the daemon's `lease.cancel` does to a queued wait: rejects it as cancelled.
    dispatcher.handlers["lease.cancel"] = () => {
      dispatcher.calls[callIndex]?.reject(new RequestCancelledError(view.id));
      return { result: "cancelled" };
    };
    const result = await tracker.cancel(view.id, identity);
    expect(result).toEqual({ kind: "cancelled" });
    expect(tracker.get(view.id)?.state).toEqual({ stage: "cancelled" });
  });

  it("reports not-cancellable, naming the lease, once the request is already granted", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant({ lease: { id: "lse_granted" } }));
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    expect(await tracker.cancel(outcome.view.id, identity)).toEqual({
      kind: "not-cancellable",
      leaseId: "lse_granted",
    });
  });

  it("reports plain not-cancellable when the queue says device work is already in flight", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view } = await createTracked(tracker, dispatcher);

    dispatcher.handlers["lease.cancel"] = () => ({ result: "not-cancellable" });
    expect(await tracker.cancel(view.id, identity)).toEqual({ kind: "not-cancellable" });
  });
});

describe("LeaseRequestTracker.waitForChange", () => {
  it("resolves undefined for an unknown id", async () => {
    const { tracker } = buildTracker();
    expect(await tracker.waitForChange("req-missing", 30)).toBeUndefined();
  });

  it("resolves immediately if the request is already terminal", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcomePromise = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant());
    const outcome = await outcomePromise;
    if (outcome.kind !== "created") throw new Error("expected created");

    const view = await tracker.waitForChange(outcome.view.id, 30);
    expect(view?.state.stage).toBe("granted");
  });

  it("resolves early on the next state change", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, dispatcher);

    const waitPromise = tracker.waitForChange(view.id, 30);
    dispatcher.calls[callIndex]?.session.onProgress?.({ etaMs: 5_000, stage: "provisioning" });
    const changed = await waitPromise;
    expect(changed?.state).toEqual({ etaSeconds: 5, stage: "provisioning" });
  });

  it("resolves with the unchanged state once the wait timer elapses", async () => {
    const { clock, dispatcher, tracker } = buildTracker();
    const { view } = await createTracked(tracker, dispatcher);

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
  dispatcher: FakeDispatcher,
  key: string,
): Promise<{ readonly view: TrackedRequestView }> {
  const outcomePromise = tracker.submit(identity, body, key);
  const call = await waitForDispatch(dispatcher, "lease.request");
  call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
  const outcome = await outcomePromise;
  if (outcome.kind !== "created") throw new Error("expected created");
  return { view: outcome.view };
}

describe("LeaseRequestTracker.submit with allowDownload", () => {
  it("answers 'created' immediately, before any progress callback", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcome = await tracker.submit(identity, { ...body, allowDownload: true });
    expect(outcome.kind).toBe("created");
    expect(dispatcher.calls[0]?.input).toMatchObject({ allowDownload: true });
  });

  it("keeps the request visible when the grant later fails -- terminal failed, not a rejected POST", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcome = await tracker.submit(identity, { ...body, allowDownload: true });
    if (outcome.kind !== "created") throw new Error("expected created");

    dispatcher.calls[0]?.reject(new Error("download failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.get(outcome.view.id)?.state.stage).toBe("failed");
  });
});

describe("LeaseRequestTracker.submit with full", () => {
  it("passes full through onto the dispatch input, and omits it otherwise", async () => {
    const { dispatcher, tracker } = buildTracker();
    await createTracked(tracker, dispatcher, { ...body, full: true } as typeof body);
    expect(dispatcher.calls[0]?.input).toMatchObject({ full: true });

    const { dispatcher: dispatcher2, tracker: tracker2 } = buildTracker();
    await createTracked(tracker2, dispatcher2);
    expect(dispatcher2.calls[0]?.input).not.toHaveProperty("full");
  });
});

describe("LeaseRequestTracker granted lease payload", () => {
  it("reports slim: false when the granted device's featureProfile is absent", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, dispatcher);
    dispatcher.calls[callIndex]?.resolve(makeGrant());
    await Promise.resolve();
    await Promise.resolve();
    const state = tracker.get(view.id)?.state;
    if (state?.stage !== "granted") throw new Error("expected granted");
    expect(state.lease.slim).toBe(false);
  });

  it("reports slim: true when the granted device's featureProfile is reduced", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view, callIndex } = await createTracked(tracker, dispatcher);
    dispatcher.calls[callIndex]?.resolve(makeGrant({ device: { featureProfile: "reduced" } }));
    await Promise.resolve();
    await Promise.resolve();
    const state = tracker.get(view.id)?.state;
    if (state?.stage !== "granted") throw new Error("expected granted");
    expect(state.lease.slim).toBe(true);
  });
});

describe("LeaseRequestTracker.waitForChange abort", () => {
  it("finishes immediately when the caller's signal aborts", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view } = await createTracked(tracker, dispatcher);

    const controller = new AbortController();
    const wait = tracker.waitForChange(view.id, 30, controller.signal);
    controller.abort();
    const result = await wait;
    expect(result?.state.stage).toBe("queued");
  });

  it("finishes immediately for a signal that is already aborted", async () => {
    const { dispatcher, tracker } = buildTracker();
    const { view } = await createTracked(tracker, dispatcher);

    const controller = new AbortController();
    controller.abort();
    const result = await tracker.waitForChange(view.id, 30, controller.signal);
    expect(result?.state.stage).toBe("queued");
  });
});

describe("LeaseRequestTracker repeats of a stored request", () => {
  it("answers a repeat of a request that failed before becoming visible with the stored, failed request, starting no second one", async () => {
    const { dispatcher, tracker } = buildTracker();
    const first = tracker.submit(identity, { ...body, noWait: true }, "key-1");
    const firstCall = await waitForDispatch(dispatcher, "lease.request");
    // How a stored `noWait` request fails with no capacity: before any progress is reported.
    firstCall.reject(new NoCapacityError());
    expect((await first).kind).toBe("rejected");

    const second = await tracker.submit(identity, { ...body, noWait: true }, "key-1");

    expect(second.kind).toBe("created");
    if (second.kind === "created") {
      expect(second.view.state).toMatchObject({ error: { code: "NO_CAPACITY" }, stage: "failed" });
    }
    expect(dispatcher.calls.filter((c) => c.operation === "lease.request")).toHaveLength(1);
  });

  it("answers a repeat of a request still waiting with that request at once, before any new progress", async () => {
    const { dispatcher, tracker } = buildTracker();
    void tracker.submit(identity, body, "key-1");
    await waitForDispatch(dispatcher, "lease.request");

    let answered: Awaited<ReturnType<LeaseRequestTracker["submit"]>> | undefined;
    void tracker.submit(identity, body, "key-1").then((outcome) => (answered = outcome));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(answered?.kind).toBe("created");
    if (answered?.kind === "created") {
      // The one request the first submission stored, answered with no new progress.
      expect(dispatcher.requests.get(answered.view.id)?.record).toMatchObject({
        idempotencyKey: "key-1",
        state: "open",
      });
      expect(answered.view.state).toEqual({ queuePosition: 1, stage: "queued" });
    }
    expect(dispatcher.calls.filter((c) => c.operation === "lease.request")).toHaveLength(1);
  });

  it("reads a granted request back from the stored record, not from anything the tracker kept", async () => {
    const { dispatcher, tracker } = buildTracker();
    const outcome = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant({ lease: { id: "lse_stored" } }));
    const created = await outcome;
    if (created.kind !== "created") throw new Error("expected created");

    // A second tracker over the same store: it was never handed this request.
    const fresh = new LeaseRequestTracker({
      clock: new FakeClock(1_000),
      dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
      requests: dispatcher.requests,
    });
    const state = fresh.get(created.view.id)?.state;
    if (state?.stage !== "granted") throw new Error("expected granted");
    expect(state.lease.id).toBe("lse_stored");
  });
});

describe("LeaseRequestTracker.submit when the stored record cannot be read", () => {
  it("still answers created with the grant when the record is gone by the time the grant lands", async () => {
    const clock = new FakeClock(1_000);
    const dispatcher = new FakeDispatcher(clock);
    const tracker = new LeaseRequestTracker({
      clock,
      dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
      // A reader that has already lost every record: pruned, or evicted at the cap.
      requests: {
        get: () => undefined,
        requestIdForLease: () => undefined,
        watch: () => undefined,
      },
    });
    const outcome = tracker.submit(identity, body);
    const call = await waitForDispatch(dispatcher, "lease.request");

    call.resolve(makeGrant({ lease: { id: "lse_pruned" } }));

    const settled = await outcome;
    expect(settled.kind).toBe("created");
    if (settled.kind === "created") {
      expect(settled.view.state).toMatchObject({ lease: { id: "lse_pruned" }, stage: "granted" });
    }
  });
});
