import type { EventBus } from "../bus/index.js";
import { type Logger, NoopLogger } from "../ports/index.js";
import type { CapacityReservation } from "./capacity/index.js";
import { type AcquisitionPlan, type AcquisitionPlanner } from "./acquisition-planner.js";
import {
  type DeviceOperationClaim,
  type DeviceOperationClaims,
} from "./device-operation-claims.js";
import { type DeviceProvisioner } from "./device-provisioner.js";
import { type LeaseRequestBook } from "./lease-request-book.js";
import {
  type DeviceMode,
  type DeviceRecord,
  type DeviceSpec,
  type LeaseRecord,
  type Platform,
  sameSpec,
} from "./domain.js";
import type { ComponentInstaller, ComponentInstallerProgress } from "./component-installer.js";
import {
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  RuntimeMissingError,
} from "./driver.js";
import { type DriverCatalog } from "./driver-catalog.js";
import { type LeaseLifecycle } from "./lease-lifecycle.js";
import type { AcquisitionMaintenance } from "./nuke-service.js";
import {
  type ManagedDeviceLifecycle,
  type ReadyDeviceHandoff,
} from "./managed-device-lifecycle.js";
import { type SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";
import {
  type LeaseGrant,
  type LeaseProgress,
  type LeaseRequestOptions,
  type LeaseTiming,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  type Waiter,
  type WaitQueue,
} from "./wait-queue.js";

export type { LeaseGrant, LeaseRequestOptions } from "./wait-queue.js";
export {
  QueueTimeoutError,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
} from "./wait-queue.js";
export { NoDriverError } from "./driver-catalog.js";

export class NoCapacityError extends Error {
  constructor() {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

class NukeCancelledError extends Error {
  constructor() {
    super("Request cancelled by nuke");
    this.name = "NukeCancelledError";
  }
}

export interface LeaseAcquisitionRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export type AcquisitionClaims = Pick<DeviceOperationClaims, "isClaimed" | "tryClaim">;
export type AcquisitionDecision = Pick<SerializedDecision, "run">;
export type AcquisitionDrivers = Pick<DriverCatalog, "get">;
export type AcquisitionPlannerPort = Pick<AcquisitionPlanner, "plan">;
export type AcquisitionQueue = Pick<
  WaitQueue,
  | "create"
  | "cancelAll"
  | "depth"
  | "enqueue"
  | "findPendingWaiter"
  | "hasPendingRequester"
  | "head"
  | "isQueued"
  | "markNew"
  | "markProcessing"
  | "notifyProgress"
  | "reject"
  | "resolve"
>;

export interface LeaseAcquisitionCoordinatorOptions {
  readonly claims: AcquisitionClaims;
  /**
   * The one installer in the core (ADR 0010 §3). A request whose runtime is missing and that
   * may download calls it directly (architecture rule 5); nothing else on this path installs.
   */
  readonly components: Pick<ComponentInstaller, "install">;
  readonly decisions: AcquisitionDecision;
  /**
   * The worker's default device mode per platform, built from config at the composition root
   * (ADR 0007 §2). A platform it does not name defaults to `"full"`.
   */
  readonly defaultModes: Readonly<Partial<Record<Platform, DeviceMode>>>;
  readonly drivers: AcquisitionDrivers;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly leases: Pick<LeaseLifecycle, "grant">;
  readonly lifecycle: Pick<
    ManagedDeviceLifecycle,
    "bootForLease" | "destroy" | "dispose" | "shutdown"
  >;
  readonly planner: AcquisitionPlannerPort;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly queue: AcquisitionQueue;
  readonly registry: LeaseAcquisitionRegistry;
  readonly logger?: Logger;
  /** Stores each request before it is queued and answers repeats of it (`LeaseRequestBook`). */
  readonly requests: Pick<LeaseRequestBook<LeaseGrant>, "admit" | "replay">;
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
export class LeaseAcquisitionCoordinator implements AcquisitionMaintenance {
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #driving = new WeakSet<AcquisitionWaiter>();
  #admissionClosed = false;
  #maintenanceDepth = 0;
  readonly #logger: Logger;

  constructor(private readonly options: LeaseAcquisitionCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-acquisition-coordinator") ?? new NoopLogger();
  }

  get queueDepth(): number {
    return this.options.queue.depth;
  }

  /**
   * The session principal a pending request was created under (ADR §4: `ownerId` on
   * `LeaseRequestOptions`, always the session principal, never the caller-suppliable
   * `requesterId`). `undefined` when no pending request exists for this requester id --
   * `cancelPending`'s own `not-found` outcome is what surfaces that, not this lookup, so a
   * caller cancelling a request that already settled (or never existed) is not authorized on
   * a manufactured owner. A synchronous read like `queueDepth`, not routed through
   * `decisions.run`: no state is asserted or mutated, and `#leaseCancel`'s contract-level
   * `authorize` hook (ADR §2 step 3) runs before the handler, so it cannot go through the
   * handler's own serialized decision anyway.
   */
  pendingRequestOwner(requesterId: string): string | undefined {
    return this.options.queue.findPendingWaiter(requesterId)?.options.ownerId;
  }

  get queueHeadSpec(): DeviceSpec | undefined {
    return (this.options.queue.head as AcquisitionWaiter | undefined)?.spec;
  }

  /**
   * Admits a request, or answers a repeat of one. A repeat under a stored key is answered before
   * any other check -- its result never depends on what changed on the host since. A new
   * request is stored before the queue sees it, inside the same serialized section as the
   * one-request-per-requester check, so two concurrent requests under one key cannot both pass.
   */
  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    let admitted: { readonly waiter: AcquisitionWaiter } | { readonly replay: Promise<LeaseGrant> };
    try {
      admitted = await this.options.decisions.run(async () => {
        const replay = this.options.requests.replay(request, options);
        if (replay !== undefined) return { replay };
        if (this.#admissionClosed) {
          this.options.eventBus.emit(
            "lease.rejected",
            { requestSpec: request, reason: "killed" },
            "lease-acquisition-coordinator",
          );
          throw new NukeCancelledError();
        }
        const activeLease = this.options.registry.snapshot.leases.find(
          (lease) => lease.requesterId === options.requesterId,
        );
        if (
          activeLease !== undefined ||
          this.options.queue.hasPendingRequester(options.requesterId)
        ) {
          this.options.eventBus.emit(
            "lease.rejected",
            { requestSpec: request, reason: "already-leased" },
            "lease-acquisition-coordinator",
          );
          throw new RequesterAlreadyLeasedError(options.requesterId, activeLease?.id);
        }
        const { id, started: accepted } = await this.options.requests.admit(
          request,
          options,
          (id, onProgress) => this.#newWaiter(request, { ...options, onProgress }, id),
        );
        this.options.eventBus.emit(
          "lease.requested",
          {
            requestId: id,
            requestSpec: request,
            requester: options.requesterId,
            waitPolicy: options.noWait ? "no-wait" : "wait",
          },
          "lease-acquisition-coordinator",
        );
        return { waiter: accepted };
      });
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    if ("replay" in admitted) return admitted.replay;
    const { waiter } = admitted;
    this.#track(this.#resolveAndDrive(waiter, request, options));
    return waiter.promise;
  }

  /** Closes acquisition admission, settles all demand, and drains driver work. */
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#maintenanceDepth += 1;
      this.#admissionClosed = true;
      for (const waiter of this.options.queue.cancelAll(() => new NukeCancelledError())) {
        this.options.eventBus.emit(
          "lease.rejected",
          { requestSpec: waiter.request, reason: "killed" },
          "lease-acquisition-coordinator",
        );
      }
    });
    while (this.#activeWorkflows.size > 0) {
      await Promise.allSettled(this.#activeWorkflows);
    }
  }

  /** Reopens acquisition admission after an administrative maintenance operation. */
  async endMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#maintenanceDepth = Math.max(0, this.#maintenanceDepth - 1);
      this.#admissionClosed = this.#maintenanceDepth > 0;
    });
  }

  async #resolveAndDrive(
    waiter: AcquisitionWaiter,
    request: DeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<void> {
    let driver: Driver;
    try {
      driver = this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }
    try {
      // The one place a request with no mode gets the worker's default (ADR 0007 §2).
      const mode = request.mode ?? this.options.defaultModes[request.platform] ?? "full";
      const resolved = await this.#resolveOrInstall(waiter, driver, { ...request, mode }, options);
      // Full is a guarantee (ADR 0007 §5): a slim spec is accepted only for a slim request, so a
      // driver that returns the wrong thing still cannot put a full request on a slim device.
      waiter.spec = mode === "slim" ? resolved : fullSpec(resolved);
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }

    await this.#drive(waiter);
  }

  /**
   * Resolves the request; when its runtime is missing, a download could supply it, and the
   * request may download, asks the installer for it and resolves once more. The installer skips
   * the install when, by the time this call reaches the front of its queue, `resolveSpec` no
   * longer fails with `RuntimeMissingError` -- another install made the runtime available.
   * Without `allowDownload` the first failure stands and the installer is never called.
   *
   * The installer's reports reach the requester as the `downloading` stage, through the queue
   * like every other stage. A report equal to the last one sent is skipped, so a percentage is
   * sent once per whole number.
   */
  async #resolveOrInstall(
    waiter: AcquisitionWaiter,
    driver: Driver,
    request: DeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<DeviceSpec> {
    try {
      return await driver.resolveSpec(request);
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeMissingError) ||
        !error.downloadable ||
        error.component === undefined ||
        options.allowDownload !== true
      ) {
        throw error;
      }
      const { component } = error;
      let lastSent: DownloadingProgress | undefined;
      await this.options.components.install({
        component,
        onProgress: (progress) => {
          const next = downloadingProgress(component, progress);
          if (lastSent !== undefined && sameDownloadingProgress(lastSent, next)) return;
          lastSent = next;
          this.options.queue.notifyProgress(waiter, next);
        },
        platform: request.platform,
        requesterId: options.requesterId,
        stillNeeded: async () => {
          try {
            await driver.resolveSpec(request);
            return false;
          } catch (stillMissing: unknown) {
            return stillMissing instanceof RuntimeMissingError;
          }
        },
      });
      return driver.resolveSpec(request);
    }
  }

  /**
   * Cancels a single pending request. Reuses the queue timeout's safety envelope exactly:
   * only a waiter still in `queued` state is safe to reject here. `processing` means device
   * work already claimed it (provision/boot/evict in flight, possibly never having touched
   * the FIFO list at all on a first-attempt direct dispatch) -- the same state the timeout
   * timer leaves untouched -- so this reports `not-cancellable` rather than inventing a new
   * rule for tearing down in-flight driver work; nuke's `cancelAll` already owns that harder
   * problem, with its own drain of `#activeWorkflows`.
   */
  async cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.options.decisions.run(async () => {
      const waiter = this.options.queue.findPendingWaiter(requesterId) as
        | AcquisitionWaiter
        | undefined;
      if (waiter === undefined) return "not-found";
      if (waiter.state !== "queued") return "not-cancellable";
      this.#reject(waiter, new RequestCancelledError(waiter.id), "cancelled");
      return "cancelled";
    });
  }

  /** Direct availability notification for release, cleanup, and queue-timeout callers. */
  kick(): void {
    this.#wakeQueue();
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    if (this.#driving.has(waiter)) return;
    this.#driving.add(waiter);
    try {
      const action = await this.options.decisions.run(async () => this.#decide(waiter));
      await this.#perform(waiter, action);
    } finally {
      this.#driving.delete(waiter);
    }
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
    let handoff: ReadyDeviceHandoff;
    try {
      handoff = await this.options.provisioner.provision(spec, {
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
      if (retry) {
        this.#driving.delete(waiter);
        await this.#drive(waiter);
      }
      return;
    }
    await this.#grantHandoff(waiter, handoff);
  }

  async #decide(waiter: AcquisitionWaiter): Promise<OperationPlan | undefined> {
    if (this.#admissionClosed && waiter.state !== "rejected") {
      this.#reject(waiter, new NukeCancelledError(), "killed");
      return undefined;
    }
    const plan = this.#nextPlan(waiter);
    if (plan === undefined) return undefined;
    if (plan.kind === "grant-ready") {
      waiter.timing = grantReadyTiming(
        this.options.drivers.get(plan.device.spec.platform),
        plan.device.spec,
      );
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

  /**
   * The one place a `LeaseGrant` is built, which is why the lease environment is read
   * here: every acquisition path -- ready device, fresh provision, boot, eviction -- funnels
   * through it, so there is no second construction site to keep in step.
   */
  async #grant(waiter: AcquisitionWaiter, deviceId: string): Promise<void> {
    const { device, lease } = await this.options.leases.grant({
      deviceId,
      ownerId: waiter.options.ownerId,
      requesterId: waiter.options.requesterId,
      ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
    });
    this.options.queue.resolve(waiter, {
      device,
      environment: this.options.drivers.get(device.spec.platform).leaseEnvironment(),
      lease,
      timing: waiter.timing,
    });
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
    } catch (error: unknown) {
      this.#logFailure(
        "shutting down an eviction target failed",
        waiter,
        device,
        "shutdown",
        error,
      );
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
    } catch (error: unknown) {
      this.#logFailure("deleting an eviction target failed", waiter, device, "delete", error);
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

  /** One `warn` line for a device step that failed in the background and is handled here by
   * deferring the waiter or destroying the device. The waiter only ever sees a generic outcome. */
  #logFailure(
    message: string,
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    step: string,
    error: unknown,
  ): void {
    this.#logger.warn(message, {
      deviceId: device.id,
      requesterId: waiter.options.requesterId,
      step,
      error: stableError(error),
    });
  }

  async #bootShutdown(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    capacityReservation: CapacityReservation,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    let handoff: ReadyDeviceHandoff;
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate({ operation: "boot" }, device.spec),
      });
      const ready = await this.options.lifecycle.bootForLease(device, claim);
      if (ready === undefined) throw new Error(`Boot target is no longer safe: ${device.id}`);
      handoff = ready;
    } catch (error: unknown) {
      this.#logFailure(
        "booting a shut-down device for a waiter failed",
        waiter,
        device,
        "boot",
        error,
      );
      let destroyed = true;
      try {
        destroyed =
          (await this.options.lifecycle.destroy(device, "lease-engine", "boot")) !== undefined;
      } catch (destroyError: unknown) {
        this.#logFailure(
          "destroying a device that failed to boot failed",
          waiter,
          device,
          "destroy",
          destroyError,
        );
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
    await this.#grantHandoff(waiter, handoff, capacityReservation);
  }

  #defer(waiter: AcquisitionWaiter): void {
    if (waiter.options.noWait) {
      this.#reject(waiter, new NoCapacityError(), "no-wait");
      return;
    }
    this.#enqueue(waiter);
    this.#notifyReclaimWait(waiter);
  }

  /**
   * A queued waiter whose spec matches a device already being reclaimed is waiting on that
   * reclaim, not on nothing in particular: an iOS erase holds the only matching device for
   * tens of seconds, and reporting only `queued` leaves the requester with a position and no
   * sense of how long. Purely informational -- the plan is untouched, and the device is
   * granted through the normal `ready` path when its reclaim commits. Nothing is reported
   * when no matching device is reclaiming, so this never invents a stage out of an idle wait.
   */
  #notifyReclaimWait(waiter: AcquisitionWaiter): void {
    const spec = waiter.spec;
    if (spec === undefined) return;
    const reclaiming = this.options.registry.snapshot.devices.some(
      (device) => device.state === "reclaiming" && sameSpec(device.spec, spec),
    );
    if (!reclaiming) return;
    this.options.queue.notifyProgress(waiter, {
      etaMs: releaseReclaimEstimateMs(this.options.drivers.get(spec.platform), spec),
      stage: "reclaiming",
    });
  }

  async #grantHandoff(
    waiter: AcquisitionWaiter,
    handoff: ReadyDeviceHandoff,
    capacityReservation?: CapacityReservation,
  ): Promise<void> {
    const granted = await this.options.decisions.run(async () => {
      try {
        if (waiter.state === "rejected") return false;
        await this.#grant(waiter, handoff.device.id);
        return true;
      } finally {
        capacityReservation?.release();
        handoff.claim.release();
      }
    });
    if (!granted) this.#wakeQueue();
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
      | "killed"
      | "cancelled",
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
      if (next !== undefined && next.state === "queued") this.#track(this.#drive(next));
    });
  }

  #track(workflow: Promise<void>): void {
    this.#activeWorkflows.add(workflow);
    void workflow.then(
      () => this.#activeWorkflows.delete(workflow),
      () => this.#activeWorkflows.delete(workflow),
    );
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions, id: string): AcquisitionWaiter {
    return Object.assign(this.options.queue.create(request, options, id), {
      failures: 0,
      timing: noTiming,
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function estimatedTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedProvisionMs = driver.estimate({ operation: "provision" }, spec);
  const estimatedBootMs = driver.estimate({ operation: "boot" }, spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedProvisionMs + estimatedBootMs,
  };
}

function estimatedBootTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedBootMs = driver.estimate({ operation: "boot" }, spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedBootMs,
  };
}

/** A device that is already ready costs nothing to hand over; only its reclaim lies ahead. */
function grantReadyTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  return {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: 0,
  };
}

