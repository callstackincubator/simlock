import { type DriverDevice, DriverCrashError } from "../../core/index.js";
import { isRecord } from "./simctl-parse.js";

export interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly udid: string;
}

export function iosDriverData(device: DriverDevice): IosDriverData {
  const value = device.driverData;
  if (
    !isRecord(value) ||
    typeof value.udid !== "string" ||
    typeof value.deviceTypeId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new DriverCrashError(`Invalid iOS driver data for device ${device.deviceId}`);
  }

  return {
    deviceTypeId: value.deviceTypeId,
    name: value.name,
    runtimeId: value.runtimeId,
    udid: value.udid,
    // why: Both are optional: absent or wrong-typed is ignored rather than rejected. A `full` key
    // an older daemon stamped here is not read: the spec's mode is the only record of it (ADR 0007 §7).
    ...(typeof value.slimSignature === "string" ? { slimSignature: value.slimSignature } : {}),
    ...(typeof value.slimMarkToken === "string" ? { slimMarkToken: value.slimMarkToken } : {}),
  };
}

export function requireIosPlatform(platform: string): void {
  if (platform !== "ios") {
    throw new DriverCrashError(`iOS simctl driver cannot handle ${platform} device requests`);
  }
}
