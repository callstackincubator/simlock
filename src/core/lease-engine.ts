import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, SystemStats } from "../ports/index.js";
import type { RunningCapacity } from "./capacity.js";
import { CapacityCoordinator, type CapacityReservation } from "./capacity-coordinator.js";
import type { Config } from "./config.js";
import type { Proposal } from "./cleanup/types.js";
import { DeviceOperationClaims, type DeviceOperationClaim } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord, Platform } from "./domain.js";
import { BootTimeoutError, type DeviceRequest, type Driver, type DriverDevice } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { Registry, type ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  type LeaseGrant,
  type LeaseProgress,
  type LeaseRequestOptions,
  type LeaseTiming,
  RequesterAlreadyLeasedError,
  type Waiter,
  WaitQueue,
} from "./wait-queue.js";
import {
  compareLeastRecentlyUsed,
  selectManagedVictim,
  selectWarmVictim,
  type WarmVictimScope,
} from "./warm-pool.js";

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

interface ProvisionAction {
  readonly kind: "provision";
  readonly reservation: CapacityReservation;
}

interface EvictRunningAction {
  readonly kind: "evict-running";
  readonly claim: DeviceOperationClaim;
  readonly device: DeviceRecord;
}

interface EvictManagedAction {
  readonly kind: "evict-managed";
  readonly claim: DeviceOperationClaim;
  readonly device: DeviceRecord;
}

