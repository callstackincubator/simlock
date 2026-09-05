import {
  isSimlockError,
  SimlockError,
  type LeaseProgress,
  type LeaseRecord,
  type LeaseRequestInput,
  type SimlockClient,
} from "../client/index.js";
import {
  awaitWithin,
  RELEASE_TIMEOUT_MS,
  startLeaseRenewal,
  type LeaseRenewal,
} from "../lease-policy/index.js";
import type { Clock } from "../ports/index.js";
import type {
  LeaseSimulatorInput,
  LeaseSimulatorOutput,
  LeaseStatusOutput,
  ListDevicesInput,
  ListDevicesOutput,
  ReleaseSimulatorInput,
  ReleaseSimulatorOutput,
} from "./contracts.js";

/**
 * How many ended leases `#announceLeaseLost` remembers, to keep one ending from reaching a
 * listener twice. Generous: a session holds one lease at a time in practice, so this is only
 * ever reached by a session that has churned through many.
 */
const ANNOUNCED_LOST_LIMIT = 64;

export interface McpSessionOptions {
  /**
   * The `Clock` port (architecture rule 9): the session's renew timer and `close()`'s release
   * bound both run on it, so tests drive them by hand.
   */
  readonly clock: Clock;
  /**
   * Opens one connection and completes the `hello` handshake, fixing this session's principal
   * for the connection's lifetime (ADR 0003 §4). Called again -- building a brand new client,
   * never reusing or repairing the dead one -- on reconnect: the typed client "does not
   * reconnect and does not retry" (ADR §10), so that policy has to live here. This is the
   * tool-call trigger, and it may auto-launch a daemon that is not running.
   */
  readonly connect: () => Promise<SimlockClient>;
  /**
   * The renew timer's own connect (ADR 0004 §2): same handshake, but it only ever reaches a
   * daemon that is **already listening** and never launches one. An idle session should not
   * lose its lease waiting for a tool call that may never come; an operator's `simlock daemon
   * stop` must not be undone by that same idle session. Both are true only because the two
   * triggers have deliberately different powers -- see `#renewHeldLease`.
   */
  readonly connectForRenew: () => Promise<SimlockClient>;
}

export interface McpErrorResult {
  readonly code: string;
  readonly message: string;
}

/** Delivered to `onLeaseLost` listeners when this session's held lease ends elsewhere. */
export interface LeaseLostNotice {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly reason: string;
}

/**
 * Delivered to `onDeviceHealth` listeners when this session's held lease's device crashed and
 * was rebooted under the same lease. Unlike `LeaseLostNotice`, the lease is NOT ended -- the
 * session keeps owning it, but whatever it had running inside the device did not survive.
 */
export type DeviceHealthNotice =
  | {
      readonly deviceId: string;
      readonly kind: "unhealthy";
      readonly leaseId: string;
      readonly reason: "crashed";
    }
  | {
      readonly attempts: number;
      readonly deviceId: string;
      readonly kind: "recovered";
      readonly leaseId: string;
    };

/** Delivered to a `lease()` call's own `onProgress` callback while that request is in flight. */
export type LeaseProgressNotice = LeaseProgress;

class McpSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpSessionError";
  }
}

export function toMcpErrorResult(error: unknown): McpErrorResult {
  if (isSimlockError(error)) return { code: error.code, message: error.message };
  if (error instanceof McpSessionError) return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: "Simlock could not complete the request" };
}

/**
 * MCP's own connection lifecycle and tool surface (ADR §11: "MCP keeps only connection
 * lifecycle (lazy reconnect, tool-call serialization) and its MCP-only relays"). Everything
 * that used to be hand-built payload construction, response parsing, and a session-local
 * owned-lease cache is gone -- `#client` (a `SimlockClient`, ADR §10) does all of that now.
 * `lease_status` is one `lease.list` call, not a cache read (ADR §9); releasing a lease this
 * session does not own surfaces the daemon's own `FORBIDDEN` rather than a client-side guard
 * pre-empting it (ADR §11).
 *
 * `#heldLeaseId` is the one piece of lease *data* this class keeps between calls, and it is not
 * a cache of lease *state* (§11's point): it is only the id of the lease this session's own
 * `lease()` last obtained, kept so `status()` can tell that lease apart from any other lease
 * `lease.list` happens to return under the same owner principal -- see `status()`'s doc
 * comment for why that distinction is load-bearing. Alongside it sits `#renewals`, one timer
 * per lease this session obtained (ADR 0004 §2): a lease enters it when `lease()` returns and
 * leaves it the moment the session stops holding that lease, by release, by loss, or by close.
 */
