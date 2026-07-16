import type { CleanupRule, Proposal, RegistryView } from "./types.js";

export const idleShutdownRule: CleanupRule = {
  evaluate(view: RegistryView): readonly Proposal[] {
    return view.devices.flatMap((device) => {
      if (
        (device.state !== "ready" && device.state !== "warm") ||
        device.lastLeaseEndedAt === undefined ||
        hasActiveLease(view, device.id)
      ) {
        return [];
      }

      const idleMs = view.now - device.lastLeaseEndedAt;
      if (idleMs <= view.config.idle.shutdownAfterMs) {
        return [];
      }

      return [
        {
          action: "shutdown",
          reason: `idle ${formatDuration(idleMs)} > T1=${formatDuration(view.config.idle.shutdownAfterMs)}`,
          rule: "idle-shutdown",
          target: device.id,
        },
      ];
    });
  },
  name: "idle-shutdown",
};

function hasActiveLease(view: RegistryView, deviceId: string): boolean {
  return view.leases.some((lease) => lease.deviceId === deviceId);
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000}m`
    : `${Math.floor(milliseconds / 1_000)}s`;
}
