import { eventSummary, eventTone } from "./activity";
import { attentionItems, attentionTone } from "./attention";
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

export interface Overview {
  readonly tiles: readonly OverviewTile[];
  readonly figures: FiguresState;
  readonly platforms: readonly PlatformUse[];
  readonly workers: readonly OverviewWorker[];
  readonly attention: readonly OverviewItem[];
  readonly activity: readonly OverviewActivity[];
}

const ACTIVITY_ROWS = 8;

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
  platforms: readonly PlatformUse[],
  now: number,
): readonly OverviewTile[] {
  const held = leasesHeld(workers);
  const limit = platforms.reduce((sum, platform) => sum + (platform.limit ?? 0), 0);
  const connected = workers.filter((worker) => worker.connection === "connected").length;
  const oldest = Math.min(...requests.map((request) => request.createdAt));
  const unknown = held === undefined;
  return [
    {
      label: "Utilisation",
      ...(unknown ? {} : { unit: "%" }),
      value: unknown ? "—" : String(Math.round(percentOf(held, limit))),
    },
    {
      label: "Leases",
      to: "/leases",
      ...(unknown ? {} : { unit: `of ${formatCount(limit)}` }),
      value: unknown ? "—" : formatCount(held),
    },
    {
      label: "Waiting",
      to: "/waiting",
      unit: requests.length === 0 ? "none" : `longest ${formatDuration(now - oldest)}`,
      value: formatCount(requests.length),
    },
    {
      label: "Workers",
      to: "/workers",
      unit: `of ${formatCount(workers.length)} up`,
      value: formatCount(connected),
    },
  ];
}

// why: the overview reads three routes the other pages read too, and every figure on it is worked
// out here from those, so a figure on the overview and the same figure on its page always agree.
export function overviewOf(input: {
  readonly workers: readonly WorkerView[];
  readonly requests: readonly WaitingRequest[];
  readonly events: readonly ConsoleEvent[];
  readonly figures?: FiguresState;
  readonly now: number;
}): Overview {
  const { events, figures = { kind: "loading" }, now, requests, workers } = input;
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
          to: itemPath("/events", event.id),
          ...(tone === undefined ? {} : { tone }),
        };
      }),
    attention: attentionItems(workers).map((item) => ({
      key: item.key,
      subject:
        "device" in item
          ? `${item.device.spec.model} on ${workerName(item.worker)}`
          : workerName(item.worker),
      to: itemPath("/attention", item.key),
      tone: attentionTone(item.condition),
      word: item.condition,
    })),
    figures,
    platforms,
    tiles: [
      ...tiles(workers, requests, platforms, now),
      ...(figures.kind === "ready" ? [figures.data.granted, figures.data.wait] : []),
    ],
    workers: workers.map(overviewWorker),
  };
}
