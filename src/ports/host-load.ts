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
    void this.options;
    return {};
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
    void this.options;
    return {};
  }
}

export class FakeHostLoadProbe implements HostLoadProbe {
  readonly #pending: ((answer: HostLoadCounters | Error) => void)[] = [];
  #counters: HostLoadCounters | undefined;
  #reads = 0;

  constructor(counters?: HostLoadCounters) {
    this.#counters = counters;
  }

  get reads(): number {
    return this.#reads;
  }

  set(counters: HostLoadCounters): void {
    this.#counters = counters;
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
