import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import type { Platform } from "./domain.js";
import type { Driver, DriverDevice } from "./driver.js";
import type { LeaseEngine } from "./lease-engine.js";
import type { Registry } from "./registry.js";

export type DoctorFinding =
  | {
      readonly kind: "registry-device-missing";
      readonly deviceId: string;
      readonly platform: Platform;
    }
  | { readonly kind: "orphan-device"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "orphan-process"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "expired-live-lease"; readonly leaseId: string; readonly deviceId: string };

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorOptions {
  readonly clock: Clock;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly leaseEngine?: LeaseEngine;
  readonly registry: Registry;
}

export interface DoctorReconcileOptions {
  readonly fix?: boolean;
}

export class Doctor {
  constructor(private readonly options: DoctorOptions) {}

  async reconcile({ fix = false }: DoctorReconcileOptions = {}): Promise<DoctorReport> {
    const snapshot = this.options.registry.snapshot;
    const realities = await Promise.all(
      this.options.drivers.map(async (driver) => ({ driver, reality: await driver.listManaged() })),
    );
    const realDeviceKeys = new Set(
      realities.flatMap(({ driver, reality }) =>
        reality.devices.map((device) => key(driver.platform, device.deviceId)),
      ),
    );
    const registryDeviceKeys = new Set(
      snapshot.devices.map((device) => key(device.spec.platform, device.driverDeviceId)),
    );
    const findings: DoctorFinding[] = [];

    for (const device of snapshot.devices) {
      if (
        device.state !== "deleted" &&
        !realDeviceKeys.has(key(device.spec.platform, device.driverDeviceId))
      ) {
        findings.push({
          deviceId: device.id,
          kind: "registry-device-missing",
          platform: device.spec.platform,
        });
      }
    }
    for (const { driver, reality } of realities) {
      for (const device of reality.devices) {
        if (!registryDeviceKeys.has(key(driver.platform, device.deviceId))) {
          findings.push({ device, kind: "orphan-device", platform: driver.platform });
        }
      }
      for (const device of reality.processes) {
        if (!registryDeviceKeys.has(key(driver.platform, device.deviceId))) {
          findings.push({ device, kind: "orphan-process", platform: driver.platform });
        }
      }
    }
    for (const lease of snapshot.leases) {
      if (lease.ttlDeadline <= this.options.clock.now()) {
        findings.push({ deviceId: lease.deviceId, kind: "expired-live-lease", leaseId: lease.id });
      }
    }

    const report = { findings };
    if (fix) {
      await this.#applySafeFixes(findings);
    }
    this.options.eventBus.emit("doctor.reconciled", { driftFindings: findings }, "doctor");
    return report;
  }

  async #applySafeFixes(findings: readonly DoctorFinding[]): Promise<void> {
    const drivers = new Map(this.options.drivers.map((driver) => [driver.platform, driver]));
    for (const finding of findings) {
      switch (finding.kind) {
        case "registry-device-missing": {
          const snapshot = this.options.registry.snapshot;
          if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
            continue;
          }
          const device = snapshot.devices.find((candidate) => candidate.id === finding.deviceId);
          if (device !== undefined && device.state !== "deleted") {
            await this.options.registry.markDeviceMissing(finding.deviceId, "doctor");
          }
          break;
        }
        case "orphan-device": {
          const driver = drivers.get(finding.platform);
          if (driver !== undefined) await driver.destroy(finding.device);
          break;
        }
        case "orphan-process": {
          const driver = drivers.get(finding.platform);
          if (driver !== undefined) await driver.shutdown(finding.device);
          break;
        }
        case "expired-live-lease":
          if (this.options.leaseEngine !== undefined) {
            await this.options.leaseEngine.expire(finding.leaseId);
          }
          break;
      }
    }
  }
}

function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}
