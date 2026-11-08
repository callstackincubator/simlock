import { type InboxItem, inGroupOrder, inboxSubject, minutesAndSeconds } from "./inbox";
import { platformSlots } from "./fleet";
import { agentKind, shortHolder, type AgentKind } from "./holder";
import { isExpiring } from "../../../src/contract/inbox";
import { type LeaseRecord, type LeaseRowView, leaseRows } from "./leases";
import type { FiguresState } from "./figures";
import { formatCount } from "./paging";
import { inboxPath } from "./paths";
import { type ConsoleRange, usagePath } from "./range";
import { formatDuration } from "./time";
import { type WaitingRequest, waitingTable } from "./waiting";
import { type FleetRow, fleetGroups } from "./worker-page";
import { isUnread, leasesHeld, type WorkerDevice, type WorkerView } from "./workers";

export interface OverviewTile {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly to?: string;
}

export interface OverviewBanner {
  readonly count: number;
  readonly title: string;
  readonly first: { readonly text: string; readonly to: string };
  readonly more: number;
}

// why: the card shows the first rows of the Fleet page's own grouping, a worker with anything wrong
// first; `total` is every worker, so the card can say how many it leaves to the page.
export interface OverviewFleet {
  readonly attention: readonly FleetRow[];
  readonly healthy: readonly FleetRow[];
  readonly total: number;
}

const FLEET_CARD_ROWS = 8;

export interface QueueRow {
  readonly key: string;
  readonly place: string;
  readonly to: string;
  readonly holder: string;
  readonly holderTitle: string;
  readonly kind: AgentKind;
  readonly waited: string;
}

export interface QueueCard {
  readonly meta: string;
  readonly rows: readonly QueueRow[];
}

export interface EndingRow {
  readonly key: string;
  readonly to: string;
  readonly holder: string;
  readonly holderTitle: string;
  readonly kind: AgentKind;
  readonly sub: string;
  readonly remaining: string;
  readonly percent: number;
}

export interface EndingCard {
  readonly meta: string;
  readonly rows: readonly EndingRow[];
}

export interface CapacityPart {
  readonly count: number;
  readonly kind: PartKind;
  readonly percent: number;
  readonly word: string;
}

export interface PlatformCapacity {
  readonly name: string;
  readonly leased: number;
  readonly total: number;
  readonly parts: readonly CapacityPart[];
  readonly notRead: number;
}

export interface Overview {
  readonly banner?: OverviewBanner;
  readonly tiles: readonly OverviewTile[];
  readonly fleet: OverviewFleet;
  readonly capacity: readonly PlatformCapacity[];
  // why: a refused read of the requests is "not known", never an empty queue.
  readonly queue: QueueCard | { readonly unavailable: string };
  readonly ending: EndingCard | { readonly unavailable: string };
  readonly figures: FiguresState;
  readonly updated?: string;
}

const QUEUE_ROWS = 3;
const ENDING_ROWS = 2;

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
  { kind: "free", word: "free" },
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

function devicePartsOf(worker: WorkerView, platform: "ios" | "android"): readonly PartKind[] {
  return (worker.devices ?? []).flatMap((device) => {
    const part = device.spec.platform === platform ? partOf(worker, device) : undefined;
    return part === undefined ? [] : [part];
  });
}

