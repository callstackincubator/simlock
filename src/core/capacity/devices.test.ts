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
  it("counts a ready device by the mode on its record when that differs from its spec's", () => {
    expect(capacityDevice(record({ mode: "full", spec: slimSpec, state: "ready" }))).toEqual({
      mode: "full",
      platform: "ios",
      state: "ready",
    });
    expect(capacityDevice(record({ mode: "slim", spec: fullSpec, state: "leased" })).mode).toBe(
      "slim",
    );
    expect(capacityDevice(record({ mode: "full", spec: slimSpec, state: "shutdown" })).mode).toBe(
      "full",
    );
  });

  it("counts a device not yet ready by its spec's mode, whatever its record says", () => {
    // `registerDevice` writes "full" on every record until the device is first made ready.
    expect(capacityDevice(record({ mode: "full", spec: slimSpec, state: "provisioning" }))).toEqual(
      { mode: "slim", platform: "ios", state: "provisioning" },
    );
  });

  it("counts a planned device by its spec's mode, and a spec with no mode as full", () => {
    expect(plannedCapacityDevice(slimSpec)).toEqual({ mode: "slim", platform: "ios" });
    expect(plannedCapacityDevice({ ...fullSpec, platform: "android" })).toEqual({
      mode: "full",
      platform: "android",
    });
  });
});
