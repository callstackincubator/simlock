import type { BaselineEntry } from "../../../src/contract/index";
import { platformName } from "../../../src/contract/inbox";
import { formatBytes } from "./load";
import { formatDuration } from "./time";
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
      built: `${formatDuration(now - Date.parse(entry.savedAt))} ago`,
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

// why: a size the daemon did not report is unknown, not zero, so a total says "known" when it is a floor.
function sizeTotal(rows: readonly BaselineRow[]): string {
  const sized = rows.filter((row) => row.sizeBytes !== undefined);
  if (sized.length === 0) return "size unknown";
  const total = formatBytes(sized.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0));
  return sized.length === rows.length ? total : `${total} known`;
}

// why: a group's count and size are those of the rows that match, not of the page on screen.
export function groupLabels(rows: readonly BaselineRow[]): ReadonlyMap<string, string> {
  const byPlatform = new Map<string, BaselineRow[]>();
  for (const row of rows)
    byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row]);
  return new Map(
    [...byPlatform].map(([platform, members]) => [
      platform,
      `${members[0]?.platformName ?? platform} · ${members.length} ${
        members.length === 1 ? "baseline" : "baselines"
      } · ${sizeTotal(members)}`,
    ]),
  );
}

export interface DiskShare {
  readonly key: string;
  readonly name: string;
  readonly text: string;
  readonly percent?: number;
}

export interface DiskUse {
  readonly summary: string;
  readonly shares: readonly DiskShare[];
}

// why: each bar is the worker's own baseline bytes against its own disk, never a share of the fleet's baselines.
export function diskUse(rows: readonly BaselineRow[], workers: readonly WorkerView[]): DiskUse {
  const sole = workers.length === 1 ? workers[0] : undefined;
  const byWorker = new Map<string, BaselineRow[]>();
  for (const row of rows) {
    const id = row.workerId ?? sole?.id;
    if (id !== undefined) byWorker.set(id, [...(byWorker.get(id) ?? []), row]);
  }
  const shares = [...byWorker].map(([id, members]): DiskShare => {
    const worker = workers.find((candidate) => candidate.id === id);
    const name = worker === undefined ? id : workerName(worker);
    const sized = members.filter((row) => row.sizeBytes !== undefined);
    const known = sized.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
    const total = worker?.load?.disk?.totalBytes;
    const used =
      sized.length === 0
        ? "size unknown"
        : `${formatBytes(known)}${sized.length === members.length ? "" : " known"}`;
    if (total === undefined || !(total > 0)) {
      return { key: id, name, text: `${used} · disk unknown` };
    }
    const percent = known === 0 ? 0 : Math.min(100, Math.max(2, Math.round((known / total) * 100)));
    return { key: id, name, percent, text: `${used} of ${formatBytes(total)}` };
  });
  shares.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return {
    shares,
    summary: `${sizeTotal(rows)} on ${shares.length} ${shares.length === 1 ? "worker" : "workers"}`,
  };
}
