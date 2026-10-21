import type { UsageOutput } from "../../../src/contract/index";
import {
  type FigureChart,
  type FigureTile,
  figuresOf,
  formatWait,
  partialNote,
  waitTile,
} from "./figures";
import { formatBytes } from "./load";
import { agentIdOf } from "./leases";
import { formatCount } from "./paging";
import { type ConsoleRange, rangeUnit, writeRange } from "./range";
import { formatDuration } from "./time";

export interface UsageCount {
  readonly label: string;
  readonly count: string;
}

export interface UsageDuration {
  readonly name: string;
  readonly count: string;
  readonly p50: string;
  readonly p95: string;
  readonly max: string;
}

export interface UsageLine {
  readonly label: string;
  readonly text: string;
}

export interface UsageScopeRow {
  readonly key: string;
  readonly name: string;
  readonly requests: string;
  readonly granted: string;
  readonly rejected: string;
  readonly waitP95: string;
}

export interface UsageRequesterRow {
  readonly key: string;
  readonly id: string;
  readonly label?: string;
  readonly requests: string;
  readonly granted: string;
  readonly rejected: string;
  readonly held: string;
}

export interface UsageView {
  readonly note?: string;
  readonly slots?: FigureChart;
  readonly tiles: readonly FigureTile[];
  readonly bySource: readonly UsageCount[];
  readonly durations: readonly UsageDuration[];
  readonly rejections: readonly UsageCount[];
  readonly incidents: readonly UsageCount[];
  readonly use: readonly UsageLine[];
  readonly platforms: readonly UsageScopeRow[];
  readonly workers: readonly UsageScopeRow[];
  readonly requesters: readonly UsageRequesterRow[];
}

export type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: UsageView; readonly refusal?: string };

type Figures = UsageOutput["totals"];
type Samples = Figures["wait"];

function duration(ms: number | null): string {
  return ms === null ? "—" : formatDuration(ms);
}

function figure(value: number | null, digits = 0): string {
  return value === null ? "—" : digits === 0 ? String(value) : value.toFixed(digits);
}

function durationRow(name: string, samples: Samples, text: (ms: number | null) => string) {
  return {
    count: formatCount(samples.count),
    max: text(samples.max),
    name,
    p50: text(samples.p50),
    p95: text(samples.p95),
  };
}

function useLines(totals: Figures): readonly UsageLine[] {
  const { queue, utilisation } = totals;
  const { ram, slots } = utilisation;
  return [
    {
      label: "Slots",
      text: `peak ${figure(slots.peak)}, mean ${figure(slots.mean, 1)}, of ${figure(slots.max)}`,
    },
    ...(ram === undefined
      ? []
      : [
          {
            label: "RAM",
            text: `peak ${formatBytes(ram.peakBytes)}, mean ${formatBytes(ram.meanBytes)}, of ${formatBytes(ram.limitBytes)}`,
          },
        ]),
    {
      label: "Queue",
      text: `peak ${figure(queue.peakDepth)}, mean ${figure(queue.meanDepth, 1)}`,
    },
  ];
}

function scopeRow(key: string, name: string, figures: Figures): UsageScopeRow {
  return {
    granted: formatCount(figures.granted),
    key,
    name,
    rejected: formatCount(figures.rejected.total),
    requests: formatCount(figures.requests),
    waitP95: formatWait(figures.wait.p95),
  };
}

// why: the page draws the daemon's answer as given; it sums, averages and re-buckets nothing, so
// its figures are the ones `simlock stats` prints for the same range.
export function usageOf(stats: UsageOutput, range: ConsoleRange, now: number): UsageView {
  const { totals } = stats;
  const unit = rangeUnit(range);
  const { bySource } = totals;
  const note = partialNote(stats, now);
  const slots = figuresOf(stats, range, now).charts.find((chart) => chart.key === "slotsUsed");
  return {
    bySource: [
      ["warm", bySource.warm] as const,
      ["booted", bySource.booted] as const,
      ["provisioned", bySource.provisioned] as const,
      ...(bySource.unknown === undefined ? [] : [["unknown", bySource.unknown] as const]),
    ].map(([label, count]) => ({ count: formatCount(count), label })),
    durations: [
      durationRow("Wait", totals.wait, formatWait),
      durationRow("Held", totals.held, duration),
      durationRow("Turnaround", totals.turnaround, duration),
      durationRow("Provisioning", totals.provisioning, duration),
      durationRow("Boot", totals.boot, duration),
    ],
    incidents: [
      { count: formatCount(totals.incidents.quarantined), label: "Quarantined" },
      {
        count: formatCount(totals.incidents.quarantineRecovered),
        label: "Recovered from quarantine",
      },
      { count: formatCount(totals.incidents.crashRecovered), label: "Recovered after a crash" },
      { count: formatCount(totals.incidents.lost), label: "Lost" },
    ],
    platforms: [
      scopeRow("ios", "iOS", stats.platforms.ios),
      scopeRow("android", "Android", stats.platforms.android),
    ],
    rejections: Object.entries(totals.rejected.byReason)
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .map(([label, count]) => ({ count: formatCount(count), label })),
    requesters: stats.requesters.map((entry) => ({
      granted: formatCount(entry.granted),
      held: formatDuration(entry.heldTotalMs),
      id: agentIdOf(entry.id),
      key: entry.id,
      rejected: formatCount(entry.rejected),
      requests: formatCount(entry.requests),
      ...(entry.label === undefined ? {} : { label: entry.label }),
    })),
    tiles: [
      { label: "Requests", unit, value: formatCount(totals.requests) },
      { label: "Granted", unit, value: formatCount(totals.granted) },
      { label: "Rejected", unit, value: formatCount(totals.rejected.total) },
      waitTile(stats, range),
      { label: "Held p50", unit, value: duration(totals.held.p50) },
    ],
    use: useLines(totals),
    ...(slots === undefined ? {} : { slots }),
    workers: stats.workers.map((worker) => scopeRow(worker.id, worker.label ?? worker.id, worker)),
    ...(note === undefined ? {} : { note }),
  };
}

// why: a new range starts every long table at its first page, but a chosen page size is the
// operator's and stays.
export function usageRangeSearch(search: string, range: ConsoleRange): string {
  const params = new URLSearchParams(search);
  for (const key of ["workers-page", "requesters-page", "range"]) params.delete(key);
  return writeRange(params.toString() === "" ? "" : `?${params.toString()}`, range);
}
