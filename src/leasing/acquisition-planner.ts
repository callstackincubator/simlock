import {
  capacityDevice,
  capacityDevices,
  plannedCapacityDevice,
  type CapacityCoordinator,
  type CapacityReservation,
  type DeviceOperationClaim,
  type DeviceOperationClaims,
  type DeviceClass,
  type DeviceRecord,
  type DeviceRequirement,
  exactRequirement,
  fits,
  fitsPhysical,
  type LeaseRecord,
  mayBeGranted,
  type PhysicalDevice,
  type PhysicalRequest,
  type Platform,
  specMode,
  selectIdleRunningVictim,
  selectManagedVictim,
  type IdleVictimScope,
  type VirtualDevice,
  type VirtualSpec,
} from "../core/index.js";

export interface AcquisitionPlannerSnapshot {
  readonly devices: readonly DeviceRecord[];
  readonly virtualDevices: readonly VirtualDevice[];
  readonly leases: readonly LeaseRecord[];
}

export interface AcquisitionPlannerInput {
  readonly failures: number;
  readonly noWait: boolean;
  readonly owner?: string | undefined;
  readonly snapshot: AcquisitionPlannerSnapshot;
  readonly spec: VirtualSpec;
  readonly requirement?: DeviceRequirement | undefined;
  readonly classOf?: ((model: string) => DeviceClass | undefined) | undefined;
}

export interface PhysicalPlanInput {
  readonly request: PhysicalRequest;
  readonly noWait: boolean;
  readonly owner: string;
  readonly snapshot: AcquisitionPlannerSnapshot;
  readonly absent: ReadonlySet<string>;
  readonly heldByOlder: (device: PhysicalDevice) => boolean;
}

