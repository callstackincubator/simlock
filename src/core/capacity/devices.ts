import { specMode, type DeviceRecord, type DeviceSpec } from "../domain.js";
import type { CapacityDevice, PlannedCapacityDevice } from "./strategy.js";

/**
 * The one place a registry record or a spec becomes a capacity device. A device
 * still `provisioning` has not been made ready, so its record's mode says nothing
 * yet and it counts by the mode its spec plans; from its first `ready` on, it
 * counts by the mode its record reports, which is the mode it actually has.
 */
export function capacityDevice(record: DeviceRecord): CapacityDevice {
  return {
    mode: record.state === "provisioning" ? specMode(record.spec) : record.mode,
    platform: record.spec.platform,
    state: record.state,
  };
}

export function capacityDevices(records: readonly DeviceRecord[]): readonly CapacityDevice[] {
  return records.map(capacityDevice);
}

/** A device about to be created counts by the mode its spec plans, full when it names none. */
export function plannedCapacityDevice(spec: DeviceSpec): PlannedCapacityDevice {
  return { mode: specMode(spec), platform: spec.platform };
}