function platformCapacity(
  workers: readonly WorkerView[],
  platform: "ios" | "android",
): PlatformCapacity {
  const counts = new Map<PartKind, number>();
  const add = (kind: PartKind, count: number) => counts.set(kind, (counts.get(kind) ?? 0) + count);
  for (const worker of workers) {
    for (const part of devicePartsOf(worker, platform)) add(part, 1);
    // why: the bar is the room every worker may run, so a full bar means no room left.
    add("free", platformSlots(worker, platform).filter((slot) => slot.kind === "free").length);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return {
    leased: counts.get("leased") ?? 0,
    total,
    name: platform === "ios" ? "iOS" : "Android",
    notRead: workers.filter(isUnread).length,
    parts: PARTS.flatMap(({ kind, word }) => {
      const count = counts.get(kind) ?? 0;
      return count === 0 ? [] : [{ count, kind, percent: percentOf(count, total), word }];
    }),
  };
}

function tiles(input: {
  readonly workers: readonly WorkerView[];
  readonly requests: readonly WaitingRequest[] | undefined;
  readonly leases: readonly LeaseRecord[] | undefined;
  readonly figures: FiguresState;
  readonly range: ConsoleRange;
  readonly now: number;
}): readonly OverviewTile[] {
  const { figures, leases, now, range, requests, workers } = input;
  const held = leasesHeld(workers);
  const connected = workers.filter((worker) => worker.connection === "connected").length;
  const devices = workers.flatMap((worker) =>
    (worker.devices ?? []).filter((entry) => entry.state !== "deleted"),
  );
  const ready = devices.filter((entry) => entry.state === "ready").length;
  const oldest = requests === undefined ? 0 : Math.min(...requests.map((r) => r.createdAt));
  const ending = leases?.filter((lease) => isExpiring(lease.ttlDeadline, now)).length;
  const wait = figures.kind === "ready" ? figures.data.wait : undefined;
  return [
    {
      label: "Leased",
      to: "/leases",
      ...(held === undefined ? {} : { unit: `/ ${formatCount(devices.length)}` }),
      value: held === undefined ? "—" : formatCount(held),
    },
    { label: "Ready", to: "/fleet", unit: "warm", value: formatCount(ready) },
    {
      label: "Waiting",
      to: "/queue",
      ...(requests === undefined
        ? {}
        : { unit: requests.length === 0 ? "none" : `max ${formatDuration(now - oldest)}` }),
      value: requests === undefined ? "—" : formatCount(requests.length),
    },
    {
      label: "Wait p95",
      to: usagePath(range),
      ...(wait === undefined ? {} : { unit: wait.unit }),
      value: wait === undefined ? "—" : wait.value,
    },
    {
      label: "Ending soon",
      to: "/leases",
      ...(ending === undefined ? {} : { unit: "< 5 min" }),
      value: ending === undefined ? "—" : formatCount(ending),
    },
    {
      label: "Workers",
      to: "/fleet",
      unit: `/ ${formatCount(workers.length)}`,
      value: formatCount(connected),
    },
  ];
}

// why: the same list and order the Inbox shows, problems only, so the first one is the Inbox's.
function bannerOf(items: readonly InboxItem[], now: number): OverviewBanner | undefined {
  const problems = inGroupOrder(items).filter((item) => item.group !== "Heads-up");
  const first = problems[0];
  if (first === undefined) return undefined;
  return {
    count: problems.length,
    first: {
      text: `${inboxSubject(first, now)} · ${first.condition}`,
      to: inboxPath(first.key),
    },
    more: problems.length - 1,
    title:
      problems.length === 1
        ? "1 thing needs you"
        : `${formatCount(problems.length)} things need you`,
  };
}

function queueOf(
  requests: readonly WaitingRequest[],
  workers: readonly WorkerView[],
  now: number,
): QueueCard {
  const table = waitingTable(requests, workers, now);
  return {
    meta: table.meta,
    rows: table.rows.slice(0, QUEUE_ROWS).map((row, index) => ({
      holder: shortHolder(row.requester),
      holderTitle: row.requester,
      key: row.key,
      kind: agentKind(row.requester),
      place: row.place === "—" ? `#${index + 1}` : row.place,
      to: row.to,
      waited: row.waited,
    })),
  };
}

// why: the same rule the Leases filter and the Inbox use, against the daemon's clock, soonest first.
function endingOf(
  leases: readonly LeaseRecord[],
  workers: readonly WorkerView[],
  now: number,
): EndingCard {
  const soon = leases
    .filter((lease) => isExpiring(lease.ttlDeadline, now))
    .toSorted((a, b) => a.ttlDeadline - b.ttlDeadline);
  const rows = soon.slice(0, ENDING_ROWS).flatMap((lease) =>
    leaseRows({ leases: [lease], now, tokens: [], workers }).map(
      (row: LeaseRowView): EndingRow => ({
        holder: row.holderDisplay,
        holderTitle: row.holderTitle,
        key: row.key,
        kind: row.holderKind,
        percent: row.percent,
        remaining: lease.ttlDeadline <= now ? "now" : minutesAndSeconds(lease.ttlDeadline - now),
        sub: row.sub,
        to: row.to,
      }),
    ),
  );
  return { meta: `${formatCount(soon.length)} under 5 min`, rows };
}

function fleetOf(workers: readonly WorkerView[], now: number): OverviewFleet {
  const groups = fleetGroups(workers, "", now);
  const attention = groups.attention.slice(0, FLEET_CARD_ROWS);
  return {
    attention,
    healthy: groups.healthy.slice(0, FLEET_CARD_ROWS - attention.length),
    total: workers.length,
  };
}

function clockOf(at: number): string {
  return [new Date(at).getHours(), new Date(at).getMinutes(), new Date(at).getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

// why: the overview reads routes the other pages read too, and every figure on it is worked
// out here from those, so a figure on the overview and the same figure on its page always agree.
export function overviewOf(input: {
  readonly workers: readonly WorkerView[];
  // why: undefined is a refused read of the requests; a daemon with no queue of its own sends [].
  readonly requests: readonly WaitingRequest[] | undefined;
  readonly queueRefusal?: string;
  readonly items?: readonly InboxItem[];
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly figures?: FiguresState;
  readonly range?: ConsoleRange;
  readonly updatedAt?: number | undefined;
  readonly now: number;
}): Overview {
  const { figures = { kind: "loading" }, items = [], leases, now, requests, workers } = input;
  const { queueRefusal = "The queue could not be read.", range = "1h" } = input;
  const banner = bannerOf(items, now);
  return {
    capacity: [platformCapacity(workers, "ios"), platformCapacity(workers, "android")],
    ending:
      leases === undefined
        ? { unavailable: "The leases could not be read." }
        : endingOf(leases, workers, now),
    figures,
    fleet: fleetOf(workers, now),
    queue: requests === undefined ? { unavailable: queueRefusal } : queueOf(requests, workers, now),
    tiles: tiles({ figures, leases, now, range, requests, workers }),
    ...(banner === undefined ? {} : { banner }),
    ...(input.updatedAt === undefined ? {} : { updated: clockOf(input.updatedAt) }),
  };
}
