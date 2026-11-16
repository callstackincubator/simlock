import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceState } from "./domain.js";
import type { ObservedDevice, ObservedMark } from "./driver.js";
import { type DoctorFinding, key, type ProvenanceDrift } from "./doctor-types.js";

export function registryDriftFindings(
  device: DeviceRecord,
  realDeviceKeys: ReadonlySet<string>,
  observedDevices: ReadonlyMap<string, ObservedDevice>,
  claims?: Pick<DeviceOperationClaims, "isClaimed">,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const deviceKey = key(device.spec.platform, device.driverDeviceId);

  const missing = missingDeviceFinding(device, deviceKey, realDeviceKeys);
  if (missing !== undefined) {
    findings.push(missing);
  }

  // why: `expected === undefined` means the registry is mid-transition: simlock is acting on the device
  // itself, so neither run state nor marks are compared.
  //
  // A device this daemon holds an operation claim on is excluded too: a lease-path boot from
  // `shutdown` runs `makeReady` while the record still says `shutdown`, and a concurrent
  // `doctor --fix` would read that as foreign drift, "fix" the record, and make the boot's own
  // commit drop its `address`/`driverData`/`mode`.
  const expected = expectedRunState(device.state);
  const observed = observedDevices.get(deviceKey);
  const claimed = claims?.isClaimed(device.id) === true;
  if (expected !== undefined && observed !== undefined && !claimed) {
    findings.push(...liveDriftFindings(device, expected, observed));
  }

  return findings;
}

function missingDeviceFinding(
  device: DeviceRecord,
  deviceKey: string,
  realDeviceKeys: ReadonlySet<string>,
): DoctorFinding | undefined {
  if (device.state === "deleted" || realDeviceKeys.has(deviceKey)) {
    return undefined;
  }
  return { deviceId: device.id, kind: "registry-device-missing", platform: device.spec.platform };
}

function liveDriftFindings(
  device: DeviceRecord,
  expected: "running" | "stopped",
  observed: ObservedDevice,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  if (observed.runState !== "transitioning" && observed.runState !== expected) {
    findings.push({
      deviceId: device.id,
      expected,
      kind: "foreign-state-change",
      observed: observed.runState,
      platform: device.spec.platform,
    });
  }

  const detail = observed.mark === undefined ? undefined : provenanceDrift(observed.mark);
  if (detail !== undefined) {
    findings.push({
      detail,
      deviceId: device.id,
      kind: "foreign-provenance-change",
      platform: device.spec.platform,
    });
  }

  return findings;
}

/**
 * why: Report-only by design. Re-marking would overwrite the only evidence that the
 * device was tampered with, and a fresh mark cannot be written to a leased
 * device without disturbing its holder -- so the core never repairs a mark.
 */
function provenanceDrift(mark: ObservedMark): ProvenanceDrift | undefined {
  if (mark.durable === undefined) {
    return "durable-mark-missing";
  }
  if (!mark.erasableReadable) {
    return undefined;
  }
  if (mark.erasable === undefined) {
    return "erased";
  }
  return mark.erasable === mark.durable ? undefined : "mark-mismatch";
}

export function isDrift(finding: DoctorFinding): boolean {
  return (
    finding.kind !== "driver-advisory" &&
    finding.kind !== "prerequisite-missing" &&
    finding.kind !== "service-broken" &&
    finding.kind !== "warm-pool-target-unreachable" &&
    finding.kind !== "module-unavailable"
  );
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
    case "quarantined":
    case "absent":
    case "deleted":
      return undefined;
  }
}
