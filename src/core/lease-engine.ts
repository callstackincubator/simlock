import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, Logger, SystemStats } from "../ports/index.js";
import type { CapacityDevice, RamBudget, RunningCapacity } from "./capacity/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import {
  buildCapacityFigures,
  CapacityCoordinator,
  capacityDevices,
  CapacityObserver,
  createCapacityStrategy,
} from "./capacity/index.js";
import { CleanupExecutor, type CleanupActionExecutor } from "./cleanup-executor.js";
import type { ComponentInstaller } from "./component-installer.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import type {
  DeviceMode,
  DeviceSpec,
  LeaseGrant as StoredLeaseGrant,
  LeaseRecord,
  LeaseRequestFailure,
  Platform,
} from "./domain.js";
import type { DeviceRequest, Driver, PassthroughCommand, PassthroughContext } from "./driver.js";
import { DriverCatalog, type ModelPreferences, type PlatformCatalog } from "./driver-catalog.js";
import {
  LeaseAcquisitionCoordinator,
  type LeaseGrant,
  type LeaseRequestOptions,
} from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { LeaseRequestBook, type WaitingRequest } from "./lease-request-book.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { NukeService } from "./nuke-service.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { WaitQueue } from "./wait-queue.js";
import { ReclaimCoordinator } from "./reclaim-coordinator.js";

export type { LeaseProgress } from "./wait-queue.js";

export interface LeaseEngineOptions {
  readonly clock: Clock;
  /**
   * The daemon's one `ComponentInstaller`, built and closed by the composition root. Only the
   * lease path installs through it: warm-pool provisioning and startup convergence never do
   * (safety rule 4). Every device provisioned is claimed through it, so none is created on a
   * component being removed (ADR 0010 §8).
   */
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: Config;
  /**
   * The one decision gate every registry write runs inside. Passed in rather than built here
   * because `components` writes the registry too and must share it.
   */
  readonly decisions: SerializedDecision;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  /**
   * Where work the engine finishes off its callers' paths reports its failures.
   * A backgrounded reclaim has no caller left to reject to, so without this its
   * only trace is the device's own registry state.
   */
  readonly logger?: Logger;
  readonly registry: Registry;
  readonly systemStats: SystemStats;
  /**
   * Turns the error a lease request failed with into the code and message stored for it. The
   * daemon passes its contract error classifier; the core never reads the code. Omitted, every
   * failure is stored as `INTERNAL` with its own message.
   */
  readonly describeFailure?: (error: unknown) => LeaseRequestFailure;
  /**
   * The worker's default device mode per platform, built from config by the composition root
   * (ADR 0007 §2). Omitted, or silent on a platform, means `"full"`.
   */
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>>;
  /**
   * ADR 0015 §4: the model names to try for each class, per platform, operator's list first.
   * Absent means none, so the catalog names no class default.
   */
  readonly modelPreferences?: ModelPreferences;
}

export {
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
} from "./lease-acquisition-coordinator.js";

/** Composition root and compatibility facade for the daemon's lease subsystem. */
export class LeaseEngine {
  readonly cleanup: CleanupActionExecutor;
  /**
   * Built here but deliberately not started: the daemon arms it only once startup
   * convergence has finished, so no health probe shells out while convergence is
   * still doing so itself. See `DaemonServer#start`.
   */
  readonly healthMonitor: LeaseHealthMonitor;
  /**
   * Read-only claim view for `Doctor`, which must not read a device this engine is
   * actively operating on as a stalled transition. Exposed as a reader, not the
   * `DeviceOperationClaims` itself, so nothing outside the engine can take or
   * release a claim.
   */
  readonly claimReader: Pick<DeviceOperationClaims, "isClaimed">;
  readonly #acquisition: LeaseAcquisitionCoordinator;
  readonly #capacity: CapacityCoordinator;
  readonly #capacityObserver: CapacityObserver;
  readonly #claims = new DeviceOperationClaims();
  readonly #drivers: DriverCatalog;
  readonly #deviceLifecycle: ManagedDeviceLifecycle;
  readonly #expiry: LeaseExpiryScheduler;
  readonly #leases: LeaseLifecycle;
  readonly #nuke: NukeService;
  readonly #planner: AcquisitionPlanner;
  readonly #provisioner: DeviceProvisioner;
  readonly #quarantine: QuarantineCoordinator;
  readonly #queue: WaitQueue;
  readonly #releaseCoordinator: LeaseReleaseCoordinator;
  /** Every lease request, stored in the registry; read by the HTTP request resource too. */
  readonly requests: LeaseRequestBook<StoredLeaseGrant>;
  readonly #decisions: SerializedDecision;
  readonly #startup: StartupConverger;
  readonly #reclaim: ReclaimCoordinator;

