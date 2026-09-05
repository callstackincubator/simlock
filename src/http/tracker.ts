import { RequestCancelledError } from "../core/index.js";
import type { Clock, IdGenerator, Logger, TimerHandle } from "../ports/index.js";
import { buildHttpSession } from "./dispatcher-session.js";
import type { HttpDispatch } from "./dispatcher-session.js";
import { mapError } from "./errors.js";
import type { TokenIdentity } from "./token-store.js";

export interface LeaseRequestInput {
  readonly platform: "ios" | "android";
  readonly device: string;
  readonly os?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly noWait?: boolean;
  readonly allowDownload?: boolean;
  readonly full?: boolean;
}

/** Matches the issue's lease object exactly; `dataPlane` is reserved and always `null` in v1. */
export interface LeasePayload {
  readonly id: string;
  readonly requestId?: string;
  readonly platform: string;
  readonly device: string;
  readonly os: string;
  readonly udid: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
  readonly dataPlane: null;
  /** Whether the granted device had its feature set reduced -- see `DeviceRecord.featureProfile`. */
  readonly slim: boolean;
}

/**
 * `LeaseRecord` has no `createdAt` -- `grantedAt` is its equivalent. `ttlMs` is read straight
 * off the lease record (ADR 0004: the daemon stores the width a lease was granted with, or
 * last renewed with), so it survives a daemon restart along with the deadline and this gateway
 * remembers nothing per request to produce it. It is never derived as `ttlDeadline -
 * grantedAt`: `grantedAt` never moves on renewal, so that arithmetic reports grant-age plus
 * TTL rather than the width actually in force -- `expiresAt` is the authoritative deadline
 * either way. Parameter types are deliberately narrower than the full
 * `DeviceRecord`/`LeaseRecord` (only the fields this function reads): both the dispatcher's
 * `lease.request` output and the core's own `LeaseGrant` satisfy this shape, so this function
 * works unchanged whether the tracker is fed directly or through `dispatch()`.
 */
export function buildLeasePayload(
  device: HttpLeaseDevice,
  lease: HttpLeaseRecord,
  extra: { readonly requestId?: string } = {},
): LeasePayload {
  return {
    id: lease.id,
    ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
    platform: device.spec.platform,
    device: device.spec.model,
    os: device.spec.osVersion,
    udid: device.driverDeviceId,
    deviceId: device.id,
    createdAt: new Date(lease.grantedAt).toISOString(),
    expiresAt: new Date(lease.ttlDeadline).toISOString(),
    ttlMs: lease.ttlMs,
    dataPlane: null,
    slim: device.featureProfile === "reduced",
  };
}

export type RequestSnapshot =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "reclaiming"; readonly etaSeconds: number }
  | { readonly stage: "provisioning"; readonly etaSeconds: number }
  | { readonly stage: "booting"; readonly etaSeconds: number }
  | { readonly stage: "granted"; readonly lease: LeasePayload }
  | {
      readonly stage: "failed";
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly stage: "cancelled" };

export function isTerminalStage(state: RequestSnapshot): boolean {
  return state.stage === "granted" || state.stage === "failed" || state.stage === "cancelled";
}

export interface TrackedRequestView {
  readonly id: string;
  readonly requesterId: string;
  readonly createdAt: string;
  readonly state: RequestSnapshot;
}

export type CancelOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-cancellable"; readonly leaseId?: string };

interface TrackedRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly createdAtIso: string;
  state: RequestSnapshot;
  readonly listeners: Set<(state: RequestSnapshot) => void>;
}

/** How long a terminal request resource answers `GET` after settling, per the issue spec. */
const TERMINAL_RETENTION_MS = 5 * 60_000;
/** How long an `Idempotency-Key` replay window stays open. */
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
/**
 * Hard ceiling on live idempotency entries: an authenticated caller can mint a fresh key per
 * request without ever occupying its one queue slot, so without a cap this map (and its
 * expiry timers) grows without bound. FIFO eviction of the oldest entry only weakens replay
 * protection for whoever is flooding, and `RequesterAlreadyLeasedError` remains the backstop
 * against a double grant.
 */
const IDEMPOTENCY_MAX_ENTRIES = 10_000;

export interface LeaseRequestTrackerOptions {
  /**
   * ADR 0003 §2: HTTP calls the exact same shared `Dispatcher` the socket path does -- not a
   * second copy of "call `LeaseCommands.request`, apply the download policy, set `ownerId`".
   * Routing `lease.request`/`lease.cancel` through this closes the download-policy divergence
   * (the clamp lives inside the dispatcher's `lease.request` handler now, so HTTP gets it for
   * free) and makes an HTTP request during startup park the same way a socket request does
   * (`dispatch()` awaits startup readiness before running any handler but `status.get`).
   */
  readonly dispatch: HttpDispatch;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger?: Logger;
}

