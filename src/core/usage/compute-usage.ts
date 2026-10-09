import { byTimeThenSeq, type EventEnvelope } from "../../bus/index.js";
import type { UsageFigures, UsageOutput } from "../../contract/index.js";
import {
  type CapacityStep,
  type CapacityValue,
  type DeviceFact,
  type Platform,
  type ReadEvents,
  readEvents,
  type RequestFact,
  type UsageWindow,
} from "./read-events.js";
import { peakAndMean, segmentsOf, type Step, valuesAt } from "./timeline.js";

export type { UsageWindow } from "./read-events.js";

export interface UsageOptions {
  /** The series bucket, picked once from the window asked for; the window's own span when absent. */
  readonly bucketMs?: number;
  /** The `requestId` of every request made before the window; a rejection of one is in no count. */
  readonly requestedBefore?: ReadonlySet<string>;
  /** The `requestId` of every request answered, granted or rejected, before the window; a request
   * made before it and not in this set was still waiting when it began. */
  readonly answeredBefore?: ReadonlySet<string>;
  /** The gateway rule (ADR 0016 §6 as ADR 0021 §5 amends it): request facts from the gateway's
   * own events, device facts from the events its workers relayed. */
  readonly fleet: boolean;
  /** Requester id to label, for the requesters the caller found a label for (ADR 0016 §7). */
  readonly labels?: Readonly<Record<string, string>>;
  /** The workers there are to report: a worker's own entry, a gateway's registry. A worker the
   * events name and this list does not is reported too. */
  readonly workers?: readonly { readonly id: string; readonly label?: string | undefined }[];
  /** The oldest timestamp the history holds, when the events passed start at the window's start
   * and so cannot say. */
  readonly oldestTs?: number | undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The widths a series may have, narrowest first (ADR 0016 §8). */
const BUCKET_WIDTHS_MS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR];
const MAX_SERIES_POINTS = 200;

/** The series bucket width for a window of `spanMs`: the narrowest that keeps 200 points. */
export function seriesBucketMs(spanMs: number): number {
  return (
    BUCKET_WIDTHS_MS.find((width) => Math.ceil(spanMs / width) <= MAX_SERIES_POINTS) ??
    (BUCKET_WIDTHS_MS.at(-1) as number)
  );
}

/**
 * The usage figures for `window`, from the events of a history (ADR 0016). Pure: events in, numbers
 * out. `events` are the envelopes the history holds for the window, with the latest envelope at or
 * before its start of `capacity.changed` and `queue.changed` (the step in force), of
 * `lease.requested` for each requester (a request still waiting when the window began) and, on a
 * gateway, the latest of its own `daemon.started`; any order, and any envelope outside the window
 * is left out.
 */
export function computeUsage(
  events: readonly EventEnvelope[],
  window: UsageWindow,
  options: UsageOptions,
): UsageOutput {
  const sorted = [...events].sort(byTimeThenSeq);
  const workers = options.workers ?? [];
  const read = readEvents(sorted, window, {
    answeredBefore: options.answeredBefore ?? new Set(),
    fleet: options.fleet,
    requestedBefore: options.requestedBefore ?? new Set(),
    self: workers[0]?.id ?? "local",
  });
  const bucketMs = options.bucketMs ?? seriesBucketMs(window.to - window.from);
  const oldest = options.oldestTs ?? sorted[0]?.timestamp;
  const coversFrom = oldest === undefined ? window.from : Math.max(window.from, oldest);
  const figures = (scope: Scope) => figuresFor(read, window, scope, options.fleet);
  const labelOf = new Map(workers.map((worker) => [worker.id, worker.label]));
  const ids = new Set([...labelOf.keys(), ...read.workers]);
  return {
    bucketMs,
    coversFrom,
    partial: coversFrom > window.from,
    platforms: { android: figures({ platform: "android" }), ios: figures({ platform: "ios" }) },
    requesters: requestersOf(read.requests, options.labels ?? {}),
    series: seriesOf(read, window, bucketMs),
    totals: figures({ queue: true }),
    window: { from: window.from, to: window.to },
    workers: [...ids].sort().map((id) => {
      const label = labelOf.get(id);
      return {
        ...figures({ queue: !options.fleet, worker: id }),
        id,
        ...(label === undefined ? {} : { label }),
      };
    }),
  };
}

interface Scope {
  readonly platform?: Platform;
  readonly worker?: string;
  /** Whether the figures carry the queue's depth, which is the host's or the fleet's, not a
   * platform's or a worker's. */
  readonly queue?: boolean;
}

function inScope(
  item: { readonly platform?: Platform | undefined; readonly worker?: string | undefined },
  scope: Scope,
): boolean {
  return (
    (scope.platform === undefined || item.platform === scope.platform) &&
    (scope.worker === undefined || item.worker === scope.worker)
  );
}

/**
 * One scope's figures. On a worker a probe (a gateway's dispatch, ADR 0021 §5) is not a request:
 * it is counted under `probes`, gives no wait, turnaround or rejection, and still counts as a grant
 * with its source and held time. A gateway's answer has no `probes`, and its sources include
 * `unknown`.
 */
