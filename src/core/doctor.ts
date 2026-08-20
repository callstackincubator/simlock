import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import type { DeviceRecord, DeviceState, Platform } from "./domain.js";
import type { Driver, DriverDevice, ObservedDevice } from "./driver.js";
import type { LeaseExpirer } from "./lease-ports.js";
import type { Registry } from "./registry.js";

export type DoctorFinding =
  | {
      readonly kind: "registry-device-missing";
      readonly deviceId: string;
      readonly platform: Platform;
    }
  | { readonly kind: "orphan-device"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "orphan-process"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "expired-live-lease"; readonly leaseId: string; readonly deviceId: string }
  | {
      readonly kind: "foreign-state-change";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly expected: "running" | "stopped";
      readonly observed: "running" | "stopped";
    };

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorOptions {
  readonly clock: Clock;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly leaseExpirer?: LeaseExpirer;
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
    const observedDevices = new Map<string, ObservedDevice>(
      realities.flatMap(({ driver, reality }) =>
        reality.devices.map((device) => [key(driver.platform, device.deviceId), device] as const),
      ),
    );
    const registryDeviceKeys = new Set(
      snapshot.devices.map((device) => key(device.spec.platform, device.driverDeviceId)),
    );
    const findings: DoctorFinding[] = [];

    for (const device of snapshot.devices) {
      const deviceFindings = registryDriftFindings(device, realDeviceKeys, observedDevices);
      findings.push(...deviceFindings);
      if (deviceFindings.some((finding) => finding.kind === "foreign-state-change")) {
        await this.options.registry.markForeignStateDetected(device.id, this.options.clock.now());
      }
    }
    findings.push(...orphanFindings(realities, registryDeviceKeys));
    findings.push(...expiredLeaseFindings(snapshot.leases, this.options.clock.now()));

    const report = { findings };
    if (fix) {
      await this.#applySafeFixes(findings);
    }
    this.#emitForeignStateEvents(findings);
    this.options.eventBus.emit("doctor.reconciled", { driftFindings: findings }, "doctor");
    return report;
  }

  #emitForeignStateEvents(findings: readonly DoctorFinding[]): void {
    for (const finding of findings) {
      if (finding.kind !== "foreign-state-change") continue;
      this.options.eventBus.emit(
        "device.foreign-state-detected",
        {
          deviceId: finding.deviceId,
          expected: finding.expected,
          observed: finding.observed,
          platform: finding.platform,
        },
        "doctor",
      );
    }
  }

  async #applySafeFixes(findings: readonly DoctorFinding[]): Promise<void> {
    for (const finding of findings) {
      switch (finding.kind) {
        case "registry-device-missing":
          await this.#fixMissingDevice(finding.deviceId);
          break;
        case "orphan-device":
        case "orphan-process":
          // Registry-only destruction: unregistered reality is report-only.
          break;
        case "expired-live-lease":
          if (this.options.leaseExpirer !== undefined) {
            await this.options.leaseExpirer.expire(finding.leaseId);
          }
          break;
        case "foreign-state-change":
          await this.#fixForeignStateChange(finding);
          break;
      }
    }
  }

  async #fixMissingDevice(deviceId: string): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === deviceId);
    if (device !== undefined && device.state !== "deleted") {
      await this.options.registry.markDeviceMissing(deviceId, "doctor");
    }
  }

  async #fixForeignStateChange(
    finding: Extract<DoctorFinding, { readonly kind: "foreign-state-change" }>,
  ): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === finding.deviceId);
    if (device === undefined) {
      return;
    }
    if (finding.expected === "running" && finding.observed === "stopped") {
      await this.options.registry.transitionDevice(finding.deviceId, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: finding.deviceId, initiator: "doctor" },
      });
    } else if (finding.expected === "stopped" && finding.observed === "running") {
      await this.options.registry.transitionDevice(finding.deviceId, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: finding.deviceId },
      });
    }
    await this.options.registry.clearForeignStateDetected(finding.deviceId);
  }
}

/** Existence and boot-state drift for a single registry device against observed reality. */
function registryDriftFindings(
  device: DeviceRecord,
  realDeviceKeys: ReadonlySet<string>,
  observedDevices: ReadonlyMap<string, ObservedDevice>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const deviceKey = key(device.spec.platform, device.driverDeviceId);

  if (device.state !== "deleted" && !realDeviceKeys.has(deviceKey)) {
    findings.push({
      deviceId: device.id,
      kind: "registry-device-missing",
      platform: device.spec.platform,
    });
  }

  const expected = expectedRunState(device.state);
  const observed = expected === undefined ? undefined : observedDevices.get(deviceKey);
  if (
    expected !== undefined &&
    observed !== undefined &&
    observed.runState !== "transitioning" &&
    observed.runState !== expected
  ) {
    findings.push({
      deviceId: device.id,
      expected,
      kind: "foreign-state-change",
      observed: observed.runState,
      platform: device.spec.platform,
    });
  }

  return findings;
}

function orphanFindings(
  realities: readonly {
    readonly driver: Driver;
    readonly reality: {
      readonly devices: readonly DriverDevice[];
      readonly processes: readonly DriverDevice[];
    };
  }[],
  registryDeviceKeys: ReadonlySet<string>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
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
  return findings;
}

function expiredLeaseFindings(
  leases: readonly {
    readonly id: string;
    readonly deviceId: string;
    readonly ttlDeadline: number;
  }[],
  now: number,
): DoctorFinding[] {
  return leases
    .filter((lease) => lease.ttlDeadline <= now)
    .map((lease) => ({
      deviceId: lease.deviceId,
      kind: "expired-live-lease" as const,
      leaseId: lease.id,
    }));
}

function expectedRunState(state: DeviceState): "running" | "stopped" | undefined {
  switch (state) {
    case "ready":
    case "leased":
      return "running";
    case "shutdown":
      return "stopped";
    case "provisioning":
    case "reclaiming":
    case "deleted":
      return undefined;
  }
}

function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}
