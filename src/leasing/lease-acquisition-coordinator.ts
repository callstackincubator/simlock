import {
  type AcquisitionMaintenance,
  type DeviceMode,
  type DeviceRequest,
  type DeviceSpec,
  type Driver,
  exactRequirement,
  type LeaseGrant,
  newLeaseRequestId,
  type Platform,
  specMode,
  type TargetResolution,
  type WaitingDemand,
} from "../core/index.js";
import { type Logger, NoopLogger } from "../ports/index.js";
import { AcquisitionAdmission } from "./acquisition-admission.js";
import { asError, DaemonUpdatingError, NukeCancelledError } from "./acquisition-errors.js";
import { AcquisitionGates } from "./acquisition-gates.js";
import { type LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";
import { AcquisitionSpecResolver } from "./acquisition-spec-resolver.js";
import { type AcquisitionWaiter, noTiming } from "./acquisition-waiter.js";
import { AcquisitionWorkflow } from "./acquisition-workflow.js";
import { emitLeaseRefusal } from "./lease-refusal.js";
import { type LeaseRequestOptions, RequestCancelledError } from "./wait-queue.js";
import { WaiterOutcomes } from "./waiter-outcomes.js";

export type { LeaseRequestOptions } from "./wait-queue.js";
export {
  DaemonUpdatingError,
  NoCapacityError,
  ProvisionFailedError,
} from "./acquisition-errors.js";
export type { LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";

export class LeaseAcquisitionCoordinator implements AcquisitionMaintenance {
  readonly #logger: Logger;
  readonly #gates: AcquisitionGates;
  readonly #specs: AcquisitionSpecResolver;
  readonly #admission: AcquisitionAdmission;
  readonly #outcomes: WaiterOutcomes;
  readonly #workflow: AcquisitionWorkflow;

  constructor(private readonly options: LeaseAcquisitionCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-acquisition-coordinator") ?? new NoopLogger();
    this.#gates = new AcquisitionGates();
    this.#specs = new AcquisitionSpecResolver(options);
    this.#admission = new AcquisitionAdmission(options);
    this.#outcomes = new WaiterOutcomes({ ...options, log: this.#logger });
    this.#workflow = new AcquisitionWorkflow({
      ...options,
      admission: this.#admission,
      gates: this.#gates,
      log: this.#logger,
      outcomes: this.#outcomes,
    });
  }

  get queueDepth(): number {
    return this.options.queue.depth;
  }

  get physicalQueueDepth(): number {
    return this.options.queue.physicalDepth;
  }

  servesDefaultMode(spec: DeviceSpec): boolean {
    if (spec.physical) return false;
    return specMode(spec) === this.defaultMode(spec.platform);
  }

  defaultMode(platform: Platform): DeviceMode {
    return this.#specs.defaultMode(platform);
  }

  /**
   * Synchronous and not routed through `decisions.run`: `lease.cancel`'s `authorize` hook runs
   * before the handler, so it cannot go through the handler's serialized decision.
   */
  pendingRequestOwner(requesterId: string, platform?: Platform): string | undefined {
    return this.options.queue.findPendingWaiter(requesterId, platform)?.options.ownerId;
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
        const requestId = newLeaseRequestId(this.options.idGenerator);
        if (this.#gates.updateHold) {
          this.#admission.refuseForUpdate(requestId, request, options);
          throw new DaemonUpdatingError();
        }
        if (this.#gates.admissionClosed) {
          emitLeaseRefusal(
            this.options.eventBus,
            {
              requestId,
              requester: options.requesterId,
              requestSpec: request,
              reason: "killed",
              fleetRequestId: options.fleetRequestId,
            },
            "lease-acquisition-coordinator",
          );
          throw new NukeCancelledError();
        }
        this.#admission.refuseIfRequesterAtLimit(request, options, requestId);
        this.#admission.refuseIfLeaseIdTaken(request, options, requestId);
        this.#admission.refuseIfLeaseIdEnded(request, options, requestId);
        const { id, started: accepted } = await this.options.requests.admit(
          request,
          options,
          (id, onProgress) => this.#newWaiter(request, { ...options, onProgress }, id),
          requestId,
        );
        this.options.eventBus.emit(
          "lease.requested",
          {
            requestId: id,
            requestSpec: request,
            requester: options.requesterId,
            waitPolicy: options.noWait ? "no-wait" : "wait",
            ...(options.fleetRequestId === undefined
              ? {}
              : { fleetRequestId: options.fleetRequestId }),
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
    this.#workflow.track(this.#resolveAndDrive(waiter, request, options));
    return waiter.promise;
  }

  /** Closes acquisition admission, settles all demand, and drains driver work. */
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#gates.enterMaintenance();
      for (const waiter of this.options.queue.cancelAll(() => new NukeCancelledError())) {
        emitLeaseRefusal(
          this.options.eventBus,
          {
            requestId: waiter.id,
            requester: waiter.options.requesterId,
            requestSpec: waiter.request,
            reason: "killed",
            fleetRequestId: waiter.options.fleetRequestId,
          },
          "lease-acquisition-coordinator",
        );
      }
    });
    await this.#workflow.waitForWorkflows();
  }

  /**
   * why: a stop waits for every request mid-provision or mid-boot, so the driver it then disposes is not under a boot still running (#1200). It also stops planning for good, so a failed boot waking the queue does not start another device the stop would wait for; a queued request ends with the daemon.
   */
  async settleAcquisitions(): Promise<void> {
    this.#gates.stopPlanningForGood();
    await this.#workflow.waitForWorkflows();
  }

  async holdForUpdate(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#gates.holdForUpdate();
      // why: a request already provisioning is granted (#825 Decisions), so only the ones not yet provisioning, `new` (still resolving its spec) or queued, are refused.
      for (const waiter of this.options.queue.pending() as readonly AcquisitionWaiter[]) {
        if (waiter.state !== "queued" && waiter.state !== "new") continue;
        if (this.options.queue.reject(waiter, new DaemonUpdatingError())) {
          this.#admission.refuseForUpdate(waiter.id, waiter.request, waiter.options);
        }
      }
    });
  }

  async releaseUpdateHold(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#gates.releaseUpdateHold();
    });
  }

  /** Reopens acquisition admission after an administrative maintenance operation. */
  async endMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#gates.leaveMaintenance();
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
        this.#outcomes.reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }
    if (request.physical === true) {
      await this.#workflow.drive(waiter);
      return;
    }
    try {
      const resolved = await this.#specs.resolveSpec(driver, request, options, (progress) =>
        this.options.queue.notifyProgress(waiter, progress),
      );
      waiter.spec = resolved.spec;
      waiter.requirement = resolved.requirement;
      waiter.classOf = resolved.classOf;
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#outcomes.reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }

    await this.#workflow.drive(waiter);
  }

  /**
   * why: a `new` or `queued` waiter is safe to reject: `new` is still resolving its spec, with no device
   * work, and `#nextPlan` skips a rejected waiter. `processing` means device work already claimed
   * it, which `cancelAll` owns tearing down. A physical waiter's only in-flight step is a presence
   * read, so it is cancellable in any live state.
   */
  async cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.options.decisions.run(async () => {
      const waiter = this.options.queue.findPendingWaiter(requesterId, platform) as
        | AcquisitionWaiter
        | undefined;
      if (waiter === undefined) return "not-found";
      if (waiter.state === "processing" && waiter.request.physical !== true) {
        return "not-cancellable";
      }
      const holdsClaim = waiter.state === "processing";
      this.#outcomes.reject(waiter, new RequestCancelledError(waiter.id), "cancelled");
      // why: a waiter mid presence read holds a grant claim, and its own wake follows the release.
      if (!holdsClaim) this.#workflow.wakeQueue();
      return "cancelled";
    });
  }

  waitingDemand(): readonly WaitingDemand[] {
    return (this.options.queue.pending() as readonly AcquisitionWaiter[]).flatMap((waiter) =>
      waiter.spec === undefined
        ? []
        : [
            {
              classOf: waiter.classOf ?? (() => undefined),
              inFlight: waiter.state === "processing",
              mode: specMode(waiter.spec),
              platform: waiter.spec.platform,
              requirement: waiter.requirement ?? exactRequirement(waiter.spec),
              spec: waiter.spec,
            },
          ],
    );
  }

  resolve(request: DeviceRequest): Promise<TargetResolution> {
    return this.#specs.resolve(request);
  }

  get maintenanceActive(): boolean {
    return this.#gates.admissionClosed;
  }

  kick(): void {
    this.#workflow.wakeQueue();
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions, id: string): AcquisitionWaiter {
    return Object.assign(this.options.queue.create(request, options, id), {
      failures: 0,
      timing: noTiming,
    });
  }
}
