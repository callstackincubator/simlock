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
/** One lease this session holds: its live renew timer, and the freshest record it renewed to. */
interface HeldLease {
  readonly renewal: LeaseRenewal;
  lease: LeaseRecord;
}

export class McpSession {
  readonly #clock: Clock;
  readonly #connect: () => Promise<SimlockClient>;
  readonly #connectForRenew: () => Promise<SimlockClient>;
  #client: SimlockClient | undefined;
  #connecting: Promise<SimlockClient> | undefined;
  /** Whether `#connecting` was started by the auto-launching `connect` (a tool call) or by the
   * non-launching `connectForRenew` (the renew timer). A tool call that joined the weaker one
   * has to be able to tell, so it can still exercise the power it was promised -- see
   * `#clientForUse`. */
  #connectingCanLaunch = false;
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
   *
   * Each entry keeps the lease record its timer is renewing, refreshed from every renewal, so
   * a timer stopped for a release that then failed can be started again against the lease as
   * it actually stands rather than as it stood at grant time -- see `release()`.
   */
  readonly #renewals = new Map<string, HeldLease>();
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
        // Inside `#endSession`'s budget (`close()` waits on this call), so it needs no bound
        // of its own -- and must not add one: a nested timer would only extend the wait an
        // ending session already bounds.
        await client.releaseLease({ leaseId: grant.lease.id }).catch(() => undefined);
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
      // Stopped *before* the release is sent, not after it answers. A renew dispatched into
      // the same window lands after `Registry#beginRelease` has dropped the record and comes
      // back `UNKNOWN_LEASE` -- a terminal answer, so `onLeaseGone` would announce a
      // `lease-lost` for the very release this agent asked for, which ADR 0003 §8 says must
      // never happen. Today the two answers arrive in an order that hides it; a gateway hop
      // (ADR 0003 §12) would not be so kind.
      const held = this.#renewals.get(input.leaseId);
      // Only the timer stops; the lease stays this session's until the daemon answers. That is
      // what keeps `close()`'s farewell release owed for a release still in flight (see
      // `close()`), which is the difference between one duplicate `UNKNOWN_LEASE` and a device
      // nobody hands back.
      held?.renewal.stop();
      let result;
      try {
        result = await client.releaseLease(input);
      } catch (error: unknown) {
        // The daemon did not take the lease: this session is still holding the device, and a
        // holder that has stopped renewing loses it at the deadline. So the timer goes back --
        // except for the answers where there is nothing left to renew (`UNKNOWN_LEASE`, or
        // `FORBIDDEN` for a lease that was never ours) and for a dead connection, where the
        // agent has asked to be rid of this lease and reconnecting a timer to keep it alive
        // would be the opposite of what it asked; it ends at its deadline instead.
        if (held !== undefined) {
          if (endsRenewal(error)) this.#forgetLease(input.leaseId);
          else this.#startRenewal(held.lease);
        }
        throw error;
      }
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
   *
   * With no client at all -- the connection died and `#wireClient` cleared it -- there is
   * nothing to release and nothing is reconnected to try: ADR 0004 §3 leaves those leases
   * granted and counting down, and an ending session is the one moment it is right to let them
   * run out rather than reach for one more connection on the way out.
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
    // `awaitWithin` stops *waiting* on the budget; it cannot stop the work. Without this the
    // abandoned loop would go on calling `releaseLease` on a client the `finally` has closed,
    // one rejection per remaining lease, after the session was supposed to be over.
    let budgetSpent = false;
    try {
      await awaitWithin(
        this.#clock,
        RELEASE_TIMEOUT_MS,
        (async () => {
          // `#mutations` never rejects (see `#mutate`), but a caller-supplied queue might.
          await inFlight.catch(() => undefined);
          for (const leaseId of heldLeaseIds) {
            if (budgetSpent) return;
            // One lease the daemon refuses (already expired, force-released) must not cost the
            // rest of them their release.
            await client.releaseLease({ leaseId }).catch(() => undefined);
          }
        })(),
        "Timed out ending the session",
      );
    } catch {
      // Bounded by design -- see above.
      budgetSpent = true;
    } finally {
      await this.#closeClient(client);
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
      // Keeps the record this session would restart renewal from in step with the daemon's
      // newest answer: a restart (see `release()`) must not renew towards a deadline and a
      // width the lease has not had for hours.
      onRenewed: (renewed) => {
        const held = this.#renewals.get(lease.id);
        if (held === undefined) return;
        held.lease = {
          ...held.lease,
          ttlDeadline: renewed.ttlDeadline,
          ...(renewed.ttlMs === undefined ? {} : { ttlMs: renewed.ttlMs }),
        };
      },
      onLeaseGone: (reason) => {
        // Renewal is over -- the daemon says the lease is gone or not ours, or it could not be
        // kept alive to its deadline. Either way this is the same ending as the push, which
        // may never arrive (a lease that expired while this connection was away has nothing
        // left to push about), and the session must stop counting the lease as its own.
        this.#reportLeaseLost({ deviceId: lease.deviceId, leaseId: lease.id, reason });
      },
      renew: (id) => this.#renewHeldLease(id),
      // The width drives the cadence, the deadline bounds it -- see `startLeaseRenewal`.
      ttlDeadline: lease.ttlDeadline,
      ttlMs: lease.ttlMs,
    });
    this.#renewals.set(lease.id, { lease, renewal });
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
    this.#renewals.get(leaseId)?.renewal.stop();
    this.#renewals.delete(leaseId);
  }

  #stopAllRenewals(): void {
    for (const held of this.#renewals.values()) held.renewal.stop();
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
   * only reaches an already-listening daemon. The two share `#connecting` so a race produces
   * one connection rather than two -- but only in the direction where sharing costs nothing.
   * A renew tick joining a tool call's connect is fine: it wanted a connection, and gets one
   * (the tool call was going to launch a daemon either way, which is not the timer's doing). A
   * tool call joining a *renew's* connect is not: `docs/CLIENT.md` and `docs/CLI.md` promise a
   * tool call may start a daemon that is not running, and it would instead fail with the
   * weaker attempt. So it retries once, alone, with the launching connect -- which is exactly
   * what it would have done had it arrived a moment later.
   */
  async #clientForUse(
    connect: () => Promise<SimlockClient> = this.#connect,
  ): Promise<SimlockClient> {
    if (this.#client !== undefined) return this.#client;
    const canLaunch = connect === this.#connect;
    if (this.#connecting === undefined) {
      this.#connecting = connect();
      this.#connectingCanLaunch = canLaunch;
    }
    const connecting = this.#connecting;
    const joinedWeakerAttempt = canLaunch && !this.#connectingCanLaunch;
    try {
      return await this.#adoptClient(await connecting);
    } catch (error: unknown) {
      this.#throwIfClosed();
      // The attempt this caller joined could not launch a daemon and this caller may: try
      // again on its own terms rather than reporting "nothing is listening" to a tool call
      // that is allowed to fix that. Only in this direction -- and the failed attempt is
      // cleared first (whichever joined caller's `finally` has not run yet would only clear
      // it again, harmlessly) so the retry starts a connection rather than re-joining the one
      // that just failed.
      if (joinedWeakerAttempt) {
        if (this.#connecting === connecting) this.#connecting = undefined;
        return this.#clientForUse(connect);
      }
      throw asSimlockError(error);
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  /**
   * Takes ownership of a freshly-connected client: it becomes this session's, and its pushes
   * start reaching this session's listeners. A session that closed while the connection was
   * being made takes ownership of nothing -- it closes the client instead, so a connection
   * built for a session that no longer exists cannot outlive it.
   */
  async #adoptClient(client: SimlockClient): Promise<SimlockClient> {
    if (this.#closed) {
      await this.#closeClient(client);
      this.#throwIfClosed();
    }
    this.#client = client;
    this.#wireClient(client);
    return client;
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

/**
 * `#connect` is expected to reject with a `SimlockError` (the real implementation always does
 * -- see `main.ts`'s `connectWithAutoLaunch`); this is the defensive fallback for any other
 * injected `connect`, so a caller never sees a bare, un-coded exception.
 */
function asSimlockError(error: unknown): unknown {
  return isSimlockError(error)
    ? error
    : new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        error instanceof Error ? error.message : String(error),
        {},
      );
}

/**
 * Whether a failed `lease.release` is a reason to leave the lease's renew timer stopped: the
 * lease is already gone or was never this principal's, or the connection carrying the answer
 * died. Anything else (an `INTERNAL` the daemon may serve on the next try, say) leaves a lease
 * this session still holds and still has to keep alive.
 */
function endsRenewal(error: unknown): boolean {
  return (
    isSimlockError(error) &&
    (error.code === "UNKNOWN_LEASE" ||
      error.code === "FORBIDDEN" ||
      error.code === "DAEMON_CONNECTION_LOST")
  );
}
