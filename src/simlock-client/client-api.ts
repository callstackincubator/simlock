import type { z } from "zod";

import type { AnySimlockError, OperationName, OPERATIONS, Role } from "../contract/index.js";
import type { LinkChannel } from "../link/index.js";
import type { CallHooks } from "./wire.js";
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

/** The full agent-visible method surface (ADR §3's operation matrix, `agent` rows) plus the
 * pushes and lifecycle every frontend needs. `simlock/admin`'s `SimlockAdminClient` extends
 * this with the `admin` rows. */
export interface SimlockClient {
  readonly principal: string;
  readonly role: Role;
  readonly daemonVersion: string;

  getCatalog(input?: CatalogGetInput): Promise<CatalogGetOutput>;
  getStatus(): Promise<StatusGetOutput>;
  identity(): Promise<IdentityOutput>;
  /**
   * ADR 0010 §8: every installed iOS simulator runtime and Android system image on the daemon's
   * machine, with its size, whether Simlock installed it, and how many devices use it.
   */
  listComponents(input?: ComponentListInput): Promise<ComponentListOutput>;
  requestLease(input: LeaseRequestInput, options?: RequestLeaseOptions): Promise<LeaseGrant>;
  cancelLease(input?: LeaseCancelInput): Promise<LeaseCancelOutput>;
  renewLease(input: LeaseRenewInput): Promise<LeaseRecord>;
  releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput>;
  releaseRunLeases(input: LeaseReleaseRunInput): Promise<LeaseReleaseRunOutput>;
  listLeases(): Promise<LeaseListOutput>;
  runDoctor(input?: DoctorRunInput): Promise<DoctorReport>;
  /** Resolves the scoped command behind `simlock simctl` / `simlock adb` (ADR 0001, decision
   * 7). Resolution only -- the caller is the process with a terminal, so it runs it. */
  resolvePassthrough(input: DriverPassthroughInput): Promise<PassthroughCommand>;
  /**
   * why: runs `simctl`, `adb` or `devicectl` **on the daemon's machine** against a device this
   * client's principal leases, streaming the output to `options.onOutput` as it arrives and resolving with the
   * command's exit code (ADR 0005 §19a). The counterpart to `resolvePassthrough`: that one
   * hands back a command line for a caller sharing the machine, this one is for a caller that
   * does not. `stdin` is written once and closed -- there is no pseudo-terminal, so
   * line-oriented commands work and full-screen ones do not (§19c).
   */
  exec(input: ExecInput, options?: ExecOptions): Promise<ExecOutput>;
  /**
   * why: turns the lease's iOS phone or tablet simulator (not a foldable) to `orientation`, whether or not the daemon's input module is on. `requesterId` is for an operator that acts for the lease's requester, as `exec`'s is.
   */
  rotate(
    leaseId: string,
    orientation: RotateInput["orientation"],
    options?: { readonly requesterId?: string },
  ): Promise<RotateOutput>;

  /**
   * Reports a lease the *daemon* ended -- an expiry, an operator release, an unrecoverable
   * device. ADR 0004 §3 narrows ADR 0003 §10 here: a dead connection is not a dead lease, so
   * this no longer fires with a synthesized `daemon-connection-lost` when the socket dies. The
   * leases this client held are still granted and still counting down; `onConnectionLost` is
   * what reports the connection, and reconnecting and renewing is the frontend's call.
   */
  onLeaseLost(listener: (push: LeaseLostPush) => void): () => void;
  onDeviceUnhealthy(listener: (push: DeviceUnhealthyPush) => void): () => void;
  onDeviceRecovered(listener: (push: DeviceRecoveredPush) => void): () => void;
  /** Fires exactly once, when the connection dies for any reason (including a deliberate
   * `close()`). Every in-flight call has already rejected `DAEMON_CONNECTION_LOST` by the time
   * this listener runs. Any lease this client was holding is still alive on the daemon. */
  onConnectionLost(listener: (error: AnySimlockError) => void): () => void;

  close(): Promise<void>;
}

/** `simlock/admin`'s extension: the `admin` rows of ADR §3's matrix. */
export interface SimlockAdminClient extends SimlockClient {
  releaseAllLeases(): Promise<LeaseReleaseAllOutput>;
  list(input?: ListGetInput): Promise<ListGetOutput>;
  runCleanup(input?: CleanupRunInput): Promise<CleanupRunOutput>;
  runNuke(input?: NukeRunInput): Promise<NukeReport>;
  forgetWarmKind(input: WarmForgetInput): Promise<WarmForgetOutput>;
  getConfig(input?: ConfigGetInput): Promise<SimlockConfig>;
  /** ADR §6's frozen exception: accepted by the daemon at any protocol version it has ever
   * spoken, even before `hello`/role resolve. Exposed here rather than on the base client
   * purely as an API-surface choice matching the ADR's operation matrix (the daemon itself
   * does not gate this operation by role at all -- see the caveat in the PR report). */
  stopDaemon(): Promise<DaemonStopOutput>;
  updateDaemon(input?: DaemonUpdateInput): Promise<DaemonUpdateOutput>;
  replayEvents(input?: EventsReplayInput): Promise<EventsReplayOutput>;
  usage(window: UsageGetInput): Promise<UsageGetOutput>;
  subscribeEvents(listener: (event: EventPush) => void): Promise<() => Promise<void>>;
  createToken(input: TokenCreateInput): Promise<TokenCreateOutput>;
  listTokens(): Promise<TokenListOutput>;
  revokeToken(input: TokenRevokeInput): Promise<TokenRevokeOutput>;

