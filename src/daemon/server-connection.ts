import type { z } from "zod";

import type { Role } from "../contract/index.js";
import { type RequestId, serializeFrame } from "../daemon-protocol/index.js";
import type { LinkConnection } from "../link/index.js";
import type { IpcConnection, Logger } from "../ports/index.js";
import type { RelayConnection } from "./relay.js";

export interface Connection {
  readonly socket: IpcConnection;
  /**
   * why: Detaches this connection's request-scoped pushes (`progress` for an in-flight
   * `lease.request`, `output` for an in-flight `device.exec`) when the socket goes away, so a
   * push callback that outlives the connection writes nothing instead of throwing into whatever
   * operation is still running. One set for both families: they are disposed for the same
   * reason and at the same moment.
   */
  readonly progressDisposers: Set<() => void>;
  readonly relays: RelayConnection;
  buffer: string;
  helloReceived: boolean;
  closed: boolean;
  principal: string;
  role: Role;
  /**
   * why: Set only for a connection accepted through `acceptUplink` (ADR 0005 §5): the role that
   * connection gets, decided by *how it was accepted* rather than by anything in its `hello`.
   * `Handshake.handle` uses it in place of the role resolver, so no credential is consulted and none
   * is required. See `acceptUplink`'s own comment for why that is the correct trust model
   * here and nowhere else.
   */
  readonly forcedRole: Role | undefined;
  /**
   * why: H3 (round 3 review, narrowed further): set only by `acceptUplink`, and only there -- a
   * dedicated fact about *how this connection was accepted*, not derived from `forcedRole`.
   * Before this, `DaemonServer#session` read `forcedRole !== undefined` as the proxy for "this is the
   * worker's own uplink to its configured gateway", which happened to be true only because
   * `acceptUplink` is `#accept`'s one caller that ever sets `forcedRole` at all -- a future
   * `#accept(socket, "agent")` (or any other forced role added for an unrelated reason) would
   * silently satisfy that same check and reopen ADR §27a's `owner` gate to whatever forced that
   * connection, with no test failing to say so. This field is set directly, once, at the one call
   * site that is actually the uplink, so a future forced role elsewhere cannot be mistaken for it.
   */
  readonly isGatewayUplink: boolean;
  // why: set with `isGatewayUplink`; the link accepts the byte channels a relay names (ADR 0028).
  readonly link: LinkConnection | undefined;
  /**
   * why: Lease ids this connection is *currently* explicitly releasing (`lease.release`/
   * `lease.release-all`), added right before the dispatched call and consumed by
   * `ConnectionPushes.notifyLeaseLost`. ADR 0003 §8 says a client "never fires `onLeaseLost` for a release the
   * same client asked for", and pushes are owner-routed to every connection sharing a
   * principal, so the suppression has to be by connection identity: skipping by principal
   * would wrongly skip every *other* live connection owning the lease. This is the only
   * lease-shaped state a connection still keeps, and it lives for the duration of one
   * dispatched call rather than for the lease's lifetime -- ADR 0004 §3 deletes the held set
   * that used to sit beside it.
   */
  readonly selfInitiatedReleases: Set<string>;
  /** why: Set by `Handshake.handle` only when this connection's `hello` failed protocol-version
   * negotiation (ADR 0003 §6). `principal`/`role` are still resolved and fixed as normal --
   * the frozen exception is scoped to the protocol-version gate, not to authentication or role
   * (see the comment on `DaemonServer#dispatchLine`'s `daemon.stop` handling). While set, every operation on
   * this connection except `daemon.stop` is refused by replaying this same error, so a client
   * whose range does not overlap the daemon's still learns why on every attempt, not just the
   * first. */
  protocolMismatch: { readonly message: string; readonly details: unknown } | undefined;
  unsubscribeEvents: (() => void) | undefined;
  /** why: Set while this connection has an active `events.subscribe`; correlates `event` pushes
   * (ADR 0003 §8). Minted per-subscription from `ConnectionPushes`' `#eventSubscriptionSeq` rather than injected --
   * `DaemonServer` has no `IdGenerator` dependency today, and this only needs to be unique per
   * connection lifetime, not globally unpredictable. */
  subscriptionId: string | undefined;
}

export async function respondError(
  socket: IpcConnection,
  id: RequestId | null,
  code: string,
  message: string,
  details?: unknown,
): Promise<void> {
  await writeFrame(socket, {
    error: { code, message, ...(details === undefined ? {} : { details }) },
    id,
    ok: false,
  });
}

/**
 * why: Validates a handler's return value against its contract output schema before it goes on
 * the wire. A mismatch here is always a daemon-side bug (the schema or the mapping is wrong,
 * per the PR brief -- never loosen the schema to whatever happens to be emitted), so it is
 * logged at error level with the full issue list, then rethrown as a plain `Error` (maps to
 * `INTERNAL` in `errorCode`). Two things follow from throwing rather than silently coercing:
 * a unit test that asserts a happy-path response fails loudly the moment a handler and its
 * schema drift, and a production caller gets a controlled `INTERNAL` response instead of
 * either a malformed payload or an unhandled exception tearing down the connection. `.parse`
 * (not `.strict()`) is deliberately non-strict here: an additive field a handler starts
 * returning before its schema is updated to include it is silently dropped, not a failure --
 * only a missing/mistyped *declared* field is a bug worth failing loudly over.
 */
export function parseOutput<Output>(
  logger: Logger,
  schema: z.ZodType<Output>,
  value: unknown,
  operationName: string,
): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  logger.error("Operation output failed contract validation", {
    operation: operationName,
    issues: result.error.issues,
  });
  throw new Error(
    `Internal: ${operationName} produced a response that does not match its contract output schema`,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/**
 * why: A frame for a peer that has gone is dropped, never rejected. Once the peer's FIN arrives the
 * socket fails every write with EPIPE, but `closed` stays false until the socket is destroyed.
 * Most pushes are fired without a catch, so a write in that window would reject unhandled and
 * take the daemon down, failing every lease request still waiting.
 */
export function writeFrame(socket: IpcConnection, frame: unknown): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return socket.write(serializeFrame(frame)).catch(() => undefined);
}
