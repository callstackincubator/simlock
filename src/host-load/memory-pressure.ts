import type { EventBus } from "../bus/index.js";
import type { Clock, MemoryCounters, TimerHandle } from "../ports/index.js";

export type MemoryPressureLevel = "normal" | "warn" | "critical";
export type MemoryPressureStep = "none" | "warming-paused" | "new-devices-paused";

interface MemoryPressureRule {
  readonly level: MemoryPressureLevel | "off";
  readonly minAvailablePercent: number;
}

interface MemoryPressureConfig {
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
  readonly eventBus: EventBus;
}

interface HeldStep {
  readonly since: number;
  readonly cause: MemoryPressureCause;
  clearTimer?: TimerHandle;
}

type StepKey = "warming" | "newDevices";

/** why: a reading older than this says nothing about the host now (ADR 0068 §1). */
const STALE_AFTER_MS = 60_000;

const LEVEL_RANK: Record<MemoryPressureLevel, number> = { normal: 0, warn: 1, critical: 2 };

/**
 * why: the step a worker is at, worked out from each host-load reading. A step comes on at the
 * first reading that meets it and lifts `clearAfterMs` after the first reading that no longer does.
 */
export class MemoryPressureTracker {
  readonly #held: Record<StepKey, HeldStep | undefined> = {
    newDevices: undefined,
    warming: undefined,
  };
  #readingAt: number | undefined;
  #staleTimer: TimerHandle | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly options: MemoryPressureOptions) {}

  observe(reading: { readonly memory?: MemoryCounters }): void {
    const now = this.options.clock.now();
    this.#readingAt = now;
    this.#armStale();
    const { config } = this.options;
    const memory = config.enabled ? reading.memory : undefined;
    this.#changing(() => {
      if (memory === undefined) {
        this.#dropAll();
        return;
      }
      this.#hold("warming", config.pauseWarming, memory, now);
      this.#hold("newDevices", config.pauseNewDevices, memory, now);
    });
    for (const listener of this.#listeners) listener();
  }

  current(): MemoryPressureState | undefined {
    if (this.#readingAt === undefined) return undefined;
    const newDevices = this.#held.newDevices;
    const warming = this.#held.warming;
    if (newDevices !== undefined) return state("new-devices-paused", newDevices, this.#readingAt);
    if (warming !== undefined) return state("warming-paused", warming, this.#readingAt);
    return { readingAt: this.#readingAt, step: "none" };
  }

  /** why: a reader acts once per reading, after the step has been updated and its event sent. */
  onReading(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#listeners.clear();
    if (this.#staleTimer !== undefined) this.options.clock.cancel(this.#staleTimer);
    this.#staleTimer = undefined;
    this.#dropAll();
  }

  #armStale(): void {
    if (this.#staleTimer !== undefined) this.options.clock.cancel(this.#staleTimer);
    this.#staleTimer = this.options.clock.setTimer(STALE_AFTER_MS, () => {
      this.#staleTimer = undefined;
      this.#changing(() => this.#dropAll());
    });
  }

  /** why: the event follows the change it reports, and only a change of step is one. */
  #changing(mutate: () => void): void {
    const from = this.current();
    mutate();
    const to = this.current();
    if (from === undefined || to === undefined || from.step === to.step) return;
    this.options.eventBus.emit(
      "memory.pressure-changed",
      {
        from: from.step,
        to: to.step,
        ...(to.cause === undefined ? {} : { cause: to.cause }),
      },
      "host-load",
    );
  }

  #dropAll(): void {
    for (const key of ["warming", "newDevices"] as const) {
      this.#cancelClear(this.#held[key]);
      this.#held[key] = undefined;
    }
  }

  #hold(key: StepKey, rule: MemoryPressureRule, memory: MemoryCounters, now: number): void {
    const held = this.#held[key];
    const cause = meets(rule, memory);
    if (cause !== undefined) {
      this.#cancelClear(held);
      this.#held[key] ??= { cause, since: now };
      return;
    }
    if (held === undefined || held.clearTimer !== undefined) return;
    held.clearTimer = this.options.clock.setTimer(this.options.config.clearAfterMs, () => {
      this.#changing(() => {
        this.#held[key] = undefined;
      });
    });
  }

  #cancelClear(held: HeldStep | undefined): void {
    if (held?.clearTimer === undefined) return;
    this.options.clock.cancel(held.clearTimer);
    delete held.clearTimer;
  }
}

function state(step: MemoryPressureStep, held: HeldStep, readingAt: number): MemoryPressureState {
  return { cause: held.cause, readingAt, since: held.since, step };
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
