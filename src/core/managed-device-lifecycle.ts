import type { Clock } from "../ports/index.js";
import {
  DeviceOperationClaims,
  type DeviceOperation,
  type DeviceOperationClaim,
} from "./device-operation-claims.js";
import type { DeviceRecord, DeviceState, DeviceTransitionUpdate, LeaseRecord } from "./domain.js";
import type { DriverDevice } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { SerializedDecision } from "./serialized-decision.js";

export interface ManagedDeviceRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
  transitionDevice(
    deviceId: string,
    to: DeviceState,
    event?:
      | {
          readonly event: "device.ready";
          readonly payload: { readonly deviceId: string; readonly bootDuration: number };
        }
      | {
          readonly event: "device.shutdown";
          readonly payload: { readonly deviceId: string; readonly initiator: string };
        }
      | {
          readonly event: "device.deleted";
          readonly payload: { readonly deviceId: string; readonly initiator: string };
        },
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord>;
}

interface ClaimedDevice {
  readonly claim: DeviceOperationClaim;
  readonly device: DeviceRecord;
  readonly release: () => void;
}

/** An exclusively claimed ready device that must be leased or released. */
export interface ReadyDeviceHandoff {
  readonly claim: DeviceOperationClaim;
  readonly device: DeviceRecord;
}

/**
 * Performs registry-owned device operations. Driver calls are deliberately
 * outside the decision gate; each operation is claimed and revalidated first.
 */
export class ManagedDeviceLifecycle {
  constructor(
    private readonly catalog: DriverCatalog,
    private readonly registry: ManagedDeviceRegistry,
    private readonly decisions: SerializedDecision,
    private readonly claims: DeviceOperationClaims,
    private readonly clock: Clock,
  ) {}

  // fallow-ignore-next-line unused-class-member -- no production caller: superseded by bootForLease, still covered by its own tests.
  async boot(
    target: DeviceRecord,
    claim?: DeviceOperationClaim,
  ): Promise<DeviceRecord | undefined> {
    return this.#makeReady(target, "shutdown", claim);
  }

  async readyProvisioned(target: DeviceRecord): Promise<DeviceRecord | undefined> {
    return this.#makeReady(target, "provisioning");
  }

  /** Makes a device ready while retaining its claim for an immediate lease handoff. */
  // fallow-ignore-next-line unused-class-member -- reached through LeaseAcquisitionCoordinator's lifecycle port.
  async bootForLease(
    target: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<ReadyDeviceHandoff | undefined> {
    return this.#makeReadyForLease(target, "shutdown", claim);
  }

  /** Makes a provisioned device ready while retaining its claim for lease handoff. */
  async readyProvisionedForLease(target: DeviceRecord): Promise<ReadyDeviceHandoff | undefined> {
    return this.#makeReadyForLease(target, "provisioning");
  }

  // fallow-ignore-next-line unused-class-member -- reached through the lifecycle/devices ports by cleanup, acquisition and nuke.
  async shutdown(
    target: DeviceRecord,
    initiator: string,
    operation: Exclude<DeviceOperation, "boot">,
    claim?: DeviceOperationClaim,
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, ["ready"], operation, claim);
    if (claimed === undefined) return undefined;

    try {
      await this.catalog.get(claimed.device.spec.platform).shutdown(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    return this.#commit(claimed, ["ready"], "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: claimed.device.id, initiator },
    });
  }

  // fallow-ignore-next-line unused-class-member -- reached through the lifecycle/devices ports by provisioning, acquisition and nuke.
  async destroy(
    target: DeviceRecord,
    initiator: string,
    operation: DeviceOperation,
    claim?: DeviceOperationClaim,
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, ["provisioning", "shutdown"], operation, claim);
    if (claimed === undefined) return undefined;

