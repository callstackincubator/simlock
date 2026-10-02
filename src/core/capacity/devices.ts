import type { DeviceRecord, DeviceSpec } from "../domain.js";
import type { PlannedCapacityDevice, RegisteredCapacityDevice } from "./strategy.js";

/**
 * The one place a registry record or a spec becomes a capacity device. A slim
 * device uses its platform's full RAM until its slim pass runs, so a device that
 * has not booted yet counts at the full size, whatever its spec plans. A device
 * still `provisioning` is one of those. Every other device counts by the mode its
 * record reports. A device quarantined straight from `provisioning` still carries
 * the `full` placeholder `registerDevice` wrote, so it counts at the full size too.
 */
export function capacityDevice(record: DeviceRecord): RegisteredCapacityDevice {
  return {
    id: record.id,
    mode: record.state === "provisioning" ? "full" : record.mode,
    platform: record.spec.platform,
    state: record.state,
  };
}

export function capacityDevices(
  records: readonly DeviceRecord[],
): readonly RegisteredCapacityDevice[] {
  return records.map(capacityDevice);
}

/** A device about to be created counts at its platform's full size, whatever its spec plans. */
export function plannedCapacityDevice(spec: DeviceSpec): PlannedCapacityDevice {
  return { mode: "full", platform: spec.platform };
}