export class McpSession {
  readonly #clock: Clock;
  readonly #connect: () => Promise<SimlockClient>;
  readonly #connectForRenew: () => Promise<SimlockClient>;
  #client: SimlockClient | undefined;
  #connecting: Promise<SimlockClient> | undefined;
  #closed = false;
  readonly #closedClients = new Set<SimlockClient>();
  #closePromise: Promise<void> | undefined;
  #clientUnsubscribers: Array<() => void> = [];
  readonly #leaseLostListeners = new Set<(notice: LeaseLostNotice) => void>();
  readonly #deviceHealthListeners = new Set<(notice: DeviceHealthNotice) => void>();
  /** Serializes every mutating (and `listDevices`/`status`, for simplicity) tool call on this
   * session so concurrent `lease_simulator`/`release_simulator` calls never interleave. */
  #mutations: Promise<void> = Promise.resolve();
  /** The id of the lease this session's own `lease()` call last obtained, or `undefined` if
   * none is outstanding. See the class doc comment and `status()` for why `lease.list` alone
   * cannot answer `lease_status` correctly. */
  #heldLeaseId: string | undefined;
  /**
   * ADR 0004 §2: the session's half of "held is a client policy" -- one renew timer per lease
   * this session obtained, keyed by lease id. Keyed rather than single because nothing here
   * limits a session to one lease: the daemon's one-lease-per-requester rule is the authority
   * (ADR 0003 §11), and if it starts allowing two, both have to be kept alive and both have to
   * be handed back on close. An entry lives exactly as long as this session holds that lease.
   */
  readonly #renewals = new Map<string, LeaseRenewal>();
  /** Lease ids already announced as lost, so one ending never reaches a listener twice -- see
   * `#announceLeaseLost`. */
  readonly #announcedLost = new Set<string>();

  constructor(options: McpSessionOptions) {
    this.#clock = options.clock;
    this.#connect = options.connect;
    this.#connectForRenew = options.connectForRenew;
  }

  lease(
    input: LeaseSimulatorInput,
    signal?: AbortSignal,
    onProgress?: (progress: LeaseProgressNotice) => void,
  ): Promise<LeaseSimulatorOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      // ADR 0004: no `mode` to ask for, and `ttlMs` (if the caller named one) travels through
      // from the tool's contract-derived schema untouched.
      const request: LeaseRequestInput = { ...input };
      const grant = await client.requestLease(request, {
        ...(onProgress === undefined ? {} : { onProgress }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (this.#closed) {
        // The session ended while the daemon was provisioning. `close()` does not queue behind
        // `#mutations`, so it has already stopped renewing: arming a timer now would leave a
        // closed session renewing on a client nobody owns any more, and `simlock mcp` (which
        // never calls `process.exit`) alive with it. Hand the device straight back instead --
        // `close()` waits, bounded, for exactly this -- and fail the call it cannot honour.
        await this.#releaseQuietly(client, grant.lease.id);
        this.#throwIfClosed();
      }
      this.#heldLeaseId = grant.lease.id;
      this.#startRenewal(grant.lease);
      return grant;
    });
  }

