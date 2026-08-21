import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, SystemStats } from "../ports/index.js";
import type { RunningCapacity } from "./capacity.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import { CapacityCoordinator } from "./capacity-coordinator.js";
import { CleanupExecutor, type CleanupActionExecutor } from "./cleanup-executor.js";
import type { Config } from "./config.js";
import type { Proposal } from "./cleanup/types.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import type { LeaseRecord, Platform } from "./domain.js";
import type { DeviceRequest, Driver } from "./driver.js";
import { DriverCatalog, type PlatformCatalog } from "./driver-catalog.js";
import {
  LeaseAcquisitionCoordinator,
  type LeaseGrant,
  type LeaseRequestOptions,
} from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { NukeService } from "./nuke-service.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import { WaitQueue } from "./wait-queue.js";
import { WarmPoolCoordinator } from "./warm-pool-coordinator.js";

export type { LeaseProgress } from "./wait-queue.js";

export interface LeaseEngineOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  readonly registry: Registry;
  readonly systemStats: SystemStats;
}

export {
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
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
  readonly #decisions = new SerializedDecision();
  readonly #startup: StartupConverger;
  readonly #warmPool: WarmPoolCoordinator;

  constructor(private readonly options: LeaseEngineOptions) {
    this.#capacity = new CapacityCoordinator(options.config, options.systemStats);
    this.claimReader = this.#claims;
    this.#planner = new AcquisitionPlanner(this.#capacity, this.#claims);
    this.#drivers = new DriverCatalog(options.drivers);
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
      decisions: this.#decisions,
      lifecycle: this.#deviceLifecycle,
      registry: options.registry,
    });
    this.#expiry = new LeaseExpiryScheduler(options.clock, async (leaseId, expectedDeadline) => {
      await this.#releaseCoordinator.expire(leaseId, expectedDeadline);
    });
    this.#leases = new LeaseLifecycle({
      clock: options.clock,
      eventBus: options.eventBus,
      expiryScheduler: this.#expiry,
      registry: options.registry,
      ttl: {
        detachedMs: options.config.lease.detachedTtlMs,
        heldBackstopMs: options.config.lease.heldTtlBackstopMs,
      },
    });
    this.#queue = new WaitQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      onTimeout: (waiter) => {
        this.options.eventBus.emit(
          "lease.rejected",
          { requestSpec: waiter.request, reason: "timeout" },
          "wait-queue",
        );
        this.#acquisition.kick();
      },
    });
    this.#acquisition = new LeaseAcquisitionCoordinator({
      claims: this.#claims,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      leases: this.#leases,
      lifecycle: this.#deviceLifecycle,
      planner: this.#planner,
      provisioner: this.#provisioner,
      queue: this.#queue,
      registry: options.registry,
    });
    this.#quarantine = new QuarantineCoordinator({
      clock: options.clock,
      config: options.config.warmPool.quarantine,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#acquisition.kick(),
      registry: options.registry,
    });
    this.#warmPool = new WarmPoolCoordinator({
      capacity: this.#capacity,
      clock: options.clock,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#acquisition.kick(),
      quarantine: this.#quarantine,
      queueHeadDemand: () => {
        const spec = this.#acquisition.queueHeadSpec;
        return spec === undefined ? undefined : { spec };
      },
      registry: options.registry,
    });
    this.#releaseCoordinator = new LeaseReleaseCoordinator({
      claims: this.#claims,
      decisions: this.#decisions,
      lifecycle: this.#leases,
      registry: options.registry,
      warmPool: this.#warmPool,
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
      capacity: this,
      claims: this.#claims,
      cleanup: this.cleanup,
      decisions: this.#decisions,
      interruptedReclaimRecovery: {
        recoverInterruptedReclaim: async (device) => {
          await this.#warmPool.recoverInterrupted(device.id);
        },
      },
      quarantineRestore: { restore: () => this.#quarantine.restore() },
      registry: options.registry,
      releases: {
        releaseOrphaned: async (leaseId) => {
          await this.#releaseCoordinator.release(leaseId, "orphaned");
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

  async release(leaseId: string, reason: "closed" | "explicit" | "killed"): Promise<void> {
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

  /** Cancels the quarantine coordinator's armed retry timers on daemon shutdown. */
  dispose(): void {
    this.#quarantine.dispose();
  }

  /** Read-only device catalog; a platform without a registered driver is omitted. */
  // fallow-ignore-next-line unused-class-member -- called through CatalogReader by DaemonServer.
  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    return this.#drivers.listCatalog(platform);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the QueueControl port by DaemonServer.
  get queueDepth(): number {
    return this.#acquisition.queueDepth;
  }

  // fallow-ignore-next-line unused-class-member -- reached through the CapacityReader port by DaemonServer.
  get runningCapacity(): RunningCapacity {
    return this.#capacity.runningCapacity(this.#capacityDevices());
  }

  /** Safely converges unleased running devices after startup reconciliation. */
  async convergeRunningCapacity(): Promise<void> {
    await this.#startup.converge();
  }

  /** Stops client feedback for a queued request without affecting its lease outcome. */
  // fallow-ignore-next-line unused-class-member -- reached through the QueueControl port by DaemonServer (same as the sibling queueDepth).
  async detachQueuedProgress(requesterId: string): Promise<void> {
    await this.#acquisition.detachQueuedProgress(requesterId);
  }

  // fallow-ignore-next-line unused-class-member -- reached through the LeaseCommands port by DaemonServer (same as the sibling heartbeat).
  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    return this.#releaseCoordinator.renew(leaseId, ttlMs);
  }

  /** Slides a held lease's TTL back out to a full backstop from now. */
  // fallow-ignore-next-line unused-class-member -- reached through the LeaseCommands port, which structural typing hides from the analyzer (same as the sibling renew).
  async heartbeat(leaseId: string): Promise<LeaseRecord> {
    return this.#releaseCoordinator.heartbeat(leaseId);
  }

  /**
   * Runs one cleanup action through the same decision queue as leasing. The
   * reservation prevents a concurrent lease decision from selecting the
   * device while its driver operation is in progress.
   */
  async executeCleanup(proposal: Proposal): Promise<boolean> {
    return this.cleanup.execute(proposal);
  }

  #capacityDevices(): { readonly platform: Platform; readonly state: string }[] {
    return this.options.registry.snapshot.devices.map((device) => ({
      platform: device.spec.platform,
      state: device.state,
    }));
  }
}
