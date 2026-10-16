import { eventSummary, eventTone } from "./activity";
import { type ConsoleEvent, timeOfDay, workerIdOf } from "./events";
import { itemPath } from "./paths";
import { formatDuration } from "./time";
import type { Tone } from "./tones";
import {
  stateEnteredAt,
  type WorkerDevice,
  type WorkerView,
  workerName,
  workerPath,
} from "./workers";

export type AttentionItem =
  | {
      readonly key: string;
      readonly condition: "disconnected" | "incompatible" | "drained";
      readonly worker: WorkerView;
    }
  | {
      readonly key: string;
      readonly condition: "over RAM budget";
      readonly worker: WorkerView;
      readonly usedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly key: string;
      readonly condition: "quarantined" | "stalled";
      readonly worker: WorkerView;
      readonly device: WorkerDevice;
    };

// why: a worker that is both disconnected and drained is two items, since each clears on its own.
export function attentionItems(workers: readonly WorkerView[]): readonly AttentionItem[] {
  return workers.flatMap((worker) => [...workerItems(worker), ...deviceItems(worker)]);
}

function workerItems(worker: WorkerView): AttentionItem[] {
  const items: AttentionItem[] = [];
  const key = (condition: string) => `${worker.id}/${condition}`;
  if (worker.connection === "disconnected" || worker.connection === "incompatible") {
    items.push({ condition: worker.connection, key: key(worker.connection), worker });
  }
  if (worker.drained) items.push({ condition: "drained", key: key("drained"), worker });
  const ramBudget = worker.capacity?.ramBudget;
  if (ramBudget?.overLimit === true) {
    items.push({
      condition: "over RAM budget",
      key: key("ram"),
      limitBytes: ramBudget.limitBytes,
      usedBytes: ramBudget.usedBytes,
      worker,
    });
  }
  return items;
}

function deviceItems(worker: WorkerView): AttentionItem[] {
  return (worker.devices ?? []).flatMap((device): AttentionItem[] => {
    const key = (condition: string) => `${worker.id}/${device.id}/${condition}`;
    if (device.state === "quarantined") {
      return [{ condition: "quarantined", device, key: key("quarantined"), worker }];
    }
    if (device.stalled === true) {
      return [{ condition: "stalled", device, key: key("stalled"), worker }];
    }
    return [];
  });
}

// why: a lost worker or a quarantined device is broken; everything else on the list needs a look
// soon, which is the warning tone, the same split the status words use.
export function attentionTone(condition: AttentionItem["condition"]): Tone {
  return condition === "disconnected" || condition === "incompatible" || condition === "quarantined"
    ? "error"
    : "warn";
}

export interface AttentionRow {
  readonly key: string;
  readonly to: string;
  readonly tone: Tone;
  readonly word: string;
  readonly subject: string;
}

export interface AttentionFact {
  readonly label: string;
  readonly value: string;
}

export interface AttentionEvent {
  readonly key: string;
  readonly time: string;
  readonly name: string;
  readonly tone?: Tone;
  readonly text: string;
  readonly to: string;
}

export interface AttentionDetail {
  readonly key: string;
  readonly title: string;
  readonly tone: Tone;
  readonly word: string;
  readonly worker: { readonly name: string; readonly to: string };
  readonly facts: readonly AttentionFact[];
  readonly events: readonly AttentionEvent[];
}

export interface AttentionPage {
  readonly rows: readonly AttentionRow[];
  // why: a URL can name an item the daemon has since cleared; that is told apart from a list
  // with nothing in it, which has no item to show at all.
  readonly shown: AttentionDetail | "resolved" | undefined;
  readonly named: boolean;
}

const HOUR = 60 * 60 * 1_000;
const EVENT_ROWS = 25;

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function protocolText(versions: { readonly min: number; readonly max: number }): string {
  return versions.min === versions.max
    ? String(versions.min)
    : `${versions.min}\u2013${versions.max}`;
}

function subjectOf(item: AttentionItem): string {
  return "device" in item
    ? `${item.device.spec.model} on ${workerName(item.worker)}`
    : workerName(item.worker);
}

function factsOf(item: AttentionItem, now: number): readonly AttentionFact[] {
  return "device" in item ? deviceFacts(item, now) : workerFacts(item, now);
}

function deviceFacts(
  item: Extract<AttentionItem, { readonly device: unknown }>,
  now: number,
): readonly AttentionFact[] {
  const since = stateEnteredAt(item.device, item.worker);
  return [
    { label: "Device", value: item.device.id },
    { label: "State", value: item.device.state },
    ...(since === undefined
      ? []
      : [{ label: "In this state for", value: formatDuration(now - since) }]),
  ];
}

function workerFacts(
  item: Exclude<AttentionItem, { readonly device: unknown }>,
  now: number,
): readonly AttentionFact[] {
  const { worker } = item;
  if (item.condition === "over RAM budget") {
    return [
      { label: "Used", value: gibibytes(item.usedBytes) },
      { label: "Limit", value: gibibytes(item.limitBytes) },
    ];
  }
  if (item.condition === "disconnected") {
    return [{ label: "Last seen", value: `${formatDuration(now - worker.lastSeenAt)} ago` }];
  }
  if (item.condition === "drained") {
    return [{ label: "Leases still held", value: String(worker.leases?.length ?? 0) }];
  }
  const { protocol } = worker;
  return protocol === undefined
    ? []
    : [
        { label: "Gateway protocol", value: protocolText(protocol.gateway) },
        { label: "Worker protocol", value: protocolText(protocol.worker) },
      ];
}

function namesItem(event: ConsoleEvent, item: AttentionItem): boolean {
  if (workerIdOf(event) === item.worker.id) return true;
  if (!("device" in item)) return false;
  const { payload } = event;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>).deviceId === item.device.id
  );
}

function detailOf(
  item: AttentionItem,
  input: {
    readonly workers: readonly WorkerView[];
    readonly events: readonly ConsoleEvent[];
    readonly now: number;
  },
): AttentionDetail {
  const { events, now, workers } = input;
  return {
    events: events
      .filter((event) => event.timestamp > now - HOUR && namesItem(event, item))
      .sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq)
      .slice(0, EVENT_ROWS)
      .map((event) => {
        const tone = eventTone(event.event);
        return {
          key: event.id,
          name: event.event,
          text: eventSummary(event, workers),
          time: timeOfDay(event.timestamp),
          to: itemPath("/events", event.id),
          ...(tone === undefined ? {} : { tone }),
        };
      }),
    facts: factsOf(item, now),
    key: item.key,
    title:
      "device" in item
        ? `${item.device.spec.model} ${item.device.spec.osVersion}`
        : workerName(item.worker),
    tone: attentionTone(item.condition),
    word: item.condition,
    worker: { name: workerName(item.worker), to: workerPath(item.worker.id) },
  };
}

// why: the list and the inspector are worked out together from the same items, so the row that is
// marked chosen is always the item the inspector shows.
export function attentionPageOf(input: {
  readonly workers: readonly WorkerView[];
  readonly events: readonly ConsoleEvent[];
  readonly now: number;
  readonly key: string | undefined;
}): AttentionPage {
  const items = attentionItems(input.workers);
  const rows = items.map((item) => ({
    key: item.key,
    subject: subjectOf(item),
    to: itemPath("/attention", item.key),
    tone: attentionTone(item.condition),
    word: item.condition,
  }));
  const named = input.key !== undefined;
  const chosen = named ? items.find((item) => item.key === input.key) : items[0];
  if (chosen !== undefined) return { named, rows, shown: detailOf(chosen, input) };
  return { named, rows, shown: named ? "resolved" : undefined };
}
