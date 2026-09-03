import {
  isSimlockError,
  SimlockError,
  type LeaseProgress,
  type LeaseRequestInput,
  type SimlockClient,
} from "../client/index.js";
import type {
  LeaseSimulatorInput,
  LeaseSimulatorOutput,
  LeaseStatusOutput,
  ListDevicesInput,
  ListDevicesOutput,
  ReleaseSimulatorInput,
  ReleaseSimulatorOutput,
} from "./contracts.js";

export interface McpSessionOptions {
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
 */
export class McpSession {
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

  constructor(options: McpSessionOptions) {
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
      return client.requestLease(request, {
        ...(onProgress === undefined ? {} : { onProgress }),
        ...(signal === undefined ? {} : { signal }),
      });
    });
  }

  release(input: ReleaseSimulatorInput): Promise<ReleaseSimulatorOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const result = await client.releaseLease(input);
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
   * call (ADR §9), never a local cache. This session only ever requests `mode: "held"` leases
   * under one requester id (its fixed principal), so `leases` holds at most one entry.
   */
  status(): Promise<LeaseStatusOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const client = await this.#clientForUse();
      const { leases } = await client.listLeases();
      const lease = leases[0];
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

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#unwireClient();
    const client = this.#client;
    this.#client = undefined;
    if (this.#connecting !== undefined) {
      void this.#connecting.then((next) => this.#closeClient(next)).catch(noop);
    }
    this.#closePromise = client === undefined ? Promise.resolve() : this.#closeClient(client);
    return this.#closePromise;
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