  release(input: ReleaseSimulatorInput): Promise<ReleaseSimulatorOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const result = await client.releaseLease(input);
      // Stopped only once the daemon has actually let the lease go. A release that fails
      // (anything but a dead connection) leaves the session still holding the device, and a
      // session that has stopped renewing a lease it still holds loses that device at the
      // deadline. A renew that overtakes a *successful* release cannot resurrect anything:
      // `Registry#beginRelease` drops the record, so `lease.renew` can only answer
      // UNKNOWN_LEASE.
      this.#forgetLease(result.leaseId);
      return { ...result, released: true };
    });
  }

  listDevices(input: ListDevicesInput): Promise<ListDevicesOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      return client.getCatalog(input);
    });
  }

  /**
   * This session's current lease, or an explicit "no lease held" result -- one `lease.list`
   * call (ADR 0003 §9), never a cache of lease state. `lease.list` filters by **owner principal
   * only** (see `src/daemon/dispatcher.ts`'s `lease.list` handler), so it can return leases
   * this connection never requested: one a `simlock lease --detach` left behind under the same
   * `SIMLOCK_AGENT_ID` principal, or one left over from an earlier session under that
   * principal. Taking `leases[0]` unconditionally would report a lease this session neither
   * renews nor will release on close. Matching on `id === #heldLeaseId` scopes the answer to
   * the one lease this session's own `lease()` call actually obtained -- the only filter left,
   * since ADR 0004 removed the `mode` the old one also checked, and the only one that was ever
   * load-bearing anyway. `leases` itself is always re-fetched, never cached.
   */
  status(): Promise<LeaseStatusOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const { leases } = await client.listLeases();
      const lease = leases.find((candidate) => candidate.id === this.#heldLeaseId);
      return lease === undefined ? { held: false } : { ...lease, held: true };
    });
  }

  /** Notifies when this session's held lease ends elsewhere (expiry or a force-release). */
  onLeaseLost(listener: (notice: LeaseLostNotice) => void): () => void {
    this.#leaseLostListeners.add(listener);
    return () => this.#leaseLostListeners.delete(listener);
  }

  /**
   * Notifies when this session's held lease's device crashed and was rebooted, or came back
   * from that. The lease itself is unaffected -- see `DeviceHealthNotice`.
   */
  onDeviceHealth(listener: (notice: DeviceHealthNotice) => void): () => void {
    this.#deviceHealthListeners.add(listener);
    return () => this.#deviceHealthListeners.delete(listener);
  }

  /**
   * Ends the session: stops renewing, releases this session's lease explicitly, then closes the
   * connection. ADR 0004 §3 ("connection close means nothing to a lease") is why the release is
   * its own call rather than a side effect of the socket going away: nothing else will free the
   * device before its deadline.
   *
   * It does not queue behind `#mutations`: blocking shutdown on an in-flight provisioning
   * request -- minutes, potentially -- would be a worse trade than ending now. A `lease()` that
   * lands after this point releases its own grant instead (see `lease()`), and a `release()`
   * still in flight is *not* a reason to skip the farewell one: the wire rejects every pending
   * request when the connection closes below, so skipping would mean no release at all. A
   * duplicate costs one `UNKNOWN_LEASE` this method already swallows.
   */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    // Whatever a tool call has in flight right now. `#endSession` waits on it (bounded) before
    // touching the connection, so a `lease()` that lands in that window still has a live wire
    // to hand its device back on.
    const inFlight = this.#mutations;
    this.#unwireClient();
    const client = this.#client;
    const heldLeaseIds = [...this.#renewals.keys()];
    this.#stopAllRenewals();
    this.#heldLeaseId = undefined;
    this.#announcedLost.clear();
    this.#client = undefined;
    if (this.#connecting !== undefined) {
      void this.#connecting.then((next) => this.#closeClient(next)).catch(noop);
    }
    this.#closePromise =
      client === undefined ? Promise.resolve() : this.#endSession(client, heldLeaseIds, inFlight);
    return this.#closePromise;
  }

  /**
   * `close()`'s tail: let the last tool call finish on a live wire, hand every lease back, then
   * close -- all inside **one** `RELEASE_TIMEOUT_MS` budget for the whole tail, not one per
   * step. A session ending against an unresponsive daemon must cost a bounded wait, and "one
   * timeout for the in-flight call plus one per lease" would let a dead daemon hold an MCP
   * server open for a multiple of it. Whatever has not finished when the budget runs out is
   * abandoned; the connection closes in the `finally`, the daemon rejects what was pending,
   * and any lease that did not make it ends at its own deadline.
   */
  async #endSession(
    client: SimlockClient,
    heldLeaseIds: readonly string[],
    inFlight: Promise<void>,
  ): Promise<void> {
    try {
      await awaitWithin(
        this.#clock,
        RELEASE_TIMEOUT_MS,
        (async () => {
          // `#mutations` never rejects (see `#mutate`), but a caller-supplied queue might.
          await inFlight.catch(() => undefined);
          for (const leaseId of heldLeaseIds) {
            // One lease the daemon refuses (already expired, force-released) must not cost the
            // rest of them their release.
            await client.releaseLease({ leaseId }).catch(() => undefined);
          }
        })(),
        "Timed out ending the session",
      );
    } catch {
      // Bounded by design -- see above.
    } finally {
      await this.#closeClient(client);
    }
  }

  /**
   * A release nobody is waiting on an answer to: bounded, and silent whatever happens. The
   * lease may already be gone (expired, force-released, or released by a tool call whose own
   * answer never arrived), the connection may be dead, or the daemon may not answer at all --
   * none of which should hold up an ending session, and all of which end the same way in the
   * daemon regardless, at the lease's deadline.
   *
   * Used by the grant-after-close path in `lease()`, which runs *inside* `#endSession`'s own
   * budget: this bound is the fallback for a caller that is not already bounded, and the outer
   * one wins whenever it is shorter.
   */
  async #releaseQuietly(client: SimlockClient, leaseId: string): Promise<void> {
    try {
      await awaitWithin(
        this.#clock,
        RELEASE_TIMEOUT_MS,
        client.releaseLease({ leaseId }),
        `Timed out releasing lease ${leaseId}`,
      );
    } catch {
      // Best-effort by design -- see above.
    }
  }

  /**
   * Starts (or restarts) the renew timer for one lease this session obtained. No client is
   * captured: each tick resolves one through `#renewHeldLease`, so a connection that died
   * between ticks costs the lease nothing (ADR 0004 §2) instead of ending its renewal.
   */
  #startRenewal(lease: LeaseRecord): void {
    this.#stopRenewal(lease.id);
    // No `onError`: this frontend owns stdout (it is the protocol) and has no side channel a
    // retryable failure could be written to. What the agent has to know is that the lease is
    // over, and that arrives as the `lease-lost` notice `onLeaseGone` raises below (or as the
    // daemon's own push, whichever comes first) rather than as a stream of attempt failures.
    const renewal = startLeaseRenewal({
      clock: this.#clock,
      leaseId: lease.id,
      onLeaseGone: (reason) => {
        // Renewal is over -- the daemon says the lease is gone or not ours, or it could not be
        // kept alive to its deadline. Either way this is the same ending as the push, which
        // may never arrive (a lease that expired while this connection was away has nothing
        // left to push about), and the session must stop counting the lease as its own.
        this.#reportLeaseLost({ deviceId: lease.deviceId, leaseId: lease.id, reason });
      },
      renew: (id) => this.#renewHeldLease(id),
      ttlDeadline: lease.ttlDeadline,
    });
    this.#renewals.set(lease.id, renewal);
  }

  /**
   * One renewal, against whatever connection this session has -- reconnecting first if the
   * current one died (ADR 0004 §2's second reconnect trigger). It connects only to a daemon
   * that is already listening: an idle session keeps its lease across a daemon it can still
   * reach, and an operator's `simlock daemon stop` is not undone by one that it cannot. A
   * failure here is not fatal to the lease; `startLeaseRenewal` retries on the next tick, with
   * the whole remaining TTL as its runway -- except for the one failure that is fatal, which
   * `onLeaseGone` handles above.
   */
  async #renewHeldLease(leaseId: string): Promise<{ readonly ttlDeadline: number }> {
    const client = await this.#clientForUse(this.#connectForRenew);
    return client.renewLease({ leaseId });
  }

  /**
   * This session's own lease has ended, as told by a renewal rather than by a push: drop the
   * timer, forget the id, and deliver the same notice a push would have. (The push relay in
   * `#wireClient` stays separate because it forwards every lease-lost push to listeners,
   * including ones for leases this session never held; this only ever fires for its own.)
   */
  #reportLeaseLost(notice: LeaseLostNotice): void {
    if (!this.#renewals.has(notice.leaseId)) return;
    this.#stopRenewal(notice.leaseId);
    if (this.#heldLeaseId === notice.leaseId) this.#heldLeaseId = undefined;
    this.#announceLeaseLost(notice);
  }

  /**
   * Tells the listeners a lease ended, once per lease. A lease that a renewal found gone is
   * very often also pushed as `lease-lost` a moment later (or the other way round) -- two
   * accounts of one ending, which would read to an agent as two devices lost.
   */
  #announceLeaseLost(notice: LeaseLostNotice): void {
    if (this.#announcedLost.has(notice.leaseId)) return;
    this.#announcedLost.add(notice.leaseId);
    // Capped: a long-lived session that loses many leases must not accumulate their ids
    // forever. A `Set` keeps insertion order, so this drops the oldest -- whose duplicate
    // push, if it were ever coming, arrived long ago.
    if (this.#announcedLost.size > ANNOUNCED_LOST_LIMIT) {
      const oldest = this.#announcedLost.values().next().value;
      if (oldest !== undefined) this.#announcedLost.delete(oldest);
    }
    for (const listener of this.#leaseLostListeners) listener(notice);
  }

  /** Stops and forgets one lease's renew timer. */
  #stopRenewal(leaseId: string): void {
    this.#renewals.get(leaseId)?.stop();
    this.#renewals.delete(leaseId);
  }

  #stopAllRenewals(): void {
    for (const renewal of this.#renewals.values()) renewal.stop();
    this.#renewals.clear();
  }

  /**
   * This session no longer holds `leaseId`: stop renewing it, drop it from `status()`'s answer
   * if it was the latest, and let its lost-notice bookkeeping go (nothing can announce a lease
   * that is no longer ours).
   */
  #forgetLease(leaseId: string): void {
    this.#stopRenewal(leaseId);
    this.#announcedLost.delete(leaseId);
    if (this.#heldLeaseId === leaseId) this.#heldLeaseId = undefined;
  }

  /**
   * Reconnects lazily: a dead `#client` (cleared by the client's own `onConnectionLost`, below)
   * makes the next caller build a brand new `SimlockClient` -- the typed client itself never
   * reconnects (ADR 0003 §10), so constructing a fresh one here on every dead connection is
   * what keeps MCP's process-outlives-a-connection lifecycle working.
   *
   * Which `connect` runs is the caller's decision, and ADR 0004 §2 makes it a meaningful one: a
   * tool call passes the auto-launching one (the default), the renew timer passes the one that
   * only reaches an already-listening daemon. Both share `#connecting`, so two triggers racing
   * produce one connection rather than two -- whichever asked first decides whether a daemon
   * gets launched, which is safe in both directions: a tool call is happening either way, and
   * the timer never launches on its own.
   */
  async #clientForUse(
    connect: () => Promise<SimlockClient> = this.#connect,
  ): Promise<SimlockClient> {
    if (this.#client !== undefined) return this.#client;
    this.#connecting ??= connect();
    const connecting = this.#connecting;
    try {
      const client = await connecting;
      if (this.#closed) {
        await this.#closeClient(client);
        this.#throwIfClosed();
      }
      this.#client = client;
      this.#wireClient(client);
      return client;
    } catch (error: unknown) {
      this.#throwIfClosed();
      // `#connect` is expected to reject with a `SimlockError` (the real implementation always
      // does -- see `main.ts`'s `connectWithAutoLaunch`), but this is a defensive fallback for
      // any other injected `connect` so a caller never sees a bare, un-coded exception.
      throw isSimlockError(error)
        ? error
        : new SimlockError(
            "DAEMON_CONNECTION_LOST",
            "transport",
            error instanceof Error ? error.message : String(error),
            {},
          );
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  /**
   * Relays a freshly-connected client's pushes to this session's own listeners (which survive
   * across a reconnect, unlike the client itself), and drops `#client` the moment this
   * connection dies so the next caller reconnects. A dead connection is deliberately *not*
   * treated as a lost lease (ADR 0004 §3, which is why the client no longer synthesizes one):
   * the lease is still granted, and the renew timer picks it back up over the next connection.
   */
  #wireClient(client: SimlockClient): void {
    this.#clientUnsubscribers = [
      client.onLeaseLost((push) => {
        // Nothing left to renew for that lease: the daemon ended it (expiry, or a
        // force-release). A dead connection is not one of those any more -- ADR 0004 §3, which
        // is why the client no longer synthesizes a push for it.
        this.#stopRenewal(push.leaseId);
        if (this.#heldLeaseId === push.leaseId) this.#heldLeaseId = undefined;
        this.#announceLeaseLost(push);
      }),
      client.onDeviceUnhealthy((push) => {
        for (const listener of this.#deviceHealthListeners) {
          listener({
            deviceId: push.deviceId,
            kind: "unhealthy",
            leaseId: push.leaseId,
            reason: "crashed",
          });
        }
      }),
      client.onDeviceRecovered((push) => {
        for (const listener of this.#deviceHealthListeners) {
          listener({
            attempts: push.attempts,
            deviceId: push.deviceId,
            kind: "recovered",
            leaseId: push.leaseId,
          });
        }
      }),
      client.onConnectionLost(() => {
        if (this.#client === client) {
          this.#client = undefined;
          this.#unwireClient();
        }
      }),
    ];
  }

  #unwireClient(): void {
    for (const unsubscribe of this.#clientUnsubscribers) unsubscribe();
    this.#clientUnsubscribers = [];
  }

  async #closeClient(client: SimlockClient): Promise<void> {
    if (this.#closedClients.has(client)) return;
    this.#closedClients.add(client);
    await client.close();
  }

  #throwIfClosed(): void {
    if (this.#closed) throw new McpSessionError("SESSION_CLOSED", "MCP session is closed");
  }

  #mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(mutation, mutation);
    this.#mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function noop(): void {}