/**
 * Gateway-layer resource tracking for `POST /v1/lease-requests`. Calls `dispatch("lease.request",
 * ...)` with an `onProgress` session override and never awaits its returned promise directly --
 * `submit` returns as soon as the request resource exists, matching "acquisition is an async
 * resource, no long-blocking POST" from the issue's design principles. `GET`, long-poll, and SSE
 * all read the same in-memory state this class owns; no core changes were needed to observe it.
 */
export class LeaseRequestTracker {
  readonly #requests = new Map<string, TrackedRequest>();
  readonly #idempotency = new Map<string, { requestId: string; timer: TimerHandle }>();
  readonly #leaseRequestId = new Map<string, string>();
  /**
   * The retention/idempotency-TTL timers `#setState`/`#registerIdempotency` arm below,
   * tracked so `dispose()` can cancel whichever are still outstanding. Without this, a
   * `Clock` backed by real timers (the daemon's `SystemClock`, unlike this class's own
   * unit tests' `FakeClock`) would keep a real `setTimeout` alive for up to
   * `TERMINAL_RETENTION_MS`/`IDEMPOTENCY_TTL_MS` after this instance is otherwise done
   * with -- which, for a Node process, means `daemon stop` would not actually exit until
   * that timer fires, minutes later.
   */
  readonly #activeTimers = new Set<TimerHandle>();

  constructor(private readonly options: LeaseRequestTrackerOptions) {}

  submit(
    identity: TokenIdentity,
    body: LeaseRequestInput,
    idempotencyKey?: string,
  ): Promise<
    | { readonly kind: "created"; readonly view: TrackedRequestView }
    | { readonly kind: "rejected"; readonly error: unknown }
  > {
    const replay = this.#replayIdempotentSubmit(identity.requesterId, idempotencyKey);
    if (replay !== undefined) return Promise.resolve({ kind: "created", view: replay });

    const id = `req_${this.options.idGenerator.generate()}`;
    const record: TrackedRequest = {
      createdAtIso: new Date(this.options.clock.now()).toISOString(),
      id,
      listeners: new Set(),
      requesterId: identity.requesterId,
      // Best-effort placeholder until the first real `onProgress` call (fired before the POST
      // response is even built in the common case) supersedes it.
      state: { queuePosition: 1, stage: "queued" },
    };
    this.#requests.set(id, record);
    this.#registerIdempotency(identity.requesterId, idempotencyKey, id);

    // Races the grant/rejection against the request's *first* progress callback -- see the
    // class doc. A rejection that lands before any progress call (already-leased, unresolvable
    // model/runtime/driver, no-capacity-with-noWait) never reached anything the queue
    // considers "in flight", so the POST itself can fail with the matching HTTP status instead
    // of the caller polling a request resource just to learn that. Once a progress callback
    // fires (or a grant lands without ever needing one), the request is a genuine async
    // resource and always answers 201.
    return new Promise((resolve) => {
      let settled = false;
      const settleCreated = () => {
        if (settled) return;
        settled = true;
        resolve({ kind: "created", view: toView(record) });
      };

      const session = buildHttpSession(identity, {
        onProgress: (progress) => {
          this.#applyProgress(record, progress);
          settleCreated();
        },
      });

      this.options
        .dispatch(
          "lease.request",
          {
            model: body.device,
            platform: body.platform,
            ...(body.os === undefined ? {} : { osVersion: body.os }),
            ...(body.full === undefined ? {} : { full: body.full }),
            ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
            ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
            ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
            // ADR 0003 §9: the initial TTL travels on the request itself -- this deletes the
            // old grant-then-immediately-renew hack. Under ADR 0004 the daemon then stores
            // that width on the lease, so nothing here has to remember it either.
            ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
          },
          session,
        )
        .then((grant) => {
          this.#applyGrant(record, grant);
          settleCreated();
        })
        .catch((error: unknown) => {
          this.#applyFailure(record, error);
          if (settled) return;
          settled = true;
          // Never became visible to any client (the POST itself is about to fail), so it
          // shouldn't answer a later GET/replay either -- including through the
          // idempotency map, whose entry (and pending expiry timer) would otherwise
          // outlive the record it points at.
          this.#requests.delete(record.id);
          if (idempotencyKey !== undefined) {
            this.#dropIdempotency(idempotencyCacheKey(identity.requesterId, idempotencyKey));
          }
          resolve({ kind: "rejected", error });
        });

      // A download-permitted request can spend minutes inside the driver's `resolveSpec`
      // (an Android `sdkmanager --install` runs there) before the first progress callback
      // -- the one pre-progress stretch that legitimately runs long. Settle the POST now:
      // the client polls the resource instead, and even an instant admission rejection
      // (already-leased) then surfaces as the resource's terminal `failed` state rather
      // than an HTTP error, because by the time it lands the resource is already visible.
      if (body.allowDownload === true) settleCreated();
    });
  }