export type AcquisitionPlan =
  | { readonly kind: "grant-ready"; readonly device: DeviceRecord }
  | {
      readonly kind: "grant-physical";
      readonly claim: DeviceOperationClaim;
      readonly device: PhysicalDevice;
    }
  | {
      readonly kind: "boot-shutdown";
      readonly capacityReservation: CapacityReservation;
      readonly claim: DeviceOperationClaim;
      readonly device: VirtualDevice;
    }
  | { readonly kind: "provision"; readonly reservation: CapacityReservation }
  | {
      readonly kind: "evict-running";
      readonly claim: DeviceOperationClaim;
      readonly device: VirtualDevice;
    }
  | {
      readonly kind: "evict-managed";
      readonly claim: DeviceOperationClaim;
      readonly device: VirtualDevice;
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
    const requirement = input.requirement ?? exactRequirement(spec);
    const classOf = input.classOf ?? (() => undefined);
    // ADR 0015 §6: an idle device serves the request when it fits and is in the pool mode the
    // new device would have. Among several that do, the first in snapshot order is taken.
    const serves = (device: DeviceRecord): boolean =>
      mayBeGranted(device) &&
      specMode(device.spec) === specMode(spec) &&
      fits(requirement, device.spec, classOf);
    const servesRequest = (device: DeviceRecord): boolean =>
      !this.claims.isClaimed(device.id) && serves(device);
    const ready = snapshot.devices.find(
      (device) => device.state === "ready" && servesRequest(device),
    );
    if (ready !== undefined) return { device: ready, kind: "grant-ready" };

    // A device the warm pool is booting for nobody in particular will serve this
    // request when it is ready: waiting for it costs less than starting a second. A device
    // another request is booting or creating is its own, so it is left alone. Under `noWait`
    // the case is ignored and the request plans as it always did.
    if (
      !input.noWait &&
      snapshot.virtualDevices.some((device) => this.#isOnItsWay(device, serves))
    ) {
      return { kind: "wait" };
    }

    // A spent fresh device sits `shutdown` until its delete; `mayBeGranted` keeps it from being booted again.
    const shutdown = snapshot.virtualDevices.find(
      (device) => device.state === "shutdown" && servesRequest(device),
    );
    if (shutdown !== undefined) return this.#planShutdownBoot(input, shutdown);

    return this.#planProvision(input);
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseAcquisitionCoordinator's `AcquisitionPlannerPort`.
  planPhysical(input: PhysicalPlanInput): AcquisitionPlan {
    for (const device of input.snapshot.devices) {
      if (!device.physical || device.state !== "ready") continue;
      if (input.absent.has(device.id)) continue;
      if (!fitsPhysical(device, input.request) || input.heldByOlder(device)) continue;
      const claim = this.claims.tryClaim(device.id, "grant", input.owner);
      if (claim !== undefined) return { claim, device, kind: "grant-physical" };
    }
    return blocked(input.noWait);
  }

  #isOnItsWay(device: VirtualDevice, serves: (device: DeviceRecord) => boolean): boolean {
    if (device.state !== "provisioning" && device.state !== "shutdown") return false;
    const claim = this.claims.claim(device.id);
    return claim?.kind === "boot" && claim.owner === undefined && serves(device);
  }

  #planShutdownBoot(input: AcquisitionPlannerInput, device: VirtualDevice): AcquisitionPlan {
    // A boot refused for RAM evicts nothing: freeing a running slot frees no RAM.
    const running = this.capacity.tryReserveBoot(
      capacityDevice(device),
      capacityDevices(input.snapshot.virtualDevices),
    );
    if (!running.ok) {
      const victim = this.#runningVictim(input.snapshot, running.reason, input.spec.platform);
      return victim === undefined
        ? blocked(input.noWait)
        : this.#claimEviction(victim, input.noWait);
    }

    const claim = this.claims.tryClaim(device.id, "boot", input.owner);
    if (claim === undefined) {
      running.reservation.release();
      return blocked(input.noWait);
    }
    return { capacityReservation: running.reservation, claim, device, kind: "boot-shutdown" };
  }

  #planProvision(input: AcquisitionPlannerInput): AcquisitionPlan {
    const reservation = this.capacity.tryReserveProvisioning(
      plannedCapacityDevice(input.spec),
      capacityDevices(input.snapshot.virtualDevices),
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

  #claimManagedEviction(device: VirtualDevice, noWait: boolean): AcquisitionPlan {
    const claim = this.claims.tryClaim(device.id, "eviction");
    return claim === undefined ? blocked(noWait) : { claim, device, kind: "evict-managed" };
  }

  #claimEviction(device: VirtualDevice, noWait: boolean): AcquisitionPlan {
    const claim = this.claims.tryClaim(device.id, "eviction");
    return claim === undefined ? blocked(noWait) : { claim, device, kind: "evict-running" };
  }

  #runningVictim(
    snapshot: AcquisitionPlannerSnapshot,
    reason: "device-limit" | "ram-budget" | "global-running-limit" | "platform-running-limit",
    platform: Platform,
  ): VirtualDevice | undefined {
    if (reason !== "global-running-limit" && reason !== "platform-running-limit") return undefined;
    const capacity = this.capacity.runningCapacity(capacityDevices(snapshot.virtualDevices));
    const platformBlocked =
      capacity[platform].running + capacity[platform].reserved >= capacity[platform].maxRunning;
    const scope: IdleVictimScope = platformBlocked
      ? { kind: "platform", platform }
      : { kind: "global" };
    return selectIdleRunningVictim(this.#eligibleEvictionDevices(snapshot), scope);
  }

  #eligibleEvictionDevices(snapshot: AcquisitionPlannerSnapshot): readonly VirtualDevice[] {
    const leased = new Set(snapshot.leases.map((lease) => lease.deviceId));
    return snapshot.virtualDevices.filter(
      (device) => !leased.has(device.id) && !this.claims.isClaimed(device.id),
    );
  }
}

function blocked(noWait: boolean): AcquisitionPlan {
  return noWait ? { kind: "no-capacity" } : { kind: "wait" };
}
