/**
 * Doubles the gateway's own suites share: a scripted worker (the `SimlockAdminClient` a
 * `WorkerLink` drives, with no daemon behind it) and the small fixtures every view needs.
 *
 * The scripted client is deliberately shaped like the real one -- it answers `status.get`,
 * `list.get`, `catalog.get` and `events.subscribe`, and can be told to fail a call or push an
 * event -- so a test drives the same code path a real worker would, minus the socket.
 */
import type { z } from "zod";

import type { SimlockAdminClient, StatusGetOutput } from "../admin/index.js";
import { SimlockError } from "../admin/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import type { OPERATIONS, platformCatalogSchema } from "../contract/index.js";

type CatalogOutput = z.infer<(typeof OPERATIONS)["catalog.get"]["output"]>;
type PlatformCatalog = z.infer<typeof platformCatalogSchema>;
type EventEnvelope = z.infer<(typeof OPERATIONS)["events.replay"]["output"]>[number];

const emptyPlatformCapacity = {
  limit: 2,
  maxRunning: 2,
  overLimit: false,
  reserved: 0,
  running: 0,
  used: 0,
  warm: 0,
};

export function statusFixture(overrides: Partial<StatusGetOutput> = {}): StatusGetOutput {
  return {
    capacity: {
      android: { ...emptyPlatformCapacity },
      global: { maxRunning: 4, overLimit: false, reserved: 0, running: 0, warm: 0 },
      ios: { ...emptyPlatformCapacity },
    },
    daemon: { health: "running", mode: "worker" },
    devices: [],
    leases: [],
    queueDepth: 0,
    ...overrides,
  };
}

export function leaseFixture(id: string, deviceId: string) {
  return {
    deviceId,
    grantedAt: 1,
    id,
    lastRenewedAt: 1,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ttlDeadline: 900_001,
    ttlMs: 900_000,
  };
}

export function deviceFixture(id: string, state: "ready" | "leased" = "ready") {
  return {
    id,
    spec: { model: "iPhone 17", osVersion: "26.0", platform: "ios" as const },
    state,
  };
}

export function catalogFixture(entries: readonly PlatformCatalog[]): CatalogOutput {
  return { platforms: [...entries] };
}

type DownloadPolicy = "never" | "on-request" | "always";

/**
 * A `SimlockAdminClient` with only the methods a `WorkerLink` actually calls. Everything else
 * rejects loudly rather than returning a plausible-looking empty value: if the link starts
 * calling something new, the test that notices should be the one that says so.
 */
export class ScriptedWorkerClient {
  status: StatusGetOutput = statusFixture();
  devices: unknown[] = [];
  catalog: CatalogOutput = catalogFixture([]);
  /** What `config.get` reports; the view carries it as a routing input (ADR 0005 §13). */
  downloadPolicy: DownloadPolicy = "on-request";
  /** What `config.get` reports for `lease.maxTtlMs` (ADR 0005 §15) -- the routing-adjacent
   * counterpart to `downloadPolicy` above. Defaults comfortably above every gateway cap this
   * suite's fixtures use, so a test that never sets it cannot accidentally trip the new warning;
   * a test exercising §15 sets it explicitly. `config.get` always answers with a real
   * `lease.maxTtlMs` when it answers at all (the field predates this change and is not
   * optional on `Config`), so unlike `downloadPolicy` there is no "unset" state to script here
   * -- the workerViewSchema field's own optionality is `config === undefined`, exercised at
   * `WorkerRegistry`'s own level in `worker-registry.test.ts`, not through this fake. */
  leaseMaxTtlMs = 24 * 60 * 60_000;
  readonly calls: string[] = [];
  /** Set to reject every call with this error -- e.g. a protocol mismatch. */
  failWith: unknown;
  closed = false;
  /**
   * Names of calls (`"status.get"`, `"list.get:devices"`, `"catalog.get"`, `"config.get"`) that
   * should hang forever instead of answering -- for exercising `WorkerLink`'s own per-call
   * timeout (D2/D3) rather than a rejection, which `SimlockWire` already handles fine. A call
   * still lands in `calls` before it hangs, so a test can tell it was attempted.
   */
  readonly hangingCalls = new Set<string>();
  /** Makes the closure `subscribeEvents` returns hang forever instead of resolving -- the exact
   * shape of D2's `events.unsubscribe` round trip that never answers. Read at call time, not
   * captured when the closure is created, so a test can flip this after the worker is already
   * connected and subscribed. */
  hangUnsubscribe = false;
  #eventListener: ((push: { event: EventEnvelope }) => void) | undefined;

  constructor(
    readonly role: "admin" | "agent" = "admin",
    readonly daemonVersion = "0.3.0",
  ) {}

  /** Delivers one event to the gateway exactly as a worker's `events.subscribe` push would. */
  pushEvent(envelope: Partial<EventEnvelope> & { readonly event: string }): void {
    this.#eventListener?.({
      event: {
        module: "test",
        payload: {},
        seq: 1,
        timestamp: 1,
        ...envelope,
      } as EventEnvelope,
    });
  }

  get subscribed(): boolean {
    return this.#eventListener !== undefined;
  }

  asClient(): SimlockAdminClient {
    // The cast is the point of this double: a `WorkerLink` only ever touches the members below,
    // and fabricating the other twenty would say less about what it depends on, not more.
    return this as unknown as SimlockAdminClient;
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async getStatus(): Promise<StatusGetOutput> {
    this.calls.push("status.get");
    if (this.hangingCalls.has("status.get")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return this.status;
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async list(input: { readonly kind?: string }): Promise<unknown> {
    const name = `list.get:${input.kind ?? "devices"}`;
    this.calls.push(name);
    if (this.hangingCalls.has(name)) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return this.devices;
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async getCatalog(): Promise<CatalogOutput> {
    this.calls.push("catalog.get");
    if (this.hangingCalls.has("catalog.get")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return this.catalog;
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async getConfig(): Promise<{
    readonly downloads: { readonly policy: DownloadPolicy };
    readonly lease: { readonly maxTtlMs: number };
  }> {
    this.calls.push("config.get");
    if (this.hangingCalls.has("config.get")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return { downloads: { policy: this.downloadPolicy }, lease: { maxTtlMs: this.leaseMaxTtlMs } };
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async subscribeEvents(
    listener: (push: { event: EventEnvelope }) => void,
  ): Promise<() => Promise<void>> {
    this.calls.push("events.subscribe");
    this.#throwIfFailing();
    this.#eventListener = listener;
    return async () => {
      if (this.hangUnsubscribe) return new Promise<never>(() => {});
      this.#eventListener = undefined;
    };
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async close(): Promise<void> {
    this.closed = true;
  }

  #throwIfFailing(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
}

/** The rejection `connectSimlockAdmin`'s degraded client throws for every call when `hello`
 * found no overlapping protocol version (ADR 0003 §6) -- what marks a view `incompatible`. */
export function protocolMismatchError(
  worker: { readonly min: number; readonly max: number },
  gateway: { readonly min: number; readonly max: number } = PROTOCOL_VERSION_RANGE,
  daemonVersion = "0.2.0",
): SimlockError<"PROTOCOL_VERSION_UNSUPPORTED"> {
  return new SimlockError(
    "PROTOCOL_VERSION_UNSUPPORTED",
    "protocol",
    "No overlapping protocol version",
    { client: gateway, daemon: worker, daemonVersion },
  );
}
