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
    /** ADR 0005 §19a: the `POST /v1/leases/{id}/exec` route's own override -- each chunk
     * becomes one SSE `output` event on that request's response. Same per-call shape as
     * `onProgress`, and inert for every other route for the same reason.
     *
     * **May return a promise**, matching `DispatchSession.onOutput` exactly (not just
     * assignable to it): the route's own implementation genuinely returns the SSE write's
     * promise, which is what pauses the command at its pipe until the chunk has actually gone
     * out (ADR 0005 §19e's backpressure, end to end). A narrower `=> void` here still lets
     * that implementation through structurally, since `void` accepts an ignored return value --
     * so this type is where the property is defined that a future implementation still returns
     * a promise, not just a hope that it will. */
    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
    /** ADR 0005 §19e: the exec route opens its event stream here rather than on the first
     * chunk, so a command that prints nothing still gets a `200` and its keepalives. */
    readonly onStarted?: () => void;
    readonly manageEventSubscription?: (subscribe: boolean) => string | undefined;
  },
): DispatchSession {
  return {
    manageEventSubscription: extra?.manageEventSubscription ?? (() => undefined),
    principal: identity.requesterId,
    role: toRole(identity.role),
    ...(extra?.onProgress === undefined ? {} : { onProgress: extra.onProgress }),
    ...(extra?.onOutput === undefined ? {} : { onOutput: extra.onOutput }),
    ...(extra?.onStarted === undefined ? {} : { onStarted: extra.onStarted }),
  };
}
