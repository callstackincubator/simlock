import type { DeviceRecord, Platform } from "./domain.js";

export type WarmVictimScope =
  | { readonly kind: "global" }
  | { readonly kind: "platform"; readonly platform: Platform };

function isWarmDevice(device: DeviceRecord): boolean {
  return device.state === "ready";
}

export function selectWarmVictim(
  devices: readonly DeviceRecord[],
  scope: WarmVictimScope,
): DeviceRecord | undefined {
  return devices
    .filter(
      (device) =>
        isWarmDevice(device) &&
        (scope.kind === "global" || device.spec.platform === scope.platform),
    )
    .sort(compareLeastRecentlyUsed)[0];
}

export function selectManagedVictim(
  devices: readonly DeviceRecord[],
  platform: Platform,
): DeviceRecord | undefined {
  return devices
    .filter(
      (device) =>
        device.spec.platform === platform &&
        (device.state === "ready" || device.state === "shutdown"),
    )
    .sort(compareLeastRecentlyUsed)[0];
}

export function compareLeastRecentlyUsed(left: DeviceRecord, right: DeviceRecord): number {
  return (
    (left.lastLeaseEndedAt ?? left.createdAt) - (right.lastLeaseEndedAt ?? right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
