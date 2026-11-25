/**
 * why: Doubles the gateway's own suites share: a scripted worker (the `SimlockAdminClient` a
 * `WorkerLink` drives, with no daemon behind it) and the small fixtures every view needs.
 *
 * The scripted client is deliberately shaped like the real one -- it answers `status.get`,
 * `list.get`, `catalog.get` and `events.subscribe`, and can be told to fail a call or push an
 * event -- so a test drives the same code path a real worker would, minus the socket.
 */
import type { z } from "zod";

import type {
  BaselineRemoveInput,
  BaselineRemoveOutput,
  BaselineSaveInput,
  BaselineSaveOutput,
  ComponentInstallInput,
  ComponentInstallOutput,
  DaemonUpdateInput,
  DaemonUpdateOutput,
  ExecInput,
  ExecOptions,
  ExecOutput,
  LeaseGrant,
  LeaseRecord,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseRenewInput,
  LeaseRequestInput,
  InstallComponentOptions,
  RequestLeaseOptions,
  RotateInput,
  RotateOutput,
  StatusGetOutput,
} from "../admin/index.js";
import type { GatewayWorkerClient } from "./worker-client.js";
import { SimlockError } from "../admin/index.js";
import { OPERATIONS, PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import type { BaselineEntry, platformCatalogSchema } from "../contract/index.js";

type CatalogOutput = z.infer<(typeof OPERATIONS)["catalog.get"]["output"]>;
type PlatformCatalog = z.infer<typeof platformCatalogSchema>;
type EventEnvelope = z.infer<(typeof OPERATIONS)["events.replay"]["output"]>[number];

const emptyPlatformCapacity = {
  atRamBudget: false,
  limit: 2,
  maxRunning: 2,
  overLimit: false,
  reserved: 0,
  running: 0,
  used: 0,
  warm: 0,
};

export function hostFixture(
  overrides: Partial<StatusGetOutput["host"]> = {},
): StatusGetOutput["host"] {
  return {
    arch: "arm64",
    os: "macOS",
    osVersion: "15.5",
    tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
    ...overrides,
  };
}

type RunningFields = "capacity" | "devices" | "leases" | "queueDepth";
export type RunningStatus = StatusGetOutput & {
  [Field in RunningFields]-?: NonNullable<StatusGetOutput[Field]>;
};

export function statusFixture(overrides: Partial<RunningStatus> = {}): RunningStatus {
  return {
    capacity: {
      android: { ...emptyPlatformCapacity },
      global: { maxRunning: 4, overLimit: false, reserved: 0, running: 0, warm: 0 },
      ios: { ...emptyPlatformCapacity },
    },
    daemon: {
      health: "running",
      mode: "worker",
      version: "0.0.0-test",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    },
    devices: [],
    host: hostFixture(),
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
    idChosenByRequester: false,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ttlDeadline: 900_001,
    ttlMs: 900_000,
  };
}

export function deviceFixture(
  id: string,
  state: "ready" | "leased" = "ready",
  mode: "slim" | "full" = "full",
  servesDefaultMode: boolean = true,
) {
  return {
    physical: false,
    id,
    mode,
    servesDefaultMode,
    spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" as const },
    state,
  };
}

export type PhysicalPresenceFixture =
  | { readonly present: true }
  | { readonly present: false; readonly reason: "locked" | "untrusted" | "not-present" };

export function physicalDeviceFixture(
  id: string,
  state: "ready" | "leased" | "reclaiming" | "absent" | "quarantined" | "deleted" = "ready",
  overrides: {
    readonly presence?: PhysicalPresenceFixture;
    readonly class?: "phone" | "tablet";
    readonly model?: string;
    readonly osVersion?: string;
    readonly platform?: "ios" | "android";
  } = {},
) {
  const { presence, class: deviceClass, model, osVersion, platform } = overrides;
  return {
    class: deviceClass ?? "phone",
    id,
    physical: true,
    servesDefaultMode: false,
    spec: {
      model: model ?? "iPhone 15 Pro",
      osVersion: osVersion ?? "18.4",
      physical: true,
      platform: platform ?? "ios",
    },
    state,
    ...(presence === undefined ? {} : { presence }),
  } as unknown as ReturnType<typeof deviceFixture>;
}

export function catalogFixture(
  entries: readonly (Omit<
    PlatformCatalog,
    "modelRuntimes" | "modelAliases" | "modelClasses" | "classDefaults"
  > &
    Partial<
      Pick<PlatformCatalog, "modelRuntimes" | "modelAliases" | "modelClasses" | "classDefaults">
    >)[],
): CatalogOutput {
  return {
    platforms: entries.map((entry) => ({
      ...entry,
      classDefaults: entry.classDefaults ?? {},
      modelAliases: entry.modelAliases ?? {},
      modelClasses: entry.modelClasses ?? {},
      modelRuntimes:
        entry.modelRuntimes ??
        Object.fromEntries(entry.models.map((model) => [model, [...entry.runtimes]])),
    })),
  };
}

export function grantFixture(overrides: Partial<LeaseGrant> = {}): LeaseGrant {
  return {
    device: {
      id: "dev_1",
      driverDeviceId: "udid-1",
      spec: { model: "iPhone 17", osVersion: "26.0", physical: false, platform: "ios" },
      mode: "full",
      physical: false,
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

/** why: A `NO_CAPACITY` a scripted worker refuses a forwarded `lease.request` with -- the shape
 * `FleetLeaseCoordinator` recognizes as a stale view (ADR §11), not a terminal failure. */
export function noCapacityError(): SimlockError<"NO_CAPACITY"> {
  return new SimlockError("NO_CAPACITY", "domain", "No device capacity is currently available", {});
}

type DownloadPolicy = "never" | "on-request" | "always";

export type RequestLeaseOutcome =
  | {
      readonly kind: "grant";
      readonly grant: LeaseGrant;
      readonly progress?: readonly LeaseProgressLike[];
      readonly beforeGrant?: () => void | Promise<void>;
    }
  | {
      readonly kind: "error";
      readonly error: unknown;
      /** why: P1 (round 2 review): a `NO_CAPACITY` reached *after* progress fired -- the worker's own
       * `#evictManaged` failure path can answer this to a `noWait` waiter after already pushing
       * `provisioning`/`reclaiming`, which is a terminal failure (device work had begun), never
       * a re-queue, unlike an *immediate* `NO_CAPACITY` (no progress) that means a stale view. */
      readonly progress?: readonly LeaseProgressLike[];
    }
  | { readonly kind: "hang"; readonly progress?: readonly LeaseProgressLike[] };

type LeaseProgressLike =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | {
      readonly stage: "downloading";
      readonly component: string;
      readonly waiting: boolean;
      readonly percent?: number | undefined;
    }
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
      readonly started?: boolean;
    }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "hang"; readonly started?: boolean };

/**
 * why: A `SimlockAdminClient` with only the methods a `WorkerLink` or a `FleetLeaseCoordinator`
 * actually call. Everything else rejects loudly rather than returning a plausible-looking empty
 * value: if either starts calling something new, the test that notices should be the one that
 * says so.
 */
export class ScriptedWorkerClient {
  status: StatusGetOutput = statusFixture();
  devices: unknown[] = [];
  catalog: CatalogOutput = catalogFixture([]);
  /** why: the inputs of the `baseline.save` and `baseline.remove` calls this worker answered. */
  readonly savedBaselines: BaselineSaveInput[] = [];
  readonly removedBaselines: BaselineRemoveInput[] = [];
  /** why: what `baseline.list` answers; the view carries it for routing (ADR 0061 §6). */
  baselines: BaselineEntry[] = [];
  downloadPolicy: DownloadPolicy = "on-request";
  downloadTimeoutMs = 20 * 60_000;
  /** why: What `config.get` reports for `lease.maxTtlMs` (ADR 0005 §15) -- the routing-adjacent
   * counterpart to `downloadPolicy` above. Defaults comfortably above every gateway cap this
   * suite's fixtures use, so a test that never sets it cannot accidentally trip the new warning;
   * a test exercising §15 sets it explicitly. `config.get` always answers with a real
   * `lease.maxTtlMs` when it answers at all (the field predates this change and is not
   * optional on `Config`), so unlike `downloadPolicy` there is no "unset" state to script here
   * -- the workerViewSchema field's own optionality is `config === undefined`, exercised at
   * `WorkerRegistry`'s own level in `worker-registry.test.ts`, not through this fake. */
  leaseMaxTtlMs = 24 * 60 * 60_000;
  readonly calls: string[] = [];
  failWith: unknown;
  subscribeDespiteFailure = false;
  closed = false;
  readonly hangingCalls = new Set<string>();
  #statusHold: Promise<void> | undefined;
  /** why: Makes the closure `subscribeEvents` returns hang forever instead of resolving -- the exact
   * shape of D2's `events.unsubscribe` round trip that never answers. Read at call time, not
   * captured when the closure is created, so a test can flip this after the worker is already
   * connected and subscribed. */
  hangUnsubscribe = false;
  #eventListener: ((push: { event: EventEnvelope }) => void) | undefined;

  readonly requestLeaseQueue: RequestLeaseOutcome[] = [];
  /** why: What a `lease.request` this worker was not explicitly scripted for answers with. Defaults
   * to `NO_CAPACITY`, deliberately: an un-scripted worker in a multi-worker test should refuse
   * rather than silently grant, so a routing bug that dispatches to the *wrong* worker shows up
   * as a rejection there instead of a second, unnoticed grant. */
  requestLeaseDefault: RequestLeaseOutcome = { kind: "error", error: noCapacityError() };
  readonly renewLeaseQueue: RenewLeaseOutcome[] = [];
  readonly releaseLeaseQueue: ReleaseLeaseOutcome[] = [];
  /** why: a real worker's `lease.released` event reaches the gateway before the release reply;
   * a test sets this to relay that event from inside the call. */
  onReleaseLease: ((leaseId: string) => void) | undefined;
  readonly execQueue: ExecOutcome[] = [];
  /**
   * why: H4 (round 3 review): the `options` most recently passed to `exec` -- captured before
   * `execQueue`'s own outcome is even read, so a `"hang"` outcome (whose returned promise never
   * settles) still leaves a test a way to invoke `onOutput` later by hand, simulating a worker
   * that keeps streaming output on a call the gateway has already given up awaiting.
   */
  lastExecOptions: ExecOptions | undefined;
  /** why: every input a gateway forwarded to this worker, to see which fields reached it. */
  readonly execInputs: ExecInput[] = [];
  /**
   * why: P4 (round 3 review): the mirror of `lastExecOptions` above, for `requestLease` -- captured
   * before `requestLeaseQueue`'s own outcome is even read, so a `"hang"` outcome leaves a test a
   * way to invoke `onProgress` later by hand, simulating a worker whose still-pending
   * `lease.request` RPC pushes progress after the gateway's own `leaseRequestTimeoutMs` already
   * gave up on it.
   */
  lastRequestLeaseOptions: RequestLeaseOptions | undefined;
  lastRequestLeaseInput: LeaseRequestInput | undefined;
  installComponentHandler: (
    input: ComponentInstallInput,
    options: InstallComponentOptions,
  ) => Promise<ComponentInstallOutput> = async (input) => ({
    component: input.version,
    outcome: "installed",
    platform: input.platform,
    version: input.version,
  });

  constructor(
    readonly role: "admin" | "agent" = "admin",
    readonly daemonVersion = "0.3.0",
  ) {}

  pushEvent(envelope: Partial<EventEnvelope> & { readonly event: string }): void {
    this.#eventListener?.({
      event: {
        id: "evt_test",
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

  asClient(): GatewayWorkerClient {
    // why: The cast is the point of this double: a `WorkerLink` only ever touches the members below,
    // and fabricating the other twenty would say less about what it depends on, not more.
    return this as unknown as GatewayWorkerClient;
  }

  holdStatus(): () => void {
    let release!: () => void;
    this.#statusHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.#statusHold = undefined;
      release();
    };
  }

  readonly updateInputs: DaemonUpdateInput[] = [];
  updateAnswer: DaemonUpdateOutput = {
    started: false,
    upToDate: false,
    resolved: null,
    version: "0.3.0",
    health: "running",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
  };

  // why: the degraded client lets `daemon.update` through (ADR 0042 §1), so this answers even when `failWith` is set.
  updateFailWith: unknown;

  async updateDaemon(input: DaemonUpdateInput = {}): Promise<DaemonUpdateOutput> {
    this.calls.push("daemon.update");
    this.updateInputs.push(input);
    if (this.hangingCalls.has("daemon.update")) return new Promise<never>(() => {});
    if (this.updateFailWith !== undefined) throw this.updateFailWith;
    return this.updateAnswer;
  }

  async getStatus(): Promise<StatusGetOutput> {
    this.calls.push("status.get");
    if (this.hangingCalls.has("status.get")) return new Promise<never>(() => {});
    await this.#statusHold;
    this.#throwIfFailing();
    // why: Parsed through the operation's output schema, as the real client parses every answer:
    // that parse is where the contract bounds what a worker claims (safety rule 10).
    return OPERATIONS["status.get"].output.parse(this.status);
  }

  async list(input: { readonly kind?: string }): Promise<unknown> {
    const name = `list.get:${input.kind ?? "devices"}`;
    this.calls.push(name);
    if (this.hangingCalls.has(name)) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return this.devices;
  }

  // fallow-ignore-next-line complexity -- one scripted outcome per branch of a real lease.request.
  async requestLease(
    input: LeaseRequestInput,
    options: RequestLeaseOptions = {},
  ): Promise<LeaseGrant> {
    this.calls.push(`lease.request:${input.requesterId ?? ""}`);
    this.#throwIfFailing();
    this.lastRequestLeaseOptions = options;
    this.lastRequestLeaseInput = input;
    const outcome = this.requestLeaseQueue.shift() ?? this.requestLeaseDefault;
    for (const progress of outcome.progress ?? []) options.onProgress?.(progress);
    if (outcome.kind === "hang") return new Promise<never>(() => {});
    if (outcome.kind === "error") throw outcome.error;
    await outcome.beforeGrant?.();
    return outcome.grant;
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    this.calls.push(`lease.renew:${input.leaseId}`);
    this.#throwIfFailing();
    const outcome = this.renewLeaseQueue.shift();
    if (outcome?.kind === "error") throw outcome.error;
    return outcome?.record ?? (leaseFixture(input.leaseId, "dev_1") as LeaseRecord);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    this.calls.push(`lease.release:${input.leaseId}`);
    this.#throwIfFailing();
    const outcome = this.releaseLeaseQueue.shift();
    if (outcome?.kind === "error") throw outcome.error;
    this.onReleaseLease?.(input.leaseId);
    return { leaseId: input.leaseId };
  }

  // fallow-ignore-next-line -- one scripted outcome per branch of a real exec (complexity), reached through the GatewayWorkerClient that asClient() casts this double to (unused-class-member).
  async exec(input: ExecInput, options: ExecOptions = {}): Promise<ExecOutput> {
    this.calls.push(`device.exec:${input.requesterId ?? ""}`);
    this.#throwIfFailing();
    this.lastExecOptions = options;
    this.execInputs.push(input);
    const outcome = this.execQueue.shift();
    if (outcome?.kind === "error") throw outcome.error;
    const { onOutput, onStarted } = options;
    if (outcome?.started === true) onStarted?.();
    if (outcome?.kind === "hang") return new Promise<never>(() => {});
    for (const chunk of outcome?.output ?? []) onOutput?.(chunk);
    return { exitCode: outcome?.exitCode ?? 0 };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async rotate(
    leaseId: string,
    orientation: RotateInput["orientation"],
    options: { readonly requesterId?: string } = {},
  ): Promise<RotateOutput> {
    this.calls.push(`device.rotate:${options.requesterId ?? ""}`);
    if (this.hangingCalls.has("device.rotate")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return { leaseId, orientation };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async installComponent(
    input: ComponentInstallInput,
    options: InstallComponentOptions = {},
  ): Promise<ComponentInstallOutput> {
    this.calls.push(`component.install:${input.platform}:${input.version}`);
    this.#throwIfFailing();
    return this.installComponentHandler(input, options);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async getCatalog(): Promise<CatalogOutput> {
    this.calls.push("catalog.get");
    if (this.hangingCalls.has("catalog.get")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return this.catalog;
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async saveBaseline(input: BaselineSaveInput): Promise<BaselineSaveOutput> {
    this.calls.push("baseline.save");
    this.#throwIfFailing();
    this.savedBaselines.push(input);
    const baseline = this.baselines.find((entry) => entry.name === input.name);
    return {
      baseline: baseline ?? {
        mode: "full",
        model: "iPhone 17",
        name: input.name,
        osVersion: "26.0",
        platform: "ios",
        savedAt: "2026-11-02T13:10:00Z",
        version: 1,
      },
      leaseId: input.leaseId,
    };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async removeBaseline(input: BaselineRemoveInput): Promise<BaselineRemoveOutput> {
    this.calls.push("baseline.remove");
    this.#throwIfFailing();
    this.removedBaselines.push(input);
    return { deletedDevices: [], name: input.name, versions: [1] };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async listBaselines(): Promise<{ readonly baselines: BaselineEntry[] }> {
    this.calls.push("baseline.list");
    if (this.hangingCalls.has("baseline.list")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return { baselines: this.baselines };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async getConfig(): Promise<{
    readonly downloads: { readonly policy: DownloadPolicy; readonly timeoutMs: number };
    readonly lease: { readonly maxTtlMs: number };
  }> {
    this.calls.push("config.get");
    if (this.hangingCalls.has("config.get")) return new Promise<never>(() => {});
    this.#throwIfFailing();
    return {
      downloads: { policy: this.downloadPolicy, timeoutMs: this.downloadTimeoutMs },
      lease: { maxTtlMs: this.leaseMaxTtlMs },
    };
  }

  async subscribeEvents(
    listener: (push: { event: EventEnvelope }) => void,
  ): Promise<() => Promise<void>> {
    this.calls.push("events.subscribe");
    if (!this.subscribeDespiteFailure) this.#throwIfFailing();
    this.#eventListener = listener;
    return async () => {
      if (this.hangUnsubscribe) return new Promise<never>(() => {});
      this.#eventListener = undefined;
    };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the GatewayWorkerClient that asClient() casts this double to.
  async close(): Promise<void> {
    this.closed = true;
  }

  #throwIfFailing(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
}

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
