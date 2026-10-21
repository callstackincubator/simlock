import { eventSummary, eventTone } from "./activity";
import { type ConsoleEvent, timeOfDay, workerIdOf } from "./events";
import { inboxPath, itemPath } from "./paths";
import {
  deviceOfLease,
  eventsOfLease,
  holderName,
  isExpiring,
  type LeaseRecord,
  leasePath,
  type TokenRecord,
} from "./leases";
import { formatDuration } from "./time";
import { requestedDevice, type WaitingRequest } from "./waiting";
import type { Tone } from "./tones";
import {
  stateEnteredAt,
  type WorkerDevice,
  type WorkerView,
  workerName,
  workerPath,
} from "./workers";

export type InboxItem =
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
      readonly condition: "quarantined" | "stalled" | "absent";
      readonly worker: WorkerView;
      readonly device: WorkerDevice;
    }
  | {
      readonly key: string;
      readonly condition: "waiting";
      readonly request: WaitingRequest;
      readonly waitedMs: number;
    }
  | {
      readonly key: string;
      readonly condition: "ending";
      readonly lease: LeaseRecord;
      readonly holder: string;
      readonly model: string;
      readonly leftMs: number;
    };

type WorkerItem = Extract<InboxItem, { readonly worker: unknown }>;

const WAITING_TOO_LONG_MS = 60_000;

export interface InboxContext {
  readonly now: number;
  readonly requests?: readonly WaitingRequest[] | undefined;
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
}

// why: a worker that is both disconnected and drained is two items, since each clears on its own.
export function inboxItems(
  workers: readonly WorkerView[],
  context?: InboxContext,
): readonly InboxItem[] {
  return [
    ...workers.flatMap((worker) => [...workerItems(worker), ...deviceItems(worker)]),
    ...(context === undefined ? [] : waitingItems(context)),
    ...(context === undefined ? [] : endingItems(workers, context)),
  ];
}

// why: a request waits on the daemon's clock, so the wait is counted from the daemon's now; the
// longest wait comes first.
function waitingItems(context: InboxContext): InboxItem[] {
  return [...(context.requests ?? [])]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .flatMap((request): InboxItem[] => {
      const waitedMs = context.now - request.createdAt;
      return waitedMs > WAITING_TOO_LONG_MS
        ? [{ condition: "waiting", key: `request/${request.id}/waiting`, request, waitedMs }]
        : [];
    });
}

// why: a lease's time left counts against the daemon's clock, and the least time left comes first.
function endingItems(workers: readonly WorkerView[], context: InboxContext): InboxItem[] {
  const { now, tokens = [] } = context;
  return [...(context.leases ?? [])]
    .sort((a, b) => a.ttlDeadline - b.ttlDeadline || (a.id < b.id ? -1 : 1))
    .flatMap((lease): InboxItem[] => {
      if (!isExpiring(lease.ttlDeadline, now)) return [];
      return [
        {
          condition: "ending",
          holder: holderName(lease.requesterId, tokens),
          key: `lease/${lease.id}/ending`,
          lease,
          leftMs: lease.ttlDeadline - now,
          model: deviceOfLease(lease, workers)?.spec.model ?? lease.deviceId,
        },
      ];
    });
}

