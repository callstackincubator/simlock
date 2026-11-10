import { type Clock, type Logger, NoopLogger } from "../ports/index.js";
import { stableError } from "./stable-error.js";
import type { CapacityReservation } from "./capacity/index.js";
import type { ComponentInstaller } from "./component-installer.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import type { LeaseProgress, VirtualDevice, VirtualSpec } from "./domain.js";
import { UnknownBaselineError, type CurrentBaseline } from "./baselines.js";
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
    readonly backend: string;
    readonly driverDeviceId: string;
    readonly spec: VirtualSpec;
    readonly driverData: unknown;
    readonly provisionDuration: number;
  }): Promise<VirtualDevice>;
}

export interface DeviceProvisionerOptions {
  readonly baselines: () => {
    current(name: string): CurrentBaseline | undefined;
    hold(name: string, version: number): () => void;
  };
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
  /** why: the categories a slim lease keeps running, handed to the driver at the boot before the grant (ADR 0066 §2). */
  readonly except?: readonly string[];
  readonly onProgress?: (progress: ProvisionProgress) => void;
  readonly reservation: CapacityReservation;
}

/** Provisions a new driver device, registers it, and makes it ready. */
export class DeviceProvisioner {
  readonly #logger: Logger;

  constructor(private readonly options: DeviceProvisionerOptions) {
    this.#logger = options.logger?.child("device-provisioner") ?? new NoopLogger();
  }

  /** why: the claim, and for a baseline copy the version and source, are taken in one gate section, so the copy is of the version current at that moment and a replace keeps its source until the copy has a record. */
  #claim(
    requested: VirtualSpec,
    made: { spec: VirtualSpec; source?: string; hold: () => void },
  ): () => void {
    const release = this.options.components.claimProvision(requested);
    if (requested.baseline === undefined) return release;
    const current = this.options.baselines().current(requested.baseline.name);
    if (current === undefined) {
      release();
      throw new UnknownBaselineError(requested.baseline.name);
    }
    made.spec = { ...requested, baseline: { name: current.name, version: current.version } };
    made.source = current.sourceId;
    made.hold = this.options.baselines().hold(current.name, current.version);
    return release;
  }

  /** why: the claim ends in the section that commits the record, so the device is counted by one of the two at every moment; the boot claim begins in that same section. */
  async #register(
    driverDevice: DriverDevice,
    spec: VirtualSpec,
    startedAt: number,
    options: ProvisionDeviceOptions,
    releaseClaim: () => void,
  ): Promise<{ device: VirtualDevice; bootClaim: DeviceOperationClaim | undefined }> {
    return this.options.decisions.run(async () => {
      try {
        const device = await this.options.registry.registerDevice({
          backend: this.options.catalog.get(spec.platform).backend.id,
          driverData: driverDevice.driverData,
          driverDeviceId: driverDevice.deviceId,
          provisionDuration: this.options.clock.now() - startedAt,
          spec,
        });
        const bootClaim =
          options.claim === undefined
            ? undefined
            : this.options.claims.tryClaim(device.id, options.claim.kind, options.claim.owner);
        return { bootClaim, device };
      } finally {
        releaseClaim();
      }
    });
  }

  async provision(
    requested: VirtualSpec,
    options: ProvisionDeviceOptions,
  ): Promise<ReadyDeviceHandoff> {
    const driver = this.options.catalog.get(requested.platform);
    const made: { spec: VirtualSpec; source?: string; hold: () => void } = {
      hold: () => undefined,
      spec: requested,
    };
    // Claimed inside the gate, so a removal's own count in the gate sees this device before the
    // driver creates it, or this claim sees the removal's mark and refuses.
    let releaseClaim: () => void;
    try {
      releaseClaim = await this.options.decisions.run(() => this.#claim(requested, made));
    } catch (error: unknown) {
      options.reservation.release();
      throw error;
    }
    const { spec, source } = made;
    const startedAt = this.options.clock.now();
    let driverDevice: DriverDevice;
    try {
      options.onProgress?.({
        stage: "provisioning",
        etaMs: driver.estimate({ operation: "provision" }, spec),
      });
      driverDevice = await driver.provision(spec, source === undefined ? undefined : { source });
    } catch (error: unknown) {
      releaseClaim();
      made.hold();
      options.reservation.release();
      throw error;
    }

    let registered: { device: VirtualDevice; bootClaim: DeviceOperationClaim | undefined };
    try {
      registered = await this.#register(driverDevice, spec, startedAt, options, () => {
        releaseClaim();
        made.hold();
      });
    } catch (error: unknown) {
      options.reservation.release();
      throw error;
    }
    const { bootClaim, device } = registered;
    return this.#makeReady(
      device,
      bootClaim,
      () => driver.estimate({ operation: "boot" }, spec),
      options,
    );
  }

  /** why: a registered device that cannot be made ready is destroyed and the caller sees `BootTimeoutError`; the reservation ends on every path. */
  async #makeReady(
    device: VirtualDevice,
    bootClaim: DeviceOperationClaim | undefined,
    bootEstimate: () => number,
    options: ProvisionDeviceOptions,
  ): Promise<ReadyDeviceHandoff> {
    try {
      options.onProgress?.({ stage: "booting", etaMs: bootEstimate() });
      const ready = await this.options.lifecycle.readyProvisionedForLease(
        device,
        bootClaim,
        options.except,
      );
      if (ready === undefined)
        throw new Error(`Registered device could not be made ready: ${device.id}`);
      return ready;
    } catch (error: unknown) {
      // why: the caller sees `BootTimeoutError` carrying the driver's message; the log keeps the full error.
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
      throw BootTimeoutError.from(device.id, error);
    } finally {
      options.reservation.release();
    }
  }
}
