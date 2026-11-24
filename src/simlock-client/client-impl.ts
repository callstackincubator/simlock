import type { z } from "zod";

import {
  type AnySimlockError,
  describeSchemaIssues,
  isSimlockError,
  type OperationName,
  OPERATIONS,
  type Role,
  SimlockError,
} from "../contract/index.js";
import type { LinkChannel, LinkConnection } from "../link/index.js";
import type { CallHooks, LeaseScopedPush, SimlockWire } from "./wire.js";
import type {
  OperationInput,
  OperationOutput,
  SimlockAdminClient,
  SimlockClient,
} from "./client-api.js";
import { cancelledError, toSimlockError } from "./client-errors.js";
import type {
  AlertsTestInput,
  AlertsTestOutput,
  BaselineListOutput,
  BaselineRemoveInput,
  BaselineRemoveOutput,
  BaselineSaveInput,
  BaselineSaveOutput,
  CatalogGetInput,
  CatalogGetOutput,
  CleanupRunInput,
  CleanupRunOutput,
  ComponentInstallInput,
  ComponentInstallOutput,
  ComponentListInput,
  ComponentListOutput,
  ComponentRemoveInput,
  ComponentRemoveOutput,
  ConfigGetInput,
  DaemonStopOutput,
  DaemonUpdateInput,
  DaemonUpdateOutput,
  DeviceAddInput,
  DeviceAddOutput,
  DeviceRecoveredPush,
  DeviceRemoveInput,
  DeviceRemoveOutput,
  DeviceUnhealthyPush,
  DoctorReport,
  DoctorRunInput,
  DriverPassthroughInput,
  EventPush,
  EventsReplayInput,
  EventsReplayOutput,
  ExecInput,
  ExecOptions,
  ExecOutput,
  IdentityOutput,
  InstallComponentOnWorkersOptions,
  InstallComponentOptions,
  MakeSeedOptions,
  SeedMakeInput,
  SeedMakeOutput,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseListOutput,
  LeaseLostPush,
  LeaseRecord,
  LeaseReleaseAllOutput,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseReleaseRunInput,
  LeaseReleaseRunOutput,
  LeaseRenewInput,
  LeaseRequestInput,
  ListGetInput,
  ListGetOutput,
  NukeReport,
  NukeRunInput,
  PassthroughCommand,
  RequestLeaseOptions,
  RotateInput,
  RotateOutput,
  SimlockConfig,
  StatusGetOutput,
  TokenCreateInput,
  TokenCreateOutput,
  TokenListOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
  UsageGetInput,
  UsageGetOutput,
  WarmForgetInput,
  WarmForgetOutput,
  WorkerDrainInput,
  WorkerDrainOutput,
  WorkerInstallComponentInput,
  WorkerInstallComponentOutput,
  WorkerListOutput,
  WorkerRemoveOutput,
  WorkerUndrainOutput,
  WorkerUpdateInput,
  WorkerUpdateOutput,
} from "./types.js";

// why: the class stays private to this file, as it was in client.ts: callers hold it only as the
// client interface, so they reach its members through that interface.
export function createSimlockClient(
  wire: SimlockWire,
  role: Role,
  principal: string,
  daemonVersion: string,
  link?: LinkConnection,
): SimlockClient & { asAdmin(): SimlockAdminClient } {
  return new SimlockClientImpl(wire, role, principal, daemonVersion, link);
}

class SimlockClientImpl {
  readonly #wire: SimlockWire;
  readonly #link: LinkConnection | undefined;
  readonly #leaseLostListeners = new Set<(push: LeaseLostPush) => void>();
  readonly #deviceUnhealthyListeners = new Set<(push: DeviceUnhealthyPush) => void>();
  readonly #deviceRecoveredListeners = new Set<(push: DeviceRecoveredPush) => void>();
  readonly #connectionLostListeners = new Set<(error: AnySimlockError) => void>();
  #eventSubscriptionId: string | undefined;

