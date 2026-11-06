import type {
  BaselineSaveInput,
  BaselineSaveOutput,
  LeaseRecord,
  RotateInput,
  RotateOutput,
  SimlockAdminClient,
} from "../admin/index.js";
import { isSimlockError, type AnySimlockError } from "../contract/index.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import type { Clock, Logger } from "../ports/index.js";
import { isUplinkLost, liveClient, type FleetViews, type WorkerDirectory } from "./fleet-ports.js";
import type { FleetLeaseEntry, FleetLeaseIndex } from "./lease-index.js";
import type { FleetLeaseRecord } from "./queue.js";

export interface FleetExecInput {
  readonly leaseId: string;
  readonly tool: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly stdinFile?: string;
}

export interface FleetRotateInput {
  readonly leaseId: string;
  readonly orientation: RotateInput["orientation"];
}

export interface FleetForwardingOptions {
  readonly clock: Clock;
  readonly directory: WorkerDirectory;
  readonly views: Pick<FleetViews, "view">;
  readonly leaseIndex: FleetLeaseIndex;
  readonly execTimeoutMs: number;
  readonly leaseRequestTimeoutMs: number;
  readonly logger: Logger;
}

export class FleetForwarding {
  constructor(private readonly options: FleetForwardingOptions) {}

  async renew(gatewayLeaseId: string, ttlMs: number | undefined): Promise<FleetLeaseRecord> {
    const entry = this.#requireEntry(gatewayLeaseId);
    let record: LeaseRecord;
    try {
      record = await this.#forwardToWorker(entry.workerId, (client) =>
        client.renewLease({
          leaseId: entry.workerLeaseId,
          ...(ttlMs === undefined ? {} : { ttlMs }),
        }),
      );
    } catch (error: unknown) {
      this.#forgetIfUnknownToWorker(gatewayLeaseId, error);
      throw error;
    }
    return this.projectRecord(record, entry);
  }

  /**
   * why: ADR 0061 §6: a save goes to the worker that holds the lease, by its own lease id; it ends the lease, so the index entry goes as after a release, and the answer waits for a view read with the worker's baselines, so a request after it sees the new copy.
   */
  async saveBaseline(
    gatewayLeaseId: string,
    input: Pick<BaselineSaveInput, "name" | "note">,
  ): Promise<BaselineSaveOutput> {
    const entry = this.#requireEntry(gatewayLeaseId);
    let saved: BaselineSaveOutput;
    try {
      saved = await this.#forwardToWorker(entry.workerId, (client) =>
        client.saveBaseline({
          leaseId: entry.workerLeaseId,
          name: input.name,
          ...(input.note === undefined ? {} : { note: input.note }),
        }),
      );
    } catch (error: unknown) {
      this.#forgetIfUnknownToWorker(gatewayLeaseId, error);
      throw error;
    }
    this.options.leaseIndex.remove(gatewayLeaseId);
    await this.options.directory.target(entry.workerId)?.refresh({ includeCatalog: true });
    return { ...saved, leaseId: gatewayLeaseId };
  }

  async release(gatewayLeaseId: string): Promise<void> {
    const entry = this.#requireEntry(gatewayLeaseId);
    try {
      await this.#forwardToWorker(entry.workerId, (client) =>
        client.releaseLease({ leaseId: entry.workerLeaseId }),
      );
    } catch (error: unknown) {
      this.#forgetIfUnknownToWorker(gatewayLeaseId, error);
      throw error;
    }
    this.options.leaseIndex.remove(gatewayLeaseId);
  }

  async releaseAll(): Promise<readonly string[]> {
    const released: string[] = [];
    let firstFailure: unknown;
    for (const entry of this.options.leaseIndex.all()) {
      try {
        await this.#forwardToWorker(entry.workerId, (client) =>
          client.releaseLease({ leaseId: entry.workerLeaseId }),
        );
        this.options.leaseIndex.remove(entry.gatewayLeaseId);
        released.push(entry.gatewayLeaseId);
      } catch (error: unknown) {
        if (this.#forgetIfUnknownToWorker(entry.gatewayLeaseId, error)) {
          // why: the worker already holds no such lease, so the release this call asked for is already true; failing on it would fail every later release-all.
          released.push(entry.gatewayLeaseId);
          continue;
        }
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) {
      throw this.#withReleasedDetails(firstFailure, released);
    }
    return released;
  }

  // why: a worker's `UNKNOWN_LEASE` is the only sign an index entry is wrong; no relayed fact ever ends a lease the worker has no record of, so without this the entry would never go.
  #forgetIfUnknownToWorker(gatewayLeaseId: string, error: unknown): boolean {
    if (!(error instanceof DispatchError) || error.code !== "UNKNOWN_LEASE") return false;
    this.options.leaseIndex.remove(gatewayLeaseId);
    return true;
  }

  #withReleasedDetails(error: unknown, released: readonly string[]): unknown {
    if (!(error instanceof DispatchError)) return error;
    const baseDetails =
      typeof error.details === "object" && error.details !== null ? error.details : {};
    return new DispatchError(error.code, error.message, {
      ...baseDetails,
      releasedLeaseIds: released,
    });
  }

  async exec(
    input: FleetExecInput,
    session: DispatchSession,
  ): Promise<{ readonly exitCode: number }> {
    const entry = this.#requireEntry(input.leaseId);
    const namespacedRequesterId = `${this.options.leaseIndex.requesterPrefix}${entry.requesterId}`;
    let started = false;
    const announceStarted = (): void => {
      if (started) return;
      started = true;
      session.onStarted?.();
    };
    // why: the timeout only stops awaiting the worker's `exec`, whose output keeps arriving; this flag stops relaying it once the caller was told the command timed out.
    let detached = false;
    return this.#forwardToWorker(entry.workerId, async (client) => {
      return this.#withExecTimeout(
        client.exec(
          {
            leaseId: entry.workerLeaseId,
            tool: input.tool,
            args: [...input.args],
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            ...(input.stdinFile === undefined ? {} : { stdinFile: input.stdinFile }),
            requesterId: namespacedRequesterId,
          },
          {
            onOutput: (chunk) => {
              if (detached) return;
              void session.onOutput?.(chunk.stream, chunk.chunk);
            },
            // why: only the worker knows when its process exists, so its relayed fact is the one path to `started`; a transport picks its response shape on it.
            onStarted: () => {
              if (detached) return;
              announceStarted();
            },
          },
        ),
        entry.workerId,
        () => {
          detached = true;
        },
      );
    });
  }

  /**
   * why: `device.rotate` forwarded to the worker that owns the lease, with the lease's own namespaced requester, bounded by `gateway.execTimeoutMs` like `exec`. A worker names the lease by its own id in any coded error; the caller holds the gateway's id, so the error names that instead.
   */
  async rotate(input: FleetRotateInput, _session: DispatchSession): Promise<RotateOutput> {
    const entry = this.#requireEntry(input.leaseId);
    const requesterId = `${this.options.leaseIndex.requesterPrefix}${entry.requesterId}`;
    try {
      const rotated = await this.#forwardToWorker(entry.workerId, (client) =>
        this.#withExecTimeout(
          client.rotate(entry.workerLeaseId, input.orientation, { requesterId }),
          entry.workerId,
          () => undefined,
          "device.rotate",
        ),
      );
      return { leaseId: input.leaseId, orientation: rotated.orientation };
    } catch (error) {
      throw this.#namedForCaller(error, entry);
    }
  }

  #namedForCaller(error: unknown, entry: FleetLeaseEntry): unknown {
    if (!(error instanceof DispatchError)) return error;
    const details =
      typeof error.details === "object" && error.details !== null ? error.details : undefined;
    const names = (details as { leaseId?: unknown } | undefined)?.leaseId === entry.workerLeaseId;
    const message = replaceWholeId(error.message, entry.workerLeaseId, entry.gatewayLeaseId);
    if (!names && message === error.message) return error;
    return new DispatchError(
      error.code,
      message,
      names ? { ...details, leaseId: entry.gatewayLeaseId } : error.details,
    );
  }

  #withExecTimeout<Value>(
    promise: Promise<Value>,
    workerId: string,
    onTimeout: () => void,
    operation = "device.exec",
  ): Promise<Value> {
    return this.#raceTimeout(
      promise,
      this.options.execTimeoutMs,
      () =>
        new DispatchError(
          "EXEC_TIMEOUT",
          `Worker ${workerId} did not answer ${operation} within gateway.execTimeoutMs (${String(this.options.execTimeoutMs)}ms)`,
        ),
      onTimeout,
    );
  }

  // why: a wedged worker would otherwise hold its waiter `processing`, where neither the queue timeout nor a cancel reaches it; a late grant after this fires is left an orphan on the worker.
  withLeaseRequestTimeout<Value>(
    promise: Promise<Value>,
    workerId: string,
    onTimeout: () => void,
  ): Promise<Value> {
    return this.#raceTimeout(
      promise,
      this.options.leaseRequestTimeoutMs,
      () =>
        new DispatchError(
          "WORKER_UNREACHABLE",
          `Worker ${workerId} did not answer lease.request within gateway.leaseRequestTimeoutMs (${String(this.options.leaseRequestTimeoutMs)}ms)`,
          { workerId },
        ),
      onTimeout,
    );
  }

  // why: `onTimeout` runs before the timeout error is built, so a caller whose callbacks outlive the promise can stop them in the same tick.
  #raceTimeout<Value>(
    promise: Promise<Value>,
    timeoutMs: number,
    buildTimeoutError: () => DispatchError,
    onTimeout?: () => void,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const timer = this.options.clock.setTimer(timeoutMs, () => {
        if (settled) return;
        settled = true;
        onTimeout?.();
        reject(buildTimeoutError());
      });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          reject(error);
        },
      );
    });
  }

  releaseOnWorker(workerId: string, workerLeaseId: string): void {
    void this.#forwardToWorker(workerId, (client) =>
      client.releaseLease({ leaseId: workerLeaseId }),
    ).catch((error: unknown) => {
      this.options.logger.warn("Failed to release a lease the gateway will not route", {
        message: error instanceof Error ? error.message : String(error),
        workerId,
        workerLeaseId,
      });
    });
  }

  async #forwardToWorker<Result>(
    workerId: string,
    fn: (client: SimlockAdminClient) => Promise<Result>,
  ): Promise<Result> {
    const client = liveClient(this.options.directory.target(workerId));
    if (client === undefined) {
      throw new DispatchError("WORKER_UNREACHABLE", `Worker ${workerId} is not reachable`, {
        workerId,
      });
    }
    try {
      return await fn(client);
    } catch (error: unknown) {
      if (isSimlockError(error)) throw classifyRelayedError(error, workerId);
      // why: a real transport failure arrives as a `SimlockError`, so anything else is this gateway's own bug, not a fact about the worker.
      if (error instanceof DispatchError) throw error;
      throw new DispatchError(
        "INTERNAL",
        `Unexpected error forwarding a call to worker ${workerId}`,
        { workerId },
      );
    }
  }

  #requireEntry(gatewayLeaseId: string): FleetLeaseEntry {
    const entry = this.options.leaseIndex.resolve(gatewayLeaseId);
    if (entry === undefined) {
      throw new DispatchError("UNKNOWN_LEASE", `Unknown lease: ${gatewayLeaseId}`, {
        leaseId: gatewayLeaseId,
      });
    }
    return entry;
  }

  projectRecord<
    Record extends { readonly id: string; readonly requesterId: string; readonly ownerId: string },
  >(
    record: Record,
    entry: FleetLeaseEntry,
  ): Record & { readonly worker?: { readonly id: string; readonly label?: string } } {
    const workerLabel = this.options.views.view(entry.workerId)?.label;
    return {
      ...record,
      id: entry.gatewayLeaseId,
      // why: the index's owner is what this gateway forwarded; a worker's echo of it is not trusted.
      ownerId: entry.ownerId,
      requesterId: entry.requesterId,
      ...(workerLabel === undefined
        ? { worker: { id: entry.workerId } }
        : { worker: { id: entry.workerId, label: workerLabel } }),
    };
  }
}

// why: a transport failure of the uplink is the worker being unreachable, not the client's own connection-loss code; any other refusal is relayed byte for byte.
export function classifyRelayedError(error: AnySimlockError, workerId: string): DispatchError {
  if (isUplinkLost(error)) {
    return new DispatchError("WORKER_UNREACHABLE", error.message, { workerId });
  }
  return new DispatchError(error.code, error.message, error.details);
}

// why: a lease id is replaced only as a whole token, so a short id inside a longer word or id is left alone.
function replaceWholeId(text: string, id: string, replacement: string): string {
  const isIdCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[\w-]/.test(character);
  let result = "";
  let from = 0;
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, from)) {
    const end = at + id.length;
    const whole = !isIdCharacter(text[at - 1]) && !isIdCharacter(text[end]);
    result += text.slice(from, at) + (whole ? replacement : id);
    from = end;
  }
  return result + text.slice(from);
}
