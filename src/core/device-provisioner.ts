import { type Clock, type Logger, NoopLogger } from "../ports/index.js";
import { stableError } from "./stable-error.js";
import type { CapacityReservation } from "./capacity/index.js";
import type { ComponentInstaller } from "./component-installer.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceSpec, LeaseProgress } from "./domain.js";
import { BootTimeoutError, type DriverDevice } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import { ManagedDeviceLifecycle, type ReadyDeviceHandoff } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";

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
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly clock: Clock;
  /**
   * The one installer (ADR 0010 §8). Every device record is created here, so this is where a
   * component being removed refuses a new device, on every path that provisions one.
   */
  readonly components: Pick<ComponentInstaller, "claimProvision">;
  readonly decisions: SerializedDecision;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "destroy" | "readyProvisionedForLease">;
  readonly registry: DeviceProvisionerRegistry;
  readonly logger?: Logger;
}

export interface ProvisionDeviceOptions {
  /**
   * A boot claim taken on the new device in the section that registers it and held until the
   * handoff, so a request planning in between sees a device that is on its way, and whose.
   */
  readonly claim?: { readonly kind: "boot"; readonly owner?: string };
  readonly onProgress?: (progress: ProvisionProgress) => void;
  readonly reservation: CapacityReservation;
}

/** Provisions a new driver device, registers it, and makes it ready. */
export class DeviceProvisioner {
  readonly #logger: Logger;

  constructor(private readonly options: DeviceProvisionerOptions) {
    this.#logger = options.logger?.child("device-provisioner") ?? new NoopLogger();
  }

  async provision(spec: DeviceSpec, options: ProvisionDeviceOptions): Promise<ReadyDeviceHandoff> {
    const driver = this.options.catalog.get(spec.platform);
    // Claimed inside the gate, so a removal's own count in the gate sees this device before the
    // driver creates it, or this claim sees the removal's mark and refuses.
    let releaseClaim: () => void;
    try {
      releaseClaim = await this.options.decisions.run(() =>
        this.options.components.claimProvision(spec),
      );
    } catch (error: unknown) {
      options.reservation.release();
      throw error;
    }
    const startedAt = this.options.clock.now();
    let driverDevice: DriverDevice;
    try {
      options.onProgress?.({
        stage: "provisioning",
        etaMs: driver.estimate({ operation: "provision" }, spec),
      });
      driverDevice = await driver.provision(spec);
    } catch (error: unknown) {
      releaseClaim();
      options.reservation.release();
      throw error;
    }

    let device: DeviceRecord;
    let bootClaim: DeviceOperationClaim | undefined;
    try {
      // The claim ends in the section that commits the record, so the device is counted by one
      // of the two at every moment; the boot claim begins in that same section.
      device = await this.options.decisions.run(async () => {
        try {
          const registered = await this.options.registry.registerDevice({
            driverData: driverDevice.driverData,
            driverDeviceId: driverDevice.deviceId,
            provisionDuration: this.options.clock.now() - startedAt,
            spec,
          });
          if (options.claim !== undefined) {
            bootClaim = this.options.claims.tryClaim(
              registered.id,
              options.claim.kind,
              options.claim.owner,
            );
          }
          return registered;
        } finally {
          releaseClaim();
        }
      });
    } catch (error: unknown) {
      options.reservation.release();
      throw error;
    }

    try {
      options.onProgress?.({
        stage: "booting",
        etaMs: driver.estimate({ operation: "boot" }, spec),
      });
      const ready = await this.options.lifecycle.readyProvisionedForLease(device, bootClaim);
      if (ready === undefined)
        throw new Error(`Registered device could not be made ready: ${device.id}`);
      return ready;
    } catch (error: unknown) {
      // The caller only ever sees `BootTimeoutError`; the driver's own reason is kept here.
      this.#logger.warn("new device failed to become ready", {
        deviceId: device.id,
        step: "boot",
        error: stableError(error),
      });
      try {
        await this.options.lifecycle.destroy(device, "lease-engine", "cleanup");
      } catch (destroyError: unknown) {
        // The registered record remains for reconcile when the driver cannot destroy it.
        this.#logger.warn("destroying a device that failed to boot failed", {
          deviceId: device.id,
          step: "destroy",
          error: stableError(destroyError),
        });
      }
      throw new BootTimeoutError(device.id);
    } finally {
      options.reservation.release();
    }
  }
}
