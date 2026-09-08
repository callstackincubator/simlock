/**
 * Doubles the gateway's own suites share: a scripted worker (the `SimlockAdminClient` a
 * `WorkerLink` drives, with no daemon behind it) and the small fixtures every view needs.
 *
 * The scripted client is deliberately shaped like the real one -- it answers `status.get`,
 * `list.get`, `catalog.get` and `events.subscribe`, and can be told to fail a call or push an
 * event -- so a test drives the same code path a real worker would, minus the socket.
 */
import type { z } from "zod";

import type {
  ExecInput,
  ExecOptions,
  ExecOutput,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseRecord,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseRenewInput,
  LeaseRequestInput,
  RequestLeaseOptions,
  SimlockAdminClient,
  StatusGetOutput,
} from "../admin/index.js";
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

export function grantFixture(overrides: Partial<LeaseGrant> = {}): LeaseGrant {
  return {
    device: {
      id: "dev_1",
      driverDeviceId: "udid-1",
      spec: { model: "iPhone 17", osVersion: "26.0", platform: "ios" },
    },
    environment: {},
    lease: leaseFixture("lse_1", "dev_1") as LeaseRecord,
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReclaimMs: 0,
      estimatedReadyMs: 0,
    },
    ...overrides,
  };
}

/** A `NO_CAPACITY` a scripted worker refuses a forwarded `lease.request` with -- the shape
 * `FleetLeaseCoordinator` recognizes as a stale view (ADR §11), not a terminal failure. */
export function noCapacityError(): SimlockError<"NO_CAPACITY"> {
  return new SimlockError("NO_CAPACITY", "domain", "No device capacity is currently available", {});
}

type DownloadPolicy = "never" | "on-request" | "always";

/** One scripted answer to a forwarded `lease.request` -- consumed FIFO from
 * `ScriptedWorkerClient#requestLeaseQueue`, oldest first, one per call. */
export type RequestLeaseOutcome =
  | {
      readonly kind: "grant";
      readonly grant: LeaseGrant;
      readonly progress?: readonly LeaseProgressLike[];
    }
  | {
      readonly kind: "error";
      readonly error: unknown;
      /** P1 (round 2 review): a `NO_CAPACITY` reached *after* progress fired -- the worker's own
       * `#evictManaged` failure path can answer this to a `noWait` waiter after already pushing
       * `provisioning`/`reclaiming`, which is a terminal failure (device work had begun), never
       * a re-queue, unlike an *immediate* `NO_CAPACITY` (no progress) that means a stale view. */
      readonly progress?: readonly LeaseProgressLike[];
    }
  /** Never settles -- for exercising a dispatch attempt still in flight (finding 1's test: "a
   * dispatch tick firing while a previous attempt for the same waiter is in flight"), and (C4,
   * round 2 review) a request that is genuinely dispatched (a `progress` push fired) but then
   * never resolves at all -- the only way to prove `request.dispatched` fired *before*
   * settlement rather than merely alongside a grant that would have emitted it anyway. */
  | { readonly kind: "hang"; readonly progress?: readonly LeaseProgressLike[] };

type LeaseProgressLike =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning"; readonly etaMs: number }
  | { readonly stage: "booting"; readonly etaMs: number }
  | { readonly stage: "reclaiming"; readonly etaMs: number };

type RenewLeaseOutcome =
  | { readonly kind: "ok"; readonly record: LeaseRecord }
  | { readonly kind: "error"; readonly error: unknown };
type ReleaseLeaseOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly error: unknown };
type ExecOutcome =
  | {
      readonly kind: "ok";
      readonly exitCode: number;
      readonly output?: readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[];
      /** ADR 0005 §19a: the worker's own "the process now exists" push, sent before any output.
       * A worker older than that frame simply never sends it. */
      readonly started?: boolean;
    }
  | { readonly kind: "error"; readonly error: unknown }
  /** Never settles -- for exercising `gateway.execTimeoutMs` (P5, round 2 review): the worker
   * never answers `device.exec` at all. With `started: true` this is the silent, long-running
   * command of §19b/§19e -- a process that exists and has written nothing yet. */
  | { readonly kind: "hang"; readonly started?: boolean };

