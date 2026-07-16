import type { CleanupRule, Proposal, RegistryView } from "./types.js";

export const idleDestroyRule: CleanupRule = {
  evaluate(view: RegistryView): readonly Proposal[] {
    return view.devices.flatMap((device) => {
      if (
        device.state !== "shutdown" ||
        device.lastLeaseEndedAt === undefined ||
        hasActiveLease(view, device.id)
      ) {
        return [];
      }

      const idleMs = view.now - device.lastLeaseEndedAt;
      if (idleMs <= view.config.idle.deleteAfterMs) {
        return [];
      }

      return [
        {
          action: "destroy",
          reason: `idle ${formatDuration(idleMs)} > T2=${formatDuration(view.config.idle.deleteAfterMs)}`,
          rule: "idle-destroy",
          target: device.id,
        },
      ];
    });
  },
  name: "idle-destroy",
};

function hasActiveLease(view: RegistryView, deviceId: string): boolean {
  return view.leases.some((lease) => lease.deviceId === deviceId);
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000}m`
    : `${Math.floor(milliseconds / 1_000)}s`;
}
