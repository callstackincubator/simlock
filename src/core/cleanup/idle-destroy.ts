import type { CleanupRule, Proposal, RegistryView } from "./types.js";

const GIBIBYTE = 1024 ** 3;

/**
 * Under disk pressure, waiting out the full T2 window before reclaiming disk
 * defeats the point, so this rule shortens its own threshold to T1 (the
 * shutdown threshold) instead. There is no separate pressure rule: the view
 * already carries diskFreeBytes, so this stays a pure function of it — no
 * dependency on an event having fired.
 */
export const idleDestroyRule: CleanupRule = {
  evaluate(view: RegistryView): readonly Proposal[] {
    const underPressure = isUnderPressure(view);
    const threshold = underPressure
      ? view.config.idle.shutdownAfterMs
      : view.config.idle.deleteAfterMs;

    return view.devices.flatMap((device) => {
      if (
        device.state !== "shutdown" ||
        device.lastLeaseEndedAt === undefined ||
        hasActiveLease(view, device.id)
      ) {
        return [];
      }

      const idleMs = view.now - device.lastLeaseEndedAt;
      if (idleMs <= threshold) {
        return [];
      }

      return [
        {
          action: "destroy",
          reason: underPressure
            ? `disk pressure (free ${formatBytes(view.diskFreeBytes)} < ${formatBytes(view.config.diskPressure.freeBytesThreshold)}): idle ${formatDuration(idleMs)} > T1=${formatDuration(view.config.idle.shutdownAfterMs)}`
            : `idle ${formatDuration(idleMs)} > T2=${formatDuration(view.config.idle.deleteAfterMs)}`,
          rule: "idle-destroy",
          target: device.id,
        },
      ];
    });
  },
  name: "idle-destroy",
};

function isUnderPressure(view: RegistryView): boolean {
  return view.diskFreeBytes < view.config.diskPressure.freeBytesThreshold;
}

function hasActiveLease(view: RegistryView, deviceId: string): boolean {
  return view.leases.some((lease) => lease.deviceId === deviceId);
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000}m`
    : `${Math.floor(milliseconds / 1_000)}s`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / GIBIBYTE;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)}GiB`;
}