    try {
      await this.catalog.get(claimed.device.spec.platform).destroy(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    return this.#commit(claimed, ["provisioning", "shutdown"], "deleted", {
      event: "device.deleted",
      payload: { deviceId: claimed.device.id, initiator },
    });
  }

  /**
   * Reboots a device that is currently leased and whose underlying process
   * died outside simlock, so the lease can continue on the same device. The
   * device stays `leased` throughout: this performs no registry transition
   * and emits no event, deliberately -- the caller (a `LeaseHealthMonitor`)
   * owns deciding what happened and telling the holder.
   */
  // fallow-ignore-next-line unused-class-member -- called through LeaseHealthMonitor's lifecycle port.
  async recoverLeased(target: DeviceRecord, leaseId: string): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claimLeased(target, leaseId);
    if (claimed === undefined) return undefined;

    try {
      // The address `makeReady` re-reads is deliberately dropped here, unlike every other
      // readiness transition (see `Driver.makeReady`): recovery keeps the device `leased`
      // throughout, so there is no transition to commit it through, and neither driver moves
      // a device's address when rebooting one that already exists -- iOS UDIDs are fixed, and
      // Android reuses the console port already in the device's driver data. A driver that
      // ever does move it would need this to persist the new value, because the holder is
      // still using the address from its original grant.
      await this.catalog
        .get(claimed.device.spec.platform)
        .makeReady(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    return this.decisions.run(() => {
      try {
        // The ~30s boot ran outside the gate; the holder may have released the
        // lease, or the TTL may have expired and moved the device on, while it
        // was in flight. Re-verify before handing the device back as recovered.
        return this.#leasedTarget(claimed.device, leaseId);
      } finally {
        claimed.release();
      }
    });
  }

  /** Shuts down a ready device when needed, then destroys it under one claim. */
  // fallow-ignore-next-line unused-class-member -- reached through LeaseAcquisitionCoordinator's lifecycle port when an unusable device must go.
  async dispose(
    target: DeviceRecord,
    initiator: string,
    operation: Exclude<DeviceOperation, "boot">,
    existingClaim?: DeviceOperationClaim,
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, ["ready", "shutdown"], operation, existingClaim);
    if (claimed === undefined) return undefined;

    try {
      let current = claimed.device;
      if (current.state === "ready") {
        await this.catalog.get(current.spec.platform).shutdown(toDriverDevice(current));
        const shutdown = await this.#commitWithoutRelease(claimed, ["ready"], "shutdown", {
          event: "device.shutdown",
          payload: { deviceId: current.id, initiator },
        });
        if (shutdown === undefined) {
          await this.#release(claimed);
          return undefined;
        }
        current = shutdown;
      }

      await this.catalog.get(current.spec.platform).destroy(toDriverDevice(current));
      return this.#commit(claimed, ["shutdown"], "deleted", {
        event: "device.deleted",
        payload: { deviceId: current.id, initiator },
      });
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }
  }

  async #makeReady(
    target: DeviceRecord,
    expectedState: "provisioning" | "shutdown",
    existingClaim?: DeviceOperationClaim,
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, [expectedState], "boot", existingClaim);
    if (claimed === undefined) return undefined;
    const startedAt = this.clock.now();

    let ready: DriverDevice;
    try {
      ready = await this.catalog
        .get(claimed.device.spec.platform)
        .makeReady(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    return this.#commit(
      claimed,
      [expectedState],
      "ready",
      {
        event: "device.ready",
        payload: { bootDuration: this.clock.now() - startedAt, deviceId: claimed.device.id },
      },
      {
        address: ready.address,
        driverData: ready.driverData,
        ...(ready.featureProfile === undefined ? {} : { featureProfile: ready.featureProfile }),
      },
    );
  }

  async #makeReadyForLease(
    target: DeviceRecord,
    expectedState: "provisioning" | "shutdown",
    existingClaim?: DeviceOperationClaim,
  ): Promise<ReadyDeviceHandoff | undefined> {
    const claimed = await this.#claim(target, [expectedState], "boot", existingClaim);
    if (claimed === undefined) return undefined;
    const startedAt = this.clock.now();
    let ready: DriverDevice;
    try {
      ready = await this.catalog
        .get(claimed.device.spec.platform)
        .makeReady(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    try {
      const device = await this.#commitWithoutRelease(
        claimed,
        [expectedState],
        "ready",
        {
          event: "device.ready",
          payload: { bootDuration: this.clock.now() - startedAt, deviceId: claimed.device.id },
        },
        {
          address: ready.address,
          driverData: ready.driverData,
          ...(ready.featureProfile === undefined ? {} : { featureProfile: ready.featureProfile }),
        },
      );
      if (device === undefined) {
        await this.#release(claimed);
        return undefined;
      }
      return { claim: claimed.claim, device };
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }
  }

  async #claim(
    target: DeviceRecord,
    expectedStates: readonly DeviceState[],
    operation: DeviceOperation,
    existingClaim?: DeviceOperationClaim,
  ): Promise<ClaimedDevice | undefined> {
    return this.decisions.run(() => {
      const device = this.#registeredTarget(target, expectedStates);
      if (device === undefined) return undefined;
      if (existingClaim !== undefined) {
        if (
          existingClaim.deviceId !== device.id ||
          existingClaim.operation !== operation ||
          !this.claims.isActive(existingClaim)
        ) {
          return undefined;
        }
        return { claim: existingClaim, device, release: existingClaim.release };
      }
      const claim = this.claims.tryClaim(device.id, operation);
      return claim === undefined ? undefined : { claim, device, release: claim.release };
    });
  }

  async #claimLeased(target: DeviceRecord, leaseId: string): Promise<ClaimedDevice | undefined> {
    return this.decisions.run(() => {
      const device = this.#leasedTarget(target, leaseId);
      if (device === undefined) return undefined;
      const claim = this.claims.tryClaim(device.id, "recovery");
      return claim === undefined ? undefined : { claim, device, release: claim.release };
    });
  }

  async #commit(
    claimed: ClaimedDevice,
    expectedStates: readonly DeviceState[],
    to: DeviceState,
    event: Parameters<ManagedDeviceRegistry["transitionDevice"]>[2],
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord | undefined> {
    return this.decisions.run(async () => {
      try {
        const device = this.#registeredTarget(claimed.device, expectedStates);
        if (device === undefined) return undefined;
        return await this.registry.transitionDevice(device.id, to, event, update);
      } finally {
        claimed.release();
      }
    });
  }

  async #commitWithoutRelease(
    claimed: ClaimedDevice,
    expectedStates: readonly DeviceState[],
    to: DeviceState,
    event: Parameters<ManagedDeviceRegistry["transitionDevice"]>[2],
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord | undefined> {
    return this.decisions.run(async () => {
      const device = this.#registeredTarget(claimed.device, expectedStates);
      if (device === undefined) return undefined;
      return this.registry.transitionDevice(device.id, to, event, update);
    });
  }

  async #release(claimed: ClaimedDevice): Promise<void> {
    await this.decisions.run(() => claimed.release());
  }

  #registeredTarget(
    target: DeviceRecord,
    expectedStates: readonly DeviceState[],
  ): DeviceRecord | undefined {
    const device = this.registry.snapshot.devices.find((candidate) => candidate.id === target.id);
    if (
      device === undefined ||
      device.driverDeviceId !== target.driverDeviceId ||
      !expectedStates.includes(device.state) ||
      this.registry.snapshot.leases.some((lease) => lease.deviceId === device.id)
    ) {
      return undefined;
    }
    return device;
  }

  /**
   * The single, deliberate exception to safety rule 2 ("never touch a leased
   * device"). This is `#registeredTarget` inverted, not removed or
   * parameterised away: normal operations require no lease on the device,
   * this requires a lease with exactly the given id. A lease-id mismatch --
   * someone else's lease, no lease at all, or the lease having moved on --
   * always returns undefined, which is what stops recovery from ever acting
   * on a device leased by someone else or on an unleased device.
   */
  #leasedTarget(target: DeviceRecord, leaseId: string): DeviceRecord | undefined {
    const device = this.registry.snapshot.devices.find((candidate) => candidate.id === target.id);
    if (device === undefined || device.driverDeviceId !== target.driverDeviceId) return undefined;
    if (device.state !== "leased") return undefined;

    const lease = this.registry.snapshot.leases.find((candidate) => candidate.id === leaseId);
    return lease === undefined || lease.deviceId !== device.id ? undefined : device;
  }
}

/**
 * `address` is never trusted by a driver's `shutdown` / `destroy` / `reclaim` / `makeReady` --
 * they derive whatever they need from `driverData` -- so a not-yet-booted device's absent
 * address is a harmless placeholder here, not a lie a driver could act on.
 */
function toDriverDevice(device: DeviceRecord): DriverDevice {
  return {
    address: device.address ?? "",
    deviceId: device.driverDeviceId,
    driverData: device.driverData,
  };
}
