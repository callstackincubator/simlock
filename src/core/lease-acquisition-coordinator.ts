import type { EventBus } from "../bus/index.js";
import type { CapacityReservation } from "./capacity-coordinator.js";
import { AcquisitionPlanner, type AcquisitionPlan } from "./acquisition-planner.js";
import { DeviceOperationClaims, type DeviceOperationClaim } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord } from "./domain.js";
import { BootTimeoutError, type DeviceRequest, type Driver } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";
import {
  type LeaseGrant,
  type LeaseRequestOptions,
  type LeaseTiming,
  RequesterAlreadyLeasedError,
  type Waiter,
  WaitQueue,
} from "./wait-queue.js";

export type { LeaseGrant, LeaseProgress, LeaseRequestOptions, LeaseTiming } from "./wait-queue.js";
export { QueueTimeoutError, RequesterAlreadyLeasedError } from "./wait-queue.js";
export { NoDriverError } from "./driver-catalog.js";

export class NoCapacityError extends Error {
  constructor() {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

export interface LeaseAcquisitionRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface LeaseAcquisitionCoordinatorOptions {
  readonly claims: DeviceOperationClaims;
  readonly decisions: SerializedDecision;
  readonly drivers: DriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly leases: Pick<LeaseLifecycle, "grant">;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "boot" | "destroy" | "dispose" | "shutdown">;
  readonly planner: AcquisitionPlanner;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly queue: WaitQueue;
  readonly registry: LeaseAcquisitionRegistry;
}

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

/** Coordinates admission, planning, device work, and queue settlement for acquisition only. */
export class LeaseAcquisitionCoordinator {
  constructor(private readonly options: LeaseAcquisitionCoordinatorOptions) {}

  get queueDepth(): number {
    return this.options.queue.depth;
  }

  get queueHeadSpec(): DeviceSpec | undefined {
    return (this.options.queue.head as AcquisitionWaiter | undefined)?.spec;
  }

  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    let waiter: AcquisitionWaiter;
    try {
      waiter = await this.options.decisions.run(async () => {
        const alreadyActive = this.options.registry.snapshot.leases.some(
          (lease) => lease.requesterId === options.requesterId,
        );
        if (alreadyActive || this.options.queue.hasPendingRequester(options.requesterId)) {
          this.options.eventBus.emit(
            "lease.rejected",
            { requestSpec: request, reason: "already-leased" },
            "lease-acquisition-coordinator",
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
          "lease-acquisition-coordinator",
        );
        return accepted;
      });
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    let driver: Driver;
    try {
      driver = this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return waiter.promise;
    }
    try {
      waiter.spec = await driver.resolveSpec(request, {
        allowDownload: options.allowDownload ?? false,
      });
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return waiter.promise;
    }

    void this.#drive(waiter);
    return waiter.promise;
  }

  async detachQueuedProgress(requesterId: string): Promise<void> {
    await this.options.decisions.run(async () => {
      this.options.queue.detachProgress(requesterId);
    });
  }

  /** Direct availability notification for release, cleanup, and queue-timeout callers. */
  kick(): void {
    this.#wakeQueue();
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    const action = await this.options.decisions.run(async () => this.#decide(waiter));
    await this.#perform(waiter, action);
  }

  async #perform(waiter: AcquisitionWaiter, action: OperationPlan | undefined): Promise<void> {
    if (action === undefined) return;
    if (action.kind === "provision") {
      const spec = waiter.spec;
      if (spec === undefined) {
        action.reservation.release();
        return;
      }
      waiter.timing = estimatedTiming(this.options.drivers.get(spec.platform), spec);
      await this.#provision(waiter, action.reservation);
      return;
    }
    if (action.kind === "boot-shutdown") {
      waiter.timing = estimatedBootTiming(
        this.options.drivers.get(action.device.spec.platform),
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
      device = await this.options.provisioner.provision(spec, {
        onProgress: (progress) => this.options.queue.notifyProgress(waiter, progress),
        reservation,
      });
    } catch (error: unknown) {
      if (error instanceof BootTimeoutError) {
        await this.options.decisions.run(async () => {
          if (waiter.state !== "rejected") this.#reject(waiter, error, "boot-timeout");
        });
        this.#wakeQueue();
        return;
      }
      const retry = await this.options.decisions.run(async () => {
        if (waiter.state === "rejected") return false;
        waiter.failures += 1;
        if (waiter.failures === 1) {
          this.options.queue.markNew(waiter);
          return true;
        }
        this.#enqueue(waiter);
        return false;
      });
      if (retry) void this.#drive(waiter);
      return;
    }
    const granted = await this.options.decisions.run(async () => {
      if (waiter.state === "rejected") return false;
      await this.#grant(waiter, device.id);
      return true;
    });
    if (!granted) this.#wakeQueue();
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
    this.options.queue.markProcessing(waiter);
    return operation;
  }

  #nextPlan(waiter: AcquisitionWaiter): AcquisitionPlan | undefined {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    if (this.options.queue.head !== undefined && this.options.queue.head !== waiter) {
      return waiter.options.noWait ? { kind: "no-capacity" } : { kind: "wait" };
    }
    return this.options.planner.plan({
      failures: waiter.failures,
      noWait: waiter.options.noWait ?? false,
      snapshot: this.options.registry.snapshot,
      spec: waiter.spec,
    });
  }

  async #grant(waiter: AcquisitionWaiter, deviceId: string): Promise<void> {
    const { device, lease } = await this.options.leases.grant({
      deviceId,
      mode: waiter.options.mode,
      requesterId: waiter.options.requesterId,
    });
    this.options.queue.resolve(waiter, { device, lease, timing: waiter.timing });
  }

  async #evictRunning(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const shutdown = await this.options.lifecycle.shutdown(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (shutdown === undefined)
        throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch {
      await this.options.decisions.run(async () => {
        claim.release();
        this.#defer(waiter);
      });
      return;
    }
    await this.#continueAfterEviction(waiter, claim);
  }

