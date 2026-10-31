import { isRotatableModel, modelFamily } from "../contract/index.js";
import type { DeviceSpec } from "../core/index.js";
import { DispatchError } from "./dispatch.js";

const SIMULATOR_NAMES = {
  tv: "an Apple TV simulator",
  vision: "an Apple Vision simulator",
  watch: "an Apple Watch simulator",
} as const;

function describeTarget(spec: DeviceSpec): { readonly phrase: string; readonly class: string } {
  if (spec.physical) {
    const phrase =
      spec.platform === "android"
        ? `an Android ${spec.class}`
        : spec.class === "phone"
          ? "an iPhone"
          : "an iPad";
    return { class: spec.class, phrase };
  }
  if (spec.platform === "android") return { class: "emulator", phrase: "an Android emulator" };
  const family = modelFamily(spec.model);
  if (family === "tv" || family === "watch" || family === "vision") {
    return { class: family, phrase: SIMULATOR_NAMES[family] };
  }
  return { class: family, phrase: `a ${spec.model} simulator` };
}

/** why: the one place that says which leases `device.rotate` turns, and how a refusal names the device. */
export function rotationRefusal(leaseId: string, spec: DeviceSpec): DispatchError | undefined {
  if (!spec.physical && spec.platform === "ios" && isRotatableModel(spec.model)) return undefined;
  const target = describeTarget(spec);
  return new DispatchError(
    "ROTATION_UNSUPPORTED",
    `Lease ${leaseId} is on ${target.phrase}; only an iOS simulator can be rotated`,
    { class: target.class, leaseId, physical: spec.physical, platform: spec.platform },
  );
}
