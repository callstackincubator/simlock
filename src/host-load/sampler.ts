import type { Clock, DiskCounters, HostLoadProbe, Logger, MemoryCounters } from "../ports/index.js";

export interface HostLoadCpu {
  readonly busyPercent: number;
  readonly cores: number;
  readonly limited: boolean;
}

export interface HostLoadReading {
  readonly ageMs: number;
  readonly cpu?: HostLoadCpu;
  readonly memory?: MemoryCounters;
  readonly disk?: DiskCounters;
}

export interface HostLoadSamplerOptions {
  readonly clock: Clock;
  readonly probe: HostLoadProbe;
  readonly logger?: Logger;
}

export class HostLoadSampler {
  constructor(private readonly options: HostLoadSamplerOptions) {}

  start(): void {
    void this.options;
  }

  current(): HostLoadReading | undefined {
    return undefined;
  }

  dispose(): void {}
}
