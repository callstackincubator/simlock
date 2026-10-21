import { eventSummary, eventTone } from "./activity";
import {
  inboxGroup,
  type InboxContext,
  inboxItems,
  inGroupOrder,
  inboxSubject,
  inboxTone,
} from "./inbox";
import { isExpiring, type LeaseRecord, type TokenRecord } from "./leases";
import type { ConsoleEvent } from "./events";
import { type DeviceSlot, slotsLabel, workerHealth, workerSlots } from "./fleet";
import type { FiguresState } from "./figures";
import { minuteLabel } from "./history";
import { formatBusyPercent, loadGauges } from "./load";
import { levelOf } from "./load-thresholds";
import { formatCount } from "./paging";
import { itemPath } from "./paths";
import { formatDuration } from "./time";
import type { Tone, Toned } from "./tones";
import type { WaitingRequest } from "./waiting";
import { isUnread, leasesHeld, type WorkerView, workerName, workerPath } from "./workers";

export interface OverviewTile {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly to?: string;
}

export interface PlatformUse {
  readonly name: string;
  readonly running?: number;
  readonly limit?: number;
  readonly leasedPercent: number;
  readonly readyPercent: number;
  readonly busyPercent: number;
}

export interface Gauge {
  readonly percent: number;
  readonly text: string;
  readonly tone: Tone | "neutral";
}

export interface OverviewWorker {
  readonly id: string;
  readonly name: string;
  readonly to: string;
  readonly health: Toned;
  readonly slots: readonly DeviceSlot[];
  readonly slotsLabel: string;
  readonly cpu?: Gauge;
  readonly memory?: Gauge;
  readonly leases?: number;
}

export interface OverviewItem {
  readonly key: string;
  readonly word: string;
  readonly tone: Tone;
  readonly subject: string;
  readonly to: string;
}

export interface OverviewActivity {
  readonly key: string;
  readonly time: string;
  readonly name: string;
  readonly tone?: Tone;
  readonly text: string;
  readonly to: string;
}

export interface OverviewInbox {
  // why: a read that failed leaves the Inbox unchecked there, so the page never says it is clear.
  readonly couldNotCheck: readonly string[];
  readonly problems: number;
  readonly needsYou: readonly OverviewItem[];
}

export interface Overview {
  readonly tiles: readonly OverviewTile[];
  readonly wait?: OverviewTile;
  readonly ending: OverviewTile;
  readonly figures: FiguresState;
  readonly platforms: readonly PlatformUse[];
  readonly workers: readonly OverviewWorker[];
  readonly inbox: OverviewInbox;
  readonly activity: readonly OverviewActivity[];
}

const ACTIVITY_ROWS = 8;
const NEEDS_YOU_ROWS = 4;

function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}

function platformUse(workers: readonly WorkerView[], platform: "ios" | "android"): PlatformUse {
  const live = workers.filter((worker) => worker.connection === "connected");
  const name = platform === "ios" ? "iOS" : "Android";
  if (workers.some(isUnread)) {
    return { busyPercent: 0, leasedPercent: 0, name, readyPercent: 0 };
  }
  const limit = live.reduce((sum, worker) => sum + (worker.capacity?.[platform].limit ?? 0), 0);
  const devices = live.flatMap((worker) =>
    (worker.devices ?? []).filter((device) => device.spec.platform === platform),
  );
  const count = (...states: readonly string[]) =>
    devices.filter((device) => states.includes(device.state)).length;
  const leased = count("leased");
  const ready = count("ready");
  const busy = count("provisioning", "reclaiming");
  return {
    busyPercent: percentOf(busy, limit),
    leasedPercent: percentOf(leased, limit),
    limit,
    name,
    readyPercent: percentOf(ready, limit),
    running: leased + ready + busy,
  };
}

function gauge(percent: number | undefined): Gauge | undefined {
  if (percent === undefined) return undefined;
  const tone = levelOf(percent);
  return { percent, text: formatBusyPercent(percent), tone: tone === "idle" ? "neutral" : tone };
}

function overviewWorker(worker: WorkerView): OverviewWorker {
  const slots = isUnread(worker) ? [] : workerSlots(worker);
  const gauges =
    worker.connection === "connected" && worker.load !== undefined ? loadGauges(worker.load) : {};
  const cpu = gauge(gauges.cpu);
  const memory = gauge(gauges.memory);
  return {
    health: workerHealth(worker),
    id: worker.id,
    name: workerName(worker),
    slots,
    slotsLabel: isUnread(worker) ? "Not reported" : slotsLabel(slots),
    to: workerPath(worker.id),
    ...(worker.leases === undefined ? {} : { leases: worker.leases.length }),
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
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
      to: itemPath("/inbox", item.key),
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
  readonly events: readonly ConsoleEvent[];
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
  readonly figures?: FiguresState;
  readonly couldNotCheck?: readonly string[];
  readonly now: number;
}): Overview {
  const {
    couldNotCheck = [],
    events,
    figures = { kind: "loading" },
    leases,
    now,
    requests,
    tokens,
    workers,
  } = input;
  const platforms = [platformUse(workers, "ios"), platformUse(workers, "android")];
  return {
    activity: [...events]
      .sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq)
      .slice(0, ACTIVITY_ROWS)
      .map((event) => {
        const tone = eventTone(event.event);
        return {
          key: event.id,
          name: event.event,
          text: eventSummary(event, workers),
          time: minuteLabel(event.timestamp),
          to: itemPath("/activity", event.id),
          ...(tone === undefined ? {} : { tone }),
        };
      }),
    ending: endingSoon(leases, now),
    inbox: inboxOf({
      context: { leases, now, requests, tokens },
      couldNotCheck,
      workers,
    }),
    figures,
    platforms,
    tiles: tiles(workers, requests, now),
    ...(figures.kind === "ready" ? { wait: figures.data.wait } : {}),
    workers: workers.map(overviewWorker),
  };
}
