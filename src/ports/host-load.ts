import { cpus, freemem, totalmem } from "node:os";

import { type Filesystem, NodeFilesystem } from "./filesystem.js";
import { NodeProcessRunner, type ProcessRunner } from "./process-runner.js";

export type MemoryPressure = "normal" | "warn" | "critical";

export interface CpuCounters {
  readonly busyTime: number;
  readonly totalTime: number;
  readonly cores: number;
  readonly limited: boolean;
}

export interface MemoryCounters {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly swapUsedBytes: number;
  readonly pressure?: MemoryPressure;
  readonly limited: boolean;
}

export interface DiskCounters {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface HostLoadCounters {
  readonly cpu?: CpuCounters;
  readonly memory?: MemoryCounters;
  readonly disk?: DiskCounters;
}

export interface HostLoadProbe {
  read(): Promise<HostLoadCounters>;
}

export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

export interface DarwinHostLoadProbeOptions {
  readonly processRunner: ProcessRunner;
  readonly filesystem: Pick<Filesystem, "diskSpace">;
  readonly dataDirectory: string;
  readonly cpus: () => readonly { readonly times: CpuTimes }[];
}

export class DarwinHostLoadProbe implements HostLoadProbe {
  constructor(private readonly options: DarwinHostLoadProbeOptions) {}

  async read(): Promise<HostLoadCounters> {
    const [cpu, memory, disk] = await Promise.all([
      this.#cpu(),
      this.#memory(),
      readDisk(this.options.filesystem, this.options.dataDirectory),
    ]);
    return { ...(cpu && { cpu }), ...(memory && { memory }), ...(disk && { disk }) };
  }

  async #cpu(): Promise<CpuCounters | undefined> {
    return machineCpu(this.options.cpus);
  }

  async #memory(): Promise<MemoryCounters | undefined> {
    try {
      const result = await this.options.processRunner.run("sysctl", SYSCTL_ARGS, {
        timeoutMs: SYSCTL_TIMEOUT_MS,
      });
      if (result.code !== 0) return undefined;
      const lines = result.stdout.split("\n").map((line) => line.trim());
      const totalBytes = parseWhole(lines[0]);
      const level = parseWhole(lines[1]);
      const swapUsedBytes = parseSwapUsed(lines[3]);
      if (totalBytes === undefined || level === undefined || level > 100) return undefined;
      if (swapUsedBytes === undefined) return undefined;
      const pressure = PRESSURE[lines[2] ?? ""];
      return {
        availableBytes: (totalBytes * level) / 100,
        limited: false,
        ...(pressure && { pressure }),
        swapUsedBytes,
        totalBytes,
      };
    } catch {
      return undefined;
    }
  }
}

// why: Node's per-core times, which macOS and Windows both report; the busy share is a ratio of two reads.
function machineCpu(cpus: () => readonly { readonly times: CpuTimes }[]): CpuCounters | undefined {
  try {
    const cores = cpus();
    if (cores.length === 0) return undefined;
    let busyTime = 0;
    let totalTime = 0;
    for (const { times } of cores) {
      const busy = times.user + times.nice + times.sys + times.irq;
      busyTime += busy;
      totalTime += busy + times.idle;
    }
    if (![busyTime, totalTime].every(Number.isFinite)) return undefined;
    return { busyTime, cores: cores.length, limited: false, totalTime };
  } catch {
    return undefined;
  }
}

export interface WindowsHostLoadProbeOptions {
  readonly processRunner: ProcessRunner;
  readonly filesystem: Pick<Filesystem, "diskSpace">;
  readonly dataDirectory: string;
  readonly cpus: () => readonly { readonly times: CpuTimes }[];
  readonly totalmem: () => number;
  readonly freemem: () => number;
  readonly now: () => number;
}

/**
 * why: Windows has neither `/proc` nor `sysctl`. Node reads the CPU times and the physical memory
 * itself (`os.freemem()` is what Windows counts as available), but not the page file, so swap comes
 * from one PowerShell CIM query. That costs about a second, so its answer is kept for
 * `PAGEFILE_REFRESH_MS`: swap moves slowly, and the sampler reads every 15 s. A query that fails
 * leaves memory out, as an unreadable swap line does on macOS.
 */
