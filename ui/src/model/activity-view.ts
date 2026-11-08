import { eventTone } from "./activity";
import { eventRow, type EventRow, eventsChart, type EventsChart, rowMatches } from "./event-list";
import { type ConsoleEvent, workerIdOf } from "./events";
import { writeQuery } from "./paging";
import { type ConsoleRange, writeRange } from "./range";
import type { WorkerView } from "./workers";
import { workerName } from "./workers";

export type Kind = "lease" | "queue" | "device" | "worker" | "baseline" | "other";

const KIND_CHOICES: readonly { readonly value: Kind; readonly label: string }[] = [
  { label: "Leases", value: "lease" },
  { label: "Queue", value: "queue" },
  { label: "Devices", value: "device" },
  { label: "Workers", value: "worker" },
  { label: "Baselines", value: "baseline" },
  { label: "Other", value: "other" },
];

// why: an event is of a kind by the prefix of its name; a component or unknown event is Other.
function kindOf(name: string): Kind {
  return (
    KIND_CHOICES.find((choice) => choice.value !== "other" && name.startsWith(`${choice.value}.`))
      ?.value ?? "other"
  );
}

// why: an event with no worker id (a gateway's own, a refused dial) has its own option, never
// dropped; the empty string is its value in the URL.
export const OTHER_WORKER = "";

export interface ActivityFilter {
  readonly kinds: readonly Kind[];
  readonly problems: boolean;
  readonly workers: readonly string[];
}

export const NO_FILTER: ActivityFilter = { kinds: [], problems: false, workers: [] };

// why: a link from before the facets carried `?subject=`: a component is Other, a value this
// console does not know is All.
const LEGACY_SUBJECTS: Readonly<Record<string, Kind>> = {
  component: "other",
  device: "device",
  lease: "lease",
  other: "other",
  worker: "worker",
};

export function readFilter(search: string): ActivityFilter {
  const params = new URLSearchParams(search);
  const asked = params
    .getAll("kind")
    .filter((value) => KIND_CHOICES.some((c) => c.value === value));
  const legacy = LEGACY_SUBJECTS[params.get("subject") ?? ""];
  return {
    kinds: (asked.length > 0 ? asked : legacy === undefined ? [] : [legacy]) as Kind[],
    problems: params.get("state") === "problems",
    workers: [...new Set(params.getAll("worker"))],
  };
}

// why: only the facets' own keys are set or dropped; the search and the range stay.
export function writeFilter(search: string, filter: ActivityFilter): string {
  const params = new URLSearchParams(search);
  for (const key of ["kind", "state", "subject", "worker"]) params.delete(key);
  for (const kind of filter.kinds) params.append("kind", kind);
  if (filter.problems) params.set("state", "problems");
  for (const worker of filter.workers) params.append("worker", worker);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function toggled<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function toggleKind(filter: ActivityFilter, kind: Kind): ActivityFilter {
  return { ...filter, kinds: toggled(filter.kinds, kind) };
}

export function toggleWorker(filter: ActivityFilter, worker: string): ActivityFilter {
  return { ...filter, workers: toggled(filter.workers, worker) };
}

export function toggleProblems(filter: ActivityFilter): ActivityFilter {
  return { ...filter, problems: !filter.problems };
}

const RANGE_MS: Readonly<Record<ConsoleRange, number>> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "6h": 21_600_000,
  "7d": 604_800_000,
};

function rangeStart(range: ConsoleRange, now: number): number {
  return now - RANGE_MS[range];
}

export interface Facet {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly checked: boolean;
}

export interface Facets {
  readonly kinds: readonly Facet[];
  readonly problems: Facet;
  readonly workers: readonly Facet[];
}

export interface ActivityRow extends EventRow {
  readonly kind: Kind;
  readonly mark?: "ok" | "warn" | "error";
  readonly subject: string;
  readonly detail: string;
  readonly worker: string;
  readonly workerTitle: string;
}

export interface ActivityView {
  readonly rows: readonly ActivityRow[];
  readonly facets: Facets;
  readonly chart: EventsChart;
  // why: the held events inside the range and the search, before the facets narrow them.
  readonly inRange: number;
  // why: the oldest held event is newer than the range's start, so history has not reached it.
  readonly partial: boolean;
}

const GOOD = /(granted|ready|built|connected|booted)$/;

