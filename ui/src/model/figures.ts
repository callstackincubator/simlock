import type { UsageOutput } from "../../../src/contract/index";
import { dayWord } from "./event-list";
import { extremes, minuteLabel } from "./history";
import { formatCount } from "./paging";
import { type ConsoleRange, rangeUnit, usagePath } from "./range";
import { formatDuration } from "./time";

export interface FigureTile {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly to?: string;
}

export interface ChartPoint {
  readonly at: number;
  readonly label: string;
  readonly count: number | null;
}

export interface FigureChart {
  readonly key: "leasesHeld" | "queueDepth" | "slotsUsed";
  readonly title: string;
  readonly unit: string;
  readonly heading: string;
  readonly bucketMs: number;
  readonly points: readonly ChartPoint[];
  readonly summary: string;
}

export type FiguresState =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: Figures; readonly refusal?: string };

export interface Figures {
  readonly note?: string;
  readonly granted: FigureTile;
  readonly wait: FigureTile;
  readonly charts: readonly FigureChart[];
}

const DAY = 86_400_000;

// why: under a second a duration would round to `0 s`, which says "no wait" for a wait that was
// real.
export function formatWait(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1_000 ? `${Math.round(ms)} ms` : formatDuration(ms);
}

// why: the Overview and the Waiting page show the same tile from the same answer, so it is built
// once.
export function waitTile(stats: UsageOutput, range: ConsoleRange): FigureTile {
  return {
    label: "Wait p95",
    unit: rangeUnit(range),
    value: formatWait(stats.totals.wait.p95),
  };
}

const CHARTS: readonly {
  readonly key: FigureChart["key"];
  readonly title: string;
  readonly heading: string;
  readonly noun: string;
}[] = [
  { heading: "Leases held", key: "leasesHeld", noun: "leases held", title: "Leases held" },
  {
    heading: "Requests in the queue",
    key: "queueDepth",
    noun: "requests queued",
    title: "Requests in the queue",
  },
  {
    heading: "Device slots in use",
    key: "slotsUsed",
    noun: "slots in use",
    title: "Device slots in use",
  },
];

function chartOf(
  stats: UsageOutput,
  spec: (typeof CHARTS)[number],
  unit: string,
  now: number,
): FigureChart {
  const { bucketMs, window } = stats;
  // why: the daemon floors window.from to a bucket, so a 24h window can run up to one bucket over.
  const withDay = window.to - window.from >= DAY + bucketMs;
  const points = stats.series.map((point, index): ChartPoint => {
    const start = window.from + index * bucketMs;
    const label = minuteLabel(start);
    return {
      at: point.at,
      count: point[spec.key],
      label: withDay ? `${dayWord(start, now)} ${label}` : label,
    };
  });
  const range = extremes(points);
  // why: the newest bucket is still filling and often has no figure yet; "now" is the newest one that does.
  const current = points.findLast((point) => point.count !== null);
  const summary =
    range === undefined || current === undefined
      ? ""
      : `Now ${current.count}; highest ${range.highest.count} at ${range.highest.label}; lowest ${range.lowest.count} at ${range.lowest.label}.`;
  return {
    bucketMs,
    heading: spec.heading,
    key: spec.key,
    points,
    summary,
    title: `${spec.title}, ${unit}`,
    unit: spec.noun,
  };
}

export function partialNote(stats: UsageOutput, now: number): string | undefined {
  if (!stats.partial) return undefined;
  const covers = stats.coversFrom;
  return `Figures cover from ${dayWord(covers, now)} ${minuteLabel(covers)}.`;
}

export function figuresOf(stats: UsageOutput, range: ConsoleRange, now: number): Figures {
  const unit = rangeUnit(range);
  const note = partialNote(stats, now);
  return {
    charts: CHARTS.map((spec) => chartOf(stats, spec, unit, now)),
    granted: {
      label: "Granted",
      to: usagePath(range),
      unit,
      value: formatCount(stats.totals.granted),
    },
    wait: waitTile(stats, range),
    ...(note === undefined ? {} : { note }),
  };
}