export class WindowsHostLoadProbe implements HostLoadProbe {
  #pageFile: { readonly usedBytes: number; readonly readAt: number } | undefined;

  constructor(private readonly options: WindowsHostLoadProbeOptions) {}

  async read(): Promise<HostLoadCounters> {
    const [cpu, memory, disk] = await Promise.all([
      machineCpu(this.options.cpus),
      this.#memory(),
      readDisk(this.options.filesystem, this.options.dataDirectory),
    ]);
    return { ...(cpu && { cpu }), ...(memory && { memory }), ...(disk && { disk }) };
  }

  async #memory(): Promise<MemoryCounters | undefined> {
    try {
      const totalBytes = this.options.totalmem();
      const availableBytes = this.options.freemem();
      if (!(totalBytes > 0) || !(availableBytes >= 0) || availableBytes > totalBytes)
        return undefined;
      const swapUsedBytes = await this.#pageFileUsed();
      if (swapUsedBytes === undefined) return undefined;
      return { availableBytes, limited: false, swapUsedBytes, totalBytes };
    } catch {
      return undefined;
    }
  }

  async #pageFileUsed(): Promise<number | undefined> {
    const now = this.options.now();
    if (this.#pageFile !== undefined && now - this.#pageFile.readAt < PAGEFILE_REFRESH_MS) {
      return this.#pageFile.usedBytes;
    }
    const result = await this.options.processRunner.run("powershell.exe", PAGEFILE_ARGS, {
      timeoutMs: PAGEFILE_TIMEOUT_MS,
    });
    const mebibytes = result.stdout.trim();
    if (result.code !== 0 || !/^\d+$/.test(mebibytes)) return undefined;
    this.#pageFile = { readAt: now, usedBytes: Number(mebibytes) * 1024 * 1024 };
    return this.#pageFile.usedBytes;
  }
}

// why: `[long]` turns a machine with no page file (no instances, a null sum) into 0, not an empty
// line. A failed query is only a non-terminating error, which `[long]` would also turn into 0 with
// exit 0; `Stop` makes it end PowerShell with exit 1 and no answer, so memory is left out instead.
const PAGEFILE_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference = 'Stop'; [long](Get-CimInstance Win32_PageFileUsage | Measure-Object -Property CurrentUsage -Sum).Sum",
];
const PAGEFILE_TIMEOUT_MS = 5_000;
const PAGEFILE_REFRESH_MS = 5 * 60_000;

const SYSCTL_ARGS = [
  "-n",
  "hw.memsize",
  "kern.memorystatus_level",
  "kern.memorystatus_vm_pressure_level",
  "vm.swapusage",
];
const SYSCTL_TIMEOUT_MS = 5_000;
const PRESSURE: Record<string, MemoryPressure | undefined> = {
  "1": "normal",
  "2": "warn",
  "4": "critical",
};
const SWAP_UNITS: Record<string, number> = { G: 1024 ** 3, K: 1024, M: 1024 ** 2 };

function parseWhole(line: string | undefined): number | undefined {
  if (line === undefined || !/^\d+$/.test(line)) return undefined;
  return Number(line);
}

function parseSwapUsed(line: string | undefined): number | undefined {
  const match = /\bused = (\d+(?:\.\d+)?)([KMG])\b/.exec(line ?? "");
  if (!match) return undefined;
  return Number(match[1]) * (SWAP_UNITS[match[2] ?? ""] ?? 0);
}

async function readDisk(
  filesystem: Pick<Filesystem, "diskSpace">,
  path: string,
): Promise<DiskCounters | undefined> {
  try {
    const { freeBytes, totalBytes } = await filesystem.diskSpace(path);
    return { freeBytes, totalBytes };
  } catch {
    return undefined;
  }
}