  get(id: string): TrackedRequestView | undefined {
    const record = this.#requests.get(id);
    return record === undefined ? undefined : toView(record);
  }

  /** Registers a listener for future state changes only -- it does not fire for the current state. */
  subscribe(id: string, listener: (state: RequestSnapshot) => void): (() => void) | undefined {
    const record = this.#requests.get(id);
    if (record === undefined) return undefined;
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /**
   * Resolves early on the next state change, else once `seconds` elapses; `undefined` if
   * `id` is unknown. An aborted `signal` (the HTTP request's own -- the client hung up)
   * also finishes immediately, so a disconnected long-poll releases its listener and timer
   * right away instead of pinning them for the full requested wait.
   */
  waitForChange(
    id: string,
    seconds: number,
    signal?: AbortSignal,
  ): Promise<TrackedRequestView | undefined> {
    const record = this.#requests.get(id);
    if (record === undefined) return Promise.resolve(undefined);
    if (isTerminalStage(record.state)) return Promise.resolve(toView(record));

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        this.options.clock.cancel(timer);
        resolve(toView(record));
      };
      const unsubscribe = this.subscribe(id, finish) ?? (() => {});
      const timer = this.options.clock.setTimer(Math.max(0, seconds) * 1_000, finish);
      if (signal?.aborted === true) finish();
      else signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Cancels a pending request via `dispatch("lease.cancel", ...)` -- the exact operation the
   * socket path's `lease.cancel` uses, authorize hook included (ADR: "cancels this principal's
   * pending request by requester id"). The terminal state is applied here, synchronously with
   * the dispatch's answer, rather than waiting for the rejected `lease.request` promise's
   * `.catch` to run on a later microtask -- a caller awaiting `cancel()` must see the settled
   * state immediately.
   */
  async cancel(id: string, identity: TokenIdentity): Promise<CancelOutcome> {
    const record = this.#requests.get(id);
    if (record === undefined) return { kind: "not-found" };
    const stateBefore = record.state;
    if (stateBefore.stage === "granted")
      return { kind: "not-cancellable", leaseId: stateBefore.lease.id };
    if (isTerminalStage(stateBefore)) return { kind: "not-cancellable" };

    const session = buildHttpSession(identity);
    const { result } = await this.options.dispatch(
      "lease.cancel",
      { requesterId: record.requesterId },
      session,
    );
    if (result === "cancelled") {
      this.#setState(record, { stage: "cancelled" });
      return { kind: "cancelled" };
    }
    // Settled between the check above and this call (e.g. granted in the interim) -- report
    // the now-current state rather than a stale answer.
    const stateAfter = record.state;
    if (stateAfter.stage === "granted")
      return { kind: "not-cancellable", leaseId: stateAfter.lease.id };
    return { kind: "not-cancellable" };
  }

  requestIdForLease(leaseId: string): string | undefined {
    return this.#leaseRequestId.get(leaseId);
  }

  /** Drops the request-id bookkeeping for a lease that just ended -- called from the HTTP app
   * on the same owner-routed fact stream (`OwnerRoutedFacts`, `lease-lost`) `LeaseNoticeBuffer`
   * consumes, not from a direct `eventBus.subscribe` on this class. ADR 0004 left this map
   * alone but deleted the per-lease TTL one that used to sit beside it: the width is on the
   * lease record now, so there is nothing gateway-side left to forget about it. */
  forgetLease(leaseId: string): void {
    this.#leaseRequestId.delete(leaseId);
  }

  dispose(): void {
    for (const timer of this.#activeTimers) this.options.clock.cancel(timer);
    this.#activeTimers.clear();
  }

  #replayIdempotentSubmit(
    requesterId: string,
    idempotencyKey: string | undefined,
  ): TrackedRequestView | undefined {
    if (idempotencyKey === undefined) return undefined;
    const entry = this.#idempotency.get(idempotencyCacheKey(requesterId, idempotencyKey));
    if (entry === undefined) return undefined;
    const existing = this.#requests.get(entry.requestId);
    return existing === undefined ? undefined : toView(existing);
  }

  #registerIdempotency(
    requesterId: string,
    idempotencyKey: string | undefined,
    requestId: string,
  ): void {
    if (idempotencyKey === undefined) return;
    if (this.#idempotency.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.#idempotency.keys().next().value;
      if (oldest !== undefined) this.#dropIdempotency(oldest);
    }
    const cacheKey = idempotencyCacheKey(requesterId, idempotencyKey);
    const timer = this.options.clock.setTimer(IDEMPOTENCY_TTL_MS, () => {
      this.#activeTimers.delete(timer);
      if (this.#idempotency.get(cacheKey)?.requestId === requestId) {
        this.#idempotency.delete(cacheKey);
      }
    });
    this.#activeTimers.add(timer);
    this.#idempotency.set(cacheKey, { requestId, timer });
  }

