import { describe, expect, it } from "vitest";

import type { DeviceRecord, DeviceSpec } from "../domain.js";
import { capacityDevice, plannedCapacityDevice } from "./devices.js";

const slimSpec: DeviceSpec = {
  mode: "slim",
  model: "iPhone 16",
  osVersion: "18.0",
  platform: "ios",
};
const fullSpec: DeviceSpec = { model: "iPhone 16", osVersion: "18.0", platform: "ios" };

function record(overrides: Partial<DeviceRecord>): DeviceRecord {
  return {
    createdAt: 0,
    driverData: {},
    driverDeviceId: "udid",
    id: "device-1",
    mode: "full",
    spec: slimSpec,
    state: "ready",
    ...overrides,
  };
}

describe("capacity devices", () => {
  it("counts a device that has booted by the mode on its record, including when that differs from its spec's", () => {
    expect(capacityDevice(record({ mode: "full", spec: slimSpec, state: "ready" }))).toEqual({
      id: "device-1",
      mode: "full",
      platform: "ios",
      state: "ready",
    });
    expect(capacityDevice(record({ mode: "slim", spec: fullSpec, state: "leased" })).mode).toBe(
      "slim",
    );
    expect(capacityDevice(record({ mode: "slim", spec: slimSpec, state: "shutdown" })).mode).toBe(
      "slim",
    );
  });

  it("counts a device still provisioning at the full size, whatever its spec or record says", () => {
    expect(capacityDevice(record({ mode: "slim", spec: slimSpec, state: "provisioning" }))).toEqual(
      { id: "device-1", mode: "full", platform: "ios", state: "provisioning" },
    );
  });

  it("counts a device quarantined from provisioning at the full size", () => {
    // `registerDevice` writes "full" on every record until the device is first made ready,
    // and quarantine leaves it there.
    expect(capacityDevice(record({ mode: "full", spec: slimSpec, state: "quarantined" }))).toEqual({
      id: "device-1",
      mode: "full",
      platform: "ios",
      state: "quarantined",
    });
  });

  it("counts a planned device at the full size whatever its spec's mode", () => {
    expect(plannedCapacityDevice(slimSpec)).toEqual({ mode: "full", platform: "ios" });
    expect(plannedCapacityDevice({ ...fullSpec, platform: "android" })).toEqual({
      mode: "full",
      platform: "android",
    });
  });
});
