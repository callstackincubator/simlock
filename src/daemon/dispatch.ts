/**
 * The transport-facing half of ADR 0003 §2's dispatcher: the session a transport hands to
 * `dispatch()`, the rejection a dispatcher throws, and the `dispatch()` signature itself.
 *
 * These three declarations live in their own module -- rather than beside the worker's
 * `Dispatcher` in `dispatcher.ts` -- because ADR 0005 §32 gives the contract a *second*
 * implementation: `src/gateway/`'s handlers read worker views and forward over uplinks instead
 * of calling `core`. Both implementations are reached by the same transports (the socket
 * server, the HTTP app), so both need this vocabulary, and the gateway must be able to import
 * it without importing `src/core` through the back door -- which is exactly what importing
 * `dispatcher.ts` would do (see `src/gateway/boundary.test.ts`).
 *
 * Nothing here imports from `src/core`, `src/drivers`, or `src/http`; the contract module and
 * its zod-inferred types are the whole dependency surface.
 */
import type { z } from "zod";

import type { OPERATIONS, OperationName, Role, leaseProgressSchema } from "../contract/index.js";

/**
 * Request-scoped progress, as the contract declares it. Structurally identical to `core`'s own
 * `LeaseProgress` (src/core/wait-queue.ts) -- the worker's dispatcher passes one straight
 * through to the other -- but named from the contract here so this module stays core-free.
 */
export type DispatchProgress = z.infer<typeof leaseProgressSchema>;

/**
 * ADR 0003 §2's "session" argument to `dispatch`. Constructed fresh per call by the transport
 * (`DaemonServer`, one per socket request; the HTTP app, one per HTTP request) from whatever
 * longer-lived state it owns -- this type does not itself track anything across calls.
 *
 * `principal`/`role` are the ADR §4/§5 identity: fixed for the connection's lifetime once
 * `hello` resolves them (see `session.ts`'s `SessionRoleResolver` seam). ADR 0004 removed the
 * two connection-scoped fields that used to sit beside them (`heldLeaseIds`,
 * `heartbeatCapability`): the daemon keeps no per-connection lease state at all any more.
 * `onProgress` and `manageEventSubscription` are the two places a request-scoped or
 * connection-scoped push actually reaches the wire -- `DaemonServer` supplies closures that
 * write socket frames; an HTTP session can leave `onProgress` unset and no-op on
 * `events.subscribe`, since HTTP has no open connection to push through even in principle
 * (ADR §8's "the HTTP notice buffer stays").
 */
export interface DispatchSession {
  readonly principal: string;
  readonly role: Role;
  /** Called for each progress update while this specific `lease.request` call is in flight.
   * Ignored by every other operation. */
  readonly onProgress?: (progress: DispatchProgress) => void;
  /**
   * Called for each chunk a `device.exec` command writes, as it writes it (ADR 0005 §19a's
   * `output` push family). Ignored by every other operation, and left unset by a transport
   * that has nowhere to put a chunk -- in which case the command still runs and still reports
   * its exit code, and the output is simply not relayed. The same shape as `onProgress`, for
   * the same reason: both are request-scoped pushes, and the dispatcher stays out of framing.
   *
   * **May return a promise**, and the command is stopped at its pipe until that resolves (see
   * `ProcessStreamOptions.onChunk`). A transport returns one when placing a chunk is not
   * instantaneous -- an SSE write, a socket frame -- so a client that reads slowly slows the
   * command rather than filling this process with its output (§19e).
   */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  /**
   * Called once, for a `device.exec` call, the moment its process is running -- after every
   * failure that can happen *before* one exists (a refused verb, an unknown tool, an unowned
   * lease, a daemon still starting) and before any output. A transport that has to commit to
   * a response shape uses it as the decision point: HTTP opens its event stream here, so a
   * command that prints nothing for nine minutes still gets its `200` and its keepalives, and
   * an `EXEC_TIMEOUT` always arrives as that stream's terminal event rather than as a status
   * code the client cannot receive any more (ADR 0005 §19e).
   */
  readonly onStarted?: () => void;
  /** `events.subscribe`/`events.unsubscribe` stay push-shaped (ADR §2: "pushes" stay with the
   * transport), so the dispatcher's handler for them does nothing but call this: `true` to
   * (re)subscribe, returning the new subscription id; `false` to tear an existing one down. */
  readonly manageEventSubscription: (subscribe: boolean) => string | undefined;
}

/** Thrown for a role/ownership rejection or a malformed request; `DaemonServer` maps this the
 * same way it already maps its own protocol errors (see `errorCode` in `server.ts`), and
 * `classifyError` trusts its `code` verbatim (see `error-code.ts`). */
export class DispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * What a transport needs from a dispatcher, and all it needs: one call that takes an operation
 * name, a raw input, and a session. `Dispatcher` (worker, `dispatcher.ts`) and
 * `GatewayDispatcher` (`src/gateway/dispatcher.ts`) both satisfy it, which is what lets
 * `DaemonServer` serve either without knowing which mode it is running in (ADR 0005 §32:
 * "the gateway is a second implementation of the daemon contract's handlers, not a second
 * contract").
 */
export interface ContractDispatcher {
  dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>>;
}
