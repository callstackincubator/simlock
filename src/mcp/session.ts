import {
  isSimlockError,
  SimlockError,
  type LeaseProgress,
  type LeaseRequestInput,
  type SimlockClient,
} from "../client/index.js";
import { startLeaseRenewal, type LeaseRenewal } from "../lease-policy/index.js";
import type { Clock, TimerHandle } from "../ports/index.js";
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
 * How long `close()` waits for its farewell `lease.release` before closing the connection
 * anyway. The daemon is a local process answering a local socket, so this is not a latency
 * budget -- it is the bound that keeps an unresponsive daemon from holding an MCP server's
 * shutdown open forever. Exceeding it costs nothing but the wait: the lease then ends the way
 * every unreleased lease ends, at its deadline.
 */
const RELEASE_ON_CLOSE_TIMEOUT_MS = 5_000;

export interface McpSessionOptions {
  /**
   * The `Clock` port (architecture rule 9): the session's renew timer and `close()`'s release
   * bound both run on it, so tests drive them by hand.
   */
  readonly clock: Clock;
  /**
   * Opens one connection and completes the `hello` handshake, fixing this session's principal
   * for the connection's lifetime (ADR §4). Called again -- building a brand new client, never
   * reusing or repairing the dead one -- on lazy reconnect: the typed client "does not
   * reconnect and does not retry" (ADR §10), so that policy has to live here.
   */
  readonly connect: () => Promise<SimlockClient>;
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
 * comment for why that distinction is load-bearing. Alongside it sits `#renewal`, the timer
 * that keeps that lease alive (ADR 0004 §2); the two are started, stopped, and cleared
 * together.
 */
export class McpSession {
  readonly #clock: Clock;
  readonly #connect: () => Promise<SimlockClient>;
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
   * ADR 0004 §2: the session's half of "held is a client policy" -- the timer that renews
   * `#heldLeaseId` at a third of its remaining TTL. Non-`undefined` exactly while this session
   * holds a lease it obtained itself.
   */
  #renewal: LeaseRenewal | undefined;

  constructor(options: McpSessionOptions) {
    this.#clock = options.clock;
    this.#connect = options.connect;
  }

  lease(
    input: LeaseSimulatorInput,
    signal?: AbortSignal,
    onProgress?: (progress: LeaseProgressNotice) => void,
  ): Promise<LeaseSimulatorOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const request: LeaseRequestInput = { ...input, mode: "held" };
      const grant = await client.requestLease(request, {
        ...(onProgress === undefined ? {} : { onProgress }),
        ...(signal === undefined ? {} : { signal }),
      });
      this.#heldLeaseId = grant.lease.id;
      this.#startRenewal(client, grant.lease.id, grant.lease.ttlDeadline);
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
      if (result.leaseId === this.#heldLeaseId) {
        this.#stopRenewal();
        this.#heldLeaseId = undefined;
      }
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
   * call (ADR §9), never a cache of lease state. `lease.list` filters by **owner principal
   * only** (no mode filter, no connection filter -- see `src/daemon/dispatcher.ts`'s
   * `lease.list` handler), so it can return leases this connection never requested: a
   * `detached` lease the CLI holds under the same `SIMLOCK_AGENT_ID` principal, or a stale
   * `held` lease left over from an earlier session under that principal. Taking `leases[0]`
   * unconditionally would report a lease this session neither holds nor will release on close.
   * Filtering to `mode === "held"` **and** `id === #heldLeaseId` scopes the answer to the one
   * lease this session's own `lease()` call actually obtained; `leases` itself is always
   * re-fetched, never cached.
   */
  status(): Promise<LeaseStatusOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const { leases } = await client.listLeases();
      const lease = leases.find((candidate) => {
        return candidate.mode === "held" && candidate.id === this.#heldLeaseId;
      });
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
   * its own call now rather than a side effect of the socket going away -- the daemon still
   * releases on close today, and will not once PR B lands.
   *
   * One race is deliberately left: a `lease()` still in flight here can set `#heldLeaseId`
   * after this method read it, and that lease is not released explicitly. It is not reachable
   * from the MCP frontend (`close()` runs on shutdown, after the transport is gone) and
   * blocking shutdown on an in-flight provisioning request -- minutes, potentially -- would be
   * a worse trade than the daemon's own expiry handling it.
   */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#stopRenewal();
    this.#unwireClient();
    const client = this.#client;
    const heldLeaseId = this.#heldLeaseId;
    this.#heldLeaseId = undefined;
    this.#client = undefined;
    if (this.#connecting !== undefined) {
      void this.#connecting.then((next) => this.#closeClient(next)).catch(noop);
    }
    this.#closePromise =
      client === undefined ? Promise.resolve() : this.#endSession(client, heldLeaseId);
    return this.#closePromise;
  }