  async #evictManaged(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const deleted = await this.options.lifecycle.dispose(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (deleted === undefined) throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch {
      await this.options.decisions.run(async () => {
        claim.release();
        this.#defer(waiter);
      });
      return;
    }
    await this.#continueAfterEviction(waiter, claim);
  }

  async #continueAfterEviction(
    waiter: AcquisitionWaiter,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const next = await this.options.decisions.run(async () => {
      claim.release();
      this.options.queue.markNew(waiter);
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
    const driver = this.options.drivers.get(device.spec.platform);
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate("boot", device.spec),
      });
      const ready = await this.options.lifecycle.boot(device, claim);
      if (ready === undefined) throw new Error(`Boot target is no longer safe: ${device.id}`);
    } catch {
      let destroyed = true;
      try {
        destroyed =
          (await this.options.lifecycle.destroy(device, "lease-engine", "boot")) !== undefined;
      } catch {
        destroyed = false;
      }
      await this.options.decisions.run(async () => {
        if (destroyed) capacityReservation.release();
        else if (!this.options.claims.isClaimed(device.id))
          this.options.claims.tryClaim(device.id, "boot");
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      if (destroyed) this.#wakeQueue();
      return;
    }
    const granted = await this.options.decisions.run(async () => {
      capacityReservation.release();
      claim.release();
      if (waiter.state === "rejected") return false;
      await this.#grant(waiter, device.id);
      return true;
    });
    if (!granted) this.#wakeQueue();
  }

  #defer(waiter: AcquisitionWaiter): void {
    if (waiter.options.noWait) this.#reject(waiter, new NoCapacityError(), "no-wait");
    else this.#enqueue(waiter);
  }

  #enqueue(waiter: AcquisitionWaiter): void {
    const alreadyQueued = this.options.queue.isQueued(waiter);
    if (this.options.queue.enqueue(waiter) && !alreadyQueued) {
      this.options.eventBus.emit(
        "lease.queued",
        { queuePosition: this.options.queue.depth, requestId: waiter.id },
        "lease-acquisition-coordinator",
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
    if (this.options.queue.reject(waiter, error)) {
      this.options.eventBus.emit(
        "lease.rejected",
        { requestSpec: waiter.request, reason },
        "lease-acquisition-coordinator",
      );
    }
  }

  #wakeQueue(): void {
    void this.options.decisions.run(async () => {
      const next = this.options.queue.head as AcquisitionWaiter | undefined;
      if (next !== undefined && next.state === "queued") void this.#drive(next);
    });
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions): AcquisitionWaiter {
    return Object.assign(this.options.queue.create(request, options), {
      failures: 0,
      timing: noTiming,
    });
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
