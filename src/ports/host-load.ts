import { cpus } from "node:os";

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
    try {
      const cores = this.options.cpus();
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
}

export class LinuxHostLoadProbe implements HostLoadProbe {
  constructor(private readonly options: LinuxHostLoadProbeOptions) {}

  async read(): Promise<HostLoadCounters> {
    const [cpu, memory, disk] = await Promise.all([
      this.#cpu(),
      this.#memory(),
      readDisk(this.options.filesystem, this.options.dataDirectory),
    ]);
    return { ...(cpu && { cpu }), ...(memory && { memory }), ...(disk && { disk }) };
  }

  async #cpu(): Promise<CpuCounters | undefined> {
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
        cores: this.options.cores(),
        limited: false,
        totalTime: busyTime + idle + iowait,
      };
    } catch {
      return undefined;
    }
  }

  async #memory(): Promise<MemoryCounters | undefined> {
    try {
      const text = await this.options.filesystem.readFile("/proc/meminfo");
      const kib = (name: string): number | undefined => {
        const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
        return match ? Number(match[1]) * 1024 : undefined;
      };
      const totalBytes = kib("MemTotal");
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
    } catch {
      return undefined;
    }
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
  return new LinuxHostLoadProbe({
    cores: () => cpus().length,
    dataDirectory: options.dataDirectory,
    filesystem,
  });
}
