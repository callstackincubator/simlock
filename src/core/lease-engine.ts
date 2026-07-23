import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, SystemStats } from "../ports/index.js";
import type { RunningCapacity } from "./capacity.js";
import { AcquisitionPlanner, type AcquisitionPlan } from "./acquisition-planner.js";
import { CapacityCoordinator, type CapacityReservation } from "./capacity-coordinator.js";
import { CleanupExecutor, type CleanupActionExecutor } from "./cleanup-executor.js";
import type { Config } from "./config.js";
import type { Proposal } from "./cleanup/types.js";
import { DeviceOperationClaims, type DeviceOperationClaim } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord, Platform } from "./domain.js";
import { BootTimeoutError, type DeviceRequest, type Driver } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { NukeService } from "./nuke-service.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupConverger } from "./startup-converger.js";
import {
  type LeaseGrant,
  type LeaseProgress,
  type LeaseRequestOptions,
  type LeaseTiming,
  RequesterAlreadyLeasedError,
  type Waiter,
  WaitQueue,
} from "./wait-queue.js";
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

export class NoCapacityError extends Error {
  constructor() {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

export { QueueTimeoutError, RequesterAlreadyLeasedError } from "./wait-queue.js";

export { HeldLeaseRenewalError } from "./lease-lifecycle.js";

class NukeCancelledError extends Error {
  constructor() {
    super("Request cancelled by nuke");
    this.name = "NukeCancelledError";
  }
}

export { NoDriverError } from "./driver-catalog.js";

interface AcquisitionWaiter extends Waiter {
  failures: number;
  spec?: DeviceSpec;
  timing: LeaseTiming;
}

type OperationPlan = Exclude<
  AcquisitionPlan,
  { readonly kind: "grant-ready" | "wait" | "no-capacity" }
>;

const noTiming: LeaseTiming = {
  estimatedBootMs: 0,
  estimatedProvisionMs: 0,
  estimatedReclaimMs: 0,
  estimatedReadyMs: 0,
};

/**
 * The daemon's serialized leasing transaction coordinator. Driver work is
 * intentionally performed after each decision section has been released.
 */
export class LeaseEngine {
  readonly cleanup: CleanupActionExecutor;
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
    this.#expiry = new LeaseExpiryScheduler(options.clock, async (leaseId) => {
      await this.#release(leaseId, "expired");
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
        this.#wakeQueue();
      },
    });
    this.#warmPool = new WarmPoolCoordinator({
      capacity: this.#capacity,
      clock: options.clock,
      decisions: this.#decisions,
      drivers: this.#drivers,
      eventBus: options.eventBus,
      notifyAvailability: () => this.#wakeQueue(),
      queueHeadDemand: () => this.#queue.head as AcquisitionWaiter | undefined,
      registry: options.registry,
    });
    this.cleanup = new CleanupExecutor({
      eventBus: options.eventBus,
      lifecycle: this.#deviceLifecycle,
      notifyAvailability: () => this.#wakeQueue(),
      registry: options.registry,
    });
    this.#nuke = new NukeService({
      devices: this.#deviceLifecycle,
      leases: { releaseAll: async (reason) => this.releaseAll(reason) },
      pendingRequests: {
        cancelAll: async () => {
          await this.#withDecision(async () => {
            for (const waiter of this.#queue.cancelAll(() => new NukeCancelledError())) {
              this.options.eventBus.emit(
                "lease.rejected",
                { requestSpec: waiter.request, reason: "killed" },
                "wait-queue",
              );
            }
          });
        },
      },
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
    let waiter: AcquisitionWaiter;
    try {
      waiter = await this.#withDecision(async () => {
        const alreadyActive = this.options.registry.snapshot.leases.some(
          (lease) => lease.requesterId === options.requesterId,
        );
        if (alreadyActive || this.#queue.hasPendingRequester(options.requesterId)) {
          this.options.eventBus.emit(
            "lease.rejected",
            { requestSpec: request, reason: "already-leased" },
            "lease-engine",
          );
          throw new RequesterAlreadyLeasedError(options.requesterId);
        }

        const accepted = this.#newWaiter(request, options);
        this.options.eventBus.emit(
          "lease.requested",
          {
            requestSpec: request,
            requester: options.requesterId,
            waitPolicy: options.noWait ? "no-wait" : "wait",
          },
          "lease-engine",
        );
        return accepted;
      });
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    let driver: Driver;
    try {
      driver = this.#drivers.get(request.platform);
    } catch (error: unknown) {
      await this.#withDecision(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return waiter.promise;
    }

    try {
      waiter.spec = await driver.resolveSpec(request, {
        allowDownload: options.allowDownload ?? false,
      });
    } catch (error: unknown) {
      await this.#withDecision(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return waiter.promise;
    }

    void this.#drive(waiter);
    return waiter.promise;
  }

  async release(leaseId: string, reason: "closed" | "explicit" | "killed"): Promise<void> {
    await this.#release(leaseId, reason);
  }

  /** Releases the daemon's current leases for an explicit operator command. */
  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.release(leaseId, reason)));
    return leaseIds;
  }

  async expire(leaseId: string): Promise<void> {
    await this.#release(leaseId, "expired");
  }

  /** Operator-only reset; targets device records from this registry exclusively. */
  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    return this.#nuke.nuke(deleteDevices);
  }

  get queueDepth(): number {
    return this.#queue.depth;
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
    await this.#withDecision(async () => {
      this.#queue.detachProgress(requesterId);
    });
  }

  async renew(leaseId: string, ttlMs: number): Promise<LeaseRecord> {
    return this.#withDecision(async () => this.#leases.renew(leaseId, ttlMs));
  }

  /**
   * Runs one cleanup action through the same decision queue as leasing. The
   * reservation prevents a concurrent lease decision from selecting the
   * device while its driver operation is in progress.
   */
  async executeCleanup(proposal: Proposal): Promise<boolean> {
    return this.cleanup.execute(proposal);
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    const action = await this.#withDecision(async () => this.#decide(waiter));
    await this.#perform(waiter, action);
  }

  async #perform(waiter: AcquisitionWaiter, action: OperationPlan | undefined): Promise<void> {
    if (action === undefined) {
      return;
    }

    if (action.kind === "provision") {
      const spec = waiter.spec;
      if (spec !== undefined) {
        waiter.timing = estimatedTiming(this.#driverFor(spec.platform), spec);
      }
      await this.#provision(waiter, action.reservation);
      return;
    }
    if (action.kind === "boot-shutdown") {
      waiter.timing = estimatedBootTiming(
        this.#driverFor(action.device.spec.platform),
        action.device.spec,
      );
      await this.#bootShutdown(waiter, action.device, action.capacityReservation, action.claim);
      return;
    }
    if (action.kind === "evict-running") {
      await this.#evictRunning(waiter, action.device, action.claim);
      return;
    }
    await this.#evictManaged(waiter, action.device, action.claim);
  }

  async #provision(waiter: AcquisitionWaiter, reservation: CapacityReservation): Promise<void> {
    const spec = waiter.spec;
    if (spec === undefined) {
      reservation.release();
      return;
    }
    let device: DeviceRecord;
    try {
      device = await this.#provisioner.provision(spec, {
        onProgress: (progress) => this.#notifyProgress(waiter, progress),
        reservation,
      });
    } catch (error: unknown) {
      if (error instanceof BootTimeoutError) {
        await this.#withDecision(async () => {
          if (waiter.state !== "rejected") this.#reject(waiter, error, "boot-timeout");
        });
        this.#wakeQueue();
        return;
      }
      const retry = await this.#withDecision(async () => {
        if (waiter.state === "rejected") {
          return false;
        }
        waiter.failures += 1;
        if (waiter.failures === 1) {
          this.#queue.markNew(waiter);
          return true;
        }
        this.#enqueue(waiter);
        return false;
      });
      if (retry) {
        void this.#drive(waiter);
      }
      return;
    }

    const granted = await this.#withDecision(async () => {
      if (waiter.state === "rejected") {
        return false;
      }
      await this.#grant(waiter, device.id);
      return true;
    });
    if (!granted) {
      this.#wakeQueue();
    }
  }

  async #decide(waiter: AcquisitionWaiter): Promise<OperationPlan | undefined> {
    const plan = this.#nextPlan(waiter);
    if (plan === undefined) return undefined;
    if (plan.kind === "grant-ready") {
      await this.#grant(waiter, plan.device.id);
      return undefined;
    }
    const operation = operationPlan(plan);
    if (operation === undefined) {
      this.#defer(waiter);
      return undefined;
    }
    this.#queue.markProcessing(waiter);
    return operation;
  }

  #nextPlan(waiter: AcquisitionWaiter): AcquisitionPlan | undefined {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    if (this.#queue.head !== undefined && this.#queue.head !== waiter) {
      return this.#blockedPlan(waiter);
    }
    return this.#planner.plan({
      failures: waiter.failures,
      noWait: waiter.options.noWait ?? false,
      snapshot: this.options.registry.snapshot,
      spec: waiter.spec,
    });
  }

  #blockedPlan(waiter: AcquisitionWaiter): AcquisitionPlan {
    return waiter.options.noWait ? { kind: "no-capacity" } : { kind: "wait" };
  }

  #defer(waiter: AcquisitionWaiter): void {
    if (waiter.options.noWait) this.#reject(waiter, new NoCapacityError(), "no-wait");
    else this.#enqueue(waiter);
  }

  async #grant(waiter: AcquisitionWaiter, deviceId: string): Promise<void> {
    const { device, lease } = await this.#leases.grant({
      deviceId,
      mode: waiter.options.mode,
      requesterId: waiter.options.requesterId,
    });

    this.#queue.resolve(waiter, { device, lease, timing: waiter.timing });
  }

  async #evictRunning(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const shutdown = await this.#deviceLifecycle.shutdown(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (shutdown === undefined)
        throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch {
      await this.#withDecision(async () => {
        claim.release();
        if (waiter.options.noWait) this.#reject(waiter, new NoCapacityError(), "no-wait");
        else this.#enqueue(waiter);
      });
      return;
    }
    const next = await this.#withDecision(async () => {
      claim.release();
      this.#queue.markNew(waiter);
      return this.#decide(waiter);
    });
    await this.#perform(waiter, next);
  }

  async #evictManaged(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const deleted = await this.#deviceLifecycle.dispose(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (deleted === undefined) throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch {
      await this.#withDecision(async () => {
        claim.release();
        if (waiter.options.noWait) this.#reject(waiter, new NoCapacityError(), "no-wait");
        else this.#enqueue(waiter);
      });
      return;
    }
    const next = await this.#withDecision(async () => {
      claim.release();
      this.#queue.markNew(waiter);
      return this.#decide(waiter);
    });
    await this.#perform(waiter, next);
  }

  async #bootShutdown(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    capacityReservation: CapacityReservation,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const driver = this.#driverFor(device.spec.platform);
    try {
      this.#notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate("boot", device.spec),
      });
      const ready = await this.#deviceLifecycle.boot(device, claim);
      if (ready === undefined) throw new Error(`Boot target is no longer safe: ${device.id}`);
    } catch {
      let destroyed = true;
      try {
        const deleted = await this.#deviceLifecycle.destroy(device, "lease-engine", "boot");
        destroyed = deleted !== undefined;
      } catch {
        destroyed = false;
      }
      await this.#withDecision(async () => {
        if (destroyed) {
          capacityReservation.release();
        } else if (!this.#claims.isClaimed(device.id)) {
          this.#claims.tryClaim(device.id, "boot");
        }
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      if (destroyed) this.#wakeQueue();
      return;
    }

    const granted = await this.#withDecision(async () => {
      capacityReservation.release();
      claim.release();
      if (waiter.state !== "rejected") {
        await this.#grant(waiter, device.id);
        return true;
      }
      return false;
    });
    if (!granted) {
      this.#wakeQueue();
    }
  }

  async #release(
    leaseId: string,
    reason: "closed" | "explicit" | "killed" | "expired",
  ): Promise<void> {
    const released = await this.#withDecision(async () => {
      return this.#leases.beginRelease(leaseId, reason);
    });

    await this.#warmPool.reclaim(released);
  }

  #enqueue(waiter: AcquisitionWaiter): void {
    const alreadyQueued = this.#queue.isQueued(waiter);
    if (this.#queue.enqueue(waiter) && !alreadyQueued) {
      this.options.eventBus.emit(
        "lease.queued",
        { queuePosition: this.#queue.depth, requestId: waiter.id },
        "lease-engine",
      );
    }
  }

  #reject(
    waiter: AcquisitionWaiter,
    error: Error,
    reason:
      | "timeout"
      | "no-wait"
      | "unresolvable-spec"
      | "already-leased"
      | "boot-timeout"
      | "killed",
  ): void {
    if (this.#queue.reject(waiter, error)) {
      this.options.eventBus.emit(
        "lease.rejected",
        { requestSpec: waiter.request, reason },
        "lease-engine",
      );
    }
  }

  #wakeQueue(): void {
    void this.#withDecision(async () => {
      const next = this.#queue.head as AcquisitionWaiter | undefined;
      if (next !== undefined && next.state === "queued") {
        void this.#drive(next);
      }
    });
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions): AcquisitionWaiter {
    return Object.assign(this.#queue.create(request, options), {
      failures: 0,
      timing: noTiming,
    });
  }

  #notifyProgress(waiter: AcquisitionWaiter, progress: LeaseProgress): void {
    this.#queue.notifyProgress(waiter, progress);
  }

  #capacityDevices(): { readonly platform: Platform; readonly state: string }[] {
    return this.options.registry.snapshot.devices.map((device) => ({
      platform: device.spec.platform,
      state: device.state,
    }));
  }

  #driverFor(platform: Platform): Driver {
    return this.#drivers.get(platform);
  }

  #withDecision<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#decisions.run(operation);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function estimatedTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedProvisionMs = driver.estimate("provision", spec);
  const estimatedBootMs = driver.estimate("boot", spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs,
    estimatedReclaimMs: 0,
    estimatedReadyMs: estimatedProvisionMs + estimatedBootMs,
  };
}

function estimatedBootTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedBootMs = driver.estimate("boot", spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: 0,
    estimatedReadyMs: estimatedBootMs,
  };
}

function operationPlan(plan: AcquisitionPlan): OperationPlan | undefined {
  return plan.kind === "grant-ready" || plan.kind === "wait" || plan.kind === "no-capacity"
    ? undefined
    : plan;
}
