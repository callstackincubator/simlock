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
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { NukeService } from "./nuke-service.js";
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

export { HeldLeaseRenewalError } from "./lease-lifecycle.js";

/** Composition root and compatibility facade for the daemon's lease subsystem. */
export class LeaseEngine {
  readonly cleanup: CleanupActionExecutor;
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
  readonly #queue: WaitQueue;
  readonly #releaseCoordinator: LeaseReleaseCoordinator;
  readonly #decisions = new SerializedDecision();
  readonly #startup: StartupConverger;
  readonly #warmPool: WarmPoolCoordinator;

  constructor(private readonly options: LeaseEngineOptions) {
    this.#capacity = new CapacityCoordinator(options.config, options.systemStats);
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
    this.#warmPool = new WarmPoolCoordinator({
      capacity: this.#capacity,
      clock: options.clock,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#acquisition.kick(),
      queueHeadDemand: () => {
        const spec = this.#acquisition.queueHeadSpec;
        return spec === undefined ? undefined : { spec };
      },
      registry: options.registry,
    });
    this.#releaseCoordinator = new LeaseReleaseCoordinator({
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
      registry: options.registry,
      timers: this.#leases,
    });
  }

  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    return this.#acquisition.request(request, options);
  }

  async release(leaseId: string, reason: "closed" | "explicit" | "killed"): Promise<void> {
    await this.#releaseCoordinator.release(leaseId, reason);
  }

  /** Releases the daemon's current leases for an explicit operator command. */
  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    return this.#releaseCoordinator.releaseAll(reason);
  }

  async expire(leaseId: string): Promise<void> {
    await this.#releaseCoordinator.expire(leaseId);
  }

  /** Operator-only reset; targets device records from this registry exclusively. */
  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    return this.#nuke.nuke(deleteDevices);
  }

  /** Read-only device catalog; a platform without a registered driver is omitted. */
  // fallow-ignore-next-line unused-class-member -- called through CatalogReader by DaemonServer.
  async listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]> {
    return this.#drivers.listCatalog(platform);
  }

  get queueDepth(): number {
    return this.#acquisition.queueDepth;
  }

  get runningCapacity(): RunningCapacity {
    return this.#capacity.runningCapacity(this.#capacityDevices());
  }

  /** Safely converges unleased running devices after startup reconciliation. */
  async convergeRunningCapacity(): Promise<void> {
    await this.#startup.converge();
  }

  /** Stops client feedback for a queued request without affecting its lease outcome. */
  async detachQueuedProgress(requesterId: string): Promise<void> {
    await this.#acquisition.detachQueuedProgress(requesterId);
  }

  async renew(leaseId: string, ttlMs: number): Promise<LeaseRecord> {
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
