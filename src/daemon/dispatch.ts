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

import {
  describeSchemaIssues,
  OPERATIONS,
  type AuthorizeContext,
  type OperationDefinition,
  type OperationName,
  type Role,
  type leaseProgressSchema,
} from "../contract/index.js";

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

// ---- the shared dispatch pipeline ------------------------------------------------------------

/**
 * A handler, erased to `never` input so a lookup table can hold every operation's handler side
 * by side. Each implementation keeps its own strongly-typed handler declarations (see
 * `Dispatcher`'s `Handler<Op>` and the gateway's) and only the table erases them; `runDispatch`
 * casts the already-schema-validated input back to `never` at the one call site that needs it.
 */
export type ErasedHandler = (input: never, session: DispatchSession) => Promise<unknown> | unknown;

export interface DispatchPipeline {
  /** Handler per operation. An operation with no entry answers `UNKNOWN_REQUEST` -- which is
   * how a worker answers `worker.*` and how `daemon.stop` (intercepted by the transport) never
   * reaches a handler. */
  readonly handlers: Partial<Record<OperationName, ErasedHandler>>;
  /** The two live lookups an `authorize` hook needs (ADR 0003 §1's `ownsLease`). A dispatcher
   * with no lease state of its own may leave this out: an absent context answers `undefined`
   * for both lookups, which every hook treats as authorized on purpose, so the handler's own
   * error surfaces instead of a misleading `FORBIDDEN`. */
  readonly authorizeLookups?: Pick<
    AuthorizeContext,
    "leaseRequesterId" | "ownerId" | "pendingRequestOwner"
  >;
  /** ADR 0003 §2 step 4: every operation but `status.get` parks here before its handler runs.
   * Omitted when there is nothing to wait for. */
  readonly awaitReady?: () => Promise<void>;
  /** Called when a handler's result fails its contract output schema -- always a daemon-side
   * bug, so both implementations log it before the caller sees a generic `INTERNAL`. */
  readonly onOutputMismatch?: (operation: string, issues: readonly unknown[]) => void;
}

/**
 * ADR 0003 §2's ordering, once, for both implementations of the contract: parse input, role
 * check, `authorize` hook, park on startup readiness, call handler, parse output. Handlers
 * never see a raw payload or run their own role/ownership check -- both already happened by
 * the time a handler's body runs.
 *
 * Shared rather than copied because it *is* the contract's enforcement: a gateway that checked
 * roles slightly differently from a worker would be a second contract wearing the first one's
 * name (§32 says the gateway is a second set of handlers, and nothing else).
 */
export async function runDispatch<Op extends OperationName>(
  operation: Op,
  rawInput: unknown,
  session: DispatchSession,
  pipeline: DispatchPipeline,
): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
  // "Generic-over-a-closed-union" cast: `OPERATIONS[operation]` for a generic `Op` collapses to
  // a union across every operation, and TypeScript refuses to call a union of functions
  // (`.role`, `.authorize`) with a generically-typed argument even though each concrete
  // instantiation is sound. `OPERATIONS` is a closed, exhaustively-typed record validated by
  // its own test suite -- this cast trusts that shape, not the runtime, unlike `input as never`
  // below (which truly is unverified until `parseDispatchInput` runs).
  const definition = OPERATIONS[operation] as unknown as OperationDefinition;
  const handler = pipeline.handlers[operation];
  if (handler === undefined) {
    throw new DispatchError("UNKNOWN_REQUEST", `Unknown request type: ${operation}`);
  }

  const input = parseDispatchInput(definition.input, rawInput ?? {});
  const requiredRole: Role =
    typeof definition.role === "function" ? definition.role(input) : definition.role;
  if (!roleSatisfies(session.role, requiredRole)) {
    throw new DispatchError(
      "FORBIDDEN",
      `Operation ${operation} requires role ${requiredRole}, session is ${session.role}`,
    );
  }
  if (definition.authorize !== undefined) {
    const context: AuthorizeContext = {
      leaseRequesterId: pipeline.authorizeLookups?.leaseRequesterId ?? (() => undefined),
      ownerId: pipeline.authorizeLookups?.ownerId ?? (() => undefined),
      pendingRequestOwner: pipeline.authorizeLookups?.pendingRequestOwner ?? (() => undefined),
      principal: session.principal,
      role: session.role,
    };
    if (!definition.authorize(input, context)) {
      throw new DispatchError("FORBIDDEN", `Not authorized for ${operation}`);
    }
  }

  if (operation !== "status.get") {
    await pipeline.awaitReady?.();
  }

  const output = await handler(input as never, session);
  return parseDispatchOutput(
    definition.output,
    output,
    operation,
    pipeline.onOutputMismatch,
  ) as z.infer<(typeof OPERATIONS)[Op]["output"]>;
}

export function roleSatisfies(sessionRole: Role, required: Role): boolean {
  return sessionRole === "admin" || required === "agent";
}

export function parseDispatchInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DispatchError("BAD_REQUEST", describeSchemaIssues(result.error.issues));
}

/**
 * Validates a handler's return value against its contract output schema before it goes on the
 * wire. A mismatch is always a daemon-side bug (the schema or the mapping is wrong -- never
 * loosen the schema to whatever happens to be emitted), so it is reported to
 * `onOutputMismatch` and then thrown as a plain `Error`, which maps to `INTERNAL`. `.parse`
 * is deliberately non-strict: an additive field a handler starts returning before its schema
 * declares it is dropped, not a failure -- only a missing or mistyped *declared* field is a
 * bug worth failing loudly over.
 */
export function parseDispatchOutput<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  operationName: string,
  onMismatch?: (operation: string, issues: readonly unknown[]) => void,
): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  onMismatch?.(operationName, result.error.issues);
  throw new Error(
    `Internal: ${operationName} produced a response that does not match its contract output schema`,
  );
}
