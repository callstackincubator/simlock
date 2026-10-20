import { loadGauges } from "./load";
import { levelOf } from "./load-thresholds";
import type { Tone, Toned } from "./tones";
import type { WorkerDevice, WorkerView } from "./workers";

const RANK: Readonly<Record<Tone, number>> = { error: 3, idle: 0, ok: 1, warn: 2 };

// why: a list row has room for one square, so of everything wrong with a worker the worst is
// shown and its word goes in the square's name; a worker with nothing wrong reads "connected".
export function workerHealth(worker: WorkerView): Toned {
  return [...stateFindings(worker), ...loadFindings(worker)].reduce<Toned>(
    (worst, finding) => (RANK[finding.tone] > RANK[worst.tone] ? finding : worst),
    { tone: "ok", word: "connected" },
  );
}

function stateFindings(worker: WorkerView): Toned[] {
  const findings: Toned[] = [];
  if (worker.connection !== "connected") findings.push({ tone: "error", word: worker.connection });
  if (worker.health === "failed") findings.push({ tone: "error", word: "failed" });
  if (worker.drained) findings.push({ tone: "warn", word: "drained" });
  if (worker.health === "starting") findings.push({ tone: "warn", word: "starting" });
  if (worker.capacity?.ramBudget?.overLimit === true) {
    findings.push({ tone: "warn", word: "over RAM budget" });
  }
  return findings;
}

// why: a reading from a worker that is not connected is stale, so it says nothing about the worker
// now; where memory reports a pressure, that word judges memory instead of its fill.
function loadFindings(worker: WorkerView): Toned[] {
  if (worker.connection !== "connected" || worker.load === undefined) return [];
  const pressure = worker.load.memory?.pressure;
  const gauges = loadGauges(worker.load);
  const figures = [
    ["CPU", gauges.cpu],
    ["memory", pressure === undefined ? gauges.memory : undefined],
    ["disk", gauges.disk],
  ] as const;
  const findings: Toned[] = figures.flatMap(([name, percent]) => {
    const tone = levelOf(percent);
    return tone === "idle" ? [] : [{ tone, word: `${name} ${percent}%` }];
  });
  if (pressure === "warn" || pressure === "critical") {
    findings.push({
      tone: pressure === "critical" ? "error" : "warn",
      word: `memory pressure ${pressure}`,
    });
  }
  return findings;
}

export type SlotKind = "leased" | "ready" | "busy" | "broken" | "absent" | "free";

export interface DeviceSlot {
  readonly kind: SlotKind;
  readonly label: string;
}

const SLOT_OF_STATE: Readonly<Partial<Record<string, SlotKind>>> = {
  absent: "absent",
  leased: "leased",
  provisioning: "busy",
  quarantined: "broken",
  ready: "ready",
  reclaiming: "busy",
};

function slotOf(device: WorkerDevice): DeviceSlot | undefined {
  const kind = SLOT_OF_STATE[device.state];
  if (kind === undefined) return undefined;
  return { kind, label: `${device.spec.model} ${device.spec.osVersion}, ${device.state}` };
}

// why: a slot is a device the worker may run; a shut-down device holds none, so it is not drawn,
// and the room left under the platform's limit shows as free slots.
export function platformSlots(
  worker: WorkerView,
  platform: "ios" | "android",
): readonly DeviceSlot[] {
  const taken = (worker.devices ?? [])
    .filter((device) => device.spec.platform === platform)
    .flatMap((device) => {
      const slot = slotOf(device);
      return slot === undefined ? [] : [slot];
    });
  const limit = worker.connection === "connected" ? (worker.capacity?.[platform].limit ?? 0) : 0;
  const free = Math.max(0, limit - taken.length);
  return [
    ...taken,
    ...Array.from({ length: free }, () => ({ kind: "free", label: "free" }) as const),
  ];
}

export function workerSlots(worker: WorkerView): readonly DeviceSlot[] {
  return [...platformSlots(worker, "ios"), ...platformSlots(worker, "android")];
}

export function slotsLabel(slots: readonly DeviceSlot[]): string {
  const counts = new Map<SlotKind, number>();
  for (const slot of slots) counts.set(slot.kind, (counts.get(slot.kind) ?? 0) + 1);
  const words: Readonly<Record<SlotKind, string>> = {
    absent: "absent",
    broken: "quarantined",
    busy: "booting",
    free: "free",
    leased: "leased",
    ready: "ready",
  };
  const parts = [...counts].map(([kind, count]) => `${count} ${words[kind]}`);
  return parts.length === 0 ? "No devices" : parts.join(", ");
}
