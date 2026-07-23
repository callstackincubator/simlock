import type { Clock } from "../ports/index.js";
import type { CapacityReservation } from "./capacity-coordinator.js";
import type { DeviceRecord, DeviceSpec } from "./domain.js";
import { BootTimeoutError, type DriverDevice } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";
import type { LeaseProgress } from "./wait-queue.js";

export type ProvisionProgress = Extract<
  LeaseProgress,
  { readonly stage: "provisioning" | "booting" }
>;

export interface DeviceProvisionerRegistry {
  registerDevice(input: {
    readonly driverDeviceId: string;
    readonly spec: DeviceSpec;
    readonly driverData: unknown;
    readonly provisionDuration: number;
  }): Promise<DeviceRecord>;
}

export interface DeviceProvisionerOptions {
  readonly catalog: DriverCatalog;
  readonly clock: Clock;
  readonly decisions: SerializedDecision;
  readonly lifecycle: ManagedDeviceLifecycle;
  readonly registry: DeviceProvisionerRegistry;
}

export interface ProvisionDeviceOptions {
  readonly onProgress?: (progress: ProvisionProgress) => void;
  readonly reservation: CapacityReservation;
}

/** Provisions a new driver device, registers it, and makes it ready. */
export class DeviceProvisioner {
  constructor(private readonly options: DeviceProvisionerOptions) {}

  async provision(spec: DeviceSpec, options: ProvisionDeviceOptions): Promise<DeviceRecord> {
    const driver = this.options.catalog.get(spec.platform);
    const startedAt = this.options.clock.now();
    let driverDevice: DriverDevice;
    try {
      options.onProgress?.({ stage: "provisioning", etaMs: driver.estimate("provision", spec) });
      driverDevice = await driver.provision(spec);
    } catch (error: unknown) {
      options.reservation.release();
      throw error;
    }

    const device = await this.options.decisions.run(() =>
      this.options.registry.registerDevice({
        driverData: driverDevice.driverData,
        driverDeviceId: driverDevice.deviceId,
        provisionDuration: this.options.clock.now() - startedAt,
        spec,
      }),
    );

    try {
      options.onProgress?.({ stage: "booting", etaMs: driver.estimate("boot", spec) });
      const ready = await this.options.lifecycle.readyProvisioned(device);
      if (ready === undefined)
        throw new Error(`Registered device could not be made ready: ${device.id}`);
      return ready;
    } catch {
      try {
        await this.options.lifecycle.destroy(device, "lease-engine", "boot");
      } catch {
        // The registered record remains for reconcile when the driver cannot destroy it.
      }
      throw new BootTimeoutError(device.id);
    } finally {
      options.reservation.release();
    }
  }
}
