import { type EventMap } from "../bus/index.js";
import {
  type DeviceClass,
  type DeviceRequirement,
  type Driver,
  type LeaseTiming,
  type VirtualSpec,
} from "../core/index.js";
import { type AcquisitionPlan, type WaitingReason } from "./acquisition-planner.js";
import { type Waiter } from "./wait-queue.js";

export interface AcquisitionWaiter extends Waiter {
  failures: number;
  classOf?: ((model: string) => DeviceClass | undefined) | undefined;
  requirement?: DeviceRequirement | undefined;
  spec?: VirtualSpec;
  /** why: a run release marked this booting request; the grant it gets is ended at once. */
  releaseAtGrant?: true;
  timing: LeaseTiming;
}

export type GrantingPlanKind =
  | "grant-ready"
  | "grant-physical"
  | "boot-shutdown"
  | "reboot-ready"
  | "provision";

export const GRANT_SOURCE: Readonly<Record<GrantingPlanKind, EventMap["lease.granted"]["source"]>> =
  {
    "boot-shutdown": "booted",
    "grant-physical": "warm",
    "grant-ready": "warm",
    provision: "provisioned",
    "reboot-ready": "booted",
  };

export type OperationPlan = Exclude<
  AcquisitionPlan,
  { readonly kind: "grant-ready" | "grant-physical" | "wait" | "no-capacity" }
>;

export const noTiming: LeaseTiming = {
  estimatedBootMs: 0,
  estimatedProvisionMs: 0,
  estimatedReclaimMs: 0,
  estimatedReadyMs: 0,
};

/** why: an `except` list, or a driver that must boot a ready device again before it can be granted, sends the device through the claimed reboot. */
export function rebootsBeforeGrant(waiter: AcquisitionWaiter, driver: Driver): boolean {
  return exceptOption(waiter).except !== undefined || driver.rebootReadyBeforeGrant === true;
}

/** why: a request's `except` reaches the driver and the device only when the resolved spec is slim; on a runtime that cannot be slimmed the lease is granted full with no `except` (ADR 0066 §1). */
export function exceptOption(waiter: AcquisitionWaiter): { readonly except?: readonly string[] } {
  const except = waiter.request.except;
  return except === undefined || waiter.spec?.mode !== "slim" ? {} : { except };
}

/** why: a request's label goes to the driver's boot only when it has one, so an unlabelled lease passes no key. */
export function labelOption(waiter: AcquisitionWaiter): { readonly label?: string } {
  const label = waiter.options.label;
  return label === undefined ? {} : { label };
}

/**
 * why: a plan handed out the capacity or device claim its operation needs; dropping the plan has
 * to give it back, or the resource stays held with nobody left to release it.
 */
export function releasePlanResources(plan: OperationPlan): void {
  if (plan.kind === "provision") plan.reservation.release();
  else if (plan.kind === "boot-shutdown") {
    plan.capacityReservation.release();
    plan.claim.release();
  } else plan.claim.release();
}

export function blockedReason(plan: AcquisitionPlan): WaitingReason {
  return "reason" in plan ? plan.reason : "no-free-physical";
}

export function operationPlan(plan: AcquisitionPlan): OperationPlan | undefined {
  return plan.kind === "grant-ready" ||
    plan.kind === "grant-physical" ||
    plan.kind === "wait" ||
    plan.kind === "no-capacity"
    ? undefined
    : plan;
}
