import type { BaselineEntry } from "../../../src/contract/index";
import { platformName } from "../../../src/contract/inbox";
import { formatBytes } from "./load";
import { formatAgo } from "./time";
import { type WorkerView, workerName } from "./workers";

export interface BaselineList {
  readonly baselines: readonly BaselineEntry[];
}

export type BaselineFilter = "all" | "stale" | "ready";

export const BASELINE_FILTERS: readonly {
  readonly value: BaselineFilter;
  readonly label: string;
}[] = [
  { label: "All", value: "all" },
  { label: "Stale", value: "stale" },
  { label: "Ready", value: "ready" },
];

export interface BaselineRow {
  readonly key: string;
  readonly workerId?: string;
  readonly worker?: string;
  readonly name: string;
  readonly platform: string;
  readonly platformName: string;
  // why: the model and runtime the baseline was saved on, as one muted line.
  readonly detail: string;
  readonly sizeBytes?: number;
  readonly size: string;
  readonly built: string;
  readonly savedAt: string;
  readonly state: "ready" | "stale";
  readonly staleReason?: string;
}

export function baselineRows(
  entries: readonly BaselineEntry[],
  workers: readonly WorkerView[],
  now: number,
): readonly BaselineRow[] {
  const rows = entries.map((entry): BaselineRow => {
    const worker = workerOf(entry, workers);
    const model = entry.imageTag === undefined ? entry.model : `${entry.model} / ${entry.imageTag}`;
    const named = platformName(entry.platform);
    return {
      built: `${formatAgo(now - Date.parse(entry.savedAt))}`,
      detail: `${model} · ${named} ${entry.osVersion}`,
      key: `${entry.workerId ?? ""}/${entry.name}`,
      name: entry.name,
      platform: entry.platform,
      platformName: named,
      savedAt: entry.savedAt,
      size: entry.sizeBytes === undefined ? "—" : formatBytes(entry.sizeBytes),
      state: entry.staleReason === undefined ? "ready" : "stale",
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
      ...(entry.workerId === undefined ? {} : { workerId: entry.workerId }),
      ...(worker === undefined ? {} : { worker }),
      ...(entry.staleReason === undefined ? {} : { staleReason: entry.staleReason }),
    };
  });
  return rows.sort(
    (a, b) =>
      platformOrder(a.platform) - platformOrder(b.platform) ||
      a.name.localeCompare(b.name) ||
      (a.worker ?? "").localeCompare(b.worker ?? ""),
  );
}

function platformOrder(platform: string): number {
  return platform === "ios" ? 0 : platform === "android" ? 1 : 2;
}

// why: a gateway names the worker by id; its label is shown when the fleet view has the worker, and the id stands when it does not.
function workerOf(entry: BaselineEntry, workers: readonly WorkerView[]): string | undefined {
  if (entry.workerId === undefined) return undefined;
  const known = workers.find((worker) => worker.id === entry.workerId);
  return known === undefined ? entry.workerId : workerName(known);
}

export function filterBaselineRows(
  rows: readonly BaselineRow[],
  filter: BaselineFilter,
): readonly BaselineRow[] {
  return filter === "all" ? rows : rows.filter((row) => row.state === filter);
}

export function searchBaselineRows(
  rows: readonly BaselineRow[],
  query: string,
): readonly BaselineRow[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return rows;
  return rows.filter((row) =>
    [row.name, row.detail, row.worker, row.staleReason].some((field) =>
      field?.toLowerCase().includes(wanted),
    ),
  );
}

// why: a group's count is that of the rows that match, not of the page on screen.
export function groupLabels(rows: readonly BaselineRow[]): ReadonlyMap<string, string> {
  const byPlatform = new Map<string, BaselineRow[]>();
  for (const row of rows)
    byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row]);
  return new Map(
    [...byPlatform].map(([platform, members]) => [
      platform,
      `${members[0]?.platformName ?? platform} · ${members.length} ${
        members.length === 1 ? "baseline" : "baselines"
      }`,
    ]),
  );
}