  constructor(private readonly options: LeaseEngineOptions) {
    this.#decisions = options.decisions;
    this.#capacity = new CapacityCoordinator(
      createCapacityStrategy(options.config.capacity, options.systemStats),
      () => this.#capacityObserver.changed(),
    );
    this.#capacityObserver = new CapacityObserver({
      eventBus: options.eventBus,
      figures: () => buildCapacityFigures(options.registry.snapshot.devices, this),
    });
    options.registry.onCommit(() => this.#capacityObserver.changed());
    this.claimReader = this.#claims;
    this.#planner = new AcquisitionPlanner(this.#capacity, this.#claims);
    this.#drivers = new DriverCatalog(options.drivers, {
      logger: options.logger,
      preferences: options.modelPreferences,
    });
    this.#deviceLifecycle = new ManagedDeviceLifecycle(
      this.#drivers,
      options.registry,
      this.#decisions,
      this.#claims,
      options.clock,
    );
    this.#provisioner = new DeviceProvisioner({
      catalog: this.#drivers,
      clock: options.clock,
      components: options.components,
      decisions: this.#decisions,
      lifecycle: this.#deviceLifecycle,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      registry: options.registry,
    });
    this.#expiry = new LeaseExpiryScheduler(
      options.clock,
      async (leaseId, expectedDeadline) => {
        await this.#releaseCoordinator.expire(leaseId, expectedDeadline);
      },
      options.logger,
    );
    this.#leases = new LeaseLifecycle({
      clock: options.clock,
      eventBus: options.eventBus,
      expiryScheduler: this.#expiry,
      registry: options.registry,
      ttl: { defaultMs: options.config.lease.defaultTtlMs },
    });
    this.#queue = new WaitQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      onDepthChange: (depth) =>
        this.options.eventBus.emit("queue.changed", { depth }, "wait-queue"),
      onTimeout: (waiter) => {
        this.options.eventBus.emit(
          "lease.rejected",
          {
            requestId: waiter.id,
            requester: waiter.options.requesterId,
            requestSpec: waiter.request,
            reason: "timeout",
          },
          "wait-queue",
        );
        this.#acquisition.kick();
      },
    });
    this.requests = new LeaseRequestBook({
      decisions: this.#decisions,
      describeFailure: options.describeFailure ?? describeUnclassifiedFailure,
      store: options.registry,
    });
    this.#acquisition = new LeaseAcquisitionCoordinator({
      catalog: this.#drivers,
      claims: this.#claims,
      components: options.components,
      decisions: this.#decisions,
      defaultModes: options.defaultModes ?? {},
      drivers: this.#drivers,
      eventBus: options.eventBus,
      idGenerator: options.idGenerator,
      leases: this.#leases,
      lifecycle: this.#deviceLifecycle,
      modelPreferences: options.modelPreferences ?? {},
      planner: this.#planner,
      provisioner: this.#provisioner,
      queue: this.#queue,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      registry: options.registry,
      requests: this.requests,
    });
    this.#quarantine = new QuarantineCoordinator({
      clock: options.clock,
      config: options.config.warmPool.quarantine,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#acquisition.kick(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      registry: options.registry,
    });
    this.#reclaim = new ReclaimCoordinator({
      clock: options.clock,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#acquisition.kick(),
      quarantine: this.#quarantine,
      registry: options.registry,
    });
    this.#releaseCoordinator = new LeaseReleaseCoordinator({
      claims: this.#claims,
      decisions: this.#decisions,
      lifecycle: this.#leases,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      notifyAvailability: () => this.#acquisition.kick(),
      registry: options.registry,
      reclaim: this.#reclaim,
    });
    this.cleanup = new CleanupExecutor({
      eventBus: options.eventBus,
      lifecycle: this.#deviceLifecycle,
      notifyAvailability: () => this.#acquisition.kick(),
      registry: options.registry,
    });
    this.#nuke = new NukeService({
      acquisition: this.#acquisition,
      devices: this.#deviceLifecycle,
      leases: this.#releaseCoordinator,
      registry: options.registry,
    });
    this.#startup = new StartupConverger({
      claims: this.#claims,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      interruptedReclaimRecovery: {
        recoverInterruptedReclaim: async (device) => {
          await this.#reclaim.recoverInterrupted(device.id);
        },
      },
      quarantineRestore: { restore: () => this.#quarantine.restore() },
      registry: options.registry,
      spentDeviceDeletion: {
        // A failed delete must not stop the daemon from starting: the device stays `shutdown`
        // and ungrantable, and the next start (or the idle delete rule) tries again.
        deleteSpent: async (device) => {
          try {
            await this.#reclaim.deleteSpent(device.id);
          } catch (error: unknown) {
            options.logger?.error("startup delete of a spent device failed", {
              deviceId: device.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
      timers: this.#leases,
    });
    this.healthMonitor = new LeaseHealthMonitor({
      clock: options.clock,
      config: options.config,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      lifecycle: this.#deviceLifecycle,
      registry: options.registry,
      releaser: {
        releaseDeviceLost: async (leaseId) => {
          await this.#releaseCoordinator.releaseDeviceLost(leaseId);
        },
      },
    });
  }

  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    return this.#acquisition.request(request, options);
  }

  async release(leaseId: string, reason: "explicit" | "killed"): Promise<void> {
    await this.#releaseCoordinator.release(leaseId, reason);
  }

  /** Releases the daemon's current leases for an explicit operator command. */
  // fallow-ignore-next-line unused-class-member -- reached through the LeaseCommands port by DaemonServer (same as the sibling release).
  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    return this.#releaseCoordinator.releaseAll(reason);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the LeaseExpirer port by Doctor.
  async expire(leaseId: string): Promise<void> {
    await this.#releaseCoordinator.expire(leaseId);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the DoctorQuarantine port by Doctor.
  async enterFromStalledTransition(deviceId: string): Promise<void> {
    await this.#quarantine.enterFromStalledTransition(deviceId);
  }

  /** Operator-only reset; targets device records from this registry exclusively. */
  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    return this.#nuke.nuke(deleteDevices);
  }

  /**
   * Awaits the reclaims release left running in the background, so a graceful
   * shutdown hands back the same settled pool an inline reclaim used to. Runs
   * before `dispose`: a reclaim that settles into a purge failure arms a
   * quarantine retry timer, and cancelling those first would strand it armed.
   */
  async settle(): Promise<void> {
    await this.#releaseCoordinator.settleBackgroundReclaims();
  }

  /**
   * Cancels every timer this engine armed, so the process can actually exit. A lease's TTL is
   * a `setTimeout` that outlives the decision to shut down, so without this a daemon with an
   * outstanding lease keeps running long after `daemon stop` -- up to that lease's whole TTL.
   *
   * Cancelling expires nothing early and loses nothing, and under ADR 0004 releases nothing
   * either: `ttlDeadline` is persisted with the lease, and `LeaseExpiryScheduler.restore`
   * re-arms it on the next start. That is exactly what makes a lease survive a daemon restart
   * intact, and a lease whose deadline passed while no daemon was running expire as soon as
   * one is there to expire it.
   */
  dispose(): void {
    this.#quarantine.dispose();
    this.#expiry.dispose();
  }

  /** Read-only device catalog; a platform without a registered driver is omitted. */
  // fallow-ignore-next-line unused-class-member -- called through CatalogReader by DaemonServer.
  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    return this.#drivers.listCatalog(platform);
  }

  /** Scoped command for a `simlock <tool>` wrapper, built by whichever driver claims it. */
  // fallow-ignore-next-line unused-class-member -- called through PassthroughResolver by DaemonServer.
  passthrough(
    tool: string,
    args: readonly string[],
    context?: PassthroughContext,
  ): PassthroughCommand {
    return this.#drivers.passthrough(tool, args, context);
  }

  get queueDepth(): number {
    return this.#acquisition.queueDepth;
  }

  // fallow-ignore-next-line unused-class-member -- reached through the CapacityReader port by DaemonServer.
  get runningCapacity(): RunningCapacity {
    return this.#capacity.runningCapacity(this.#capacityDevices());
  }

  /** The managed-device ceiling the live strategy enforces, for status reporting. */
  // fallow-ignore-next-line unused-class-member -- reached through the CapacityReader port by DaemonServer.
  deviceLimit(platform: Platform): number {
    return this.#capacity.deviceLimit(platform);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the CapacityReader port by DaemonServer.
  atRamBudget(platform: Platform): boolean {
    return this.#capacity.atRamBudget(platform, this.#capacityDevices());
  }

  // fallow-ignore-next-line unused-class-member -- reached through the DeviceModeReader port by the dispatcher.
  servesDefaultMode(spec: DeviceSpec): boolean {
    return this.#acquisition.servesDefaultMode(spec);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the CapacityReader port by DaemonServer.
  get ramBudget(): RamBudget | undefined {
    return this.#capacity.ramBudget(this.#capacityDevices());
  }

  /** Safely converges unleased running devices after startup reconciliation. */
  async convergeRunningCapacity(): Promise<void> {
    await this.#startup.converge();
    // Every run begins with a step in both: what the figures and the queue depth are now.
    this.#capacityObserver.start();
    this.options.eventBus.emit("queue.changed", { depth: this.#queue.depth }, "wait-queue");
  }

  /** Every request waiting for a device on this host, for `list.get` and `status.get`. */
  // fallow-ignore-next-line unused-class-member -- reached through the QueueControl port by the dispatcher (same as the sibling queueDepth).
  waitingRequests(): readonly WaitingRequest[] {
    return this.requests.waiting(this.#queue.places());
  }

  /** Cancels a single pending request by requester id, for the HTTP lease-request delete route. */
  // fallow-ignore-next-line unused-class-member -- reached through the QueueControl port by DaemonServer (same as the sibling queueDepth).
  async cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.#acquisition.cancelPending(requesterId);
  }

  /** The session principal that owns a pending request, for `lease.cancel`'s owner-aware
   * `authorize` hook (ADR §4). See the coordinator method's own comment. */
  // fallow-ignore-next-line unused-class-member -- reached through the QueueControl port by the dispatcher's authorize context (same as the sibling cancelPending).
  pendingRequestOwner(requesterId: string): string | undefined {
    return this.#acquisition.pendingRequestOwner(requesterId);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the LeaseCommands port by DaemonServer, which structural typing hides from the analyzer.
  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    return this.#releaseCoordinator.renew(leaseId, ttlMs);
  }

  #capacityDevices(): readonly CapacityDevice[] {
    return capacityDevices(this.options.registry.snapshot.devices);
  }
}

function describeUnclassifiedFailure(error: unknown): LeaseRequestFailure {
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
