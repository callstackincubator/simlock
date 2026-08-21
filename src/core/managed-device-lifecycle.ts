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

  /** Shuts down a ready device when needed, then destroys it under one claim. */
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
      { address: ready.address, driverData: ready.driverData },
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
        { address: ready.address, driverData: ready.driverData },
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
