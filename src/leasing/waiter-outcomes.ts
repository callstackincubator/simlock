import { type DeviceRecord, sameSpec, stableError, toDriverDevice } from "../core/index.js";
import { type Logger } from "../ports/index.js";
import { NoCapacityError } from "./acquisition-errors.js";
import { type WaitingReason } from "./acquisition-planner.js";
import { type LeaseAcquisitionCoordinatorOptions } from "./acquisition-ports.js";
import { releaseReclaimEstimateMs } from "./acquisition-timing.js";
import {
  type AcquisitionWaiter,
  exceptOption,
  GRANT_SOURCE,
  type GrantingPlanKind,
} from "./acquisition-waiter.js";
import { emitLeaseRefusal } from "./lease-refusal.js";
import { lineOf } from "./wait-queue.js";

export type WaiterOutcomesOptions = Pick<
  LeaseAcquisitionCoordinatorOptions,
  "drivers" | "endLease" | "eventBus" | "leases" | "queue" | "registry"
> & { readonly log: Logger };

/** why: every way a waiter waits, is refused or is granted goes through one method here, so each emits its one event in one place. */
export class WaiterOutcomes {
  constructor(private readonly options: WaiterOutcomesOptions) {}

  // fallow-ignore-next-line unused-class-member -- AcquisitionWorkflow calls it through its options' outcomes.
  async grant(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    kind: GrantingPlanKind,
  ): Promise<void> {
    // Built before the write: the grant a repeat of this request answers is stored with the lease.
    const granted = await this.options.leases.grant({
      deviceId: device.id,
      environment: this.options.drivers
        .get(device.spec.platform)
        .leaseEnvironment(toDriverDevice(device)),
      ownerId: waiter.options.ownerId,
      requestId: waiter.id,
      requesterId: waiter.options.requesterId,
      source: GRANT_SOURCE[kind],
      timing: waiter.timing,
      ...(device.mode === "slim" ? exceptOption(waiter) : {}),
      ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
      ...(waiter.options.leaseId === undefined ? {} : { leaseId: waiter.options.leaseId }),
      ...(waiter.options.runId === undefined ? {} : { runId: waiter.options.runId }),
      ...(waiter.options.fleetRequestId === undefined
        ? {}
        : { fleetRequestId: waiter.options.fleetRequestId }),
    });
    this.options.queue.resolve(waiter, granted);
    if (waiter.releaseAtGrant === true) {
      // why: this runs inside the decision section the release also needs, so it follows once that section is free.
      void this.options.endLease(granted.lease.id).catch((error: unknown) => {
        this.options.log.warn("ending a lease a run release marked failed", {
          leaseId: granted.lease.id,
          error: stableError(error),
        });
      });
    }
  }

  /** One `warn` line for a device step that failed in the background and is handled here by
   * deferring the waiter or destroying the device. The waiter only ever sees a generic outcome. */
  // fallow-ignore-next-line unused-class-member -- AcquisitionWorkflow calls it through its options' outcomes.
  logFailure(
    message: string,
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    step: string,
    error: unknown,
  ): void {
    this.options.log.warn(message, {
      deviceId: device.id,
      requesterId: waiter.options.requesterId,
      step,
      error: stableError(error),
    });
  }

  // fallow-ignore-next-line unused-class-member -- AcquisitionWorkflow calls it through its options' outcomes.
  defer(waiter: AcquisitionWaiter, reason: WaitingReason): void {
    if (waiter.options.noWait) {
      this.reject(waiter, new NoCapacityError(reason), "no-wait");
      return;
    }
    this.enqueue(waiter, reason);
    this.notifyReclaimWait(waiter);
  }

  /**
   * A queued waiter whose spec matches a device already being reclaimed is waiting on that
   * reclaim, not on nothing in particular: an iOS erase holds the only matching device for
   * tens of seconds, and reporting only `queued` leaves the requester with a position and no
   * sense of how long. Purely informational -- the plan is untouched. When the reclaim
   * commits, the waiter is planned again like any other: an Android device comes back
   * `ready` and is granted at once, an iOS one comes back `shutdown` and is granted
   * through a `boot-shutdown` plan, a full boot after the erase. Nothing is reported
   * when no matching device is reclaiming, so this never invents a stage out of an idle wait.
   */
  notifyReclaimWait(waiter: AcquisitionWaiter): void {
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

  enqueue(waiter: AcquisitionWaiter, reason: WaitingReason): void {
    const alreadyQueued = this.options.queue.isQueued(waiter);
    if (this.options.queue.enqueue(waiter, reason) && !alreadyQueued) {
      this.options.eventBus.emit(
        "lease.queued",
        {
          queuePosition:
            lineOf(waiter.request) === "physical"
              ? this.options.queue.physicalDepth
              : this.options.queue.depth,
          requestId: waiter.id,
        },
        "lease-acquisition-coordinator",
      );
    }
  }

  reject(
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
      emitLeaseRefusal(
        this.options.eventBus,
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason,
          fleetRequestId: waiter.options.fleetRequestId,
        },
        "lease-acquisition-coordinator",
      );
    }
  }
}
