import {
  parseRawCatalog,
  parseRawDeviceRecovered,
  parseRawDeviceUnhealthy,
  parseRawLeaseGrant,
  parseRawLeaseHeartbeatAck,
  parseRawLeaseLost,
  parseRawLeaseProgress,
  type RawLeaseGrant,
  type RawLeaseProgress,
} from "../daemon-client/contracts.js";
import { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";
import type {
  HeldLeaseStatus,
  LeaseSimulatorInput,
  LeaseSimulatorOutput,
  LeaseStatusOutput,
  ListDevicesInput,
  ListDevicesOutput,
  NoLeaseStatus,
  ReleaseSimulatorInput,
  ReleaseSimulatorOutput,
} from "./contracts.js";
import {
  leaseSimulatorOutputSchema,
  listDevicesOutputSchema,
  MAX_TIMEOUT_SECONDS,
} from "./contracts.js";

export interface McpSessionOptions {
  readonly connect: () => Promise<DaemonConnection>;
  readonly requesterId: string;
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
export type LeaseProgressNotice = RawLeaseProgress;

interface OwnedLease {
  readonly device: string;
  readonly deviceId: string;
  readonly expiresAtMs: number;
  readonly leaseId: string;
  readonly os: string;
  readonly platform: "android" | "ios";
}

interface LeaseAbortWatch {
  readonly cancelled: Promise<never>;
  cleanup(): Promise<void> | undefined;
  dispose(): void;
}

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
  if (error instanceof DaemonClientError || error instanceof McpSessionError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL", message: "Simlock could not complete the request" };
}

export class McpSession {
  readonly #connect: () => Promise<DaemonConnection>;
  readonly #requesterId: string;
  #connection: DaemonConnection | undefined;
  #connecting: Promise<DaemonConnection> | undefined;
  #closed = false;
  #closedConnections = new Set<DaemonConnection>();
  #closePromise: Promise<void> | undefined;
  #rejectClosed!: (reason: McpSessionError) => void;
  #sessionClosed: Promise<never>;
  #ownedLease: OwnedLease | undefined;
  #pushUnsubscribe: (() => void) | undefined;
  #closeUnsubscribe: (() => void) | undefined;
  /** Scoped to the in-flight `lease()` call; cleared once that call settles or the session closes. */
  #leaseProgressListener: ((progress: LeaseProgressNotice) => void) | undefined;
  readonly #leaseLostListeners = new Set<(notice: LeaseLostNotice) => void>();
  readonly #deviceHealthListeners = new Set<(notice: DeviceHealthNotice) => void>();
  #mutations: Promise<void> = Promise.resolve();

  constructor(options: McpSessionOptions) {
    this.#connect = options.connect;
    this.#requesterId = options.requesterId;
    this.#sessionClosed = new Promise<never>((_resolve, reject) => {
      this.#rejectClosed = reject;
    });
    void this.#sessionClosed.catch(() => undefined);
  }

  /**
   * `onProgress` is scoped to this call only: it receives queue/provisioning/boot updates for
   * this request while it is in flight, and is torn down on completion, error, cancellation, or
   * session close. It never leaks across sequential lease requests.
   */
  lease(
    input: LeaseSimulatorInput,
    signal?: AbortSignal,
    onProgress?: (progress: LeaseProgressNotice) => void,
  ): Promise<LeaseSimulatorOutput> {
    return this.#mutate(() => {
      this.#throwIfClosed();
      return this.#lease(input, signal, onProgress);
    });
  }

  release(input: ReleaseSimulatorInput): Promise<ReleaseSimulatorOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      if (this.#ownedLease?.leaseId !== input.lease_id) {
        throw new McpSessionError("LEASE_NOT_OWNED", "This session does not own that lease");
      }
      const connection = await this.#connectionForUse();
      try {
        await Promise.race([
          connection.request("lease.release", { leaseId: input.lease_id }),
          this.#sessionClosed,
        ]);
      } catch (error: unknown) {
        if (isNoLongerActiveLease(error)) this.#ownedLease = undefined;
        throw error;
      }
      this.#ownedLease = undefined;
      return { lease_id: input.lease_id, released: true };
    });
  }

  listDevices(input: ListDevicesInput): Promise<ListDevicesOutput> {
    return this.#mutate(async () => {
      this.#throwIfClosed();
      const response = await this.#requestReadOnly(
        "catalog.get",
        input.platform === undefined ? {} : { platform: input.platform },
      );
      const catalog = parseRawCatalog(response);
      return listDevicesOutputSchema.parse({
        platforms: catalog.platforms.map((entry) => ({
          default_runtime: entry.defaultRuntime,
          models: entry.models,
          platform: entry.platform,
          runtimes: entry.runtimes,
        })),
      });
    });
  }

  /** This session's current lease, or an explicit "no lease held" result. Cheap, local, and safe to poll. */
  status(): LeaseStatusOutput {
    this.#throwIfClosed();
    return this.#ownedLease === undefined ? noLeaseStatus() : heldLeaseStatus(this.#ownedLease);
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
    this.#ownedLease = undefined;
    this.#leaseProgressListener = undefined;
    this.#pushUnsubscribe?.();
    this.#pushUnsubscribe = undefined;
    this.#closeUnsubscribe?.();
    this.#closeUnsubscribe = undefined;
    this.#rejectClosed(new McpSessionError("SESSION_CLOSED", "MCP session is closed"));
    const connection = this.#connection;
    this.#connection = undefined;
    if (this.#connecting !== undefined) {
      void this.#connecting
        .then((nextConnection) => this.#closeDaemonConnection(nextConnection))
        .catch(noop);
    }
    this.#closePromise =
      connection === undefined ? Promise.resolve() : this.#closeDaemonConnection(connection);
    return this.#closePromise;
  }

  async #lease(
    input: LeaseSimulatorInput,
    signal?: AbortSignal,
    onProgress?: (progress: LeaseProgressNotice) => void,
  ): Promise<LeaseSimulatorOutput> {
    throwIfAborted(signal);

    const abortWatch = this.#watchLeaseAbort(signal);
    this.#leaseProgressListener = onProgress;
    let responseReceived = false;
    try {
      const connection = await this.#connectionForUse();
      await this.#throwIfCancelledBeforeRequest(signal);
      const response = await this.#requestLease(connection, input, abortWatch.cancelled);
      responseReceived = true;
      return await this.#mapLeaseResponse(connection, response, signal, abortWatch);
    } catch (error: unknown) {
      await this.#cleanupFailedLease(responseReceived, abortWatch.cleanup());
      throw error;
    } finally {
      this.#leaseProgressListener = undefined;
      abortWatch.dispose();
    }
  }

  #watchLeaseAbort(signal: AbortSignal | undefined): LeaseAbortWatch {
    let cleanup: Promise<void> | undefined;
    let reject: ((reason: McpSessionError) => void) | undefined;
    const cancelled = new Promise<never>((_resolve, nextReject) => {
      reject = nextReject;
    });
    void cancelled.catch(() => undefined);
    const abort = () => {
      cleanup ??= this.#closeConnection().catch(() => undefined);
      reject?.(new McpSessionError("CANCELLED", "Lease request cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    return {
      cancelled,
      cleanup: () => cleanup,
      dispose: () => signal?.removeEventListener("abort", abort),
    };
  }

  async #throwIfCancelledBeforeRequest(signal: AbortSignal | undefined): Promise<void> {
    if (!signal?.aborted) return;
    await this.#closeConnection().catch(() => undefined);
    throw new McpSessionError("CANCELLED", "Lease request cancelled");
  }

  #requestLease(
    connection: DaemonConnection,
    input: LeaseSimulatorInput,
    cancelled: Promise<never>,
  ): Promise<unknown> {
    return Promise.race([
      connection.request("lease.request", daemonLeaseRequest(input, this.#requesterId)),
      cancelled,
      this.#sessionClosed,
    ]);
  }

  async #mapLeaseResponse(
    connection: DaemonConnection,
    response: unknown,
    signal: AbortSignal | undefined,
    abortWatch: LeaseAbortWatch,
  ): Promise<LeaseSimulatorOutput> {
    const grant = parseRawLeaseGrant(response);
    this.#throwIfClosed();
    if (signal?.aborted) {
      await abortWatch.cleanup();
      throw new McpSessionError("CANCELLED", "Lease request cancelled");
    }
    if (grant.lease.mode !== "held") {
      await this.#releaseUnexpectedLease(connection, grant.lease.id);
      throw new McpSessionError("INVALID_LEASE_GRANT", "Daemon returned a non-held lease grant");
    }
    const output = leaseSimulatorOutputSchema.parse(leaseSimulatorOutput(grant));
    this.#ownedLease = {
      device: output.device,
      deviceId: output.device_id,
      expiresAtMs: output.expires_at_ms,
      leaseId: output.lease_id,
      os: output.os,
      platform: output.platform,
    };
    return output;
  }

  async #releaseUnexpectedLease(connection: DaemonConnection, leaseId: string): Promise<void> {
    try {
      await connection.request("lease.release", { leaseId });
    } catch {
      // The connection close below remains the daemon-side held-lease cleanup fallback.
    } finally {
      await this.#closeConnection().catch(() => undefined);
    }
  }

  async #cleanupFailedLease(
    responseReceived: boolean,
    abortCleanup: Promise<void> | undefined,
  ): Promise<void> {
    if (abortCleanup !== undefined) await abortCleanup;
    else if (responseReceived) await this.#closeConnection().catch(() => undefined);
  }

  /**
   * Reconnects lazily: a dead `#connection` (cleared by `#handleConnectionClosed`, below) makes
   * the next call re-run `#connect()`, which auto-starts the daemon exactly as the CLI does and
   * re-negotiates capabilities (e.g. the heartbeat) at `hello`, free of charge.
   */
  async #connectionForUse(): Promise<DaemonConnection> {
    if (this.#connection !== undefined) return this.#connection;
    this.#connecting ??= this.#connect();
    const connecting = this.#connecting;
    try {
      const connection = await connecting;
      if (this.#closed) {
        await this.#closeDaemonConnection(connection);
        this.#throwIfClosed();
      }
      this.#connection = connection;
      this.#pushUnsubscribe = connection.onPush((kind, payload) => this.#handlePush(kind, payload));
      this.#closeUnsubscribe = connection.onClose(() => this.#handleConnectionClosed(connection));
      return connection;
    } catch (error: unknown) {
      this.#throwIfClosed();
      if (error instanceof DaemonClientError || error instanceof McpSessionError) throw error;
      throw new DaemonClientError("DAEMON_UNAVAILABLE", errorMessage(error));
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  async #closeConnection(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#pushUnsubscribe?.();
    this.#pushUnsubscribe = undefined;
    this.#closeUnsubscribe?.();
    this.#closeUnsubscribe = undefined;
    if (connection !== undefined) await this.#closeDaemonConnection(connection);
  }

  /**
   * The invariant this relies on: a dead connection means the held lease is already gone
   * daemon-side, by one of three paths — a graceful `daemon stop` releases held leases before
   * exiting, an ordinary connection close releases that connection's held leases the same way,
   * and an ungraceful death leaves the lease persisted for the startup path to release as
   * `orphaned`. So this never asks the daemon; it just stops believing the lease is ours and
   * tells the agent (#15's `onLeaseLost` channel) so it can decide whether to re-lease.
   */
  #handleConnectionClosed(connection: DaemonConnection): void {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    this.#pushUnsubscribe?.();
    this.#pushUnsubscribe = undefined;
    this.#closeUnsubscribe = undefined;
    if (this.#ownedLease === undefined) return;
    const lease = this.#ownedLease;
    this.#ownedLease = undefined;
    for (const listener of this.#leaseLostListeners) {
      listener({
        deviceId: lease.deviceId,
        leaseId: lease.leaseId,
        reason: "daemon-connection-lost",
      });
    }
  }

  /**
   * Retries at most once, and only for idempotent, read-only requests. A `lease.request` must
   * never go through here: retrying it after a mid-request connection death could provision and
   * grant a *second* device, which would violate "reconnecting never implicitly acquires one".
   */
  async #requestReadOnly(type: string, payload: unknown): Promise<unknown> {
    const connection = await this.#connectionForUse();
    try {
      return await Promise.race([connection.request(type, payload), this.#sessionClosed]);
    } catch (error: unknown) {
      if (!(error instanceof DaemonClientError) || error.code !== "DAEMON_CONNECTION_LOST") {
        throw error;
      }
      // The close listener may not have run yet -- `IpcDaemonConnection.request()` also
      // rejects synchronously once it observes the transport already closed, ahead of the
      // underlying `onClose` propagating back to `#handleConnectionClosed`. Don't trust that
      // ordering: if this is still the connection that just failed, drop it explicitly so
      // `#connectionForUse()` is forced to build a fresh one instead of handing back the same
      // dead connection.
      if (this.#connection === connection) await this.#closeConnection().catch(() => undefined);
      const retryConnection = await this.#connectionForUse();
      return await Promise.race([retryConnection.request(type, payload), this.#sessionClosed]);
    }
  }

  /**
   * Relays a daemon push to this session's own listeners (lease-lost facts, in-flight lease
   * progress, and the heartbeat ack that keeps `#ownedLease.expiresAtMs` truthful under the
   * sliding TTL — see `IpcDaemonConnection`, which turns the server's `lease.heartbeat` push
   * into an answered request and re-surfaces its ack here under the same push kind).
   */
  #handlePush(kind: string, payload: unknown): void {
    switch (kind) {
      case "progress":
        this.#handleLeaseProgress(payload);
        return;
      case "lease.heartbeat":
        this.#handleHeartbeatAck(payload);
        return;
      case "lease-lost":
        this.#handleLeaseLost(payload);
        return;
      case "device-unhealthy":
        this.#handleDeviceUnhealthy(payload);
        return;
      case "device-recovered":
        this.#handleDeviceRecovered(payload);
        return;
    }
  }

  /** Relays a lease-lost push to `#leaseLostListeners`, if it names this session's own lease. */
  #handleLeaseLost(payload: unknown): void {
    let notice: LeaseLostNotice;
    try {
      notice = parseRawLeaseLost(payload);
    } catch {
      return;
    }
    if (this.#ownedLease === undefined || this.#ownedLease.leaseId !== notice.leaseId) return;
    this.#ownedLease = undefined;
    for (const listener of this.#leaseLostListeners) listener(notice);
  }

  /** Relays a device-unhealthy push to `#deviceHealthListeners`, if it names this session's lease. */
  #handleDeviceUnhealthy(payload: unknown): void {
    let raw: ReturnType<typeof parseRawDeviceUnhealthy>;
    try {
      raw = parseRawDeviceUnhealthy(payload);
    } catch {
      return;
    }
    if (this.#ownedLease === undefined || this.#ownedLease.leaseId !== raw.leaseId) return;
    for (const listener of this.#deviceHealthListeners) {
      listener({
        deviceId: raw.deviceId,
        kind: "unhealthy",
        leaseId: raw.leaseId,
        reason: "crashed",
      });
    }
  }

  /** Relays a device-recovered push to `#deviceHealthListeners`, if it names this session's lease. */
  #handleDeviceRecovered(payload: unknown): void {
    let raw: ReturnType<typeof parseRawDeviceRecovered>;
    try {
      raw = parseRawDeviceRecovered(payload);
    } catch {
      return;
    }
    if (this.#ownedLease === undefined || this.#ownedLease.leaseId !== raw.leaseId) return;
    for (const listener of this.#deviceHealthListeners) {
      listener({
        attempts: raw.attempts,
        deviceId: raw.deviceId,
        kind: "recovered",
        leaseId: raw.leaseId,
      });
    }
  }

  /**
   * `lease_status` reads `#ownedLease.expiresAtMs` locally, with no daemon round-trip
   * (deliberate — see PR #25). Under a sliding TTL that cache would otherwise go stale the
   * moment a heartbeat renews the lease elsewhere; this keeps it truthful without adding a
   * round-trip to `status()` itself.
   */
  #handleHeartbeatAck(payload: unknown): void {
    if (this.#ownedLease === undefined) return;
    let ack: ReturnType<typeof parseRawLeaseHeartbeatAck>;
    try {
      ack = parseRawLeaseHeartbeatAck(payload);
    } catch {
      return;
    }
    const slid = ack.leases.find((lease) => lease.leaseId === this.#ownedLease?.leaseId);
    if (slid === undefined) return;
    this.#ownedLease = { ...this.#ownedLease, expiresAtMs: slid.ttlDeadline };
  }

  /** Relays a daemon progress push to the in-flight `lease()` call's own `onProgress`, if any. */
  #handleLeaseProgress(payload: unknown): void {
    if (this.#leaseProgressListener === undefined) return;
    let progress: LeaseProgressNotice;
    try {
      progress = parseRawLeaseProgress(payload);
    } catch {
      return;
    }
    this.#leaseProgressListener(progress);
  }

  async #closeDaemonConnection(connection: DaemonConnection): Promise<void> {
    if (this.#closedConnections.has(connection)) return;
    this.#closedConnections.add(connection);
    await connection.close();
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

function isNoLongerActiveLease(error: unknown): boolean {
  return (
    error instanceof DaemonClientError &&
    (error.code === "UNKNOWN_LEASE" || error.code === "LEASE_EXPIRED")
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McpSessionError("CANCELLED", "Lease request cancelled");
}

function noop(): void {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function daemonLeaseRequest(
  input: LeaseSimulatorInput,
  requesterId: string,
): Record<string, unknown> {
  return {
    allowDownload: input.allow_download,
    mode: "held",
    noWait: input.no_wait,
    requesterId,
    request: {
      model: input.device,
      ...(input.os === undefined ? {} : { osVersion: input.os }),
      platform: input.platform,
      ...(input.full ? { full: true } : {}),
    },
    ...(input.timeout_seconds === undefined
      ? {}
      : { timeoutMs: timeoutMilliseconds(input.timeout_seconds) }),
  };
}

function timeoutMilliseconds(timeoutSeconds: number): number {
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new McpSessionError(
      "INVALID_TIMEOUT",
      "timeout_seconds is too large to convert safely to milliseconds",
    );
  }
  return timeoutSeconds * 1_000;
}

function noLeaseStatus(): NoLeaseStatus {
  return { held: false };
}

function heldLeaseStatus(lease: OwnedLease): HeldLeaseStatus {
  return {
    device: lease.device,
    device_id: lease.deviceId,
    expires_at_ms: lease.expiresAtMs,
    held: true,
    lease_id: lease.leaseId,
    os: lease.os,
    platform: lease.platform,
    state: "leased",
  };
}

function leaseSimulatorOutput(grant: RawLeaseGrant): LeaseSimulatorOutput {
  return {
    address: grant.device.address,
    device: grant.device.spec.model,
    device_id: grant.device.driverDeviceId,
    expires_at_ms: grant.lease.ttlDeadline,
    lease_id: grant.lease.id,
    mode: "held",
    os: grant.device.spec.osVersion,
    platform: grant.device.spec.platform,
    slim: grant.slim,
    state: "leased",
    timing: {
      estimated_boot_ms: grant.timing.estimatedBootMs,
      estimated_provision_ms: grant.timing.estimatedProvisionMs,
      estimated_reclaim_ms: grant.timing.estimatedReclaimMs,
      estimated_ready_ms: grant.timing.estimatedReadyMs,
    },
  };
}
