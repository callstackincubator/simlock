import type { z } from "zod";

import { leaseRequestRecordSchema } from "../contract/index.js";
import type { Clock } from "../ports/index.js";
import { buildHttpSession } from "./dispatcher-session.js";
import type { HttpDispatch } from "./dispatcher-session.js";
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
  /** ADR §27a. Threaded straight through to the shared dispatcher's own `lease.request` input --
   * the same gate every other transport is held to (`FORBIDDEN` for a non-admin token) decides
   * this, not this route (H7, round 2 review: before this, `leaseRequestBodySchema` had no
   * `owner` field at all and quietly discarded one a caller sent, the anti-pattern this
   * codebase's own `device.exec`'s `requesterId` precedent already rejected for the same reason
   * -- an identity named and answered as though it had not been is the kind of silence that
   * reads like authorization). */
  readonly owner?: string;
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
  /** The principal that sent the request -- what reading or cancelling it is authorized on. */
  readonly ownerId: string;
  readonly createdAt: string;
  readonly state: RequestSnapshot;
}

export type CancelOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-cancellable"; readonly leaseId?: string };

/**
 * The daemon's stored lease requests, as this resource reads them: a worker's `LeaseEngine`
 * request book, or a gateway's fleet coordinator's. `record` is read through the contract's
 * `leaseRequestRecordSchema` rather than trusted, because the two backends store different grant
 * types and this module names neither.
 */
export interface LeaseRequestReader {
  get(
    id: string,
  ): { readonly record: unknown; readonly progress?: HttpLeaseProgress | undefined } | undefined;
  watch(id: string, listener: () => void): (() => void) | undefined;
  requestIdForLease(leaseId: string): string | undefined;
}

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
  readonly requests: LeaseRequestReader;
  readonly clock: Clock;
}

/**
 * `POST /v1/lease-requests` and the routes that read it back. The request itself is the daemon's
 * stored record -- this class holds no request state of its own, so a request answers `GET`
 * across a daemon restart and whichever frontend sent it. What lives here is the HTTP shape:
 * deciding when a `POST` answers `201` rather than an error, and turning a stored record and
 * its live progress into the resource's states.
 */
export class LeaseRequestTracker {
  constructor(private readonly options: LeaseRequestTrackerOptions) {}

  /**
   * Answers `created` once the daemon has stored the request and either reported progress, or
   * granted it, or -- for `allowDownload`, whose spec resolution can run for minutes before any
   * progress -- as soon as it is stored. A rejection that lands before any of those fails the
   * `POST` itself, so a client is not made to poll a resource just to learn it was refused; the
   * stored failure still answers a repeat of the request.
   */
  submit(
    identity: TokenIdentity,
    body: LeaseRequestInput,
    idempotencyKey?: string,
  ): Promise<
    | { readonly kind: "created"; readonly view: TrackedRequestView }
    | { readonly kind: "rejected"; readonly error: unknown }
  > {
    return new Promise((resolve) => {
      let requestId: string | undefined;
      let settled = false;
      const settleCreated = (state?: RequestSnapshot): void => {
        if (settled || requestId === undefined) return;
        const view = this.get(requestId);
        if (view === undefined) return;
        settled = true;
        resolve({ kind: "created", view: state === undefined ? view : { ...view, state } });
      };

      const session = buildHttpSession(identity, {
        onProgress: () => settleCreated(),
        onRequestAdmitted: (id) => {
          requestId = id;
          if (body.allowDownload === true) settleCreated();
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
            // ADR §27a (H7, round 2 review): forwarded as-is -- the shared dispatcher's own
            // `lease.request` handler is what rejects a non-admin token naming this.
            ...(body.owner === undefined ? {} : { owner: body.owner }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          session,
        )
        .then(
          // The grant answers before its record is written (the daemon stores the result
          // once the wait settles), so the `201` is built from the grant itself.
          (grant) =>
            settleCreated({
              lease: buildLeasePayload(
                grant.device,
                grant.lease,
                requestId === undefined ? {} : { requestId },
              ),
              stage: "granted",
            }),
          (error: unknown) => {
            if (settled) return;
            settled = true;
            resolve({ kind: "rejected", error });
          },
        );
    });
  }

  get(id: string): TrackedRequestView | undefined {
    const found = this.options.requests.get(id);
    if (found === undefined) return undefined;
    const parsed = leaseRequestRecordSchema.safeParse(found.record);
    if (!parsed.success) return undefined;
    return toView(parsed.data, found.progress);
  }

  /** Registers a listener for future state changes only -- it does not fire for the current state. */
  subscribe(id: string, listener: (state: RequestSnapshot) => void): (() => void) | undefined {
    return this.options.requests.watch(id, () => {
      const view = this.get(id);
      if (view !== undefined) listener(view.state);
    });
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
    const initial = this.get(id);
    if (initial === undefined) return Promise.resolve(undefined);
    if (isTerminalStage(initial.state)) return Promise.resolve(initial);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        this.options.clock.cancel(timer);
        resolve(this.get(id) ?? initial);
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
   * pending request by requester id"). The request book reports a cancelled wait as cancelled
   * from the moment it is rejected, before the record is written, so a `GET` right after the
   * `204` already reads `cancelled`.
   */
  async cancel(id: string, identity: TokenIdentity): Promise<CancelOutcome> {
    const before = this.get(id);
    if (before === undefined) return { kind: "not-found" };
    if (before.state.stage === "granted")
      return { kind: "not-cancellable", leaseId: before.state.lease.id };
    if (isTerminalStage(before.state)) return { kind: "not-cancellable" };

    const session = buildHttpSession(identity);
    const { result } = await this.options.dispatch(
      "lease.cancel",
      { requesterId: before.requesterId },
      session,
    );
    if (result === "cancelled") return { kind: "cancelled" };
    // Settled between the check above and this call (e.g. granted in the interim) -- report
    // the now-current state rather than a stale answer.
    const after = this.get(id)?.state;
    if (after?.stage === "granted") return { kind: "not-cancellable", leaseId: after.lease.id };
    return { kind: "not-cancellable" };
  }

  requestIdForLease(leaseId: string): string | undefined {
    return this.options.requests.requestIdForLease(leaseId);
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

type StoredRequest = z.infer<typeof leaseRequestRecordSchema>;

function toView(
  record: StoredRequest,
  progress: HttpLeaseProgress | undefined,
): TrackedRequestView {
  return {
    createdAt: new Date(record.createdAt).toISOString(),
    id: record.id,
    ownerId: record.ownerId,
    requesterId: record.requesterId,
    state: toSnapshot(record, progress),
  };
}

function toSnapshot(
  record: StoredRequest,
  progress: HttpLeaseProgress | undefined,
): RequestSnapshot {
  if (record.state === "granted" && record.grant !== undefined) {
    return {
      lease: buildLeasePayload(record.grant.device, record.grant.lease, { requestId: record.id }),
      stage: "granted",
    };
  }
  if (record.state === "cancelled") return { stage: "cancelled" };
  if (record.state !== "open") {
    return {
      error: record.failure ?? { code: "INTERNAL", message: "Internal error" },
      stage: "failed",
    };
  }
  // Open with no progress reported yet: the request is admitted and about to queue.
  if (progress === undefined) return { queuePosition: 1, stage: "queued" };
  if (progress.stage === "queued")
    return { queuePosition: progress.queuePosition, stage: "queued" };
  return { etaSeconds: toSeconds(progress.etaMs), stage: progress.stage };
}

function toSeconds(ms: number): number {
  return Math.round(ms / 1_000);
}
