import type { BaselineEntry } from "../../../src/contract/index";
import { platformName } from "../../../src/contract/inbox";
import { formatBytes } from "./load";
import { formatDuration } from "./time";
import { type WorkerView, workerName } from "./workers";

export interface BaselineList {
  readonly baselines: readonly BaselineEntry[];
}

export interface BaselineRow {
  readonly key: string;
  readonly worker?: string;
  readonly stale?: string;
  readonly name: string;
  readonly version: number;
  readonly platform: string;
  readonly model: string;
  readonly os: string;
  readonly mode: string;
  readonly note: string;
  readonly size: string;
  readonly saved: string;
  readonly savedAt: string;
}

export function baselineRows(
  entries: readonly BaselineEntry[],
  workers: readonly WorkerView[],
  now: number,
): readonly BaselineRow[] {
  const rows = entries.map((entry) => {
    const worker = workerOf(entry, workers);
    return {
      key: `${worker ?? ""}/${entry.name}`,
      mode: entry.mode,
      model: entry.imageTag === undefined ? entry.model : `${entry.model} / ${entry.imageTag}`,
      name: entry.name,
      note: entry.note ?? "",
      os: entry.osVersion,
      platform: platformName(entry.platform),
      saved: `${formatDuration(now - Date.parse(entry.savedAt))} ago`,
      savedAt: entry.savedAt,
      size: entry.sizeBytes === undefined ? "—" : formatBytes(entry.sizeBytes),
      version: entry.version,
      ...(worker === undefined ? {} : { worker }),
      ...(entry.staleReason === undefined ? {} : { stale: entry.staleReason }),
    };
  });
  return rows.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.worker ?? "").localeCompare(b.worker ?? ""),
  );
}

// why: a gateway names the worker by id; its label is shown when the fleet view has the worker, and the id stands when it does not.
function workerOf(entry: BaselineEntry, workers: readonly WorkerView[]): string | undefined {
  if (entry.workerId === undefined) return undefined;
  const known = workers.find((worker) => worker.id === entry.workerId);
  return known === undefined ? entry.workerId : workerName(known);
}
