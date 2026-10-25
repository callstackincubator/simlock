import type { z } from "zod";

import { describeRequestedDevice, problemCount } from "../../../src/contract/inbox";
import type { inboxItemSchema } from "../../../src/contract/index";
import { eventSummary, eventTone } from "./activity";
import { type ConsoleEvent, timeOfDay, workerIdOf } from "./events";
import { eventsOfLease, leasePath } from "./leases";
import { inboxPath, itemPath } from "./paths";
import { formatDuration } from "./time";
import type { Tone } from "./tones";
import { type WorkerView, workerName, workerPath } from "./workers";

// why: the item is the daemon's (`inbox.get`): the console decides nothing about what needs the operator.
export type InboxItem = z.infer<typeof inboxItemSchema>;

export interface InboxList {
  readonly items: readonly InboxItem[];
}

type WorkerItem = Extract<InboxItem, { readonly worker: unknown }>;

const GROUPS: readonly InboxGroup[] = ["Broken", "Needs a look", "Heads-up"];

// why: the Inbox lists its groups in a fixed order, each keeping the order its items came in.
export function inGroupOrder(items: readonly InboxItem[]): readonly InboxItem[] {
  return GROUPS.flatMap((group) => items.filter((item) => item.group === group));
}

// why: a broken item is the error tone; everything else on the list needs a look soon, which is the
// warning tone, the same split the status words use.
export function inboxTone(group: InboxGroup): Tone {
  return group === "Broken" ? "error" : "warn";
}

export type InboxGroup = InboxItem["group"];

export type InboxFilter = "all" | InboxGroup;

export const INBOX_FILTERS: readonly { readonly value: InboxFilter; readonly label: string }[] = [
  { label: "All", value: "all" },
  ...GROUPS.map((group) => ({ label: group, value: group })),
];

export function filterInboxRows(
  rows: readonly InboxRow[],
  filter: InboxFilter,
): readonly InboxRow[] {
  return filter === "all" ? rows : rows.filter((row) => row.group === filter);
}

export interface InboxRow {
  readonly group: InboxGroup;
  readonly key: string;
  readonly to: string;
  readonly tone: Tone;
  readonly word: string;
  readonly subject: string;
}

export interface InboxFact {
  readonly label: string;
  readonly value: string;
}

export interface InboxEvent {
  readonly key: string;
  readonly time: string;
  readonly name: string;
  readonly tone?: Tone;
  readonly text: string;
  readonly to: string;
}

export interface InboxDetail {
  readonly key: string;
  readonly title: string;
  readonly tone: Tone;
  readonly word: string;
  // why: the box at the top of the drawer, saying in a sentence what the Inbox found.
  readonly what: string;
  readonly about: { readonly name: string; readonly to: string; readonly open: string };
  readonly facts: readonly InboxFact[];
  readonly events: readonly InboxEvent[];
}

