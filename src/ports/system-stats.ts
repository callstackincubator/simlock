import { availableParallelism, totalmem } from "node:os";

export interface SystemStats {
  cpuCount(): number;
  totalRamBytes(): number;
}

export class NodeSystemStats implements SystemStats {
  cpuCount(): number {
    return availableParallelism();
  }

  totalRamBytes(): number {
    return totalmem();
  }
}

export interface SystemStatsValues {
  readonly cpuCount: number;
  readonly totalRamBytes: number;
}

export class FakeSystemStats implements SystemStats {
  constructor(private readonly values: SystemStatsValues) {}

  cpuCount(): number {
    return this.values.cpuCount;
  }

  totalRamBytes(): number {
    return this.values.totalRamBytes;
  }
}