  constructor(
    wire: SimlockWire,
    readonly role: Role,
    readonly principal: string,
    readonly daemonVersion: string,
    link?: LinkConnection,
  ) {
    this.#wire = wire;
    this.#link = link;
    wire.onLeaseScopedPush((push) => this.#handleLeaseScopedPush(push));
    wire.onDeath((error) => this.#handleConnectionLost(error));
  }

  asAdmin(): SimlockAdminClient {
    // `this` already implements every method the interface below needs (see the class body) --
    // this cast documents that the split is purely at the type layer.
    return this as unknown as SimlockAdminClient;
  }

  // ---- agent-visible operations --------------------------------------------------------------

  getCatalog(input: CatalogGetInput = {}): Promise<CatalogGetOutput> {
    return this.#call("catalog.get", input);
  }

  getStatus(): Promise<StatusGetOutput> {
    return this.#call("status.get", {});
  }

  identity(): Promise<IdentityOutput> {
    return this.#call("identity.get", {});
  }

  listComponents(input: ComponentListInput = {}): Promise<ComponentListOutput> {
    return this.#call("component.list", input);
  }

  async requestLease(
    input: LeaseRequestInput,
    options: RequestLeaseOptions = {},
  ): Promise<LeaseGrant> {
    const parsed = this.#parseInput("lease.request", input);
    const requesterId = parsed.requesterId ?? this.principal;
    const { signal, onProgress } = options;

    if (signal?.aborted === true) throw cancelledError();

    const requestPromise = this.#callRaw("lease.request", parsed, { onProgress }).then((grant) =>
      this.#parseOutput("lease.request", grant),
    );

    if (signal === undefined) return requestPromise;
    return this.#requestLeaseWithAbort(requestPromise, signal, {
      platform: parsed.platform,
      requesterId,
    });
  }

  cancelLease(input: LeaseCancelInput = {}): Promise<LeaseCancelOutput> {
    return this.#call("lease.cancel", input);
  }

  releaseRunLeases(input: LeaseReleaseRunInput): Promise<LeaseReleaseRunOutput> {
    return this.#call("lease.release-run", this.#parseInput("lease.release-run", input));
  }

  renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    return this.#call("lease.renew", input);
  }

  async releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    const parsed = this.#parseInput("lease.release", input);
    // The daemon suppresses the matching `lease-lost` push to this connection itself (ADR
    // §8) -- see the comment on `SimlockWire`'s `#deliveredLeaseLost`. Nothing to mark here.
    return this.#call("lease.release", parsed);
  }

  listLeases(): Promise<LeaseListOutput> {
    return this.#call("lease.list", {});
  }

  runDoctor(input: DoctorRunInput = {}): Promise<DoctorReport> {
    return this.#call("doctor.run", input);
  }

  resolvePassthrough(input: DriverPassthroughInput): Promise<PassthroughCommand> {
    return this.#call("driver.passthrough", input);
  }

  async exec(input: ExecInput, options: ExecOptions = {}): Promise<ExecOutput> {
    const payload = await this.#callRaw("device.exec", this.#parseInput("device.exec", input), {
      onOutput: options.onOutput,
      onStarted: options.onStarted,
    });
    return this.#parseOutput("device.exec", payload);
  }

  rotate(
    leaseId: string,
    orientation: RotateInput["orientation"],
    options: { readonly requesterId?: string } = {},
  ): Promise<RotateOutput> {
    return this.#call("device.rotate", { leaseId, orientation, ...options });
  }

  onLeaseLost(listener: (push: LeaseLostPush) => void): () => void {
    this.#leaseLostListeners.add(listener);
    return () => this.#leaseLostListeners.delete(listener);
  }

  onDeviceUnhealthy(listener: (push: DeviceUnhealthyPush) => void): () => void {
    this.#deviceUnhealthyListeners.add(listener);
    return () => this.#deviceUnhealthyListeners.delete(listener);
  }

  onDeviceRecovered(listener: (push: DeviceRecoveredPush) => void): () => void {
    this.#deviceRecoveredListeners.add(listener);
    return () => this.#deviceRecoveredListeners.delete(listener);
  }

  onConnectionLost(listener: (error: AnySimlockError) => void): () => void {
    this.#connectionLostListeners.add(listener);
    return () => this.#connectionLostListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#wire.close();
  }

  async relayRequest(
    input: OperationInput<"relay.request">,
    hooks: Pick<CallHooks, "onRelayHead" | "onRelayInvalid">,
  ): Promise<OperationOutput<"relay.request">> {
    const payload = await this.#callRaw("relay.request", input, hooks);
    return this.#parseOutput("relay.request", payload);
  }

  openChannel(options: { readonly signal: AbortSignal }): Promise<LinkChannel> {
    const link = this.#link;
    if (link === undefined) return Promise.reject(new Error("The connection carries no link"));
    return link.openChannel(options);
  }

  relayCancel(input: OperationInput<"relay.cancel">): Promise<OperationOutput<"relay.cancel">> {
    return this.#call("relay.cancel", input);
  }

  // ---- admin-only operations ------------------------------------------------------------------

  releaseAllLeases(): Promise<LeaseReleaseAllOutput> {
    return this.#call("lease.release-all", {});
  }

  list(input: ListGetInput = {}): Promise<ListGetOutput> {
    return this.#call("list.get", input);
  }

  runCleanup(input: CleanupRunInput = {}): Promise<CleanupRunOutput> {
    return this.#call("cleanup.run", input);
  }

  runNuke(input: NukeRunInput = {}): Promise<NukeReport> {
    return this.#call("nuke.run", input);
  }

  forgetWarmKind(input: WarmForgetInput): Promise<WarmForgetOutput> {
    return this.#call("warm.forget", input);
  }

  getConfig(input: ConfigGetInput = {}): Promise<SimlockConfig> {
    return this.#call("config.get", input);
  }

  stopDaemon(): Promise<DaemonStopOutput> {
    return this.#call("daemon.stop", {});
  }

  updateDaemon(input: DaemonUpdateInput = {}): Promise<DaemonUpdateOutput> {
    return this.#call("daemon.update", input);
  }

  replayEvents(input: EventsReplayInput = {}): Promise<EventsReplayOutput> {
    return this.#call("events.replay", input);
  }

  usage(window: UsageGetInput): Promise<UsageGetOutput> {
    return this.#call("usage.get", window);
  }

  async subscribeEvents(listener: (event: EventPush) => void): Promise<() => Promise<void>> {
    const unsubscribePush = this.#wire.onEvent((payload) => listener(payload as EventPush));
    const result = await this.#call("events.subscribe", {});
    this.#eventSubscriptionId = result.subscriptionId;
    return async () => {
      unsubscribePush();
      if (this.#eventSubscriptionId === undefined) return;
      this.#eventSubscriptionId = undefined;
      await this.#call("events.unsubscribe", {});
    };
  }

  createToken(input: TokenCreateInput): Promise<TokenCreateOutput> {
    return this.#call("token.create", input);
  }

  listTokens(): Promise<TokenListOutput> {
    return this.#call("token.list", {});
  }

  revokeToken(input: TokenRevokeInput): Promise<TokenRevokeOutput> {
    return this.#call("token.revoke", input);
  }

  listWorkers(): Promise<WorkerListOutput> {
    return this.#call("worker.list", {});
  }

  drainWorker(input: WorkerDrainInput): Promise<WorkerDrainOutput> {
    return this.#call("worker.drain", input);
  }

  undrainWorker(input: WorkerDrainInput): Promise<WorkerUndrainOutput> {
    return this.#call("worker.undrain", input);
  }

  updateWorker(input: WorkerUpdateInput): Promise<WorkerUpdateOutput> {
    return this.#call("worker.update", input);
  }

  testAlertDestination(input: AlertsTestInput): Promise<AlertsTestOutput> {
    return this.#call("alerts.test", input);
  }

  async installComponent(
    input: ComponentInstallInput,
    options: InstallComponentOptions = {},
  ): Promise<ComponentInstallOutput> {
    const payload = await this.#callRaw(
      "component.install",
      this.#parseInput("component.install", input),
      { onComponentProgress: options.onProgress },
    );
    return this.#parseOutput("component.install", payload);
  }

  async makeSeed(input: SeedMakeInput, options: MakeSeedOptions = {}): Promise<SeedMakeOutput> {
    const payload = await this.#callRaw("seed.make", this.#parseInput("seed.make", input), {
      onSeedProgress: options.onProgress,
    });
    return this.#parseOutput("seed.make", payload);
  }

  async installComponentOnWorkers(
    input: WorkerInstallComponentInput,
    options: InstallComponentOnWorkersOptions = {},
  ): Promise<WorkerInstallComponentOutput> {
    const { onProgress } = options;
    const payload = await this.#callRaw(
      "worker.install-component",
      this.#parseInput("worker.install-component", input),
      {
        // A gateway always names the worker; an update that names none cannot be attributed
        // to one, so it is dropped rather than guessed.
        onComponentProgress:
          onProgress === undefined
            ? undefined
            : (progress, workerId) => {
                if (workerId !== undefined) onProgress({ ...progress, workerId });
              },
      },
    );
    return this.#parseOutput("worker.install-component", payload);
  }

  removeWorker(input: WorkerDrainInput): Promise<WorkerRemoveOutput> {
    return this.#call("worker.remove", input);
  }

  removeComponent(input: ComponentRemoveInput): Promise<ComponentRemoveOutput> {
    return this.#call("component.remove", input);
  }

  saveBaseline(input: BaselineSaveInput): Promise<BaselineSaveOutput> {
    return this.#call("baseline.save", input);
  }

  listBaselines(): Promise<BaselineListOutput> {
    return this.#call("baseline.list", {});
  }

  removeBaseline(input: BaselineRemoveInput): Promise<BaselineRemoveOutput> {
    return this.#call("baseline.remove", input);
  }

  addDevice(input: DeviceAddInput): Promise<DeviceAddOutput> {
    return this.#call("device.add", input);
  }

  removeDevice(input: DeviceRemoveInput): Promise<DeviceRemoveOutput> {
    return this.#call("device.remove", input);
  }

  #requestLeaseWithAbort(
    requestPromise: Promise<LeaseGrant>,
    signal: AbortSignal,
    cancel: LeaseCancelInput,
  ): Promise<LeaseGrant> {
    return new Promise((resolve, reject) => {
      let requestDone = false;
      let aborted = false;

      const onAbort = (): void => {
        if (requestDone) return; // after the grant resolved (or it already failed) -> ignored.
        aborted = true;
        void this.#cancelOnAbort(requestPromise, cancel).then(resolve, reject);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      requestPromise.then(
        (grant) => {
          requestDone = true;
          signal.removeEventListener("abort", onAbort);
          if (!aborted) resolve(grant);
        },
        (error: unknown) => {
          requestDone = true;
          signal.removeEventListener("abort", onAbort);
          if (!aborted) reject(error as Error);
        },
      );
    });
  }

  async #cancelOnAbort(
    requestPromise: Promise<LeaseGrant>,
    cancel: LeaseCancelInput,
  ): Promise<LeaseGrant> {
    let outcome: LeaseCancelOutput["result"];
    try {
      outcome = (await this.#call("lease.cancel", cancel)).result;
    } catch (error: unknown) {
      // Only a connection that actually died mid-cancel falls through to let awaiting
      // `requestPromise` below surface whatever that produces (most likely
      // `DAEMON_CONNECTION_LOST`, a more accurate rejection than a manufactured `CANCELLED`
      // would be here). Every other rejection -- `FORBIDDEN`, `BAD_REQUEST` -- is a real
      // answer from the daemon and must surface as-is: this `catch` used to swallow those
      // unconditionally, which is what let an aborted `requestLease` silently resolve with a
      // real grant instead of `CANCELLED` (see the PR report's B3).
      if (isSimlockError(error) && error.kind === "transport") {
        return requestPromise;
      }
      throw error;
    }

    if (outcome === "not-found") {
      // Either genuinely never existed, or -- per ADR §10's fourth case -- the grant already
      // resolved before the cancel reached the daemon: "after the grant resolved -> ignored".
      // Both cases defer entirely to the original outcome.
      return requestPromise;
    }

    if (outcome === "cancelled") {
      // Queued: the daemon rejects the original waiter; wait for that, then surface CANCELLED
      // regardless of the rejection's own code/message.
      await requestPromise.catch(() => undefined);
      throw cancelledError();
    }

    // "not-cancellable": device work already in flight. Wait for the outcome; a grant that
    // still arrives is abandoned immediately so the caller never holds a lease it walked away
    // from, then CANCELLED is surfaced either way.
    try {
      const grant = await requestPromise;
      await this.#releaseAbandonedGrant(grant);
    } catch {
      // The request failed on its own (e.g. ran out of capacity mid-flight) -- nothing to
      // release, and CANCELLED is still the right thing to tell a caller who asked to abort.
    }
    throw cancelledError();
  }

  async #releaseAbandonedGrant(grant: LeaseGrant): Promise<void> {
    try {
      await this.releaseLease({ leaseId: grant.lease.id });
    } catch {
      // Best-effort: the caller already gets CANCELLED either way. A failed release here means
      // the daemon may still show the lease held -- see the PR report's weak-spots list.
    }
  }

  // ---- pushes -----------------------------------------------------------------------------

  #handleLeaseScopedPush(push: LeaseScopedPush): void {
    switch (push.kind) {
      case "lease-lost":
        for (const listener of this.#leaseLostListeners) {
          listener({ deviceId: push.deviceId, leaseId: push.leaseId, reason: push.reason });
        }
        return;
      case "device-unhealthy":
        for (const listener of this.#deviceUnhealthyListeners) {
          listener({ deviceId: push.deviceId, leaseId: push.leaseId });
        }
        return;
      case "device-recovered":
        for (const listener of this.#deviceRecoveredListeners) {
          listener({ attempts: push.attempts, deviceId: push.deviceId, leaseId: push.leaseId });
        }
        return;
    }
  }

  /**
   * ADR 0004 §3: a dead connection ends no lease, so nothing is synthesized here. The daemon
   * releases nothing on close, so every lease this client was holding is still granted, still
   * counting down its own TTL, and still renewable by whatever connects next -- which is the
   * frontend's decision to make, not this client's (ADR 0003 §10).
   */
  #handleConnectionLost(error: AnySimlockError): void {
    for (const listener of this.#connectionLostListeners) listener(error);
  }

  // ---- call plumbing --------------------------------------------------------------------------

  #parseInput<Name extends OperationName>(
    name: Name,
    input: unknown,
  ): z.infer<(typeof OPERATIONS)[Name]["input"]> {
    const result = OPERATIONS[name].input.safeParse(input);
    if (result.success) return result.data as z.infer<(typeof OPERATIONS)[Name]["input"]>;
    throw new SimlockError(
      "BAD_REQUEST",
      "protocol",
      describeSchemaIssues(result.error.issues),
      {},
    );
  }

  #parseOutput<Name extends OperationName>(
    name: Name,
    payload: unknown,
  ): z.infer<(typeof OPERATIONS)[Name]["output"]> {
    const result = OPERATIONS[name].output.safeParse(payload);
    if (result.success) return result.data as z.infer<(typeof OPERATIONS)[Name]["output"]>;
    throw new SimlockError(
      "BAD_FRAME",
      "protocol",
      `Daemon's ${name} response did not match the contract output schema`,
      {},
    );
  }

  async #call<Name extends OperationName>(
    name: Name,
    input: z.infer<(typeof OPERATIONS)[Name]["input"]>,
  ): Promise<z.infer<(typeof OPERATIONS)[Name]["output"]>> {
    const payload = await this.#callRaw(name, input);
    return this.#parseOutput(name, payload);
  }

  #callRaw(name: OperationName, input: unknown, hooks: CallHooks = {}): Promise<unknown> {
    const parsed = this.#parseInput(name, input);
    return this.#wire.call(name, parsed, hooks).catch((error: unknown) => {
      throw toSimlockError(error);
    });
  }
}
