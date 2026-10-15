import type { WorkerView } from "./workers";

export type WorkerLoad = NonNullable<WorkerView["load"]>;

const MIB = 2 ** 20;
const GIB = 2 ** 30;

function roundHalfUp(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 0.5) / scale;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const mebibytes = Math.floor(bytes / MIB + 0.5);
  if (mebibytes < 1024) return `${mebibytes} MiB`;
  return `${roundHalfUp(bytes / GIB, 1).toFixed(1)} GiB`;
}

export function formatBusyPercent(percent: number): string {
  return `${roundHalfUp(percent, 0)}%`;
}

export function formatCores(cores: number): string {
  const figure = cores < 0.005 ? "<0.01" : String(roundHalfUp(cores, cores < 0.1 ? 2 : 1));
  return `${figure} ${cores === 1 ? "core" : "cores"}`;
}

export interface LoadGauges {
  readonly cpu?: number | undefined;
  readonly disk?: number | undefined;
  readonly memory?: number | undefined;
}

export function loadGauges(load: WorkerLoad): LoadGauges {
  const { cpu, disk, memory } = load;
  return {
    ...(cpu !== undefined && { cpu: clampPercent(cpu.busyPercent) }),
    ...(memory !== undefined && {
      memory: usedPercent(memory.availableBytes, memory.totalBytes),
    }),
    ...(disk !== undefined && { disk: usedPercent(disk.freeBytes, disk.totalBytes) }),
  };
}

function clampPercent(percent: number): number {
  // why: the same round as the figures above the gauge, not Math.round — the two differ just under
  // a half, where the text would say 1% and the bar would draw 0.
  return roundHalfUp(Math.min(100, Math.max(0, percent)), 0);
}

function usedPercent(available: number, total: number): number | undefined {
  if (!(total > 0)) return undefined;
  return clampPercent((1 - available / total) * 100);
}