function figuresFor(
  read: ReadEvents,
  window: UsageWindow,
  scope: Scope,
  fleet: boolean,
): UsageFigures {
  const requests = read.requests.filter((fact) => inScope(fact, scope));
  const devices = read.devices.filter((fact) => inScope(fact, scope));
  const asked = requests.filter((fact) => fact.requestedAt !== undefined && fact.probe !== true);
  const probes = requests.filter((fact) => fact.probe === true);
  const grants = requests.flatMap((fact) =>
    fact.outcome?.kind === "granted" ? [{ ...fact, outcome: fact.outcome }] : [],
  );
  const turnarounds = grants.filter((fact) => fact.probe !== true).flatMap(turnaroundOf);
  const rejected = requests.flatMap((fact) =>
    fact.outcome?.kind === "rejected" && fact.probe !== true ? [fact.outcome.reason] : [],
  );
  const sources = sourcesOf(grants.map((fact) => fact.outcome.source));
  return {
    ...deviceFigures(devices),
    bySource: {
      booted: sources.booted,
      provisioned: sources.provisioned,
      ...(fleet ? { unknown: sources.unknown } : {}),
      warm: sources.warm,
    },
    declined: read.declines.filter((fact) => inScope(fact, scope)).length,
    granted: grants.length,
    held: summarise(grants.flatMap((fact) => fact.heldMs ?? [])),
    queue:
      scope.queue === true ? queueOf(read.queue, window) : { meanDepth: null, peakDepth: null },
    rejected: { byReason: countBy(rejected), total: rejected.length },
    requests: asked.length,
    turnaround: summarise(turnarounds),
    utilisation: utilisationOf(read.capacity, window, scope),
    wait: summarise(asked.flatMap((fact) => spanOf(fact.requestedAt, fact.outcome?.at))),
    ...(fleet ? {} : { probes: probes.length }),
  };
}

/** Wait plus held time: each by the clock of the host that saw it, so the two never mix. */
function turnaroundOf(fact: RequestFact): number[] {
  const wait = spanOf(fact.requestedAt, fact.outcome?.at)[0];
  return wait === undefined || fact.heldMs === undefined ? [] : [wait + fact.heldMs];
}

/** The milliseconds from `start` to `end`, when both are known. */
function spanOf(start: number | undefined, end: number | undefined): number[] {
  return start === undefined || end === undefined ? [] : [end - start];
}

type GrantSource = "booted" | "provisioned" | "unknown" | "warm";

function sourcesOf(grantedSources: readonly string[]): Record<GrantSource, number> {
  const counts = countBy(grantedSources);
  return {
    booted: counts.booted ?? 0,
    provisioned: counts.provisioned ?? 0,
    unknown: counts.unknown ?? 0,
    warm: counts.warm ?? 0,
  };
}

