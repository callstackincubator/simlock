import type { Clock } from "../ports/index.js";
import { DeviceOperationClaims, type DeviceOperation } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceState, LeaseRecord } from "./domain.js";
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
  ): Promise<DeviceRecord>;
}

interface ClaimedDevice {
  readonly device: DeviceRecord;
  readonly release: () => void;
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

  // fallow-ignore-next-line unused-class-member -- wired into LeaseEngine in the follow-up integration.
  async boot(target: DeviceRecord): Promise<DeviceRecord | undefined> {
    return this.#makeReady(target, "shutdown");
  }

  async readyProvisioned(target: DeviceRecord): Promise<DeviceRecord | undefined> {
    return this.#makeReady(target, "provisioning");
  }

  // fallow-ignore-next-line unused-class-member -- wired into cleanup and eviction in the follow-up integration.
  async shutdown(
    target: DeviceRecord,
    initiator: string,
    operation: Exclude<DeviceOperation, "boot">,
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, ["ready"], operation);
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
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, ["provisioning", "shutdown"], operation);
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

  async #makeReady(
    target: DeviceRecord,
    expectedState: "provisioning" | "shutdown",
  ): Promise<DeviceRecord | undefined> {
    const claimed = await this.#claim(target, [expectedState], "boot");
    if (claimed === undefined) return undefined;
    const startedAt = this.clock.now();

    try {
      await this.catalog
        .get(claimed.device.spec.platform)
        .makeReady(toDriverDevice(claimed.device));
    } catch (error: unknown) {
      await this.#release(claimed);
      throw error;
    }

    return this.#commit(claimed, [expectedState], "ready", {
      event: "device.ready",
      payload: { bootDuration: this.clock.now() - startedAt, deviceId: claimed.device.id },
    });
  }

  async #claim(
    target: DeviceRecord,
    expectedStates: readonly DeviceState[],
    operation: DeviceOperation,
  ): Promise<ClaimedDevice | undefined> {
    return this.decisions.run(() => {
      const device = this.#registeredTarget(target, expectedStates);
      if (device === undefined) return undefined;
      const claim = this.claims.tryClaim(device.id, operation);
      return claim === undefined ? undefined : { device, release: claim.release };
    });
  }

  async #commit(
    claimed: ClaimedDevice,
    expectedStates: readonly DeviceState[],
    to: DeviceState,
    event: Parameters<ManagedDeviceRegistry["transitionDevice"]>[2],
  ): Promise<DeviceRecord | undefined> {
    return this.decisions.run(async () => {
      try {
        const device = this.#registeredTarget(claimed.device, expectedStates);
        if (device === undefined) return undefined;
        return await this.registry.transitionDevice(device.id, to, event);
      } finally {
        claimed.release();
      }
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

function toDriverDevice(device: DeviceRecord): DriverDevice {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}
