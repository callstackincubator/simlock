import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type { PhysicalDevice, Platform } from "./domain.js";
import type { Driver, DriverRefusalReason } from "./driver.js";
import type { PhysicalEnrollmentInput, RegistrySnapshot } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";

export type DeviceNotEnrollableReason = DriverRefusalReason | "enrolled-on-other-platform";

export class DeviceNotEnrollableError extends Error {
  constructor(
    readonly platform: Platform,
    readonly id: string,
    readonly reason: DeviceNotEnrollableReason,
    message: string,
    readonly canonicalId?: string,
  ) {
    super(message);
    this.name = "DeviceNotEnrollableError";
  }
}

export class DeviceBusyError extends Error {
  constructor(
    readonly id: string,
    readonly reason: "leased" | "reclaiming" | "busy",
  ) {
    super(
      reason === "leased"
        ? `${id} is leased: release it first`
        : reason === "reclaiming"
          ? `${id} is being reclaimed: try again when it finishes`
          : `${id} is busy with another operation: try again in a moment`,
    );
    this.name = "DeviceBusyError";
  }
}

export class UnknownEnrolledDeviceError extends Error {
  constructor(readonly id: string) {
    super(`${id} is not an enrolled device`);
    this.name = "UnknownEnrolledDeviceError";
  }
}

class PhysicalInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhysicalInspectionError";
  }
}

interface PhysicalEnrollmentResult {
  readonly device: PhysicalDevice;
  readonly reenrolled: boolean;
}

export interface PhysicalEnrollmentOptions {
  readonly claims: Pick<DeviceOperationClaims, "claim" | "tryClaim">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: { get(platform: Platform): Driver };
  readonly physicalDeviceReady?: (deviceId: string) => void;
  readonly registry: PhysicalEnrollmentRegistry;
}

export interface PhysicalEnrollmentRegistry {
  readonly snapshot: Pick<RegistrySnapshot, "devices" | "virtualDevices">;
  enrollPhysical(input: PhysicalEnrollmentInput): Promise<PhysicalDevice>;
  reenrollPhysical(deviceId: string, input: PhysicalEnrollmentInput): Promise<PhysicalDevice>;
  unenrollPhysical(deviceId: string): Promise<PhysicalDevice>;
}

export class PhysicalEnrollment {
  constructor(private readonly options: PhysicalEnrollmentOptions) {}

  async add(platform: Platform, id: string): Promise<PhysicalEnrollmentResult> {
    this.#refuseVirtual(platform, id);
    const driver = this.options.drivers.get(platform);
    const read = await this.#inspect(driver, platform, id);

    const claimed = await this.options.decisions.run(async () => {
      const existing = this.#enrolled(read.driverDeviceId);
      if (existing === undefined) {
        return { created: await this.options.registry.enrollPhysical({ ...read, platform }) };
      }
      if (existing.spec.platform !== platform) {
        throw new DeviceNotEnrollableError(
          platform,
          id,
          "enrolled-on-other-platform",
          `${id} is enrolled as a ${existing.spec.platform} device`,
          read.driverDeviceId,
        );
      }
      this.#requireFree(existing);
      const claim = this.options.claims.tryClaim(existing.id, "enrollment");
      if (claim === undefined) throw new DeviceBusyError(existing.driverDeviceId, "busy");
      return { claim, existing };
    });
    if ("created" in claimed) {
      this.options.physicalDeviceReady?.(claimed.created.id);
      return { device: claimed.created, reenrolled: false };
    }

    const { claim, existing } = claimed;
    try {
      const again = await this.#inspect(driver, platform, id, existing.driverDeviceId);
      if (again.driverDeviceId !== existing.driverDeviceId) {
        throw new PhysicalInspectionError(
          `${existing.driverDeviceId} was read again as ${again.driverDeviceId}`,
        );
      }
      const device = await this.options.decisions.run(() =>
        this.options.registry.reenrollPhysical(existing.id, { ...again, platform }),
      );
      this.options.physicalDeviceReady?.(device.id);
      return { device, reenrolled: true };
    } finally {
      claim.release();
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through the dispatcher's enrollment port.
  async remove(id: string): Promise<PhysicalDevice> {
    return this.options.decisions.run(() => {
      const existing = this.#enrolled(id);
      if (existing === undefined) throw new UnknownEnrolledDeviceError(id);
      this.#requireFree(existing);
      return this.options.registry.unenrollPhysical(existing.id);
    });
  }

  #refuseVirtual(platform: Platform, id: string): void {
    const own = this.options.registry.snapshot.virtualDevices.find(
      (device) =>
        device.state !== "deleted" && (device.driverDeviceId === id || device.address === id),
    );
    if (own !== undefined) {
      throw new DeviceNotEnrollableError(
        platform,
        id,
        "virtual-device",
        `${id} is a simulator or emulator Simlock manages`,
      );
    }
  }

  async #inspect(
    driver: Driver,
    platform: Platform,
    id: string,
    canonicalId?: string,
  ): Promise<Omit<PhysicalEnrollmentInput, "platform">> {
    let inspection: Awaited<ReturnType<Driver["inspectPhysical"]>>;
    try {
      inspection = await driver.inspectPhysical(canonicalId ?? id);
    } catch (error: unknown) {
      throw new PhysicalInspectionError(
        `Reading ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!inspection.enrollable) {
      throw new DeviceNotEnrollableError(
        platform,
        id,
        inspection.reason,
        inspection.message,
        canonicalId,
      );
    }
    return {
      apps: inspection.apps,
      class: inspection.class,
      driverDeviceId: inspection.driverDeviceId,
      model: inspection.model,
      osVersion: inspection.osVersion,
    };
  }

  #enrolled(canonicalId: string): PhysicalDevice | undefined {
    return this.options.registry.snapshot.devices.find(
      (device): device is PhysicalDevice =>
        device.physical && device.state !== "deleted" && device.driverDeviceId === canonicalId,
    );
  }

  #requireFree(device: PhysicalDevice): void {
    if (device.state === "leased") throw new DeviceBusyError(device.driverDeviceId, "leased");
    const held = this.options.claims.claim(device.id);
    if (device.state === "reclaiming" || held?.kind === "reclaim") {
      throw new DeviceBusyError(device.driverDeviceId, "reclaiming");
    }
    if (held !== undefined) throw new DeviceBusyError(device.driverDeviceId, "busy");
    if (device.state !== "ready" && device.state !== "quarantined" && device.state !== "absent") {
      throw new DeviceBusyError(device.driverDeviceId, "busy");
    }
  }
}
