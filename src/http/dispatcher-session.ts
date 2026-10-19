import type { z } from "zod";

import type { DispatchSession } from "../daemon/dispatcher.js";
import type { LeaseProgress } from "../core/index.js";
import { OPERATIONS } from "../contract/index.js";
import type { ComponentProgress, OperationName, Role } from "../contract/index.js";
import type { Identity } from "../auth/index.js";

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
function toRole(identityRole: Identity["role"]): Role {
  return identityRole === "operator" ? "admin" : "agent";
}

const VIA_VALUES = OPERATIONS["identity.get"].output.shape.via.options;

function toVia(via: string): DispatchSession["via"] {
  const known = VIA_VALUES.find((value) => value === via);
  if (known === undefined) throw new Error(`Unknown identity via: ${via}`);
  return known;
}

// why: `onProgress` and the like are per-call, not part of the identity, so the routes that need one pass an override in `extra`; every other route gets inert defaults that no operation it dispatches ever calls.

export function buildHttpSession(
  identity: Identity,
  extra?: {
    readonly onProgress?: (progress: LeaseProgress) => void;
    /** The lease-request route's own override: the stored request's id, the moment the daemon
     * admits the request (or finds the stored one a repeat names). Inert for every other route. */
    readonly onRequestAdmitted?: (requestId: string, replayed: boolean) => void;
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
     * chunk, so a command that prints nothing still gets a `200` and its keepalives. The
     * component install route opens its stream here too, once the install has admitted the
     * call (ADR 0010 §6). */
    readonly onStarted?: () => void;
    /** ADR 0010 §6: the component install route's own override -- each update becomes one SSE
     * `progress` event on that request's response, with `workerId` when a gateway relayed it
     * from a worker (§7). Inert for every other route. */
    readonly onComponentProgress?: (progress: ComponentProgress, workerId?: string) => void;
    readonly manageEventSubscription?: (subscribe: boolean) => string | undefined;
  },
): DispatchSession {
  return {
    manageEventSubscription: extra?.manageEventSubscription ?? (() => undefined),
    principal: identity.principal,
    name: identity.name,
    role: toRole(identity.role),
    via: toVia(identity.via),
    ...(extra?.onProgress === undefined ? {} : { onProgress: extra.onProgress }),
    ...(extra?.onRequestAdmitted === undefined
      ? {}
      : { onRequestAdmitted: extra.onRequestAdmitted }),
    ...(extra?.onOutput === undefined ? {} : { onOutput: extra.onOutput }),
    ...(extra?.onStarted === undefined ? {} : { onStarted: extra.onStarted }),
    ...(extra?.onComponentProgress === undefined
      ? {}
      : { onComponentProgress: extra.onComponentProgress }),
  };
}
