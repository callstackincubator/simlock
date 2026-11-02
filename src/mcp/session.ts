import {
  isSimlockError,
  SimlockError,
  type DeviceOutputChunk,
  type ExecOutput,
  type LeaseProgress,
  type LeaseRecord,
  type LeaseRequestInput,
  type SimlockClient,
} from "../client/index.js";
import { parseOrientation } from "../contract/index.js";
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
  RotateDeviceInput,
  RotateDeviceOutput,
  RunOnDeviceInput,
} from "./contracts.js";

const ANNOUNCED_LOST_LIMIT = 64;

export interface McpSessionOptions {
  readonly clock: Clock;
  readonly connect: () => Promise<SimlockClient>;
  readonly connectForRenew: () => Promise<SimlockClient>;
}

export interface McpErrorResult {
  readonly code: string;
  readonly message: string;
}

export interface LeaseLostNotice {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly reason: string;
}

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
  #connectingCanLaunch = false;
  #closed = false;
  readonly #closedClients = new Set<SimlockClient>();
  #closePromise: Promise<void> | undefined;
  #clientUnsubscribers: Array<() => void> = [];
  readonly #leaseLostListeners = new Set<(notice: LeaseLostNotice) => void>();
  readonly #deviceHealthListeners = new Set<(notice: DeviceHealthNotice) => void>();
  #mutations: Promise<void> = Promise.resolve();
  #heldLeaseId: string | undefined;
  /**
   * why: ADR 0004 §2, the session's half of "held is a client policy" -- one renew timer per lease
   * this session obtained, keyed by lease id. Keyed rather than single because nothing here
   * limits a session to one lease: the daemon's per-requester lease limit is the authority, and
   * when it allows more than one (`lease.maxPerRequester`, a number or one per platform), every
   * one has to be kept alive and handed back on close. An entry lives exactly as long as this session holds that lease.
   *
   * Each entry keeps the lease record its timer is renewing, refreshed from every renewal, so
   * a timer stopped for a release that then failed can be started again against the lease as
   * it actually stands rather than as it stood at grant time -- see `release()`.
   */
  readonly #renewals = new Map<string, HeldLease>();
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
      const request: LeaseRequestInput = { ...input };
      const grant = await client.requestLease(request, {
        ...(onProgress === undefined ? {} : { onProgress }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (this.#closed) {
        // why: The session ended while the daemon was provisioning. `close()` does not queue behind
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
      // why: Stopped *before* the release is sent, not after it answers. A renew dispatched into
      // the same window lands after `Registry#beginRelease` has dropped the record and comes
      // back `UNKNOWN_LEASE` -- a terminal answer, so `onLeaseGone` would announce a
      // `lease-lost` for the very release this agent asked for, which ADR 0003 §8 says must
      // never happen. Today the two answers arrive in an order that hides it; a gateway hop
      // (ADR 0003 §12) would not be so kind.
      const held = this.#renewals.get(input.leaseId);
      // why: Only the timer stops; the lease stays this session's until the daemon answers. That is
      // what keeps `close()`'s farewell release owed for a release still in flight (see
      // `close()`), which is the difference between one duplicate `UNKNOWN_LEASE` and a device
      // nobody hands back.
      held?.renewal.stop();
      let result;
      try {
        result = await client.releaseLease(input);
      } catch (error: unknown) {
        // why: The daemon did not take the lease: this session is still holding the device, and a
        // holder that has stopped renewing loses it at the deadline. So the timer goes back --
        // unless the lease is not this session's any more. That is the answers where there is
        // nothing left to renew (`UNKNOWN_LEASE`, or `FORBIDDEN` for a lease that was never
        // ours) and a dead connection, where the agent has asked to be rid of this lease and
        // reconnecting a timer to keep it alive would be the opposite of what it asked; and it
        // is also a `lease-lost` push that arrived while the release was in flight, which drops
        // the lease from `#renewals` -- restarting on that would renew towards a lease the
        // daemon has already ended.
        if (held !== undefined) {
          if (endsRenewal(error) || !this.#renewals.has(input.leaseId)) {
            this.#forgetLease(input.leaseId);
          } else {
            this.#startRenewal(held.lease);
          }
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
   * why: This session's current lease, or an explicit "no lease held" result -- one `lease.list`
   * call (ADR 0003 §9), never a cache of lease state. `lease.list` filters by **owner principal
   * only** (see `src/daemon/dispatcher.ts`'s `lease.list` handler), so it can return leases
   * this connection never requested: one a `simlock lease --detach` left behind under the same
   * principal (`SIMLOCK_AGENT_ID` or the agent session's id), or one left over from an earlier session under that
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

  // why: not on `#mutate` -- a command can run for minutes, and `lease_status` or a release
  // must not wait behind it (ADR 0047 §6).
  async runOnDevice(
    input: RunOnDeviceInput,
    onOutput: (chunk: DeviceOutputChunk) => void,
  ): Promise<ExecOutput> {
    this.#throwIfClosed();
    const leaseId = this.#heldLeaseId;
    if (leaseId === undefined) {
      throw new McpSessionError(
        "NO_LEASE",
        "This MCP session holds no lease. Call lease_simulator first.",
      );
    }
    const client = await this.#clientForUse();
    return client.exec({ ...input, leaseId }, { onOutput });
  }

  // why: not on `#mutate`, like `runOnDevice`; the parse is first so a bad spelling never reaches the daemon.
  async rotateDevice(input: RotateDeviceInput): Promise<RotateDeviceOutput> {
    this.#throwIfClosed();
    const parsed = parseOrientation(input.orientation);
    if (!parsed.ok) throw new McpSessionError("BAD_REQUEST", parsed.message);
    const leaseId = this.#heldLeaseId;
    if (leaseId === undefined) {
      throw new McpSessionError(
        "NO_LEASE",
        "This MCP session holds no lease. Call lease_simulator first.",
      );
    }
    const client = await this.#clientForUse();
    return client.rotate(leaseId, parsed.orientation);
  }

  onLeaseLost(listener: (notice: LeaseLostNotice) => void): () => void {
    this.#leaseLostListeners.add(listener);
    return () => this.#leaseLostListeners.delete(listener);
  }

  onDeviceHealth(listener: (notice: DeviceHealthNotice) => void): () => void {
    this.#deviceHealthListeners.add(listener);
    return () => this.#deviceHealthListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    // why: Whatever a tool call has in flight right now. `#endSession` waits on it (bounded) before
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
   * why: `close()`'s tail: let the last tool call finish on a live wire, hand every lease back, then
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
    // why: `awaitWithin` stops *waiting* on the budget; it cannot stop the work. Without this the
    // abandoned loop would go on calling `releaseLease` on a client the `finally` has closed,
    // one rejection per remaining lease, after the session was supposed to be over.
    let budgetSpent = false;
    try {
      await awaitWithin(
        this.#clock,
        RELEASE_TIMEOUT_MS,
        (async () => {
          // why: `#mutations` never rejects (see `#mutate`), but a caller-supplied queue might.
          await inFlight.catch(() => undefined);
          for (const leaseId of heldLeaseIds) {
            if (budgetSpent) return;
            // why: One lease the daemon refuses (already expired, force-released) must not cost the
            // rest of them their release.
            await client.releaseLease({ leaseId }).catch(() => undefined);
          }
        })(),
        "Timed out ending the session",
      );
    } catch {
      budgetSpent = true;
    } finally {
      await this.#closeClient(client);
    }
  }

  #startRenewal(lease: LeaseRecord): void {
    this.#stopRenewal(lease.id);
    // why: No `onError`: this frontend owns stdout (it is the protocol) and has no side channel a
    // retryable failure could be written to. What the agent has to know is that the lease is
    // over, and that arrives as the `lease-lost` notice `onLeaseGone` raises below (or as the
    // daemon's own push, whichever comes first) rather than as a stream of attempt failures.
    const renewal = startLeaseRenewal({
      clock: this.#clock,
      leaseId: lease.id,
      // why: Keeps the record this session would restart renewal from in step with the daemon's
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
        // why: Renewal is over -- the daemon says the lease is gone or not ours, or it could not be
        // kept alive to its deadline. Either way this is the same ending as the push, which
        // may never arrive (a lease that expired while this connection was away has nothing
        // left to push about), and the session must stop counting the lease as its own.
        this.#reportLeaseLost({ deviceId: lease.deviceId, leaseId: lease.id, reason });
      },
      renew: (id) => this.#renewHeldLease(id),
      ttlDeadline: lease.ttlDeadline,
      ttlMs: lease.ttlMs,
    });
    this.#renewals.set(lease.id, { lease, renewal });
  }

  async #renewHeldLease(leaseId: string): Promise<{ readonly ttlDeadline: number }> {
    const client = await this.#clientForUse(this.#connectForRenew);
    return client.renewLease({ leaseId });
  }

  #reportLeaseLost(notice: LeaseLostNotice): void {
    if (!this.#renewals.has(notice.leaseId)) return;
    this.#stopRenewal(notice.leaseId);
    if (this.#heldLeaseId === notice.leaseId) this.#heldLeaseId = undefined;
    this.#announceLeaseLost(notice);
  }

  /**
   * why: Tells the listeners a lease ended, once per lease. A lease that a renewal found gone is
   * very often also pushed as `lease-lost` a moment later (or the other way round) -- two
   * accounts of one ending, which would read to an agent as two devices lost.
   */
  #announceLeaseLost(notice: LeaseLostNotice): void {
    if (this.#announcedLost.has(notice.leaseId)) return;
    this.#announcedLost.add(notice.leaseId);
    // why: Capped: a long-lived session that loses many leases must not accumulate their ids
    // forever. A `Set` keeps insertion order, so this drops the oldest -- whose duplicate
    // push, if it were ever coming, arrived long ago.
    if (this.#announcedLost.size > ANNOUNCED_LOST_LIMIT) {
      const oldest = this.#announcedLost.values().next().value;
      if (oldest !== undefined) this.#announcedLost.delete(oldest);
    }
    for (const listener of this.#leaseLostListeners) listener(notice);
  }

  #stopRenewal(leaseId: string): void {
    this.#renewals.get(leaseId)?.renewal.stop();
    this.#renewals.delete(leaseId);
  }

  #stopAllRenewals(): void {
    for (const held of this.#renewals.values()) held.renewal.stop();
    this.#renewals.clear();
  }

  #forgetLease(leaseId: string): void {
    this.#stopRenewal(leaseId);
    this.#announcedLost.delete(leaseId);
    if (this.#heldLeaseId === leaseId) this.#heldLeaseId = undefined;
  }

  /**
   * why: Reconnects lazily: a dead `#client` (cleared by the client's own `onConnectionLost`, below)
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
   * tool call joining a *renew's* connect is not: the client guide and the CLI reference promise a
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
      // why: The attempt this caller joined could not launch a daemon and this caller may: try
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

  async #adoptClient(client: SimlockClient): Promise<SimlockClient> {
    if (this.#closed) {
      await this.#closeClient(client);
      this.#throwIfClosed();
    }
    // why: Every caller that shared `#connecting` arrives here with the same client, and only the
    // first of them may wire it: a second `#wireClient` would strand the first set of
    // unsubscribers (`#unwireClient` only knows the latest), leaving two live relays for one
    // connection and an agent reading every push twice.
    if (this.#client === client) return client;
    this.#client = client;
    this.#wireClient(client);
    return client;
  }

  #wireClient(client: SimlockClient): void {
    this.#clientUnsubscribers = [
      client.onLeaseLost((push) => {
        // why: Nothing left to renew for that lease: the daemon ended it (expiry, or a
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

function endsRenewal(error: unknown): boolean {
  return (
    isSimlockError(error) &&
    (error.code === "UNKNOWN_LEASE" ||
      error.code === "FORBIDDEN" ||
      error.code === "DAEMON_CONNECTION_LOST")
  );
}
