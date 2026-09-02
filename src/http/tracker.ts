import type { EventBus } from "../bus/index.js";
import {
  type DeviceRecord,
  type DeviceRequest,
  type LeaseRecord,
  RequestCancelledError,
} from "../core/index.js";
import type { LeaseCommands, QueueControl } from "../core/lease-ports.js";
import type { LeaseGrant, LeaseProgress, LeaseRequestOptions } from "../core/wait-queue.js";
import type { Clock, IdGenerator, Logger, TimerHandle } from "../ports/index.js";
import { mapError } from "./errors.js";

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
 * `LeaseRecord` has no `createdAt` -- `grantedAt` is its equivalent. `ttlMs` must be supplied
 * by the caller (the tracker's record of what was applied at grant or last renew, or the
 * lease's mode default when that record is gone, e.g. after a daemon restart). It is never
 * derived as `ttlDeadline - grantedAt`: `grantedAt` never moves on renewal, so that
 * arithmetic reports grant-age plus TTL rather than the interval actually in force --
 * `expiresAt` is the authoritative deadline either way.
 */
export function buildLeasePayload(
  device: DeviceRecord,
  lease: LeaseRecord,
  extra: { readonly requestId?: string; readonly ttlMs: number },
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
    ttlMs: extra.ttlMs,
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
  readonly leases: LeaseCommands;
  readonly queue: QueueControl;
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** `lease.detachedTtlMs` -- every HTTP lease is detached, so this is the one mode default that applies. */
  readonly defaultTtlMs: number;
  readonly logger?: Logger;
}

/**
 * Gateway-layer resource tracking for `POST /v1/lease-requests`. Calls `LeaseCommands.request`
 * with an `onProgress` callback and never awaits its returned promise directly -- `submit`
 * returns as soon as the request resource exists, matching "acquisition is an async resource,
 * no long-blocking POST" from the issue's design principles. `GET`, long-poll, and SSE all
 * read the same in-memory state this class owns; no core changes were needed to observe it.
 */
export class LeaseRequestTracker {
  readonly #requests = new Map<string, TrackedRequest>();
  readonly #idempotency = new Map<string, { requestId: string; timer: TimerHandle }>();
  readonly #leaseRequestId = new Map<string, string>();
  readonly #leaseTtlMs = new Map<string, number>();
  readonly #unsubscribers: Array<() => void>;
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

  constructor(private readonly options: LeaseRequestTrackerOptions) {
    this.#unsubscribers = [
      options.eventBus.subscribe("lease.released", (envelope) => {
        this.#leaseRequestId.delete(envelope.payload.leaseId);
        this.#leaseTtlMs.delete(envelope.payload.leaseId);
      }),
      options.eventBus.subscribe("lease.expired", (envelope) => {
        this.#leaseRequestId.delete(envelope.payload.leaseId);
        this.#leaseTtlMs.delete(envelope.payload.leaseId);
      }),
    ];
  }

  submit(
    identity: { readonly requesterId: string },
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
      // Best-effort snapshot of current queue depth: on the "admitted, still queued" path
      // below this is superseded by the first real `onProgress` call before the POST response
      // is even built, so it only matters for the sliver of time before that.
      requesterId: identity.requesterId,
      state: { queuePosition: this.options.queue.queueDepth + 1, stage: "queued" },
    };
    this.#requests.set(id, record);
    this.#registerIdempotency(identity.requesterId, idempotencyKey, id);

    const deviceRequest: DeviceRequest = {
      model: body.device,
      platform: body.platform,
      ...(body.os === undefined ? {} : { osVersion: body.os }),
      ...(body.full === undefined ? {} : { full: body.full }),
    };

    // Races the grant/rejection against the request's *first* progress callback. A rejection
    // that lands before any progress call (already-leased, unresolvable model/runtime/driver,
    // no-capacity-with-noWait -- see `LeaseAcquisitionCoordinator#request`/`#resolveAndDrive`)
    // never reached anything the queue considers "in flight", so the POST itself can fail with
    // the matching HTTP status instead of the caller polling a request resource just to learn
    // that. Once a progress callback fires (or a grant lands without ever needing one, e.g. an
    // immediately-ready device), the request is a genuine async resource and always answers
    // 201 -- from here on, failures surface only as the resource's terminal `failed` state.
    return new Promise((resolve) => {
      let settled = false;
      const settleCreated = () => {
        if (settled) return;
        settled = true;
        resolve({ kind: "created", view: toView(record) });
      };

      const requestOptions: LeaseRequestOptions = {
        mode: "detached",
        onProgress: (progress) => {
          this.#applyProgress(record, progress);
          settleCreated();
        },
        requesterId: identity.requesterId,
        ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
        ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
        ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      };

      this.options.leases
        .request(deviceRequest, requestOptions)
        .then(async (grant) => {
          await this.#applyGrant(record, grant, body.ttlMs);
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
   * Cancels a pending request. Reuses `QueueControl.cancelPending`'s safety envelope exactly
   * (see its own docs): only a request still queued -- no device work claimed for it yet -- is
   * cancellable. The terminal state is applied here, synchronously with the queue's answer,
   * rather than waiting for the rejected `LeaseCommands.request` promise's `.catch` to run on a
   * later microtask -- a caller awaiting `cancel()` must see the settled state immediately.
   */
  async cancel(id: string): Promise<CancelOutcome> {
    const record = this.#requests.get(id);
    if (record === undefined) return { kind: "not-found" };
    const stateBefore = record.state;
    if (stateBefore.stage === "granted")
      return { kind: "not-cancellable", leaseId: stateBefore.lease.id };
    if (isTerminalStage(stateBefore)) return { kind: "not-cancellable" };

    const outcome = await this.options.queue.cancelPending(record.requesterId);
    if (outcome === "cancelled") {
      this.#setState(record, { stage: "cancelled" });
      return { kind: "cancelled" };
    }
    // Settled between the check above and this call (e.g. granted in the interim) -- report
    // the now-current state rather than a stale answer. Read fresh rather than reusing
    // `stateBefore`: the object identity is the same, but its `stage` may have moved on
    // during the `await` above.
    const stateAfter = record.state;
    if (stateAfter.stage === "granted")
      return { kind: "not-cancellable", leaseId: stateAfter.lease.id };
    return { kind: "not-cancellable" };
  }

  /** The tracker's own record of the ttl actually applied to a lease it granted (grant or renew). */
  effectiveTtlMs(leaseId: string): number | undefined {
    return this.#leaseTtlMs.get(leaseId);
  }

  /** Updates the tracked ttl after a direct (non-tracker) renew, e.g. `POST /v1/leases/:id/renew`. */
  recordLeaseTtl(leaseId: string, ttlMs: number): void {
    this.#leaseTtlMs.set(leaseId, ttlMs);
  }

  requestIdForLease(leaseId: string): string | undefined {
    return this.#leaseRequestId.get(leaseId);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
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
    // The mapping outlived the request's own 5-minute retention: treat this as a fresh key
    // rather than returning nothing -- `submit`'s caller falls through to creating a new
    // request, and `RequesterAlreadyLeasedError` remains the real backstop against a double
    // grant if the original request had already succeeded.
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

  #applyProgress(record: TrackedRequest, progress: LeaseProgress): void {
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

  async #applyGrant(
    record: TrackedRequest,
    grant: LeaseGrant,
    ttlMs: number | undefined,
  ): Promise<void> {
    let lease = grant.lease;
    let effectiveTtlMs = this.options.defaultTtlMs;
    if (ttlMs !== undefined) {
      try {
        // `LeaseRequestOptions` carries no ttl -- a detached grant always lands on
        // `lease.detachedTtlMs` (see `LeaseLifecycle#ttlFor`). A caller-specified `ttlMs` in
        // the request body is applied with an explicit renew right after grant; see the class
        // doc and this session's report for what was investigated here.
        lease = await this.options.leases.renew(lease.id, ttlMs);
        effectiveTtlMs = ttlMs;
      } catch (error: unknown) {
        this.options.logger?.warn(
          "Requested ttlMs was not applied; lease keeps the default deadline",
          {
            leaseId: lease.id,
            message: error instanceof Error ? error.message : String(error),
            requestedTtlMs: ttlMs,
          },
        );
        // Renewing a lease that was just granted failing would be surprising; fall back to the
        // grant's own (config-default) deadline rather than losing the lease record entirely.
        // `effectiveTtlMs` deliberately stays at the default: the payload must report the ttl
        // actually in force, not the one that failed to apply.
      }
    }
    this.#leaseRequestId.set(lease.id, record.id);
    this.#leaseTtlMs.set(lease.id, effectiveTtlMs);
    this.#setState(record, {
      lease: buildLeasePayload(grant.device, lease, {
        requestId: record.id,
        ttlMs: effectiveTtlMs,
      }),
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
