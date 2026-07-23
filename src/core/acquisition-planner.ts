import type { CapacityReservation, CapacityCoordinator } from "./capacity-coordinator.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord, Platform } from "./domain.js";
import { selectManagedVictim, selectWarmVictim, type WarmVictimScope } from "./warm-pool.js";

export interface AcquisitionPlannerSnapshot {
  readonly devices: readonly DeviceRecord[];
  readonly leases: readonly LeaseRecord[];
}

export interface AcquisitionPlannerInput {
  readonly failures: number;
  readonly noWait: boolean;
  readonly snapshot: AcquisitionPlannerSnapshot;
  readonly spec: DeviceSpec;
}

export type AcquisitionPlan =
  | { readonly kind: "grant-ready"; readonly device: DeviceRecord }
  | {
      readonly kind: "boot-shutdown";
      readonly capacityReservation: CapacityReservation;
      readonly claim: DeviceOperationClaim;
      readonly device: DeviceRecord;
    }
  | { readonly kind: "provision"; readonly reservation: CapacityReservation }
  | {
      readonly kind: "evict-running";
      readonly claim: DeviceOperationClaim;
      readonly device: DeviceRecord;
    }
  | {
      readonly kind: "evict-managed";
      readonly claim: DeviceOperationClaim;
      readonly device: DeviceRecord;
    }
  | { readonly kind: "wait" }
  | { readonly kind: "no-capacity" };

/**
 * Read-only acquisition policy with short-lived, explicit capacity and device
 * operation reservations. The caller performs every resulting side effect.
 */
export class AcquisitionPlanner {
  constructor(
    private readonly capacity: CapacityCoordinator,
    private readonly claims: DeviceOperationClaims,
  ) {}

  plan(input: AcquisitionPlannerInput): AcquisitionPlan {
    const { snapshot, spec } = input;
    const ready = snapshot.devices.find(
      (device) =>
        device.state === "ready" &&
        !this.claims.isClaimed(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (ready !== undefined) return { device: ready, kind: "grant-ready" };

    const shutdown = snapshot.devices.find(
      (device) =>
        device.state === "shutdown" &&
        !this.claims.isClaimed(device.id) &&
        sameSpec(device.spec, spec),
    );
    if (shutdown !== undefined) return this.#planShutdownBoot(input, shutdown);

    return this.#planProvision(input);
  }

  #planShutdownBoot(input: AcquisitionPlannerInput, device: DeviceRecord): AcquisitionPlan {
    const running = this.capacity.tryReserveRunning(
      input.spec.platform,
      capacityDevices(input.snapshot),
    );
    if (!running.ok) {
      const victim = this.#runningVictim(input.snapshot, running.reason, input.spec.platform);
      return victim === undefined
        ? blocked(input.noWait)
        : this.#claimEviction(victim, input.noWait);
    }

    const claim = this.claims.tryClaim(device.id, "boot");
    if (claim === undefined) {
      running.reservation.release();
      return blocked(input.noWait);
    }
    return { capacityReservation: running.reservation, claim, device, kind: "boot-shutdown" };
  }

  #planProvision(input: AcquisitionPlannerInput): AcquisitionPlan {
    const reservation = this.capacity.tryReserveProvisioning(
      input.spec.platform,
      capacityDevices(input.snapshot),
    );
    if (reservation.ok) {
      if (input.failures < 2) return { kind: "provision", reservation: reservation.reservation };
      reservation.reservation.release();
      return blocked(input.noWait);
    }

    if (reservation.reason === "device-limit") {
      const victim = selectManagedVictim(
        this.#eligibleEvictionDevices(input.snapshot),
        input.spec.platform,
      );
      if (victim !== undefined) return this.#claimManagedEviction(victim, input.noWait);
    }

    const victim = this.#runningVictim(input.snapshot, reservation.reason, input.spec.platform);
    return victim === undefined ? blocked(input.noWait) : this.#claimEviction(victim, input.noWait);
  }

  #claimManagedEviction(device: DeviceRecord, noWait: boolean): AcquisitionPlan {
    const claim = this.claims.tryClaim(device.id, "eviction");
    return claim === undefined ? blocked(noWait) : { claim, device, kind: "evict-managed" };
  }

  #claimEviction(device: DeviceRecord, noWait: boolean): AcquisitionPlan {
    const claim = this.claims.tryClaim(device.id, "eviction");
    return claim === undefined ? blocked(noWait) : { claim, device, kind: "evict-running" };
  }

  #runningVictim(
    snapshot: AcquisitionPlannerSnapshot,
    reason: "device-limit" | "ram-budget" | "global-running-limit" | "platform-running-limit",
    platform: Platform,
  ): DeviceRecord | undefined {
    if (reason !== "global-running-limit" && reason !== "platform-running-limit") return undefined;
    const capacity = this.capacity.runningCapacity(capacityDevices(snapshot));
    const platformBlocked =
      capacity[platform].running + capacity[platform].reserved >= capacity[platform].maxRunning;
    const scope: WarmVictimScope = platformBlocked
      ? { kind: "platform", platform }
      : { kind: "global" };
    return selectWarmVictim(this.#eligibleEvictionDevices(snapshot), scope);
  }

  #eligibleEvictionDevices(snapshot: AcquisitionPlannerSnapshot): readonly DeviceRecord[] {
    const leased = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.devices.filter(
      (device) => !leased.has(device.id) && !this.claims.isClaimed(device.id),
    );
  }
}

function blocked(noWait: boolean): AcquisitionPlan {
  return noWait ? { kind: "no-capacity" } : { kind: "wait" };
}

function capacityDevices(snapshot: AcquisitionPlannerSnapshot) {
  return snapshot.devices.map((device) => ({
    platform: device.spec.platform,
    state: device.state,
  }));
}

function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion
  );
}