export interface LinuxHostLoadProbeOptions {
  readonly filesystem: Pick<Filesystem, "diskSpace" | "readFile">;
  readonly dataDirectory: string;
  readonly cores: () => number;
  readonly nowMicros: () => number;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

interface CgroupLimit {
  readonly folder: string;
  readonly value: number;
}

interface CgroupLimits {
  readonly cpu?: CgroupLimit;
  readonly memory?: CgroupLimit;
}

function parseQuota(text: string | undefined): number | undefined {
  const match = /^(max|[1-9]\d*) ([1-9]\d*)\n?$/.exec(text ?? "");
  if (!match || match[1] === "max") return undefined;
  return Number(match[1]) / Number(match[2]);
}

function parseLimit(text: string | undefined): number | undefined {
  const match = /^(max|\d+)\n?$/.exec(text ?? "");
  if (!match || match[1] === "max") return undefined;
  return Number(match[1]);
}

function lower(
  current: CgroupLimit | undefined,
  folder: string,
  value: number | undefined,
): CgroupLimit | undefined {
  if (value === undefined || (current !== undefined && value >= current.value)) return current;
  return { folder, value };
}

function machineMemory(
  totalBytes: number | undefined,
  kib: (name: string) => number | undefined,
): MemoryCounters | undefined {
  const availableBytes = kib("MemAvailable");
  const swapTotal = kib("SwapTotal");
  const swapFree = kib("SwapFree");
  if (
    totalBytes === undefined ||
    availableBytes === undefined ||
    swapTotal === undefined ||
    swapFree === undefined
  ) {
    return undefined;
  }
  return {
    availableBytes,
    limited: false,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
    totalBytes,
  };
}

export class LinuxHostLoadProbe implements HostLoadProbe {
  constructor(private readonly options: LinuxHostLoadProbeOptions) {}

  async read(): Promise<HostLoadCounters> {
    const limits = await this.#limits();
    const [cpu, memory, disk] = await Promise.all([
      this.#cpu(limits.cpu),
      this.#memory(limits.memory),
      readDisk(this.options.filesystem, this.options.dataDirectory),
    ]);
    return { ...(cpu && { cpu }), ...(memory && { memory }), ...(disk && { disk }) };
  }

  async #optional(path: string): Promise<string | undefined> {
    try {
      return await this.options.filesystem.readFile(path);
    } catch {
      return undefined;
    }
  }

  async #folders(): Promise<string[]> {
    const line = (await this.#optional("/proc/self/cgroup"))
      ?.split("\n")
      .find((candidate) => candidate.startsWith("0::"));
    if (line === undefined) return [];
    const segments = line.slice(3).split("/").filter(Boolean);
    if (segments.includes("..")) return [CGROUP_ROOT];
    const folders = [CGROUP_ROOT];
    for (const segment of segments) {
      folders.push(`${folders[folders.length - 1]}/${segment}`);
    }
    return folders;
  }