function markOf(name: string): ActivityRow["mark"] {
  const tone = eventTone(name);
  if (tone === "error" || tone === "warn") return tone;
  return GOOD.test(name) ? "ok" : undefined;
}

interface Entry {
  readonly row: EventRow;
  readonly kind: Kind;
  readonly worker: string;
  readonly problem: boolean;
}

function passes(filter: ActivityFilter, entry: Entry, skip?: "kind" | "state" | "worker"): boolean {
  return (
    (skip === "kind" || filter.kinds.length === 0 || filter.kinds.includes(entry.kind)) &&
    (skip === "state" || !filter.problems || entry.problem) &&
    (skip === "worker" || filter.workers.length === 0 || filter.workers.includes(entry.worker))
  );
}

function split(summary: string, name: string): { subject: string; detail: string } {
  if (summary === name) return { detail: "", subject: "" };
  const at = summary.indexOf(" · ");
  return at < 0
    ? { detail: "", subject: summary }
    : { detail: summary.slice(at + 3), subject: summary.slice(0, at) };
}

// why: the held events inside the range and the search are counted once; each facet's count
// applies the other facets and not its own, so a box shows what ticking it would add.
export function activityView(input: {
  readonly events: readonly ConsoleEvent[];
  readonly workers: readonly WorkerView[];
  readonly filter: ActivityFilter;
  readonly search: string;
  readonly range: ConsoleRange;
  readonly now: number;
}): ActivityView {
  const { events, filter, now, range, search, workers } = input;
  const start = rangeStart(range, now);
  const query = writeRange(writeFilter(writeQuery("", search), filter), range);
  const dated = range === "24h" || range === "7d";
  const entries: Entry[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    oldest = Math.min(oldest, event.timestamp);
    if (event.timestamp < start) continue;
    const base = eventRow(event, workers, query);
    if (!rowMatches(base, search)) continue;
    const row = dated
      ? {
          ...base,
          time: `${new Date(event.timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${base.time}`,
        }
      : base;
    entries.push({
      kind: kindOf(event.event),
      problem: eventTone(event.event) !== undefined,
      row,
      worker: workerIdOf(event) ?? OTHER_WORKER,
    });
  }
  const names = new Map(workers.map((worker) => [worker.id, workerName(worker)]));
  const count = (skip: "kind" | "state" | "worker", test: (entry: Entry) => boolean) =>
    entries.filter((entry) => passes(filter, entry, skip) && test(entry)).length;
  const workerIds = new Set([...entries.map((entry) => entry.worker), ...filter.workers]);
  const shown = entries.filter((entry) => passes(filter, entry));
  const rows = shown.map(({ kind, row, worker }): ActivityRow => {
    const { detail, subject } = split(row.summary, row.name);
    const mark = markOf(row.name);
    return {
      ...row,
      detail,
      kind,
      subject,
      worker: worker === OTHER_WORKER ? "—" : (names.get(worker) ?? worker),
      workerTitle: worker === OTHER_WORKER ? "No worker" : worker,
      ...(mark === undefined ? {} : { mark }),
    };
  });
  const shownIds = new Set(shown.map((entry) => entry.row.id));
  const chartEvents = events.filter((event) => shownIds.has(event.id));
  return {
    chart: eventsChart(chartEvents, now),
    facets: {
      kinds: KIND_CHOICES.map((choice) => ({
        checked: filter.kinds.includes(choice.value),
        count: count("kind", (entry) => entry.kind === choice.value),
        label: choice.label,
        value: choice.value,
      })),
      problems: {
        checked: filter.problems,
        count: count("state", (entry) => entry.problem),
        label: "Problems only",
        value: "problems",
      },
      workers: [...workerIds]
        .map((id) => ({
          checked: filter.workers.includes(id),
          count: count("worker", (entry) => entry.worker === id),
          label: id === OTHER_WORKER ? "Other" : (names.get(id) ?? id),
          value: id,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    },
    inRange: entries.length,
    partial: range !== "1h" && oldest > start,
    rows,
  };
}

const RANGE_WORDS: Readonly<Record<ConsoleRange, string>> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "6h": "6 hours",
  "7d": "7 days",
};

export function coverageText(range: ConsoleRange): string {
  return `The events loaded do not reach back ${RANGE_WORDS[range]} yet. Older events load as you scroll, or with Load older events.`;
}
