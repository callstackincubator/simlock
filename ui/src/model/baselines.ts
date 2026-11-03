import type { BaselineEntry } from "../../../src/contract/index";
import { platformName } from "../../../src/contract/inbox";
import { formatBytes } from "./load";
import { formatDuration } from "./time";

export interface BaselineList {
  readonly baselines: readonly BaselineEntry[];
}

export interface BaselineRow {
  readonly key: string;
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
  now: number,
): readonly BaselineRow[] {
  return entries.map((entry) => ({
    key: entry.name,
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
  }));
}
