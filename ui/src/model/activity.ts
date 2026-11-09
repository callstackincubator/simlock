import { agentIdOf } from "../../../src/contract/inbox";
import { type ConsoleEvent, workerIdOf } from "./events";
import type { Tone } from "./tones";
import { type WorkerView, workerName } from "./workers";

function field(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requesterIn(payload: unknown): string | undefined {
  const requester = field(payload, "requester") ?? field(payload, "requesterId");
  return requester === undefined ? undefined : agentIdOf(requester);
}

function deviceName(
  deviceId: string | undefined,
  workers: readonly WorkerView[],
): string | undefined {
  if (deviceId === undefined) return undefined;
  for (const worker of workers) {
    const device = worker.devices?.find((entry) => entry.id === deviceId);
    if (device !== undefined) return `${device.spec.model} ${device.spec.osVersion}`;
  }
  return undefined;
}

// why: a row has one line for an event, so it names who, what and where from whichever payload
// fields the event carries; the payload itself stays whole on the event's own page.
export function eventSummary(event: ConsoleEvent, workers: readonly WorkerView[]): string {
  const parts = summaryParts(event, workers);
  return parts.length === 0 ? event.event : parts.join(" · ");
}

// why: a log row has a column for who or what an event is about and one for the rest, so the
// summary's parts are split after the first.
export function summaryParts(event: ConsoleEvent, workers: readonly WorkerView[]): string[] {
  const { payload } = event;
  const workerId = workerIdOf(event);
  const worker = workers.find((entry) => entry.id === workerId);
  const parts = [
    requesterIn(payload),
    deviceName(field(payload, "deviceId"), workers),
    field(payload, "component"),
    worker === undefined ? field(payload, "label") : workerName(worker),
    field(payload, "reason"),
  ].filter((part): part is string => part !== undefined);
  return parts;
}

const ERROR_EVENT = /(quarantined|disconnected|failed|rejected|crash|stranded)/;
const WARN_EVENT = /(expired|drain-started|absence|stalled|pressure|declined)/;

// why: an event's name is coloured only where it reports trouble, so a quiet feed reads quiet.
export function eventTone(name: string): Tone | undefined {
  if (ERROR_EVENT.test(name)) return "error";
  if (WARN_EVENT.test(name)) return "warn";
  return undefined;
}

const OK_EVENT = /(granted|ready|connected|completed)/;

// why: a log row has a square for every event, so a quiet one is neutral and a good one green, where an
// event's name takes a colour only for trouble.
export function squareTone(name: string): Tone {
  return eventTone(name) ?? (OK_EVENT.test(name) ? "ok" : "idle");
}