interface BootShutdownAction {
  readonly kind: "boot-shutdown";
  readonly capacityReservation: CapacityReservation;
  readonly claim: DeviceOperationClaim;
  readonly device: DeviceRecord;
}

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
  readonly #capacity: CapacityCoordinator;
  readonly #claims = new DeviceOperationClaims();
  readonly #drivers: DriverCatalog;
  readonly #expiry: LeaseExpiryScheduler;
  readonly #leases: LeaseLifecycle;
  readonly #queue: WaitQueue;
  readonly #decisions = new SerializedDecision();

  constructor(private readonly options: LeaseEngineOptions) {
    this.#capacity = new CapacityCoordinator(options.config, options.systemStats);
    this.#drivers = new DriverCatalog(options.drivers);
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
    const releasedLeaseIds = await this.releaseAll("killed");
    await this.#withDecision(async () => {
      for (const waiter of this.#queue.cancelAll(() => new NukeCancelledError())) {
        this.options.eventBus.emit(
          "lease.rejected",
          { requestSpec: waiter.request, reason: "killed" },
          "wait-queue",
        );
      }
    });

    for (const device of this.options.registry.snapshot.devices) {
      if (device.state === "deleted") continue;
      const driver = this.#driverFor(device.spec.platform);
      if (device.state === "ready") {
        await driver.shutdown(toDriverDevice(device));
        await this.#withDecision(async () => {
          const current = this.options.registry.snapshot.devices.find(
            (candidate) => candidate.id === device.id,
          );
          if (current?.state === "ready") {
            await this.options.registry.transitionDevice(device.id, "shutdown", {
              event: "device.shutdown",
              payload: { deviceId: device.id, initiator: "nuke" },
            });
          }
        });
      }
      if (deleteDevices) {
        const current = this.options.registry.snapshot.devices.find(
          (candidate) => candidate.id === device.id,
        );
        if (current?.state !== "shutdown") continue;
        await driver.destroy(toDriverDevice(current));
        await this.#withDecision(async () => {
          const latest = this.options.registry.snapshot.devices.find(
            (candidate) => candidate.id === device.id,
          );
          if (latest?.state === "shutdown") {
            await this.options.registry.transitionDevice(device.id, "deleted", {
              event: "device.deleted",
              payload: { deviceId: device.id, initiator: "nuke" },
            });
          }
        });
      }
    }
    return { releasedLeaseIds };
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  get runningCapacity(): RunningCapacity {
    return this.#capacity.runningCapacity(this.#capacityDevices());
  }

  /** Safely converges unleased running devices after startup reconciliation. */
  async convergeRunningCapacity(): Promise<void> {
    await this.#leases.restoreExpiryTimers();
    for (const legacy of this.options.registry.snapshot.devices.filter(
      (device) =>
        device.state === "reclaiming" &&
        !this.options.registry.snapshot.leases.some((lease) => lease.deviceId === device.id),
    )) {
      const driver = this.#driverFor(legacy.spec.platform);
      await driver.shutdown(toDriverDevice(legacy));
      await this.#withDecision(async () => {
        await this.options.registry.completeFailedPurge(legacy.id, "shutdown");
        this.options.eventBus.emit(
          "device.shutdown",
          { deviceId: legacy.id, initiator: "startup-legacy-warm-migration" },
          "lease-engine",
        );
      });
    }
    for (;;) {
      const candidate = await this.#withDecision(async () => {
        const capacity = this.runningCapacity;
        const overPlatforms = (["ios", "android"] as const).filter(
          (platform) => capacity[platform].running > capacity[platform].maxRunning,
        );
        if (capacity.global.running <= capacity.global.maxRunning && overPlatforms.length === 0) {
          return undefined;
        }
        const leases = new Set(
          this.options.registry.snapshot.leases.map((lease) => lease.deviceId),
        );
        return this.options.registry.snapshot.devices
          .filter(
            (device) =>
              device.state === "ready" &&
              !leases.has(device.id) &&
              !this.#claims.isClaimed(device.id) &&
              (overPlatforms.length === 0 || overPlatforms.includes(device.spec.platform)),
          )
          .sort(compareLeastRecentlyUsed)[0];
      });
      if (candidate === undefined) return;
      await this.executeCleanup({
        action: "shutdown",
        reason: "running capacity exceeds configured maxRunning",
        rule: "startup-max-running",
        target: candidate.id,
      });
    }
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
    const action = proposal.action;
    if (action !== "shutdown" && action !== "destroy") {
      return false;
    }

    const selected = await this.#withDecision(async () => {
      const candidate = this.options.registry.snapshot.devices.find(
        (current) => current.id === proposal.target,
      );
      if (candidate === undefined || !this.#canExecuteCleanup(candidate, action)) {
        return undefined;
      }
      const claim = this.#claims.tryClaim(candidate.id, "cleanup");
      return claim === undefined ? undefined : { claim, device: candidate };
    });
    if (selected === undefined) {
      return false;
    }
    const { claim, device } = selected;

    const driver = this.#driverFor(device.spec.platform);
    try {
      if (action === "shutdown") {
        await driver.shutdown(toDriverDevice(device));
      } else {
        await driver.destroy(toDriverDevice(device));
      }
    } catch (error: unknown) {
      await this.#withDecision(async () => {
        claim.release();
      });
      throw error;
    }

    await this.#withDecision(async () => {
      claim.release();
      const event =
        action === "shutdown"
          ? {
              event: "device.shutdown" as const,
              payload: { deviceId: device.id, initiator: "cleanup-reaper" },
            }
          : {
              event: "device.deleted" as const,
              payload: { deviceId: device.id, initiator: "cleanup-reaper" },
            };
      await this.options.registry.transitionDevice(
        device.id,
        action === "shutdown" ? "shutdown" : "deleted",
        event,
      );
    });
    this.#wakeQueue();
    return true;
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    const action = await this.#withDecision(async () => this.#decide(waiter));
    await this.#perform(waiter, action);
  }

  async #perform(
    waiter: AcquisitionWaiter,
    action:
      | ProvisionAction
      | BootShutdownAction
      | EvictRunningAction
      | EvictManagedAction
      | undefined,
  ): Promise<void> {
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
      return;
    }
    const driver = this.#driverFor(spec.platform);
    const provisionStartedAt = this.options.clock.now();
    let driverDevice: DriverDevice;
    try {
      this.#notifyProgress(waiter, {
        stage: "provisioning",
        etaMs: driver.estimate("provision", spec),
      });
      driverDevice = await driver.provision(spec);
    } catch {
      const retry = await this.#withDecision(async () => {
        reservation.release();
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

    const device = await this.#withDecision(async () => {
      return this.options.registry.registerDevice({
        driverData: driverDevice.driverData,
        driverDeviceId: driverDevice.deviceId,
        provisionDuration: this.options.clock.now() - provisionStartedAt,
        spec,
      });
    });

    const readyStartedAt = this.options.clock.now();
    try {
      this.#notifyProgress(waiter, { stage: "booting", etaMs: driver.estimate("boot", spec) });
      await driver.makeReady(driverDevice);
    } catch {
      let destroyed = true;
      try {
        await driver.destroy(driverDevice);
      } catch {
        destroyed = false;
      }
      await this.#withDecision(async () => {
        if (destroyed) {
          reservation.release();
          await this.options.registry.transitionDevice(device.id, "deleted", {
            event: "device.deleted",
            payload: { deviceId: device.id, initiator: "lease-engine" },
          });
        }
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      if (destroyed) this.#wakeQueue();
      return;
    }

    const granted = await this.#withDecision(async () => {
      reservation.release();
      await this.options.registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: this.options.clock.now() - readyStartedAt, deviceId: device.id },
      });
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

  async #decide(
    waiter: AcquisitionWaiter,
  ): Promise<
    ProvisionAction | BootShutdownAction | EvictRunningAction | EvictManagedAction | undefined
  > {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    const spec = waiter.spec;
    if (this.#queue.head !== undefined && this.#queue.head !== waiter) {
      if (waiter.options.noWait) {
        this.#reject(waiter, new NoCapacityError(), "no-wait");
        return undefined;
      }
      this.#enqueue(waiter);
      return undefined;
    }

    const ready = this.options.registry.snapshot.devices.find(
      (device) =>
        device.state === "ready" &&
        !this.#claims.isClaimed(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (ready !== undefined) {
      await this.#grant(waiter, ready.id);
      return undefined;
    }

    const shutdown = this.options.registry.snapshot.devices.find(
      (device) =>
        device.state === "shutdown" &&
        !this.#claims.isClaimed(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (shutdown !== undefined) {
      const running = this.#capacity.tryReserveRunning(spec.platform, this.#capacityDevices());
      if (!running.ok) {
        const victim = this.#runningVictim(running.reason, spec.platform);
        if (victim !== undefined) {
          const claim = this.#claims.tryClaim(victim.id, "eviction");
          if (claim === undefined) throw new Error(`Failed to claim selected victim: ${victim.id}`);
          this.#queue.markProcessing(waiter);
          return { claim, device: victim, kind: "evict-running" };
        }
        if (waiter.options.noWait) this.#reject(waiter, new NoCapacityError(), "no-wait");
        else this.#enqueue(waiter);
        return undefined;
      }
      const claim = this.#claims.tryClaim(shutdown.id, "boot");
      if (claim === undefined) {
        running.reservation.release();
        throw new Error(`Failed to claim selected shutdown device: ${shutdown.id}`);
      }
      this.#queue.markProcessing(waiter);
      return {
        capacityReservation: running.reservation,
        claim,
        device: shutdown,
        kind: "boot-shutdown",
      };
    }

    const reservation = this.#capacity.tryReserveProvisioning(
      spec.platform,
      this.#capacityDevices(),
    );
    if (!reservation.ok && reservation.reason === "device-limit") {
      const victim = selectManagedVictim(this.#eligibleEvictionDevices(), spec.platform);
      if (victim !== undefined) {
        const claim = this.#claims.tryClaim(victim.id, "eviction");
        if (claim === undefined) throw new Error(`Failed to claim selected victim: ${victim.id}`);
        this.#queue.markProcessing(waiter);
        return { claim, device: victim, kind: "evict-managed" };
      }
    }
    if (!reservation.ok) {
      const victim = this.#runningVictim(reservation.reason, spec.platform);
      if (victim !== undefined) {
        const claim = this.#claims.tryClaim(victim.id, "eviction");
        if (claim === undefined) throw new Error(`Failed to claim selected victim: ${victim.id}`);
        this.#queue.markProcessing(waiter);
        return { claim, device: victim, kind: "evict-running" };
      }
    }
    if (reservation.ok && waiter.failures < 2) {
      this.#queue.markProcessing(waiter);
      return { kind: "provision", reservation: reservation.reservation };
    }
    if (reservation.ok) {
      reservation.reservation.release();
    }

    if (waiter.options.noWait) {
      this.#reject(waiter, new NoCapacityError(), "no-wait");
      return undefined;
    }
    this.#enqueue(waiter);
    return undefined;
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
    const driver = this.#driverFor(device.spec.platform);
    try {
      await driver.shutdown(toDriverDevice(device));
      await this.#withDecision(async () => {
        await this.options.registry.transitionDevice(device.id, "shutdown", {
          event: "device.shutdown",
          payload: { deviceId: device.id, initiator: "warm-pool-active-demand" },
        });
      });
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
    const driver = this.#driverFor(device.spec.platform);
    try {
      if (device.state === "ready") {
        await driver.shutdown(toDriverDevice(device));
        await this.#withDecision(async () => {
          await this.options.registry.transitionDevice(device.id, "shutdown", {
            event: "device.shutdown",
            payload: { deviceId: device.id, initiator: "warm-pool-active-demand" },
          });
        });
      }
      await driver.destroy(toDriverDevice(device));
      await this.#withDecision(async () => {
        await this.options.registry.transitionDevice(device.id, "deleted", {
          event: "device.deleted",
          payload: { deviceId: device.id, initiator: "warm-pool-active-demand" },
        });
      });
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
    const startedAt = this.options.clock.now();
    try {
      this.#notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate("boot", device.spec),
      });
      await driver.makeReady(toDriverDevice(device));
    } catch {
      let destroyed = true;
      try {
        await driver.destroy(toDriverDevice(device));
      } catch {
        destroyed = false;
      }
      await this.#withDecision(async () => {
        if (destroyed) {
          capacityReservation.release();
          claim.release();
          await this.options.registry.transitionDevice(device.id, "deleted", {
            event: "device.deleted",
            payload: { deviceId: device.id, initiator: "lease-engine" },
          });
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
      await this.options.registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: this.options.clock.now() - startedAt, deviceId: device.id },
      });
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

    await this.#reclaim(released);
  }

  async #reclaim(released: ReleasedLease): Promise<void> {
    const driver = this.#driverFor(released.device.spec.platform);
    const startedAt = this.options.clock.now();
    const attemptedStrategy = driver.reclaimStrategy({ clean: "standard" });
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(released.device), { clean: "standard" });
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(released, startedAt, attemptedStrategy, error);
      return;
    }

    const keepReady = await this.#withDecision(async () => this.#mayRemainWarm(released.device));
    let finalState: "ready" | "shutdown" = result.state;
    if (keepReady && result.state === "shutdown") {
      try {
        await driver.makeReady(toDriverDevice(released.device));
        finalState = "ready";
      } catch {
        finalState = "shutdown";
      }
    } else if (!keepReady && result.state === "ready") {
      try {
        await driver.shutdown(toDriverDevice(released.device));
        finalState = "shutdown";
      } catch {
        finalState = "ready";
      }
    }
    await this.#withDecision(async () => {
      await this.options.registry.transitionDevice(released.device.id, finalState, {
        event: "device.reclaimed",
        payload: {
          deviceId: released.device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
        },
      });
    });
    this.#wakeQueue();
  }

  async #recoverPurgeFailure(
    released: ReleasedLease,
    startedAt: number,
    attemptedStrategy: "erase" | "snapshot" | "wipe",
    error: unknown,
  ): Promise<void> {
    const driver = this.#driverFor(released.device.spec.platform);
    let ready = true;
    try {
      await driver.makeReady(toDriverDevice(released.device));
    } catch {
      ready = false;
    }
    const duration = this.options.clock.now() - startedAt;
    await this.#withDecision(async () => {
      await this.options.registry.completeFailedPurge(
        released.device.id,
        ready ? "ready" : "shutdown",
      );
      this.options.eventBus.emit(
        "device.purge-failed",
        {
          attemptedStrategy,
          deviceId: released.device.id,
          duration,
          error: stableError(error),
          leaseId: released.lease.id,
        },
        "lease-engine",
      );
    });
    this.#wakeQueue();
  }

  #mayRemainWarm(device: DeviceRecord): boolean {
    const capacity = this.runningCapacity;
    if (
      capacity.global.running > capacity.global.maxRunning ||
      capacity[device.spec.platform].running > capacity[device.spec.platform].maxRunning
    ) {
      return false;
    }
    const head = this.#queue.head as AcquisitionWaiter | undefined;
    if (head?.spec === undefined || sameSpec(head.spec, device.spec)) return true;
    return this.#capacity.canReserveRunning(head.spec.platform, this.#capacityDevices()).ok;
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

  #eligibleEvictionDevices(): DeviceRecord[] {
    const leased = new Set(this.options.registry.snapshot.leases.map((lease) => lease.deviceId));
    return this.options.registry.snapshot.devices.filter(
      (device) => !leased.has(device.id) && !this.#claims.isClaimed(device.id),
    );
  }

  #runningVictim(
    reason: "device-limit" | "ram-budget" | "global-running-limit" | "platform-running-limit",
    platform: Platform,
  ): DeviceRecord | undefined {
    if (reason !== "global-running-limit" && reason !== "platform-running-limit") return undefined;
    const capacity = this.runningCapacity;
    const platformBlocked =
      capacity[platform].running + capacity[platform].reserved >= capacity[platform].maxRunning;
    const scope: WarmVictimScope = platformBlocked
      ? { kind: "platform", platform }
      : { kind: "global" };
    return selectWarmVictim(this.#eligibleEvictionDevices(), scope);
  }

  #canExecuteCleanup(device: DeviceRecord, action: "shutdown" | "destroy"): boolean {
    if (
      this.#claims.isClaimed(device.id) ||
      this.options.registry.snapshot.leases.some((lease) => lease.deviceId === device.id)
    ) {
      return false;
    }

    return (
      (action === "shutdown" && device.state === "ready") ||
      (action === "destroy" && device.state === "shutdown")
    );
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

function stableError(error: unknown): string {
  const value = asError(error);
  return `${value.name}: ${value.message}`;
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

function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion
  );
}

function toDriverDevice(device: DeviceRecord): DriverDevice {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}
