/**
 * The typed client's wire layer (ADR 0003 §10). One connection, one frame-id space, no
 * reconnect and no retry -- see the module comment on `client.ts` for the policy this
 * implements. This file owns only framing, push routing, and connection-death handling; every
 * typed method surface lives in `client.ts`.
 */
import type { IpcConnection } from "../ports/index.js";
import {
  fromWireError,
  mapLegacyProtocolMismatch,
  normalizeProtocolVersion,
  PROTOCOL_VERSION_RANGE,
  PUSH_SCHEMAS,
  SimlockError,
  helloReplySchema,
  type AnySimlockError,
  type ProtocolRange,
  type Role,
} from "../contract/index.js";
import { parseDaemonResponse, serializeFrame } from "../daemon-protocol/index.js";
import type { LeaseProgress } from "./types.js";

/** The one legacy code a protocol-2 daemon answers `hello` with (see
 * `src/daemon-client/startup-coordinator.ts`'s comment, the only place in this repo that names
 * it -- there is no live protocol-2 daemon to negotiate with, so this constant documents a
 * historical fact rather than something exercised against a real peer). */
const LEGACY_MISMATCH_CODE = "PROTOCOL_VERSION_MISMATCH";

export interface HelloOptions {
  readonly principal?: string;
  readonly credential?: string;
  readonly capabilities?: { readonly heartbeat?: boolean };
}

export interface HelloResult {
  readonly protocolVersion: number;
  readonly daemonProtocolRange: ProtocolRange;
  readonly daemonVersion: string;
  readonly role: Role;
  /** ADR §4: the connection's resolved, fixed-for-its-lifetime principal -- see
   * `helloReplySchema`'s comment. */
  readonly principal: string;
}

interface PendingCall {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: ((progress: LeaseProgress) => void) | undefined;
}

export type LeaseScopedPush =
  | {
      readonly kind: "lease-lost";
      readonly leaseId: string;
      readonly deviceId: string;
      readonly reason: string;
    }
  | { readonly kind: "device-unhealthy"; readonly leaseId: string; readonly deviceId: string }
  | {
      readonly kind: "device-recovered";
      readonly leaseId: string;
      readonly deviceId: string;
      readonly attempts: number;
    };

/**
 * Everything below `client.ts`'s typed method surface: frame ids, pending-call bookkeeping,
 * push routing and de-duplication, and connection-death fan-out. Deliberately has no idea what
 * a "lease" or a "grant" is beyond the push correlation keys the contract declares -- that
 * vocabulary lives in `client.ts`.
 */
export class SimlockWire {
  readonly #connection: IpcConnection;
  readonly #pending = new Map<number, PendingCall>();
  readonly #leaseScopedListeners = new Set<(push: LeaseScopedPush) => void>();
  readonly #eventListeners = new Set<(payload: unknown) => void>();
  readonly #closeListeners = new Set<(error: AnySimlockError) => void>();
  /** Lease ids this client itself asked to release -- suppresses the matching `lease-lost`
   * push exactly once (ADR §8: "never fires onLeaseLost for a release the same client asked
   * for"), then is removed so a *later*, unrelated crash for a reused lease id is not silently
   * eaten forever. */
  readonly #selfInitiatedReleases = new Set<string>();
  /** De-dup key (`${kind}:${leaseId}`) for lease-scoped pushes already delivered, so a
   * redundant re-push (the owner-routed fan-out can in principle reach the same connection
   * twice for one fact) does not fire a listener twice for the same fact. */
  readonly #deliveredLeaseScoped = new Set<string>();
  #buffer = "";
  #nextId = 1;
  #dead: AnySimlockError | undefined;

