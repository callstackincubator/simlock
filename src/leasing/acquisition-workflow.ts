import {
  BootTimeoutError,
  type CapacityReservation,
  ComponentBeingRemovedError,
  type DeviceOperationClaim,
  exactRequirement,
  fitsPhysical,
  type PhysicalDevice,
  type PhysicalRequest,
  readPhysicalPresence,
  type ReadyDeviceHandoff,
  UnknownBaselineError,
  type VirtualDevice,
} from "../core/index.js";
import { type Logger } from "../ports/index.js";
import { type AcquisitionAdmission } from "./acquisition-admission.js";
import {
  DaemonUpdatingError,
  NukeCancelledError,
  PhysicalUnknownModelError,
  ProvisionFailedError,
} from "./acquisition-errors.js";
import { type AcquisitionGates } from "./acquisition-gates.js";
import {
  type AcquisitionPlan,
  type PhysicalPlanInput,
  type WaitingReason,
} from "./acquisition-planner.js";
import { type LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";
import { physicalRequestOf } from "./acquisition-requests.js";
import { baselineSpec } from "./acquisition-spec-resolver.js";
import { estimatedBootTiming, estimatedTiming, grantReadyTiming } from "./acquisition-timing.js";
import {
  type AcquisitionWaiter,
  blockedReason,
  exceptOption,
  type GrantingPlanKind,
  type OperationPlan,
  operationPlan,
  rebootsBeforeGrant,
  releasePlanResources,
} from "./acquisition-waiter.js";
import { lineOf } from "./wait-queue.js";
import { type WaiterOutcomes } from "./waiter-outcomes.js";

export type AcquisitionWorkflowOptions = Pick<
  LeaseAcquisitionCoordinatorOptions,
  | "baselines"
  | "claims"
  | "decisions"
  | "drivers"
  | "lifecycle"
  | "planner"
  | "provisioner"
  | "queue"
  | "quarantine"
  | "registry"
> & {
  readonly admission: AcquisitionAdmission;
  readonly gates: AcquisitionGates;
  readonly log: Logger;
  readonly outcomes: WaiterOutcomes;
};

/** why: the lease workflows that drive a waiter from plan to grant, one claimed device step at a time; they reach the outcomes, gates and admission through the options, and own only the in-flight sets. */
export class AcquisitionWorkflow {
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #driving = new WeakSet<AcquisitionWaiter>();
  readonly #planAgain = new WeakSet<AcquisitionWaiter>();

  constructor(private readonly options: AcquisitionWorkflowOptions) {}

  async waitForWorkflows(): Promise<void> {
    while (this.#activeWorkflows.size > 0) {
      await Promise.allSettled(this.#activeWorkflows);
    }
  }

  // why: every waiter passes `#nextPlan` before a provision starts, in whatever state `markNew` or `#defer` left it, so the update hold refuses here (#825 Decisions).
  refuseUnderHold(waiter: AcquisitionWaiter): boolean {
    if (!this.options.gates.updateHold) return false;
    if (this.options.queue.reject(waiter, new DaemonUpdatingError())) {
      this.options.admission.refuseForUpdate(waiter.id, waiter.request, waiter.options);
    }
    return true;
  }

  async drive(waiter: AcquisitionWaiter): Promise<void> {
    if (this.#driving.has(waiter)) return;
    this.#driving.add(waiter);
    try {
      if (waiter.request.physical === true) {
        await this.drivePhysical(waiter);
        return;
      }
      const action = await this.options.decisions.run(async () => this.decide(waiter));
      await this.perform(waiter, action);
    } finally {
      this.#driving.delete(waiter);
      // why: the wake inside the drive that discarded a superseded copy found the waiter still driving, so nothing else would plan it again.
      if (this.#planAgain.delete(waiter)) this.wakeQueue();
    }
  }

  async drivePhysical(waiter: AcquisitionWaiter): Promise<void> {
    const absent = new Set<string>();
    for (;;) {
      const plan = await this.options.decisions.run(async () =>
        this.decidePhysical(waiter, absent),
      );
      if (plan === undefined) return;
      if (!(await this.grantPhysical(waiter, plan, absent))) return;
    }
  }

  decidePhysical(
    waiter: AcquisitionWaiter,
    absent: ReadonlySet<string>,
  ): Extract<AcquisitionPlan, { readonly kind: "grant-physical" }> | undefined {
    const request = physicalRequestOf(waiter.request);
    const enrolled = this.options.registry.snapshot.devices;
    if (
      !enrolled.some(
        (device) => device.physical && device.state !== "deleted" && fitsPhysical(device, request),
      )
    ) {
      this.options.outcomes.reject(
        waiter,
        new PhysicalUnknownModelError(request),
        "unresolvable-spec",
      );
      return undefined;
    }
    const plan = this.options.planner.planPhysical({
      absent,
      heldByOlder: this.heldByOlder(waiter),
      noWait: waiter.options.noWait ?? false,
      owner: waiter.id,
      request,
      snapshot: this.options.registry.snapshot,
    });
    if (plan.kind !== "grant-physical") {
      this.options.outcomes.defer(waiter, blockedReason(plan));
      return undefined;
    }
    if (!this.options.queue.markProcessing(waiter)) {
      plan.claim.release();
      return undefined;
    }
    return plan;
  }

  heldByOlder(waiter: AcquisitionWaiter): PhysicalPlanInput["heldByOlder"] {
    const older: PhysicalRequest[] = [];
    for (const other of this.options.queue.pending()) {
      if (other === waiter) break;
      if (lineOf(other.request) === "physical" && other.state === "queued") {
        older.push(physicalRequestOf(other.request));
      }
    }
    return (device: PhysicalDevice) => older.some((request) => fitsPhysical(device, request));
  }

  async grantPhysical(
    waiter: AcquisitionWaiter,
    plan: Extract<AcquisitionPlan, { readonly kind: "grant-physical" }>,
    absent: Set<string>,
  ): Promise<boolean> {
    const { claim, device } = plan;
    let present = false;
    try {
      const reads = await readPhysicalPresence(this.options.drivers.get(device.spec.platform), [
        device,
      ]);
      present = reads.get(device.driverDeviceId) === true;
    } catch (error: unknown) {
      this.options.outcomes.logFailure(
        "reading a physical device's presence failed",
        waiter,
        device,
        "presence",
        error,
      );
    }
    let replan = false;
    await this.options.decisions.run(async () => {
      try {
        if (!this.options.queue.markProcessing(waiter)) return;
        const current = this.options.registry.snapshot.devices.find(
          (candidate) => candidate.id === device.id,
        );
        if (!present || !this.options.claims.isActive(claim) || current?.state !== "ready") {
          absent.add(device.id);
          replan = true;
          return;
        }
        await this.options.outcomes.grant(waiter, current, plan.kind);
      } catch (error: unknown) {
        this.options.outcomes.logFailure(
          "granting a physical device failed",
          waiter,
          device,
          "grant",
          error,
        );
        this.options.outcomes.defer(waiter, "no-free-physical");
      } finally {
        claim.release();
      }
    });
    if (!replan) this.wakeQueue();
    return replan;
  }

  async perform(waiter: AcquisitionWaiter, action: OperationPlan | undefined): Promise<void> {
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
      waiter.timing = await estimatedBootTiming(
        this.options.drivers.get(action.device.spec.platform),
        action.device,
      );
      await this.bootShutdown(waiter, action.device, action.capacityReservation, action.claim);
      return;
    }
    if (action.kind === "reboot-ready") {
      waiter.timing = await estimatedBootTiming(
        this.options.drivers.get(action.device.spec.platform),
        action.device,
      );
      await this.rebootReady(waiter, action.device, action.claim);
      return;
    }
    if (action.kind === "evict-running") {
      await this.evictRunning(waiter, action.device, action.claim, action.reason);
      return;
    }
    await this.evictManaged(waiter, action.device, action.claim, action.reason);
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
        claim: { kind: "boot", owner: waiter.id },
        ...exceptOption(waiter),
        onProgress: (progress) => this.options.queue.notifyProgress(waiter, progress),
        reservation,
      });
    } catch (error: unknown) {
      if (error instanceof BootTimeoutError && exceptOption(waiter).except === undefined) {
        await this.options.decisions.run(async () => {
          if (waiter.state !== "rejected")
            this.options.outcomes.reject(waiter, error, "boot-timeout");
        });
        this.wakeQueue();
        return;
      }
      // why: a component being removed (ADR 0010 §8) or a baseline removed since the request resolved it will not come back, so no device is created and the request ends as `RUNTIME_MISSING` or `UNKNOWN_BASELINE` rather than retrying.
      if (error instanceof ComponentBeingRemovedError || error instanceof UnknownBaselineError) {
        await this.options.decisions.run(async () => {
          if (waiter.state !== "rejected")
            this.options.outcomes.reject(waiter, error, "unresolvable-spec");
        });
        this.wakeQueue();
        return;
      }
      await this.countFailure(waiter, error);
      return;
    }
    await this.grantHandoff(waiter, handoff, "provision");
  }

  async decide(waiter: AcquisitionWaiter): Promise<OperationPlan | undefined> {
    if (this.options.gates.admissionClosed && waiter.state !== "rejected") {
      this.options.outcomes.reject(waiter, new NukeCancelledError(), "killed");
      return undefined;
    }
    if (this.options.gates.stopPlanning) return undefined;
    const plan = this.nextPlan(waiter);
    if (plan === undefined) return undefined;
    if (plan.kind === "grant-ready") return this.decideGrantReady(waiter, plan);
    const operation = operationPlan(plan);
    if (operation === undefined) {
      this.options.outcomes.defer(waiter, blockedReason(plan));
      return undefined;
    }
    // why: a refusal means the queue has just rejected this waiter at its deadline, so the device
    // work this plan stands for would run for a requester who was already answered. The plan holds
    // a capacity reservation or a device claim, so it gives those back here rather than at a
    // performer that will never be reached.
    if (!this.options.queue.markProcessing(waiter)) {
      releasePlanResources(operation);
      return undefined;
    }
    return operation;
  }

  async decideGrantReady(
    waiter: AcquisitionWaiter,
    plan: Extract<AcquisitionPlan, { kind: "grant-ready" }>,
  ): Promise<undefined> {
    waiter.timing = grantReadyTiming(
      this.options.drivers.get(plan.device.spec.platform),
      plan.device.spec,
    );
    // why: the queue's own rule is that a timeout firing mid-attempt does not reject
    // (`wait-queue.ts`), and it tells an attempt is in flight only from `processing`. Without
    // this mark the waiter is still `queued` while the lease is written, so a timeout that
    // falls due in that window rejects the caller over a lease that is being stored.
    if (!this.options.queue.markProcessing(waiter)) return undefined;
    try {
      await this.options.outcomes.grant(waiter, plan.device, plan.kind);
      // why: the next request in line may already have a ready device waiting for it, and no
      // other event will wake it.
      this.wakeQueue();
    } catch (error: unknown) {
      this.options.outcomes.logFailure(
        "granting a ready device failed",
        waiter,
        plan.device,
        "grant",
        error,
      );
      this.options.outcomes.defer(waiter, "waiting-for-device");
    }
    return undefined;
  }

  nextPlan(waiter: AcquisitionWaiter): AcquisitionPlan | undefined {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }

    if (this.refuseUnderHold(waiter)) return undefined;
    this.followBaseline(waiter);
    const head = this.options.queue.head;
    if (head !== undefined && head !== waiter) {
      const reason = "behind-earlier-request";
      return waiter.options.noWait ? { kind: "no-capacity", reason } : { kind: "wait", reason };
    }
    return this.options.planner.plan({
      noWait: waiter.options.noWait ?? false,
      owner: waiter.id,
      snapshot: this.options.registry.snapshot,
      spec: waiter.spec,
      requirement: waiter.requirement,
      classOf: waiter.classOf,
      rebootReady: rebootsBeforeGrant(waiter, this.options.drivers.get(waiter.spec.platform)),
    });
  }

  /** why: a save between two decisions makes the baseline's newest version the one a waiting request gets (ADR 0061 §5), so each decision plans against the version current at that moment. */
  followBaseline(waiter: AcquisitionWaiter): void {
    const named = waiter.spec?.baseline;
    if (named === undefined) return;
    const current = this.options.baselines.current(named.name);
    if (current === undefined || current.version === named.version) return;
    waiter.spec = baselineSpec(current);
    waiter.requirement = exactRequirement(waiter.spec);
  }

  async evictRunning(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    claim: DeviceOperationClaim,
    reason: WaitingReason,
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
      this.options.outcomes.logFailure(
        "shutting down an eviction target failed",
        waiter,
        device,
        "shutdown",
        error,
      );
      await this.options.decisions.run(async () => {
        claim.release();
        this.options.outcomes.defer(waiter, reason);
      });
      return;
    }
    await this.continueAfterEviction(waiter, claim);
  }

  async evictManaged(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    claim: DeviceOperationClaim,
    reason: WaitingReason,
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
      this.options.outcomes.logFailure(
        "deleting an eviction target failed",
        waiter,
        device,
        "delete",
        error,
      );
      await this.options.decisions.run(async () => {
        claim.release();
        this.options.outcomes.defer(waiter, reason);
      });
      return;
    }
    await this.continueAfterEviction(waiter, claim);
  }

  async continueAfterEviction(
    waiter: AcquisitionWaiter,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const next = await this.options.decisions.run(async () => {
      claim.release();
      this.options.queue.markNew(waiter);
      return this.decide(waiter);
    });
    await this.perform(waiter, next);
  }

  async rebootReady(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    let handoff: ReadyDeviceHandoff;
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: waiter.timing.estimatedBootMs,
      });
      const except = exceptOption(waiter).except ?? [];
      const ready = await this.options.lifecycle.rebootForLease(device, claim, except);
      if (ready === undefined) throw new Error(`Reboot target is no longer safe: ${device.id}`);
      handoff = ready;
    } catch (error: unknown) {
      this.options.outcomes.logFailure(
        "rebooting a warm device for a waiter failed",
        waiter,
        device,
        "reboot",
        error,
      );
      await this.destroyFailedBoot(waiter, device, "shutdown");
      await this.countFailure(waiter, error);
      return;
    }
    await this.grantHandoff(waiter, handoff, "reboot-ready");
  }

  /** why: a device that failed to boot is destroyed, or quarantined when the destroy fails too, before the waiter's slot is freed (see below). */
  async destroyFailedBoot(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    state: VirtualDevice["state"],
  ): Promise<void> {
    let destroyed = true;
    try {
      await this.options.lifecycle.destroy(device, "lease-engine", "cleanup");
    } catch (destroyError: unknown) {
      this.options.outcomes.logFailure(
        "destroying a device that failed to boot failed",
        waiter,
        device,
        "destroy",
        destroyError,
      );
      destroyed = false;
    }
    // why: a device the destroy could not retire may still be running, so it is handed to
    // quarantine before the waiter's reservation is freed: `quarantined` is the one state that
    // retries it, keeps it out of every plan and still counts it as running. Freeing the slot
    // first would leave a window where the next planner boots a device that may be running.
    if (!destroyed) {
      try {
        const quarantined = await this.options.quarantine.enterFromStalledTransition(
          device.id,
          state,
        );
        if (!quarantined) {
          this.options.log.warn(
            "a device that failed to be destroyed was not quarantined: something else owns it now",
            { deviceId: device.id, requesterId: waiter.options.requesterId, step: "quarantine" },
          );
        }
      } catch (quarantineError: unknown) {
        this.options.outcomes.logFailure(
          "quarantining a device that failed to boot and to be destroyed failed",
          waiter,
          device,
          "quarantine",
          quarantineError,
        );
      }
    }
  }

  /**
   * why: a failed boot of an except lease counts like a failed provision (ADR 0066 §3): the first
   * plans again, the second rejects `PROVISION_FAILED`, one count for provision, boot and reboot.
   */
  async countFailure(waiter: AcquisitionWaiter, error: unknown): Promise<void> {
    const retry = await this.options.decisions.run(async () => {
      if (waiter.state === "rejected") return false;
      waiter.failures += 1;
      if (waiter.failures === 1) {
        this.options.queue.markNew(waiter);
        return true;
      }
      // why: ADR 0021 §1 declines a probe instead of rejecting it, and its caller (the gateway) reads the code.
      this.options.outcomes.reject(
        waiter,
        new ProvisionFailedError(error),
        waiter.options.fleetRequestId === undefined ? "unresolvable-spec" : "no-wait",
      );
      return false;
    });
    if (retry) {
      this.#driving.delete(waiter);
      await this.drive(waiter);
    } else {
      this.wakeQueue();
    }
  }

  async bootShutdown(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    capacityReservation: CapacityReservation,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    let handoff: ReadyDeviceHandoff;
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: waiter.timing.estimatedBootMs,
      });
      const ready = await this.options.lifecycle.bootForLease(
        device,
        claim,
        exceptOption(waiter).except,
      );
      if (ready === undefined) throw new Error(`Boot target is no longer safe: ${device.id}`);
      handoff = ready;
    } catch (error: unknown) {
      this.options.outcomes.logFailure(
        "booting a shut-down device for a waiter failed",
        waiter,
        device,
        "boot",
        error,
      );
      await this.destroyFailedBoot(waiter, device, device.state);
      if (exceptOption(waiter).except !== undefined) {
        await this.options.decisions.run(() => capacityReservation.release());
        await this.countFailure(waiter, error);
        return;
      }
      await this.options.decisions.run(async () => {
        capacityReservation.release();
        if (waiter.state !== "rejected") {
          this.options.outcomes.reject(
            waiter,
            BootTimeoutError.from(device.id, error),
            "boot-timeout",
          );
        }
      });
      this.wakeQueue();
      return;
    }
    await this.grantHandoff(waiter, handoff, "boot-shutdown", capacityReservation);
  }

  /**
   * Wakes the queue after a grant as well as after a waiter that was rejected meanwhile: a
   * request that planned while this device was still being readied may have queued only
   * because this waiter held the head of the queue or because the capacity reservation
   * released here still counted.
   */
  async grantHandoff(
    waiter: AcquisitionWaiter,
    handoff: ReadyDeviceHandoff,
    kind: GrantingPlanKind,
    capacityReservation?: CapacityReservation,
  ): Promise<void> {
    let superseded = false;
    await this.options.decisions.run(async () => {
      try {
        if (waiter.state === "rejected") return;
        if (this.isSuperseded(handoff.device)) {
          superseded = true;
          return;
        }
        await this.options.outcomes.grant(waiter, handoff.device, kind);
      } catch (error: unknown) {
        // why: a grant that failed to store leaves no lease behind (`#commit` mutates memory
        // only after the file write), so the waiter is re-queued for a fresh grant like every
        // sibling step; without this catch the error dies in `#track` and the waiter is never
        // planned again -- no timer, no wake, and its request stays open for the process.
        this.options.outcomes.logFailure(
          kind === "provision"
            ? "granting a provisioned device failed"
            : "granting a booted device failed",
          waiter,
          handoff.device,
          "grant",
          error,
        );
        this.options.outcomes.defer(waiter, "waiting-for-device");
      } finally {
        capacityReservation?.release();
        handoff.claim.release();
      }
    });
    if (superseded) await this.discardSuperseded(waiter, handoff);
    this.wakeQueue();
  }

  /** why: a copy of a version that a save replaced while it was being made is never granted. */
  isSuperseded(device: VirtualDevice): boolean {
    const made = device.spec.baseline;
    if (made === undefined) return false;
    return this.options.baselines.current(made.name)?.version !== made.version;
  }

  /** why: the superseded copy is deleted outside the gate, and its waiter plans again against the newest version. */
  async discardSuperseded(waiter: AcquisitionWaiter, handoff: ReadyDeviceHandoff): Promise<void> {
    try {
      await this.options.lifecycle.dispose(handoff.device, "baseline-replaced", "cleanup");
    } catch (error: unknown) {
      this.options.outcomes.logFailure(
        "deleting a copy of a replaced baseline failed",
        waiter,
        handoff.device,
        "delete",
        error,
      );
    }
    await this.options.decisions.run(() =>
      this.options.outcomes.defer(waiter, "waiting-for-device"),
    );
    this.#planAgain.add(waiter);
  }

  wakeQueue(): void {
    void this.options.decisions.run(async () => {
      const next = this.options.queue.head as AcquisitionWaiter | undefined;
      if (next !== undefined && next.state === "queued") this.track(this.drive(next));
      for (const waiter of this.options.queue.pending() as readonly AcquisitionWaiter[]) {
        if (lineOf(waiter.request) === "physical") {
          this.track(this.drive(waiter));
        }
      }
    });
  }

  track(workflow: Promise<void>): void {
    this.#activeWorkflows.add(workflow);
    void workflow.then(
      () => this.#activeWorkflows.delete(workflow),
      () => this.#activeWorkflows.delete(workflow),
    );
  }
}