/**
 * A `SimlockAdminClient` with only the methods a `WorkerLink` or a `FleetLeaseCoordinator`
 * actually call. Everything else rejects loudly rather than returning a plausible-looking empty
 * value: if either starts calling something new, the test that notices should be the one that
 * says so.
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

  /** #118: one scripted `lease.request` answer per call, oldest first. Empty when unset --
   * `requestLeaseDefault` answers every call once this queue runs dry. */
  readonly requestLeaseQueue: RequestLeaseOutcome[] = [];
  /** What a `lease.request` this worker was not explicitly scripted for answers with. Defaults
   * to `NO_CAPACITY`, deliberately: an un-scripted worker in a multi-worker test should refuse
   * rather than silently grant, so a routing bug that dispatches to the *wrong* worker shows up
   * as a rejection there instead of a second, unnoticed grant. */
  requestLeaseDefault: RequestLeaseOutcome = { kind: "error", error: noCapacityError() };
  readonly renewLeaseQueue: RenewLeaseOutcome[] = [];
  readonly releaseLeaseQueue: ReleaseLeaseOutcome[] = [];
  readonly execQueue: ExecOutcome[] = [];
  /**
   * H4 (round 3 review): the `options` most recently passed to `exec` -- captured before
   * `execQueue`'s own outcome is even read, so a `"hang"` outcome (whose returned promise never
   * settles) still leaves a test a way to invoke `onOutput` later by hand, simulating a worker
   * that keeps streaming output on a call the gateway has already given up awaiting.
   */
  lastExecOptions: ExecOptions | undefined;
  /**
   * P4 (round 3 review): the mirror of `lastExecOptions` above, for `requestLease` -- captured
   * before `requestLeaseQueue`'s own outcome is even read, so a `"hang"` outcome leaves a test a
   * way to invoke `onProgress` later by hand, simulating a worker whose still-pending
   * `lease.request` RPC pushes progress after the gateway's own `leaseRequestTimeoutMs` already
   * gave up on it.
   */
  lastRequestLeaseOptions: RequestLeaseOptions | undefined;

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

  /** #118: `FleetLeaseCoordinator#attempt` forwards every dispatch through this, always with
   * `noWait: true` (ADR §12) -- scripted per `requestLeaseQueue`/`requestLeaseDefault` above. */
  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async requestLease(
    input: LeaseRequestInput,
    options: RequestLeaseOptions = {},
  ): Promise<LeaseGrant> {
    this.calls.push(`lease.request:${input.requesterId ?? ""}`);
    this.#throwIfFailing();
    this.lastRequestLeaseOptions = options;
    const outcome = this.requestLeaseQueue.shift() ?? this.requestLeaseDefault;
    for (const progress of outcome.progress ?? []) options.onProgress?.(progress);
    if (outcome.kind === "hang") return new Promise<never>(() => {});
    if (outcome.kind === "error") throw outcome.error;
    return outcome.grant;
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    this.calls.push(`lease.renew:${input.leaseId}`);
    this.#throwIfFailing();
    const outcome = this.renewLeaseQueue.shift();
    if (outcome?.kind === "error") throw outcome.error;
    return outcome?.record ?? (leaseFixture(input.leaseId, "dev_1") as LeaseRecord);
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    this.calls.push(`lease.release:${input.leaseId}`);
    this.#throwIfFailing();
    const outcome = this.releaseLeaseQueue.shift();
    if (outcome?.kind === "error") throw outcome.error;
    return { leaseId: input.leaseId };
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async cancelLease(_input: LeaseCancelInput = {}): Promise<LeaseCancelOutput> {
    this.calls.push("lease.cancel");
    this.#throwIfFailing();
    return { result: "cancelled" };
  }

  /** #118: `FleetLeaseCoordinator#exec` forwards here with the namespaced requester -- assert
   * on `calls` (test: "device.exec forwarding sends the namespaced requesterId"). */
  // fallow-ignore-next-line unused-class-member -- reached structurally through the `SimlockAdminClient` the cast in `asClient()` produces; the audit cannot follow a member access through that.
  async exec(input: ExecInput, options: ExecOptions = {}): Promise<ExecOutput> {
    this.calls.push(`device.exec:${input.requesterId ?? ""}`);
    this.#throwIfFailing();
    this.lastExecOptions = options;
    const outcome = this.execQueue.shift();
    if (outcome?.kind === "hang") {
      if (outcome.started === true) options.onStarted?.();
      return new Promise<never>(() => {});
    }
    if (outcome?.kind === "error") throw outcome.error;
    if (outcome?.started === true) options.onStarted?.();
    for (const chunk of outcome?.output ?? []) options.onOutput?.(chunk);
    return { exitCode: outcome?.exitCode ?? 0 };
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
