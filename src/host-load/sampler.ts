import {
  type Clock,
  type CpuCounters,
  type DiskCounters,
  type HostLoadCounters,
  type HostLoadProbe,
  type Logger,
  type MemoryCounters,
  NoopLogger,
  type TimerHandle,
} from "../ports/index.js";

interface HostLoadCpu {
  readonly busyPercent: number;
  readonly cores: number;
  readonly limited: boolean;
}

interface HostLoadReading {
  readonly ageMs: number;
  readonly cpu?: HostLoadCpu;
  readonly memory?: MemoryCounters;
  readonly disk?: DiskCounters;
}

interface HostLoadSamplerOptions {
  readonly clock: Clock;
  readonly probe: HostLoadProbe;
  readonly logger?: Logger;
}

const SAMPLE_INTERVAL_MS = 15_000;
const READ_BOUND_MS = 10_000;

type Part = "cpu" | "memory" | "disk";
type PartState = "never" | "read" | "failed";

export class HostLoadSampler {
  readonly #logger: Logger;
  readonly #states: Record<Part, PartState> = { cpu: "never", disk: "never", memory: "never" };
  #previous: CpuCounters | undefined;
  #reading: { readonly at: number; readonly parts: Omit<HostLoadReading, "ageMs"> } | undefined;
  #inFlight = false;
  #disposed = false;
  #tickTimer: TimerHandle | undefined;
  #boundTimer: TimerHandle | undefined;

  constructor(private readonly options: HostLoadSamplerOptions) {
    this.#logger = (options.logger ?? new NoopLogger()).child("host-load");
  }

  start(): void {
    if (this.#disposed || this.#tickTimer !== undefined || this.#inFlight) return;
    this.#arm();
    this.#sample();
  }

  current(): HostLoadReading | undefined {
    if (this.#reading === undefined) return undefined;
    return {
      ageMs: Math.max(0, this.options.clock.now() - this.#reading.at),
      ...this.#reading.parts,
    };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#tickTimer !== undefined) this.options.clock.cancel(this.#tickTimer);
    this.#tickTimer = undefined;
    if (this.#boundTimer !== undefined) this.options.clock.cancel(this.#boundTimer);
    this.#boundTimer = undefined;
  }

  #arm(): void {
    this.#tickTimer = this.options.clock.setTimer(SAMPLE_INTERVAL_MS, () => {
      this.#tickTimer = undefined;
      if (this.#disposed || this.#inFlight) return;
      this.#arm();
      this.#sample();
    });
  }

  #sample(): void {
    if (this.#inFlight) return;
    this.#inFlight = true;
    const { clock, probe } = this.options;
    let finished = false;
    const give = (counters: HostLoadCounters | undefined, error?: unknown): void => {
      if (finished || this.#disposed) return;
      finished = true;
      if (this.#boundTimer !== undefined) clock.cancel(this.#boundTimer);
      this.#boundTimer = undefined;
      this.#record(counters, error);
    };
    this.#boundTimer = clock.setTimer(READ_BOUND_MS, () => {
      this.#boundTimer = undefined;
      // why: an answer already queued behind the timer beats the bound, so a late tick cannot discard it.
      void Promise.resolve().then(() => give(undefined, new Error("host load read timed out")));
    });
    const settled = (): void => {
      this.#inFlight = false;
      if (this.#boundTimer !== undefined && !finished) clock.cancel(this.#boundTimer);
      if (!finished) this.#boundTimer = undefined;
      // why: a tick that fired during this read re-armed nothing, so the beat resumes here.
      if (!this.#disposed && this.#tickTimer === undefined) this.#arm();
    };
    let read: Promise<HostLoadCounters>;
    try {
      read = probe.read();
    } catch (error) {
      settled();
      give(undefined, error);
      return;
    }
    read.then(
      (counters) => {
        settled();
        give(counters);
      },
      (error: unknown) => {
        settled();
        give(undefined, error);
      },
    );
  }

  #record(counters: HostLoadCounters | undefined, error: unknown): void {
    const now = this.options.clock.now();
    if (counters === undefined) {
      this.#logger.warn("Host load read failed", { error: describe(error) });
      for (const part of ["cpu", "memory", "disk"] as const) {
        if (this.#states[part] === "read") this.#states[part] = "failed";
      }
      this.#reading = { at: now, parts: {} };
      return;
    }
    for (const part of ["cpu", "memory", "disk"] as const) {
      this.#note(part, counters[part] !== undefined);
    }
    const parts: { cpu?: HostLoadCpu; memory?: MemoryCounters; disk?: DiskCounters } = {};
    if (counters.cpu !== undefined) {
      const cpu = busyPercent(this.#previous, counters.cpu);
      if (cpu !== undefined) parts.cpu = cpu;
      this.#previous = counters.cpu;
    }
    if (counters.memory !== undefined) parts.memory = counters.memory;
    if (counters.disk !== undefined) parts.disk = counters.disk;
    this.#reading = { at: now, parts };
  }

  #note(part: Part, present: boolean): void {
    const state = this.#states[part];
    if (present) {
      if (state === "failed") this.#logger.warn("Host load part read again", { part });
      this.#states[part] = "read";
    } else if (state === "read") {
      this.#logger.warn("Host load part failed", { part });
      this.#states[part] = "failed";
    }
  }
}

function busyPercent(
  previous: CpuCounters | undefined,
  current: CpuCounters,
): HostLoadCpu | undefined {
  if (previous === undefined) return undefined;
  if (previous.cores !== current.cores || previous.limited !== current.limited) return undefined;
  const total = current.totalTime - previous.totalTime;
  if (!(total > 0)) return undefined;
  const busy = (100 * (current.busyTime - previous.busyTime)) / total;
  return {
    busyPercent: Math.min(100, Math.max(0, busy)),
    cores: current.cores,
    limited: current.limited,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