  async #limits(): Promise<CgroupLimits> {
    let cpu: CgroupLimit | undefined;
    let memory: CgroupLimit | undefined;
    for (const folder of await this.#folders()) {
      const [cpuMax, memoryMax] = await Promise.all([
        this.#optional(`${folder}/cpu.max`),
        this.#optional(`${folder}/memory.max`),
      ]);
      cpu = lower(cpu, folder, parseQuota(cpuMax));
      memory = lower(memory, folder, parseLimit(memoryMax));
    }
    return { ...(cpu && { cpu }), ...(memory && { memory }) };
  }

  async #cpu(limit: CgroupLimit | undefined): Promise<CpuCounters | undefined> {
    try {
      const cores = this.options.cores();
      if (limit !== undefined && limit.value < cores) {
        const stat = await this.#optional(`${limit.folder}/cpu.stat`);
        const usage = /^usage_usec (\d+)$/m.exec(stat ?? "");
        if (!usage) return undefined;
        const now = this.options.nowMicros();
        return {
          busyTime: Number(usage[1]),
          cores: limit.value,
          limited: true,
          totalTime: now * limit.value,
        };
      }
      return await this.#machineCpu(cores);
    } catch {
      return undefined;
    }
  }

  async #machineCpu(cores: number): Promise<CpuCounters | undefined> {
    try {
      const text = await this.options.filesystem.readFile("/proc/stat");
      const line = text.split("\n").find((candidate) => /^cpu\s/.test(candidate));
      if (line === undefined) return undefined;
      const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
      if (fields.length < 8 || !fields.every((value) => Number.isFinite(value) && value >= 0)) {
        return undefined;
      }
      const [
        user = 0,
        nice = 0,
        system = 0,
        idle = 0,
        iowait = 0,
        irq = 0,
        softirq = 0,
        steal = 0,
      ] = fields;
      const busyTime = user + nice + system + irq + softirq + steal;
      return {
        busyTime,
        cores,
        limited: false,
        totalTime: busyTime + idle + iowait,
      };
    } catch {
      return undefined;
    }
  }

  async #memory(limit: CgroupLimit | undefined): Promise<MemoryCounters | undefined> {
    try {
      const text = await this.#optional("/proc/meminfo");
      const kib = (name: string): number | undefined => {
        const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text ?? "");
        return match ? Number(match[1]) * 1024 : undefined;
      };
      const machineTotal = kib("MemTotal");
      if (limit !== undefined && (machineTotal === undefined || limit.value < machineTotal)) {
        return await this.#limitedMemory(limit);
      }
      return machineMemory(machineTotal, kib);
    } catch {
      return undefined;
    }
  }

  async #limitedMemory(limit: CgroupLimit): Promise<MemoryCounters | undefined> {
    const [current, stat, swap] = await Promise.all([
      this.#optional(`${limit.folder}/memory.current`),
      this.#optional(`${limit.folder}/memory.stat`),
      this.#optional(`${limit.folder}/memory.swap.current`),
    ]);
    const used = /^(\d+)\n?$/.exec(current ?? "");
    const inactive = /^inactive_file (\d+)$/m.exec(stat ?? "");
    if (!used || !inactive) return undefined;
    const swapMatch = /^(\d+)\n?$/.exec(swap ?? "");
    return {
      availableBytes: Math.max(0, limit.value - (Number(used[1]) - Number(inactive[1]))),
      limited: true,
      swapUsedBytes: swapMatch ? Number(swapMatch[1]) : 0,
      totalBytes: limit.value,
    };
  }
}

export class FakeHostLoadProbe implements HostLoadProbe {
  readonly #pending: ((answer: HostLoadCounters | Error) => void)[] = [];
  readonly #counters: HostLoadCounters | undefined;
  #reads = 0;

  constructor(counters?: HostLoadCounters) {
    this.#counters = counters;
  }

  get reads(): number {
    return this.#reads;
  }

  answer(next: HostLoadCounters | Error): void {
    this.#pending.shift()?.(next);
  }

  read(): Promise<HostLoadCounters> {
    this.#reads += 1;
    if (this.#counters !== undefined) return Promise.resolve(this.#counters);
    return new Promise((resolve, reject) => {
      this.#pending.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer)));
    });
  }
}

export interface ProductionHostLoadProbeOptions {
  readonly platform: NodeJS.Platform;
  readonly dataDirectory: string;
}

export function productionHostLoadProbe(options: ProductionHostLoadProbeOptions): HostLoadProbe {
  const filesystem = new NodeFilesystem();
  if (options.platform === "darwin") {
    return new DarwinHostLoadProbe({
      cpus,
      dataDirectory: options.dataDirectory,
      filesystem,
      processRunner: new NodeProcessRunner(),
    });
  }
  if (options.platform === "win32") {
    return new WindowsHostLoadProbe({
      cpus,
      dataDirectory: options.dataDirectory,
      filesystem,
      freemem,
      now: () => Date.now(),
      processRunner: new NodeProcessRunner(),
      totalmem,
    });
  }
  return new LinuxHostLoadProbe({
    cores: () => cpus().length,
    dataDirectory: options.dataDirectory,
    filesystem,
    nowMicros: () => Number(process.hrtime.bigint() / 1000n),
  });
}
