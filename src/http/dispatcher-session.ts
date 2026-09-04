import type { z } from "zod";

import type { DispatchSession } from "../daemon/dispatcher.js";
import type { LeaseProgress } from "../core/index.js";
import type { OPERATIONS, OperationName, Role } from "../contract/index.js";
import type { TokenIdentity, TokenRole } from "./token-store.js";

/**
 * The one method `createHttpApp` needs from `DaemonServer` (ADR §2: "the HTTP app ... calls
 * the same dispatcher in-process"). Structural, not `DaemonServer` itself, so a test can supply
 * any object with a matching `dispatch` -- including `DaemonServer` itself (its public
 * `dispatch` method has exactly this signature) or a `Dispatcher` instance directly.
 */
export type HttpDispatch = <Op extends OperationName>(
  operation: Op,
  input: unknown,
  session: DispatchSession,
) => Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>>;

/** No HTTP request ever holds a lease across calls (every HTTP lease is detached, ADR 0003
 * §2/§9's "the HTTP tracker and notice buffer remain the known stateful leftovers in a
 * frontend" -- held-lease bookkeeping stays a socket-connection concept), so every
 * `DispatchSession` built for an HTTP request shares this same empty, frozen set rather than
 * allocating one per call. */
const NO_HELD_LEASES: ReadonlySet<string> = new Set();

/** ADR §5's socket roles map onto HTTP's pre-existing bearer-token roles one for one: an
 * `operator` token is what already grants HTTP's admin-only routes (`/v1/leases`,
 * `/v1/devices`, `/v1/events`...), so it resolves to the contract's `"admin"`; an `agent`
 * token resolves to `"agent"`. */
function toRole(tokenRole: TokenRole): Role {
  return tokenRole === "operator" ? "admin" : "agent";
}

/**
 * Builds the `DispatchSession` ADR §2's shared dispatcher needs, from one HTTP request's
 * already-verified bearer-token identity. This is the "bearer-token-to-session adapter" ADR §2
 * assigns to the HTTP app: `principal` is the token's `requesterId` (ADR §4: "For HTTP the
 * principal is the token's requester id"), `role` is `identity.role` translated per `toRole`.
 *
 * `onProgress`/`manageEventSubscription` are per-call, not part of the token identity --
 * callers that need either (the lease-request tracker's `onProgress`, the `/v1/events/stream`
 * SSE route's `manageEventSubscription`) pass their own override via `extra`. Every other route
 * gets an inert default: `onProgress` is simply never invoked by any operation but
 * `lease.request`'s handler, and `manageEventSubscription` is only ever invoked by
 * `events.subscribe`/`events.unsubscribe`'s handlers, neither of which any other route
 * dispatches -- an HTTP request that doesn't wire either override never triggers this fallback
 * in practice; it exists only to satisfy `DispatchSession`'s required fields.
 */
export function buildHttpSession(
  identity: TokenIdentity,
  extra?: {
    readonly onProgress?: (progress: LeaseProgress) => void;
    readonly manageEventSubscription?: (subscribe: boolean) => string | undefined;
  },
): DispatchSession {
  return {
    heartbeatCapability: false,
    heldLeaseIds: NO_HELD_LEASES,
    manageEventSubscription: extra?.manageEventSubscription ?? (() => undefined),
    principal: identity.requesterId,
    role: toRole(identity.role),
    ...(extra?.onProgress === undefined ? {} : { onProgress: extra.onProgress }),
  };
}