/** The figures a device event brings: durations, incidents, and failures by name. */
function deviceFigures(
  devices: readonly DeviceFact[],
): Pick<UsageFigures, "boot" | "failures" | "incidents" | "provisioning"> {
  const durations = (kind: DeviceFact["kind"]) =>
    summarise(devices.filter((fact) => fact.kind === kind).map((fact) => fact.value as number));
  const named = (kind: DeviceFact["kind"]) =>
    countBy(devices.filter((fact) => fact.kind === kind).map((fact) => fact.value as string));
  const incidents = named("incident");
  return {
    boot: durations("boot"),
    failures: { byEvent: named("failure") },
    incidents: {
      crashRecovered: incidents.crashRecovered ?? 0,
      lost: incidents.lost ?? 0,
      quarantineRecovered: incidents.quarantineRecovered ?? 0,
      quarantined: incidents.quarantined ?? 0,
    },
    provisioning: durations("provisioning"),
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** p50, p95 and max by nearest rank: the smallest sample at or above that share of the samples. */
function summarise(values: readonly number[]): UsageFigures["wait"] {
  if (values.length === 0) return { count: 0, max: null, p50: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (share: number) =>
    sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] as number;
  return { count: sorted.length, max: sorted.at(-1) as number, p50: rank(0.5), p95: rank(0.95) };
}

function queueOf(steps: readonly Step<number>[], window: UsageWindow): UsageFigures["queue"] {
  const figures = peakAndMean(segmentsOf(steps, window.from, window.to), (values) => values[0]);
  return figures === undefined
    ? { meanDepth: null, peakDepth: null }
    : { meanDepth: figures.mean, peakDepth: figures.peak };
}

const sumOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);

/** The RAM figure summed over the workers that report a budget; `undefined` when none does. */
const ramOf = (values: readonly CapacityValue[], key: "used" | "limit"): number | undefined =>
  sumOf(values.flatMap((value) => (value.ram === undefined ? [] : [value.ram[key]])));

/** What one scope's capacity steps say: a platform's own entry, or the global one. */
function scopedSteps(steps: readonly CapacityStep[], scope: Scope): Step<CapacityValue>[] {
  const platform = scope.platform;
  return steps
    .filter((step) => scope.worker === undefined || step.key === scope.worker)
    .map((step) => ({
      at: step.at,
      key: step.key,
      value: platform === undefined ? step.value : step.value.platforms[platform],
    }));
}

function utilisationOf(
  steps: readonly CapacityStep[],
  window: UsageWindow,
  scope: Scope,
): UsageFigures["utilisation"] {
  const segments = segmentsOf(scopedSteps(steps, scope), window.from, window.to);
  const slots = peakAndMean(segments, (values) => sumOf(values.map((value) => value.used)));
  const ram = peakAndMean(segments, (values) => ramOf(values, "used"));
  const maxima = segments.flatMap((segment) =>
    segment.end > segment.start ? (sumOf(segment.values.map((value) => value.max)) ?? []) : [],
  );
  const limits = segments.flatMap((segment) => ramOf(segment.values, "limit") ?? []);
  return {
    ...(ram === undefined
      ? {}
      : { ram: { limitBytes: limits.at(-1) as number, meanBytes: ram.mean, peakBytes: ram.peak } }),
    slots: {
      max: maxima.length === 0 ? null : Math.max(...maxima),
      mean: slots?.mean ?? null,
      peak: slots?.peak ?? null,
    },
  };
}

function requestersOf(
  requests: readonly RequestFact[],
  labels: Readonly<Record<string, string>>,
): UsageOutput["requesters"] {
  const byId = new Map<string, Requester>();
  for (const fact of requests) {
    // A probe that was not granted is nothing of its requester's: it was never its request.
    if (fact.probe === true && fact.outcome?.kind !== "granted") continue;
    const entry = byId.get(fact.requester) ?? {
      granted: 0,
      heldTotalMs: 0,
      id: fact.requester,
      rejected: 0,
      requests: 0,
    };
    byId.set(fact.requester, countRequest(entry, fact));
  }
  return [...byId.values()]
    .sort((left, right) => right.requests - left.requests || (left.id < right.id ? -1 : 1))
    .map((entry) => {
      const label = Object.hasOwn(labels, entry.id) ? labels[entry.id] : undefined;
      return label === undefined ? entry : { ...entry, label };
    });
}

type Requester = UsageOutput["requesters"][number];

/** `entry` with `fact` counted in it: a request made, a grant and the time it was held, a rejection.
 * A probe counts only as a grant and its held time. */
function countRequest(entry: Requester, fact: RequestFact): Requester {
  const probe = fact.probe === true;
  const kind = fact.outcome?.kind;
  return {
    ...entry,
    granted: entry.granted + Number(kind === "granted"),
    // Only a granted request has a held time.
    heldTotalMs: entry.heldTotalMs + (fact.heldMs ?? 0),
    rejected: entry.rejected + Number(kind === "rejected" && !probe),
    requests: entry.requests + Number(fact.requestedAt !== undefined && !probe),
  };
}

function seriesOf(read: ReadEvents, window: UsageWindow, bucketMs: number): UsageOutput["series"] {
  const points = Math.ceil((window.to - window.from) / bucketMs);
  const ends = Array.from({ length: points }, (_, index) =>
    Math.min(window.from + (index + 1) * bucketMs, window.to),
  );
  const capacity = valuesAt(scopedSteps(read.capacity, {}), ends);
  const depths = valuesAt(read.queue, ends);
  const waiting = waitingAt(
    [...read.requests, ...read.carried].filter((fact) => fact.probe !== true),
    ends,
  );
  return ends.map((at, index) => {
    const values = capacity[index] as readonly CapacityValue[];
    const ram = ramOf(values, "used");
    return {
      at,
      queueDepth: (depths[index] as readonly number[])[0] ?? null,
      ...(ram === undefined ? {} : { ramUsedBytes: ram }),
      slotsMax: sumOf(values.map((value) => value.max)) ?? null,
      slotsUsed: sumOf(values.map((value) => value.used)) ?? null,
      waiting: waiting[index] as number,
    };
  });
}

/**
 * How many requests have been made and not yet settled at each of `times`, which ascend: every
 * request open at that time, those made before the window and still open when it began included.
 */
function waitingAt(requests: readonly RequestFact[], times: readonly number[]): number[] {
  const ascending = (values: number[]) => values.sort((left, right) => left - right);
  const made = ascending(requests.flatMap((fact) => fact.requestedAt ?? []));
  const settled = ascending(
    requests.flatMap((fact) => (fact.requestedAt === undefined ? [] : (fact.outcome?.at ?? []))),
  );
  let madeBy = 0;
  let settledBy = 0;
  return times.map((time) => {
    while (madeBy < made.length && (made[madeBy] as number) <= time) madeBy += 1;
    while (settledBy < settled.length && (settled[settledBy] as number) <= time) settledBy += 1;
    return madeBy - settledBy;
  });
}