/**
 * What this device's reclaim will cost once the lease is released -- the one part of a
 * grant's timing that describes work still ahead of the holder rather than work already
 * done. `standard` because that is what every release path asks for (`WarmPoolCoordinator
 * #reclaim`, `QuarantineCoordinator`); a holder cannot request a different clean level.
 */
function releaseReclaimEstimateMs(driver: Driver, spec: DeviceSpec): number {
  return driver.estimate({ clean: "standard", operation: "reclaim" }, spec);
}

function operationPlan(plan: AcquisitionPlan): OperationPlan | undefined {
  return plan.kind === "grant-ready" || plan.kind === "wait" || plan.kind === "no-capacity"
    ? undefined
    : plan;
}

/** The spec without a planned mode: the full spec of the same model and runtime. */
function fullSpec(spec: DeviceSpec): DeviceSpec {
  if (spec.mode === undefined) return spec;
  const { mode: _mode, ...full } = spec;
  return full;
}

type DownloadingProgress = Extract<LeaseProgress, { readonly stage: "downloading" }>;

/**
 * The installer's report in the requester's words. `waiting` is a request still behind another
 * install; `downloading` is its own install running, with the driver's percentage rounded down to
 * a whole number from 0 to 100. A percentage that is not a finite number is left out.
 */
function downloadingProgress(
  component: string,
  progress: ComponentInstallerProgress,
): DownloadingProgress {
  if (progress.stage === "waiting") return { component, stage: "downloading", waiting: true };
  const { percent } = progress;
  return percent === undefined || !Number.isFinite(percent)
    ? { component, stage: "downloading", waiting: false }
    : {
        component,
        percent: Math.min(100, Math.max(0, Math.floor(percent))),
        stage: "downloading",
        waiting: false,
      };
}

function sameDownloadingProgress(left: DownloadingProgress, right: DownloadingProgress): boolean {
  return (
    left.component === right.component &&
    left.waiting === right.waiting &&
    left.percent === right.percent
  );
}
