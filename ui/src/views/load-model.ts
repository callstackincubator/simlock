import type { WorkerView } from "./workers-model";

export type WorkerLoad = NonNullable<WorkerView["load"]>;

export function formatBytes(_bytes: number): string {
  return "";
}

export function formatBusyPercent(_percent: number): string {
  return "";
}

export function formatCores(_cores: number): string {
  return "";
}

export function loadSummary(_load: WorkerLoad): string {
  return "";
}
