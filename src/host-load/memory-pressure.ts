import type { Clock, MemoryCounters } from "../ports/index.js";

export type MemoryPressureLevel = "normal" | "warn" | "critical";
export type MemoryPressureStep = "none" | "warming-paused" | "new-devices-paused";

export interface MemoryPressureRule {
  readonly level: MemoryPressureLevel | "off";
  readonly minAvailablePercent: number;
}

export interface MemoryPressureConfig {
  readonly enabled: boolean;
  readonly pauseWarming: MemoryPressureRule;
  readonly pauseNewDevices: MemoryPressureRule;
  readonly clearAfterMs: number;
}

export interface MemoryPressureCause {
  readonly trigger: "level" | "floor";
  readonly availablePercent: number;
  readonly level?: MemoryPressureLevel;
  readonly floorPercent?: number;
}

export interface MemoryPressureState {
  readonly step: MemoryPressureStep;
  readonly since?: number;
  readonly cause?: MemoryPressureCause;
  readonly readingAt: number;
}

interface MemoryPressureOptions {
  readonly clock: Clock;
  readonly config: MemoryPressureConfig;
}

interface HeldStep {
  readonly since: number;
  readonly cause: MemoryPressureCause;
}

const LEVEL_RANK: Record<MemoryPressureLevel, number> = { normal: 0, warn: 1, critical: 2 };

/**
 * why: the step a worker is at, worked out from each host-load reading. A step comes on at the
 * first reading that meets it and lifts `clearAfterMs` after the first reading that no longer does.
 */
export class MemoryPressureTracker {
  #warming: HeldStep | undefined;
  #newDevices: HeldStep | undefined;
  #readingAt: number | undefined;

  constructor(private readonly options: MemoryPressureOptions) {}

  observe(reading: { readonly memory?: MemoryCounters }): void {
    const now = this.options.clock.now();
    this.#readingAt = now;
    const { config } = this.options;
    const memory = config.enabled ? reading.memory : undefined;
    this.#warming = this.#hold(this.#warming, config.pauseWarming, memory, now);
    this.#newDevices = this.#hold(this.#newDevices, config.pauseNewDevices, memory, now);
  }

  current(): MemoryPressureState | undefined {
    if (this.#readingAt === undefined) return undefined;
    const held =
      this.#newDevices === undefined
        ? this.#warming === undefined
          ? undefined
          : ({ held: this.#warming, step: "warming-paused" } as const)
        : ({ held: this.#newDevices, step: "new-devices-paused" } as const);
    if (held === undefined) return { readingAt: this.#readingAt, step: "none" };
    return {
      cause: held.held.cause,
      readingAt: this.#readingAt,
      since: held.held.since,
      step: held.step,
    };
  }

  #hold(
    held: HeldStep | undefined,
    rule: MemoryPressureRule,
    memory: MemoryCounters | undefined,
    now: number,
  ): HeldStep | undefined {
    const cause = memory === undefined ? undefined : meets(rule, memory);
    if (cause === undefined) return held;
    return held ?? { cause, since: now };
  }
}

function meets(rule: MemoryPressureRule, memory: MemoryCounters): MemoryPressureCause | undefined {
  const exactPercent = (100 * memory.availableBytes) / memory.totalBytes;
  const availablePercent = Math.floor(Math.min(100, Math.max(0, exactPercent)));
  if (
    rule.level !== "off" &&
    memory.pressure !== undefined &&
    LEVEL_RANK[memory.pressure] >= LEVEL_RANK[rule.level]
  ) {
    return { availablePercent, level: memory.pressure, trigger: "level" };
  }
  if (exactPercent < rule.minAvailablePercent) {
    return { availablePercent, floorPercent: rule.minAvailablePercent, trigger: "floor" };
  }
  return undefined;
}
