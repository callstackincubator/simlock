import {
  parseRawCatalog,
  parseRawLeaseGrant,
  parseRawLeaseLost,
  type RawLeaseGrant,
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
  return { code: "INTERNAL", message: "Pitlane could not complete the request" };
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
  readonly #leaseLostListeners = new Set<(notice: LeaseLostNotice) => void>();
  #mutations: Promise<void> = Promise.resolve();

  constructor(options: McpSessionOptions) {
    this.#connect = options.connect;
    this.#requesterId = options.requesterId;
    this.#sessionClosed = new Promise<never>((_resolve, reject) => {
      this.#rejectClosed = reject;
    });
    void this.#sessionClosed.catch(() => undefined);
  }

  lease(input: LeaseSimulatorInput, signal?: AbortSignal): Promise<LeaseSimulatorOutput> {
    return this.#mutate(() => {
      this.#throwIfClosed();
      return this.#lease(input, signal);
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
      const connection = await this.#connectionForUse();
      const response = await Promise.race([
        connection.request(
          "catalog.get",
          input.platform === undefined ? {} : { platform: input.platform },
        ),
        this.#sessionClosed,
      ]);
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

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#ownedLease = undefined;
    this.#pushUnsubscribe?.();
    this.#pushUnsubscribe = undefined;
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

  async #lease(input: LeaseSimulatorInput, signal?: AbortSignal): Promise<LeaseSimulatorOutput> {
    throwIfAborted(signal);

    const abortWatch = this.#watchLeaseAbort(signal);
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
      return connection;
    } catch (error: unknown) {
      this.#throwIfClosed();
      throw error;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  async #closeConnection(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#pushUnsubscribe?.();
    this.#pushUnsubscribe = undefined;
    if (connection !== undefined) await this.#closeDaemonConnection(connection);
  }

  /** Relays a daemon lease-lost push to this session's own listeners (e.g. an MCP logging notification). */
  #handlePush(kind: string, payload: unknown): void {
    if (kind !== "lease-lost") return;
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
    device: grant.device.spec.model,
    device_id: grant.device.driverDeviceId,
    expires_at_ms: grant.lease.ttlDeadline,
    lease_id: grant.lease.id,
    mode: "held",
    os: grant.device.spec.osVersion,
    platform: grant.device.spec.platform,
    state: "leased",
    timing: {
      estimated_boot_ms: grant.timing.estimatedBootMs,
      estimated_provision_ms: grant.timing.estimatedProvisionMs,
      estimated_reclaim_ms: grant.timing.estimatedReclaimMs,
      estimated_ready_ms: grant.timing.estimatedReadyMs,
    },
  };
}
