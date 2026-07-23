import { parseRawLeaseGrant, type RawLeaseGrant } from "../daemon-client/contracts.js";
import { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";
import type {
  LeaseSimulatorInput,
  LeaseSimulatorOutput,
  ReleaseSimulatorInput,
  ReleaseSimulatorOutput,
} from "./contracts.js";
import { leaseSimulatorOutputSchema } from "./contracts.js";

export interface McpSessionOptions {
  readonly connect: () => Promise<DaemonConnection>;
  readonly requesterId: string;
}

export interface McpErrorResult {
  readonly code: string;
  readonly message: string;
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
  #ownedLeaseId: string | undefined;
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
      if (this.#ownedLeaseId !== input.lease_id) {
        throw new McpSessionError("LEASE_NOT_OWNED", "This session does not own that lease");
      }
      const connection = await this.#connectionForUse();
      try {
        await Promise.race([
          connection.request("lease.release", { leaseId: input.lease_id }),
          this.#sessionClosed,
        ]);
      } catch (error: unknown) {
        if (isNoLongerActiveLease(error)) this.#ownedLeaseId = undefined;
        throw error;
      }
      this.#ownedLeaseId = undefined;
      return { lease_id: input.lease_id, released: true };
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#ownedLeaseId = undefined;
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
    if (this.#ownedLeaseId !== undefined) {
      throw new McpSessionError("LEASE_ALREADY_OWNED", "This session already owns a lease");
    }
    throwIfAborted(signal);

    const abortWatch = this.#watchLeaseAbort(signal);
    let responseReceived = false;
    try {
      const connection = await this.#connectionForUse();
      await this.#throwIfCancelledBeforeRequest(signal);
      const response = await this.#requestLease(connection, input, abortWatch.cancelled);
      responseReceived = true;
      return await this.#mapLeaseResponse(response, signal, abortWatch);
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
      throw new McpSessionError("INVALID_LEASE_GRANT", "Daemon returned a non-held lease grant");
    }
    const output = leaseSimulatorOutputSchema.parse(leaseSimulatorOutput(grant));
    this.#ownedLeaseId = grant.lease.id;
    return output;
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
    if (connection !== undefined) await this.#closeDaemonConnection(connection);
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
    ...(input.timeout_seconds === undefined ? {} : { timeoutMs: input.timeout_seconds * 1_000 }),
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