export interface InboxPage {
  readonly problems: number;
  readonly rows: readonly InboxRow[];
  // why: a URL can name an item the daemon has since cleared; that is told apart from a list
  // with nothing in it, which has no item to show at all.
  readonly shown: InboxDetail | "resolved" | undefined;
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

function minutesAndSeconds(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// why: the daemon sends each time as the subject's own timestamp and the console counts from them
// against the daemon's clock, so the wait and the time left tick between reads.
function waitedMs(item: Extract<InboxItem, { readonly request: unknown }>, now: number): number {
  return now - item.request.createdAt;
}

function leftMs(item: Extract<InboxItem, { readonly lease: unknown }>, now: number): number {
  return item.lease.ttlDeadline - now;
}

function deviceWorkerName(device: {
  readonly workerId: string;
  readonly workerLabel?: string | undefined;
}): string {
  return device.workerLabel ?? device.workerId;
}

export function inboxSubject(item: InboxItem, now: number): string {
  if (item.condition === "waiting") {
    return `${item.request.requesterId} has waited ${formatDuration(waitedMs(item, now))}`;
  }
  if (item.condition === "ending") {
    const base = `${item.lease.holder} · ${item.lease.model} ends`;
    const left = leftMs(item, now);
    return left <= 0 ? `${base} now` : `${base} in ${minutesAndSeconds(left)}`;
  }
  if (item.condition === "absent") {
    // why: the daemon names a reason for every absent phone; "not-present" is the plain fallback for a record that lacks one.
    return `${item.device.spec.model} is absent (${item.device.absentReason ?? "not-present"})`;
  }
  return "device" in item
    ? `${item.device.spec.model} on ${deviceWorkerName(item.device)}`
    : workerName(item.worker);
}

function factsOf(item: InboxItem, now: number): readonly InboxFact[] {
  if (item.condition === "waiting") {
    return [
      { label: "Waited", value: formatDuration(waitedMs(item, now)) },
      { label: "Device", value: describeRequestedDevice(item.request.spec) },
      { label: "Request", value: item.request.id },
    ];
  }
  if (item.condition === "ending") {
    return [
      { label: "Time left", value: timeLeft(leftMs(item, now)) },
      { label: "Device", value: item.lease.model },
      { label: "Holder", value: item.lease.holder },
      { label: "Lease", value: item.lease.id },
    ];
  }
  return "device" in item ? deviceFacts(item, now) : workerFacts(item, now);
}

function timeLeft(leftMs: number): string {
  return leftMs <= 0 ? "now" : minutesAndSeconds(leftMs);
}

// why: each sentence says what the daemon found and what it means, so the drawer opens on the
// reason before the details.
// why: `Extract` finds nothing for a condition that shares its item shape with others (a worker's
// three), so each item is matched by whether its condition type holds this one.
type ItemOf<C extends InboxItem["condition"]> = InboxItem extends infer I
  ? I extends { readonly condition: infer K }
    ? [C] extends [K]
      ? I
      : never
    : never
  : never;

type Say = { readonly [C in InboxItem["condition"]]: (item: ItemOf<C>, now: number) => string };

const SAY: Say = {
  absent: (item, now) => `${inboxSubject(item, now)}: the phone cannot be reached.`,
  disconnected: (item) => `${workerName(item.worker)} has lost its connection to the gateway.`,
  drained: (item) => `${workerName(item.worker)} is drained: it takes no new leases.`,
  ending: (item, now) =>
    `${item.lease.holder}'s lease on ${item.lease.model} ${
      leftMs(item, now) <= 0 ? "ends now" : `ends in ${minutesAndSeconds(leftMs(item, now))}`
    }.`,
  incompatible: (item) => `${workerName(item.worker)} runs a protocol this gateway cannot talk to.`,
  "over RAM budget": (item) =>
    `${workerName(item.worker)} uses more memory than its budget allows.`,
  quarantined: (item) =>
    `${item.device.spec.model} is quarantined and cannot be leased until it is dealt with.`,
  stalled: (item) => `${item.device.spec.model} has stayed in one state longer than expected.`,
  "update failed": (item) => {
    const failure = item.worker.lastUpdateFailure;
    return failure === undefined || failure === null
      ? ""
      : `The update of ${workerName(item.worker)} to ${failure.to} failed while ${failure.stage}: ${failure.message}. It runs ${failure.from} again.`;
  },
  waiting: (item, now) =>
    `${item.request.requesterId} has waited ${formatDuration(waitedMs(item, now))} for a device.`,
};

function whatHappened(item: InboxItem, now: number): string {
  return (SAY[item.condition] as (item: InboxItem, now: number) => string)(item, now);
}

function deviceFacts(
  item: Extract<InboxItem, { readonly device: unknown }>,
  now: number,
): readonly InboxFact[] {
  const since = item.device.stateEnteredAt;
  return [
    { label: "Device", value: item.device.id },
    { label: "State", value: item.device.state },
    ...(since === undefined
      ? []
      : [{ label: "In this state for", value: formatDuration(now - since) }]),
    ...causeFacts(item.device),
  ];
}

const CAUSE_TEXT = {
  "purge-failed": "Purge failed",
  "shutdown-failed": "Shutdown failed",
  "delete-failed": "Delete failed",
} as const;

function causeFacts(device: {
  readonly state: string;
  readonly quarantineCause?:
    | {
        readonly kind: keyof typeof CAUSE_TEXT | "stalled";
        readonly stalledState?: string | undefined;
        readonly message?: string | undefined;
      }
    | undefined;
}): readonly InboxFact[] {
  const cause = device.quarantineCause;
  if (device.state !== "quarantined" || cause === undefined) return [];
  if (cause.kind === "stalled") {
    return [{ label: "Cause", value: `Stalled while ${cause.stalledState ?? ""}` }];
  }
  const text = CAUSE_TEXT[cause.kind];
  return [
    { label: "Cause", value: cause.message === undefined ? text : `${text}: ${cause.message}` },
  ];
}

function updateFailureFacts(worker: WorkerItem["worker"], now: number): readonly InboxFact[] {
  const failure = worker.lastUpdateFailure;
  return failure === undefined || failure === null
    ? []
    : [
        { label: "From", value: failure.from },
        { label: "To", value: failure.to },
        { label: "Stage", value: failure.stage },
        { label: "When", value: `${formatDuration(now - failure.at)} ago` },
      ];
}

function workerFacts(
  item: Exclude<WorkerItem, { readonly device: unknown }>,
  now: number,
): readonly InboxFact[] {
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
    return [{ label: "Leases still held", value: String(worker.heldLeases) }];
  }
  if (item.condition === "update failed") return updateFailureFacts(worker, now);
  const { protocol } = worker;
  return protocol === undefined
    ? []
    : [
        { label: "Gateway protocol", value: protocolText(protocol.gateway) },
        { label: "Worker protocol", value: protocolText(protocol.worker) },
      ];
}

function payloadField(event: ConsoleEvent, field: string): unknown {
  const { payload } = event;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[field]
    : undefined;
}

function eventsOfItem(item: InboxItem, events: readonly ConsoleEvent[]): readonly ConsoleEvent[] {
  if (item.condition === "ending") return eventsOfLease(events, item.lease.id);
  if (item.condition === "waiting") {
    return events.filter((event) => payloadField(event, "requestId") === item.request.id);
  }
  return events.filter(
    (event) =>
      workerIdOf(event) === ("device" in item ? item.device.workerId : item.worker.id) ||
      ("device" in item && payloadField(event, "deviceId") === item.device.id),
  );
}

function aboutOf(item: InboxItem): InboxDetail["about"] {
  if (item.condition === "waiting") {
    return {
      name: item.request.requesterId,
      open: "Open request",
      to: itemPath("/queue", item.request.id),
    };
  }
  if (item.condition === "ending") {
    return {
      name: `${item.lease.holder} · ${item.lease.model}`,
      open: "Open lease",
      to: leasePath(item.lease.id),
    };
  }
  if ("device" in item) {
    return {
      name: deviceWorkerName(item.device),
      open: "Open worker",
      to: workerPath(item.device.workerId),
    };
  }
  return { name: workerName(item.worker), open: "Open worker", to: workerPath(item.worker.id) };
}

function titleOf(item: InboxItem): string {
  if ("device" in item) return `${item.device.spec.model} ${item.device.spec.osVersion}`;
  return aboutOf(item).name;
}

function detailOf(
  item: InboxItem,
  input: {
    readonly workers: readonly WorkerView[];
    readonly events: readonly ConsoleEvent[];
    readonly now: number;
  },
): InboxDetail {
  const { events, now, workers } = input;
  return {
    about: aboutOf(item),
    events: eventsOfItem(
      item,
      events.filter((event) => event.timestamp > now - HOUR),
    )
      .toSorted((a, b) => b.timestamp - a.timestamp || b.seq - a.seq)
      .slice(0, EVENT_ROWS)
      .map((event) => {
        const tone = eventTone(event.event);
        return {
          key: event.id,
          name: event.event,
          text: eventSummary(event, workers),
          time: timeOfDay(event.timestamp),
          to: itemPath("/activity", event.id),
          ...(tone === undefined ? {} : { tone }),
        };
      }),
    facts: factsOf(item, now),
    key: item.key,
    title: titleOf(item),
    tone: inboxTone(item.group),
    what: whatHappened(item, now),
    word: item.condition,
  };
}

// why: the rows and the drawer's detail are worked out together from the same items, so they
// never disagree.
export function inboxPageOf(input: {
  readonly items: readonly InboxItem[];
  readonly workers: readonly WorkerView[];
  readonly events: readonly ConsoleEvent[];
  readonly now: number;
  readonly key: string | undefined;
}): InboxPage {
  const { items, now } = input;
  const rows = inGroupOrder(items).map((item) => ({
    group: item.group,
    key: item.key,
    subject: inboxSubject(item, now),
    to: inboxPath(item.key),
    tone: inboxTone(item.group),
    word: item.condition,
  }));
  const named = input.key !== undefined;
  const chosen = named ? items.find((item) => item.key === input.key) : items[0];
  const problems = problemCount(items);
  if (chosen !== undefined) {
    return { named, problems, rows, shown: detailOf(chosen, input) };
  }
  return { named, problems, rows, shown: named ? "resolved" : undefined };
}