  constructor(connection: IpcConnection) {
    this.#connection = connection;
    connection.onData((chunk) => this.#read(chunk));
    connection.onError(() =>
      this.#die(
        new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Daemon connection is closed", {}),
      ),
    );
    connection.onClose(() =>
      this.#die(
        new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Daemon connection closed", {}),
      ),
    );
  }

  /** Sends `hello` and returns its reply, or throws the contract's typed mismatch/auth error.
   * Called exactly once, before any other frame -- see `client.ts`'s `connect*` functions. */
  async hello(options: HelloOptions): Promise<HelloResult> {
    let raw: unknown;
    try {
      raw = await this.#send("hello", {
        clientVersion: "1.0.0",
        protocolVersion: PROTOCOL_VERSION_RANGE.max,
        protocolRange: PROTOCOL_VERSION_RANGE,
        ...(options.principal === undefined ? {} : { principal: options.principal }),
        ...(options.credential === undefined ? {} : { credential: options.credential }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      });
    } catch (error: unknown) {
      throw this.#toHelloError(error);
    }
    const parsed = helloReplySchema.safeParse(raw);
    if (!parsed.success) {
      throw new SimlockError(
        "BAD_FRAME",
        "protocol",
        "Daemon's hello reply did not match the protocol contract",
        {},
      );
    }
    return {
      daemonProtocolRange: parsed.data.daemonProtocolRange,
      daemonVersion: parsed.data.version,
      principal: parsed.data.principal,
      protocolVersion: parsed.data.protocolVersion,
      role: parsed.data.role,
    };
  }

  #toHelloError(error: unknown): AnySimlockError {
    if (!(error instanceof WireCallError)) {
      return new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        error instanceof Error ? error.message : String(error),
        {},
      );
    }
    if (error.code === LEGACY_MISMATCH_CODE) {
      return mapLegacyProtocolMismatch(PROTOCOL_VERSION_RANGE, error.message);
    }
    if (error.code === "PROTOCOL_VERSION_UNSUPPORTED") {
      const details = asRecord(error.details);
      const client = asProtocolRange(details.client) ?? PROTOCOL_VERSION_RANGE;
      const daemon = asProtocolRange(details.daemon);
      if (daemon !== undefined) {
        return new SimlockError("PROTOCOL_VERSION_UNSUPPORTED", "protocol", error.message, {
          client,
          daemon,
          daemonVersion:
            typeof details.daemonVersion === "string" ? details.daemonVersion : "unknown",
        });
      }
    }
    return fromWireError(error.code, error.message, error.details);
  }

  /** One request/response round trip for an already role/shape-agnostic operation name.
   * `client.ts` is responsible for input/output schema validation; this only moves bytes and
   * correlates frame ids. */
  call(
    type: string,
    payload: unknown,
    onProgress?: (progress: LeaseProgress) => void,
  ): Promise<unknown> {
    if (this.#dead !== undefined) return Promise.reject(this.#dead);
    return this.#send(type, payload, onProgress);
  }

  onLeaseScopedPush(listener: (push: LeaseScopedPush) => void): () => void {
    this.#leaseScopedListeners.add(listener);
    return () => this.#leaseScopedListeners.delete(listener);
  }

  onEvent(listener: (payload: unknown) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Fires exactly once, when this connection dies (socket close/error, or `close()`). */
  onDeath(listener: (error: AnySimlockError) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** A lease this client itself is releasing: the next matching `lease-lost` push is
   * swallowed rather than surfaced as a loss. */
  markSelfInitiatedRelease(leaseId: string): void {
    this.#selfInitiatedReleases.add(leaseId);
  }

  async close(): Promise<void> {
    this.#die(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Client closed the connection", {}),
    );
    await this.#connection.close();
  }

  #send(
    type: string,
    payload: unknown,
    onProgress?: (progress: LeaseProgress) => void,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { onProgress, reject, resolve });
      void this.#connection.write(serializeFrame({ id, payload, type })).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue; // A malformed line from the daemon is not this client's problem to crash over.
      }
      this.#dispatch(value);
    }
  }

  // fallow-ignore-next-line complexity -- one frame-kind switch, deliberately not split further.
  #dispatch(value: unknown): void {
    const frame = parseDaemonResponse(value);
    if (frame === undefined) return;
    if (frame.kind === "push") {
      this.#dispatchPush(frame.push, frame.payload);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return; // ADR §8: drop pushes/replies for ids no longer tracked.
    this.#pending.delete(frame.id);
    if (frame.kind === "success") {
      pending.resolve(frame.payload);
    } else {
      const details = asRecord(frame.error);
      pending.reject(
        new WireCallError(
          typeof details.code === "string" ? details.code : "INTERNAL",
          typeof details.message === "string" ? details.message : "Daemon request failed",
          details.details,
        ),
      );
    }
  }

  // fallow-ignore-next-line complexity -- one push-kind switch, deliberately not split further (matches DaemonServer/Dispatcher's own single-switch dispatch style elsewhere).
  #dispatchPush(push: string, payload: unknown): void {
    switch (push) {
      case "progress": {
        const parsed = PUSH_SCHEMAS.progress.safeParse(payload);
        if (!parsed.success) return;
        const requestId = parsed.data.requestId;
        const id = typeof requestId === "number" ? requestId : Number(requestId);
        const pending = this.#pending.get(id);
        pending?.onProgress?.(parsed.data.progress);
        return;
      }
      case "lease-lost": {
        const parsed = PUSH_SCHEMAS["lease-lost"].safeParse(payload);
        if (!parsed.success) return;
        const suppressed = this.#selfInitiatedReleases.delete(parsed.data.leaseId);
        if (suppressed) return;
        this.#emitLeaseScoped({
          deviceId: parsed.data.deviceId,
          kind: "lease-lost",
          leaseId: parsed.data.leaseId,
          reason: parsed.data.reason,
        });
        return;
      }
      case "device-unhealthy": {
        const parsed = PUSH_SCHEMAS["device-unhealthy"].safeParse(payload);
        if (!parsed.success) return;
        this.#emitLeaseScoped({
          deviceId: parsed.data.deviceId,
          kind: "device-unhealthy",
          leaseId: parsed.data.leaseId,
        });
        return;
      }
      case "device-recovered": {
        const parsed = PUSH_SCHEMAS["device-recovered"].safeParse(payload);
        if (!parsed.success) return;
        this.#emitLeaseScoped({
          attempts: parsed.data.attempts,
          deviceId: parsed.data.deviceId,
          kind: "device-recovered",
          leaseId: parsed.data.leaseId,
        });
        return;
      }
      case "lease.heartbeat": {
        // Reactive pong, same behavior as today's `daemon-client/connection.ts`: answer with
        // an ordinary request frame carrying the same payload (nonce), fire-and-forget.
        void this.#send("lease.heartbeat", payload).catch(() => undefined);
        return;
      }
      case "event": {
        const parsed = PUSH_SCHEMAS.event.safeParse(payload);
        if (!parsed.success) return;
        for (const listener of this.#eventListeners) listener(parsed.data);
        return;
      }
      default:
        return;
    }
  }

  #emitLeaseScoped(push: LeaseScopedPush): void {
    const key = `${push.kind}:${push.leaseId}`;
    if (this.#deliveredLeaseScoped.has(key)) return;
    this.#deliveredLeaseScoped.add(key);
    for (const listener of this.#leaseScopedListeners) listener(push);
  }

  #die(error: AnySimlockError): void {
    if (this.#dead !== undefined) return;
    this.#dead = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(error);
  }
}

/** Internal wire-level rejection: `{code, message, details}` straight off the wire, not yet
 * mapped through the contract's error table. `client.ts`/`hello()` do that mapping -- kept
 * separate from `SimlockError` so a mid-mapping bug cannot masquerade as a real contract error. */
export class WireCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WireCallError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asProtocolRange(value: unknown): ProtocolRange | undefined {
  const record = asRecord(value);
  return typeof record.min === "number" && typeof record.max === "number"
    ? normalizeProtocolVersion({ max: record.max, min: record.min })
    : undefined;
}