  /** `close()`'s tail: the farewell release (best-effort, bounded), then the connection. */
  async #endSession(client: SimlockClient, heldLeaseId: string | undefined): Promise<void> {
    if (heldLeaseId !== undefined) {
      try {
        await this.#withReleaseTimeout(client.releaseLease({ leaseId: heldLeaseId }));
      } catch {
        // Best-effort by design: the lease may already be gone (expired, force-released), the
        // connection may be dead, or the daemon may not answer. Shutdown continues either way,
        // and an unreleased lease still ends at its deadline.
      }
    }
    await this.#closeClient(client);
  }

  /** Rejects once `RELEASE_ON_CLOSE_TIMEOUT_MS` passes, so a dead-but-open socket cannot pin an
   * MCP server open. The timer is always cancelled, so it never holds the process open itself. */
  async #withReleaseTimeout(release: Promise<unknown>): Promise<void> {
    let timer: TimerHandle | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = this.#clock.setTimer(RELEASE_ON_CLOSE_TIMEOUT_MS, () => {
        timer = undefined;
        reject(new McpSessionError("RELEASE_TIMEOUT", "Timed out releasing the session's lease"));
      });
    });
    try {
      await Promise.race([release, expiry]);
    } finally {
      if (timer !== undefined) this.#clock.cancel(timer);
    }
  }

  /**
   * Starts (or restarts) the renew timer for the lease this session just obtained. The client
   * is captured deliberately: if that connection dies, the renewal fails and stops rather than
   * quietly reconnecting behind the tool surface -- reconnect stays a decision the next tool
   * call makes (`#clientForUse`).
   */
  #startRenewal(client: SimlockClient, leaseId: string, ttlDeadline: number): void {
    this.#stopRenewal();
    // No `onError`: this frontend owns stdout (it is the protocol) and has no side channel a
    // failed renewal could be written to. Every failure that matters to the agent surfaces as
    // the `lease-lost` notice that follows it, or as the next tool call's own error.
    this.#renewal = startLeaseRenewal({
      clock: this.#clock,
      leaseId,
      renew: (id) => client.renewLease({ leaseId: id }),
      ttlDeadline,
    });
  }

  #stopRenewal(): void {
    this.#renewal?.stop();
    this.#renewal = undefined;
  }

  /**
   * Reconnects lazily: a dead `#client` (cleared by the client's own `onConnectionLost`, below)
   * makes the next call re-run `#connect()`, building a brand new `SimlockClient` -- the typed
   * client itself never reconnects (ADR §10), so constructing a fresh one here on every dead
   * connection is what keeps MCP's process-outlives-a-connection lifecycle working.
   */
  async #clientForUse(): Promise<SimlockClient> {
    if (this.#client !== undefined) return this.#client;
    this.#connecting ??= this.#connect();
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
   * connection dies so the next call reconnects. The client already synthesizes `onLeaseLost`
   * for every lease it held when its connection dies (ADR §10), so nothing extra is needed
   * here for that case.
   */
  #wireClient(client: SimlockClient): void {
    this.#clientUnsubscribers = [
      client.onLeaseLost((push) => {
        if (push.leaseId === this.#heldLeaseId) {
          // Nothing left to renew: the lease ended elsewhere (expiry, a force-release, or this
          // connection dying -- the client synthesizes the push for that last one).
          this.#stopRenewal();
          this.#heldLeaseId = undefined;
        }
        for (const listener of this.#leaseLostListeners) listener(push);
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
