import type { VirtualDevice, Platform } from "./domain.js";

export type IdleVictimScope =
  | { readonly kind: "global" }
  | { readonly kind: "platform"; readonly platform: Platform };

function isWarmDevice(device: VirtualDevice): boolean {
  return device.state === "ready";
}

export function selectIdleRunningVictim(
  devices: readonly VirtualDevice[],
  scope: IdleVictimScope,
): VirtualDevice | undefined {
  return devices
    .filter(
      (device) =>
        isWarmDevice(device) &&
        (scope.kind === "global" || device.spec.platform === scope.platform),
    )
    .sort(compareLeastRecentlyUsed)[0];
}

export function selectManagedVictim(
  devices: readonly VirtualDevice[],
  platform: Platform,
): VirtualDevice | undefined {
  return devices
    .filter(
      (device) =>
        device.spec.platform === platform &&
        (device.state === "ready" || device.state === "shutdown"),
    )
    .sort(compareLeastRecentlyUsed)[0];
}

export function compareLeastRecentlyUsed(left: VirtualDevice, right: VirtualDevice): number {
  return (
    (left.lastLeaseEndedAt ?? left.createdAt) - (right.lastLeaseEndedAt ?? right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