  #dropIdempotency(cacheKey: string): void {
    const entry = this.#idempotency.get(cacheKey);
    if (entry === undefined) return;
    this.options.clock.cancel(entry.timer);
    this.#activeTimers.delete(entry.timer);
    this.#idempotency.delete(cacheKey);
  }

  #applyProgress(record: TrackedRequest, progress: HttpLeaseProgress): void {
    switch (progress.stage) {
      case "queued":
        this.#setState(record, { queuePosition: progress.queuePosition, stage: "queued" });
        return;
      case "provisioning":
        this.#setState(record, { etaSeconds: toSeconds(progress.etaMs), stage: "provisioning" });
        return;
      case "booting":
        this.#setState(record, { etaSeconds: toSeconds(progress.etaMs), stage: "booting" });
        return;
      case "reclaiming":
        this.#setState(record, { etaSeconds: toSeconds(progress.etaMs), stage: "reclaiming" });
        return;
    }
  }

  #applyGrant(record: TrackedRequest, grant: HttpLeaseGrant): void {
    this.#leaseRequestId.set(grant.lease.id, record.id);
    this.#setState(record, {
      lease: buildLeasePayload(grant.device, grant.lease, { requestId: record.id }),
      stage: "granted",
    });
  }

  #applyFailure(record: TrackedRequest, error: unknown): void {
    if (error instanceof RequestCancelledError) {
      this.#setState(record, { stage: "cancelled" });
      return;
    }
    const mapped = mapError(error);
    this.#setState(record, {
      error: { code: mapped.code, message: mapped.message },
      stage: "failed",
    });
  }

  #setState(record: TrackedRequest, state: RequestSnapshot): void {
    if (isTerminalStage(record.state)) return;
    record.state = state;
    // Snapshotted: a listener may synchronously subscribe/unsubscribe (e.g. an SSE stream
    // ending itself), which would otherwise mutate `record.listeners` mid-iteration.
    for (const listener of Array.from(record.listeners)) listener(state);
    if (isTerminalStage(state)) {
      const timer = this.options.clock.setTimer(TERMINAL_RETENTION_MS, () => {
        this.#activeTimers.delete(timer);
        this.#requests.delete(record.id);
      });
      this.#activeTimers.add(timer);
    }
  }
}

/** Structural subset of `LeaseProgress` (`src/core/wait-queue.ts`) -- this module only ever
 * receives it through a dispatched `lease.request`'s session `onProgress` override, never
 * imports the core type directly. */
type HttpLeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };

/**
 * Structural subsets of the *contract's* `lease.request` output shape (`z.infer<leaseGrantSchema>`
 * -- see `schemas.ts`), not core's `DeviceRecord`/`LeaseRecord`: `dispatch()` always returns
 * contract-shaped data (e.g. `spec.full` is optional there, since the schema declares it
 * `.optional()`, where core's own `DeviceSpec.full` is not), and this module never imports core
 * domain types at all -- everything it needs from a grant is these few fields.
 */
interface HttpLeaseDevice {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly spec: { readonly platform: string; readonly model: string; readonly osVersion: string };
  readonly featureProfile?: "full" | "reduced" | undefined;
}

interface HttpLeaseRecord {
  readonly id: string;
  readonly grantedAt: number;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
}

interface HttpLeaseGrant {
  readonly device: HttpLeaseDevice;
  readonly lease: HttpLeaseRecord;
}

function toView(record: TrackedRequest): TrackedRequestView {
  return {
    createdAt: record.createdAtIso,
    id: record.id,
    requesterId: record.requesterId,
    state: record.state,
  };
}

function idempotencyCacheKey(requesterId: string, key: string): string {
  return `${requesterId} ${key}`;
}

function toSeconds(ms: number): number {
  return Math.round(ms / 1_000);
}