  /** why: ADR 0005 §23. A worker lists itself as its only worker; `drainWorker`, `undrainWorker`, `removeWorker` and
   * `updateWorker` (a gateway updating one of its workers, ADR 0042 §2) reject on a worker with `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012). */
  listWorkers(): Promise<WorkerListOutput>;
  drainWorker(input: WorkerDrainInput): Promise<WorkerDrainOutput>;
  undrainWorker(input: WorkerDrainInput): Promise<WorkerUndrainOutput>;
  removeWorker(input: WorkerDrainInput): Promise<WorkerRemoveOutput>;
  updateWorker(input: WorkerUpdateInput): Promise<WorkerUpdateOutput>;

  /**
   * why: ADR 0035 §1: asks a gateway to post one sample message to the named alert destination, once.
   * Rejects with `ALERT_SEND_FAILED` when the receiver does not take it, `UNKNOWN_ALERT_DESTINATION`
   * for a name the gateway has not configured, and on a worker with `UNSUPPORTED_IN_WORKER_MODE`.
   */
  testAlertDestination(input: AlertsTestInput): Promise<AlertsTestOutput>;

  /**
   * ADR 0010 §6: installs one iOS simulator runtime or Android system image, with no lease.
   * Resolves once it is installed or found already there; `options.onProgress` hears `waiting`
   * while another install on the platform runs ahead, then `downloading`. Refused with
   * `DOWNLOADS_DISABLED` under `downloads.policy: "never"`.
   */
  installComponent(
    input: ComponentInstallInput,
    options?: InstallComponentOptions,
  ): Promise<ComponentInstallOutput>;

  /**
   * why: ADR 0090 §4: makes a kind's seed and settles it, on a worker. Resolves with the settled seed, or
   * `already-settled`; `options.onProgress` hears each stage with the seed's kind. Refused with
   * `SEED_SETTLE_FAILED` when the make or the settle fails or 60 minutes pass; a gateway refuses it.
   */
  makeSeed(input: SeedMakeInput, options?: MakeSeedOptions): Promise<SeedMakeOutput>;

  /**
   * ADR 0010 §7, gateway-only: installs one component on named workers (`workers: [ids]`) or on
   * every connected one (`workers: "all"`). Every targeted worker is asked at the same time and
   * answers for itself; the result lists one entry per worker. `options.onProgress` hears each
   * worker's progress with its `workerId`. A worker answers `UNSUPPORTED_IN_WORKER_MODE`.
   */
  installComponentOnWorkers(
    input: WorkerInstallComponentInput,
    options?: InstallComponentOnWorkersOptions,
  ): Promise<WorkerInstallComponentOutput>;

  /**
   * ADR 0010 §8: removes one component Simlock installed, or with `dryRun: true` runs every
   * check and removes nothing. Refused with `COMPONENT_NOT_OWNED`, `COMPONENT_IN_USE` (with the
   * counts as details) or `COMPONENT_BUSY`.
   */
  removeComponent(input: ComponentRemoveInput): Promise<ComponentRemoveOutput>;

  /** why: ADR 0061 §4: ends the held lease and keeps its device as a named baseline; admin only. */
  saveBaseline(input: BaselineSaveInput): Promise<BaselineSaveOutput>;

  /** why: the newest version of each baseline on the worker, with its stale reason. */
  listBaselines(): Promise<BaselineListOutput>;

  /** why: deletes every version of a baseline and the idle devices made from it; refused while a lease uses it. */
  removeBaseline(input: BaselineRemoveInput): Promise<BaselineRemoveOutput>;

  /**
   * Enrols the physical device plugged into the host this daemon runs on, named by
   * any ID the platform's driver reads. A device it cannot enrol is `DEVICE_NOT_ENROLLABLE` with
   * a reason; a leased, reclaiming or busy one is `DEVICE_BUSY`. A device already
   * enrolled is enrolled again: its record is kept and its model, OS version, class and apps are
   * read anew (`reenrolled: true`). A gateway answers `UNSUPPORTED_IN_GATEWAY_MODE`.
   */
  addDevice(input: DeviceAddInput): Promise<DeviceAddOutput>;

  /**
   * Forgets an enrolled physical device, named by its canonical ID. Nothing is sent
   * to the device. `UNKNOWN_DEVICE` for an ID with no enrolled device, `DEVICE_BUSY` for a leased,
   * reclaiming or busy one (another operation holds it). A gateway answers `UNSUPPORTED_IN_GATEWAY_MODE`.
   */
  removeDevice(input: DeviceRemoveInput): Promise<DeviceRemoveOutput>;
}

export type OperationInput<Name extends OperationName> = z.infer<
  (typeof OPERATIONS)[Name]["input"]
>;
export type OperationOutput<Name extends OperationName> = z.infer<
  (typeof OPERATIONS)[Name]["output"]
>;

// why: not part of `SimlockAdminClient`, so `simlock/admin` does not export it (ADR 0026).

export interface RelayClientMethods {
  relayRequest(
    input: OperationInput<"relay.request">,
    hooks: Pick<CallHooks, "onRelayHead" | "onRelayInvalid">,
  ): Promise<OperationOutput<"relay.request">>;
  // why: rejects on a connection that holds no link, since a channel is a link's (ADR 0028).
  openChannel(options: { readonly signal: AbortSignal }): Promise<LinkChannel>;
  relayCancel(input: OperationInput<"relay.cancel">): Promise<OperationOutput<"relay.cancel">>;
}
