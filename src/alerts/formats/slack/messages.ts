import type { AlertEventName } from "../../../core/index.js";
import { formatAge, formatBytes, part } from "./units.js";

type Payload = Record<string, unknown>;
type Message = (payload: Payload, worker: string) => string;

function leases(count: unknown): string {
  if (count === 0) return "";
  return count === 1 ? " while holding 1 lease" : ` while holding ${part(count)} leases`;
}

function more(count: unknown): string {
  return typeof count === "number" && count > 1
    ? ` ${count} more refusals like it came before this one.`
    : "";
}

export const SLACK_MESSAGES: Record<AlertEventName | "alerts.test-sent", Message> = {
  "worker.connected": (p, worker) =>
    p.version === undefined
      ? `🟢 Worker ${worker} connected.`
      : `🟢 Worker ${worker} connected (simlock ${part(p.version)}).`,
  "worker.disconnected": (p, worker) => `🔴 Worker ${worker} disconnected${leases(p.leaseCount)}.`,
  "worker.rejected": (p) =>
    `⛔ A worker was refused (${part(p.reason)}): ${part(p.label ?? p.workerId ?? "an unknown worker")}.${more(p.count)}`,
  "worker.drain-started": (_p, worker) => `⏸ Worker ${worker} is drained: it takes no new leases.`,
  "worker.drain-ended": (_p, worker) => `▶️ Worker ${worker} takes new leases again.`,
  "device.quarantine-abandoned": (p, worker) =>
    `⚠️ Device ${part(p.deviceId)} on ${worker} was retired after ${part(p.attempts)} failed clean-ups.`,
  "device.quarantine-stranded": (p, worker) =>
    `🛑 Device ${part(p.deviceId)} on ${worker} could not be cleaned up or deleted after ${part(p.attempts)} tries: ${part(p.error)}. It needs a person.`,
  "device.recovery-failed": (p, worker) =>
    `⚠️ Device ${part(p.deviceId)} on ${worker} crashed during lease ${part(p.leaseId)} and could not be brought back: ${part(p.reason)}.`,
  "device.stalled-transition-detected": (p, worker) =>
    `⏳ Device ${part(p.deviceId)} on ${worker} has been ${part(p.state)} for ${formatAge(p.ageMs)}.`,
  "disk.pressure-detected": (p, worker) =>
    `💾 Worker ${worker} is low on disk: ${formatBytes(p.freeBytes)} free (threshold ${formatBytes(p.threshold)}).`,
  "component.install-failed": (p, worker) =>
    `❌ Installing ${part(p.platform)} ${part(p.componentId)} on ${worker} failed: ${part(p.error)}.`,
  "alerts.test-sent": (p) =>
    `🔔 Test message from the simlock gateway to destination ${part(p.destination)}.`,
};