function workerItems(worker: WorkerView): InboxItem[] {
  const items: InboxItem[] = [];
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

function deviceItems(worker: WorkerView): InboxItem[] {
  return (worker.devices ?? []).flatMap((device): InboxItem[] => {
    const key = (condition: string) => `${worker.id}/${device.id}/${condition}`;
    if (device.state === "quarantined") {
      return [{ condition: "quarantined", device, key: key("quarantined"), worker }];
    }
    if (device.stalled === true) {
      return [{ condition: "stalled", device, key: key("stalled"), worker }];
    }
    if (device.state === "absent") {
      return [{ condition: "absent", device, key: key("absent"), worker }];
    }
    return [];
  });
}

const GROUPS: readonly InboxGroup[] = ["Broken", "Needs a look", "Heads-up"];

export function inboxGroup(item: InboxItem): InboxGroup {
  if (item.condition === "ending") return "Heads-up";
  return inboxTone(item.condition) === "error" ? "Broken" : "Needs a look";
}

// why: a heads-up is not a problem yet, so the count the sidebar and Overview show leaves it out.
export function problemCount(items: readonly InboxItem[]): number {
  return items.filter((item) => inboxGroup(item) !== "Heads-up").length;
}

// why: the Inbox lists its groups in a fixed order, each keeping the order its items came in.
export function inGroupOrder(items: readonly InboxItem[]): readonly InboxItem[] {
  return GROUPS.flatMap((group) => items.filter((item) => inboxGroup(item) === group));
}

// why: a lost worker or a quarantined device is broken; everything else on the list needs a look
// soon, which is the warning tone, the same split the status words use.
export function inboxTone(condition: InboxItem["condition"]): Tone {
  return condition === "disconnected" || condition === "incompatible" || condition === "quarantined"
    ? "error"
    : "warn";
}

export type InboxGroup = "Broken" | "Needs a look" | "Heads-up";

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

export function inboxSubject(item: InboxItem): string {
  if (item.condition === "waiting") {
    return `${item.request.requesterId} has waited ${formatDuration(item.waitedMs)}`;
  }
  if (item.condition === "ending") {
    const base = `${item.holder} · ${item.model} ends`;
    return item.leftMs <= 0 ? `${base} now` : `${base} in ${minutesAndSeconds(item.leftMs)}`;
  }
  if (item.condition === "absent") {
    // why: the daemon names a reason for every absent phone; "not-present" is the plain fallback for a record that lacks one.
    return `${item.device.spec.model} is absent (${item.device.absentReason ?? "not-present"})`;
  }
  return "device" in item
    ? `${item.device.spec.model} on ${workerName(item.worker)}`
    : workerName(item.worker);
}

function factsOf(item: InboxItem, now: number): readonly InboxFact[] {
  if (item.condition === "waiting") {
    return [
      { label: "Waited", value: formatDuration(item.waitedMs) },
      { label: "Device", value: requestedDevice(item.request.spec) },
      { label: "Request", value: item.request.id },
    ];
  }
  if (item.condition === "ending") {
    return [
      { label: "Time left", value: timeLeft(item.leftMs) },
      { label: "Device", value: item.model },
      { label: "Holder", value: item.holder },
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

type Say = { readonly [C in InboxItem["condition"]]: (item: ItemOf<C>) => string };

const SAY: Say = {
  absent: (item) => `${inboxSubject(item)}: the phone cannot be reached.`,
  disconnected: (item) => `${workerName(item.worker)} has lost its connection to the gateway.`,
  drained: (item) => `${workerName(item.worker)} is drained: it takes no new leases.`,
  ending: (item) =>
    `${item.holder}'s lease on ${item.model} ${
      item.leftMs <= 0 ? "ends now" : `ends in ${minutesAndSeconds(item.leftMs)}`
    }.`,
  incompatible: (item) => `${workerName(item.worker)} runs a protocol this gateway cannot talk to.`,
  "over RAM budget": (item) =>
    `${workerName(item.worker)} uses more memory than its budget allows.`,
  quarantined: (item) =>
    `${item.device.spec.model} is quarantined and cannot be leased until it is dealt with.`,
  stalled: (item) => `${item.device.spec.model} has stayed in one state longer than expected.`,
  waiting: (item) =>
    `${item.request.requesterId} has waited ${formatDuration(item.waitedMs)} for a device.`,
};

function whatHappened(item: InboxItem): string {
  return (SAY[item.condition] as (item: InboxItem) => string)(item);
}

function deviceFacts(
  item: Extract<InboxItem, { readonly device: unknown }>,
  now: number,
): readonly InboxFact[] {
  const since = stateEnteredAt(item.device, item.worker);
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
      workerIdOf(event) === item.worker.id ||
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
      name: `${item.holder} · ${item.model}`,
      open: "Open lease",
      to: leasePath(item.lease.id),
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
    tone: inboxTone(item.condition),
    what: whatHappened(item),
    word: item.condition,
  };
}

// why: the rows and the drawer's detail are worked out together from the same items, so they
// never disagree.
export function inboxPageOf(input: {
  readonly workers: readonly WorkerView[];
  readonly events: readonly ConsoleEvent[];
  readonly now: number;
  readonly key: string | undefined;
  readonly requests?: readonly WaitingRequest[] | undefined;
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
}): InboxPage {
  const items = inboxItems(input.workers, input);
  const rows = inGroupOrder(items).map((item) => ({
    group: inboxGroup(item),
    key: item.key,
    subject: inboxSubject(item),
    to: inboxPath(item.key),
    tone: inboxTone(item.condition),
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
