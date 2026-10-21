import {
  inboxGroup,
  type InboxContext,
  inboxItems,
  inGroupOrder,
  inboxSubject,
  inboxTone,
} from "./inbox";
import { isExpiring, type LeaseRecord, type TokenRecord } from "./leases";
import type { FiguresState } from "./figures";
import { formatCount } from "./paging";
import { inboxPath } from "./paths";
import { formatDuration } from "./time";
import type { Tone } from "./tones";
import type { WaitingRequest } from "./waiting";
import { type WorkerRow, workerRow } from "./worker-page";
import { isUnread, leasesHeld, type WorkerDevice, type WorkerView } from "./workers";

export interface OverviewTile {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly to?: string;
}

export interface OverviewItem {
  readonly key: string;
  readonly word: string;
  readonly tone: Tone;
  readonly subject: string;
  readonly to: string;
}

export interface OverviewInbox {
  // why: a read that failed leaves the Inbox unchecked there, so the page never says it is clear.
  readonly couldNotCheck: readonly string[];
  readonly problems: number;
  readonly needsYou: readonly OverviewItem[];
}

export interface CapacityPart {
  readonly count: number;
  readonly kind: PartKind;
  readonly percent: number;
  readonly word: string;
}

export interface PlatformCapacity {
  readonly name: string;
  readonly parts: readonly CapacityPart[];
  readonly notRead: number;
}

export interface Overview {
  readonly capacity: readonly PlatformCapacity[];
  readonly tiles: readonly OverviewTile[];
  readonly wait?: OverviewTile;
  readonly ending: OverviewTile;
  readonly figures: FiguresState;
  readonly workers: readonly WorkerRow[];
  readonly inbox: OverviewInbox;
}

const NEEDS_YOU_ROWS = 4;

function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}

const PARTS = [
  { kind: "leased", word: "leased" },
  { kind: "ready", word: "ready" },
  { kind: "busy", word: "booting" },
  { kind: "drained", word: "drained" },
  { kind: "broken", word: "quarantined" },
  { kind: "absent", word: "absent" },
  { kind: "shutdown", word: "shut down" },
  { kind: "offline", word: "offline" },
] as const;

export type PartKind = (typeof PARTS)[number]["kind"];

const PART_OF_STATE: Readonly<Record<string, PartKind>> = {
  absent: "absent",
  leased: "leased",
  provisioning: "busy",
  quarantined: "broken",
  ready: "ready",
  reclaiming: "busy",
  shutdown: "shutdown",
};

// why: where a device is decides before what it is doing: on a worker that is not connected its
// state is the last one heard, so it counts as offline; on a drained worker a ready device is
// not available to lease, so it counts as drained.
function partOf(worker: WorkerView, device: WorkerDevice): PartKind | undefined {
  if (device.state === "deleted") return undefined;
  if (worker.connection !== "connected") return "offline";
  if (device.state === "ready" && worker.drained) return "drained";
  return PART_OF_STATE[device.state];
}

function platformCapacity(
  workers: readonly WorkerView[],
  platform: "ios" | "android",
): PlatformCapacity {
  const counts = new Map<PartKind, number>();
  for (const worker of workers) {
    for (const device of worker.devices ?? []) {
      const part = device.spec.platform === platform ? partOf(worker, device) : undefined;
      if (part !== undefined) counts.set(part, (counts.get(part) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return {
    name: platform === "ios" ? "iOS" : "Android",
    notRead: workers.filter(isUnread).length,
    parts: PARTS.flatMap(({ kind, word }) => {
      const count = counts.get(kind) ?? 0;
      return count === 0 ? [] : [{ count, kind, percent: percentOf(count, total), word }];
    }),
  };
}

function tiles(
  workers: readonly WorkerView[],
  requests: readonly WaitingRequest[],
  now: number,
): readonly OverviewTile[] {
  const held = leasesHeld(workers);
  const connected = workers.filter((worker) => worker.connection === "connected").length;
  const oldest = Math.min(...requests.map((request) => request.createdAt));
  const devices = workers.flatMap((worker) =>
    (worker.devices ?? []).filter((entry) => entry.state !== "deleted"),
  );
  const ready = devices.filter((entry) => entry.state === "ready").length;
  return [
    {
      label: "Leased",
      to: "/leases",
      ...(held === undefined ? {} : { unit: `of ${formatCount(devices.length)} · ${ready} ready` }),
      value: held === undefined ? "—" : formatCount(held),
    },
    {
      label: "Waiting",
      to: "/queue",
      unit: requests.length === 0 ? "none" : `longest ${formatDuration(now - oldest)}`,
      value: formatCount(requests.length),
    },
    {
      label: "Workers",
      to: "/fleet",
      unit: `of ${formatCount(workers.length)}`,
      value: formatCount(connected),
    },
  ];
}

// why: the same rule the Leases filter and the Inbox use, against the daemon's clock; a failed read
// of the leases is "not known", not none.
function endingSoon(leases: readonly LeaseRecord[] | undefined, now: number): OverviewTile {
  const count = leases?.filter((lease) => isExpiring(lease.ttlDeadline, now)).length;
  return {
    label: "Ending soon",
    to: "/leases",
    ...(count === undefined ? {} : { unit: "under 5 min" }),
    value: count === undefined ? "—" : formatCount(count),
  };
}

// why: Needs you lists problems only, in the Inbox's own order, so its first rows are the Inbox's.
function inboxOf(input: {
  readonly workers: readonly WorkerView[];
  readonly couldNotCheck: readonly string[];
  readonly context: InboxContext;
}): OverviewInbox {
  const { context, couldNotCheck, workers } = input;
  const problems = inGroupOrder(inboxItems(workers, context)).filter(
    (item) => inboxGroup(item) !== "Heads-up",
  );
  return {
    needsYou: problems.slice(0, NEEDS_YOU_ROWS).map((item) => ({
      key: item.key,
      subject: inboxSubject(item),
      to: inboxPath(item.key),
      tone: inboxTone(item.condition),
      word: item.condition,
    })),
    couldNotCheck,
    problems: problems.length,
  };
}

// why: the overview reads three routes the other pages read too, and every figure on it is worked
// out here from those, so a figure on the overview and the same figure on its page always agree.
export function overviewOf(input: {
  readonly workers: readonly WorkerView[];
  readonly requests: readonly WaitingRequest[];
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
  readonly figures?: FiguresState;
  readonly couldNotCheck?: readonly string[];
  readonly now: number;
}): Overview {
  const {
    couldNotCheck = [],
    figures = { kind: "loading" },
    leases,
    now,
    requests,
    tokens,
    workers,
  } = input;
  return {
    capacity: [platformCapacity(workers, "ios"), platformCapacity(workers, "android")],
    ending: endingSoon(leases, now),
    inbox: inboxOf({
      context: { leases, now, requests, tokens },
      couldNotCheck,
      workers,
    }),
    figures,
    tiles: tiles(workers, requests, now),
    ...(figures.kind === "ready" ? { wait: figures.data.wait } : {}),
    workers: workers.map((worker) => workerRow(worker)),
  };
}
