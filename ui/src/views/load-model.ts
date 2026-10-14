import type { WorkerView } from "./workers-model";

export type WorkerLoad = NonNullable<WorkerView["load"]>;

const MIB = 2 ** 20;
const GIB = 2 ** 30;

function roundHalfUp(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 0.5) / scale;
}

function isGib(bytes: number): boolean {
  return bytes > 0 && Math.floor(bytes / MIB + 0.5) >= 1024;
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

export function loadSummary(load: WorkerLoad): string {
  const { cpu, disk, memory } = load;
  const cpuPart =
    cpu === undefined
      ? "CPU unavailable"
      : `CPU ${formatBusyPercent(cpu.busyPercent)}${cpu.limited ? " (limit)" : ""}`;
  let memoryPart = "memory unavailable";
  if (memory !== undefined) {
    const bothGib = isGib(memory.availableBytes) && isGib(memory.totalBytes);
    const available = bothGib
      ? roundHalfUp(memory.availableBytes / GIB, 1).toFixed(1)
      : formatBytes(memory.availableBytes);
    memoryPart = `memory ${available} of ${formatBytes(memory.totalBytes)}${
      memory.limited ? " (limit)" : ""
    }`;
  }
  const diskPart =
    disk === undefined ? "disk unavailable" : `disk ${formatBytes(disk.freeBytes)} free`;
  return [cpuPart, memoryPart, diskPart].join(" · ");
}
