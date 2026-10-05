import type { CapacityFiguresPayload, EventBus, EventMap } from "../../bus/index.js";
import type { CapacityFigures } from "./figures.js";

type CapacityChanged = EventMap["capacity.changed"];

function entry(figures: CapacityFiguresPayload): CapacityFiguresPayload {
  return {
    maxRunning: figures.maxRunning,
    reserved: figures.reserved,
    running: figures.running,
    warm: figures.warm,
  };
}

/** The part of the figures `capacity.changed` carries. */
export function capacityChangedPayload(figures: CapacityFigures): CapacityChanged {
  return {
    android: entry(figures.android),
    global: entry(figures.global),
    ios: entry(figures.ios),
    ...(figures.ramBudget === undefined
      ? {}
      : {
          ramBudget: {
            limitBytes: figures.ramBudget.limitBytes,
            usedBytes: figures.ramBudget.usedBytes,
          },
        }),
  };
}

export interface CapacityObserverOptions {
  readonly eventBus: Pick<EventBus, "emit">;
  /** Builds the current figures; the same function `status.get` builds its own through. */
  readonly figures: () => CapacityFigures;
}

/**
 * Emits `capacity.changed` when the capacity figures differ from the last emitted. Callers tell
 * it a commit or a reservation change happened (`changed`); it decides whether anything moved.
 * Silent until `start`, which emits once so every run begins with a step.
 */
export class CapacityObserver {
  #started = false;
  #last: string | undefined;

  constructor(private readonly options: CapacityObserverOptions) {}

  start(): void {
    this.#started = true;
    this.changed();
  }

  changed(): void {
    if (!this.#started) return;
    const payload = capacityChangedPayload(this.options.figures());
    const key = JSON.stringify(payload);
    if (key === this.#last) return;
    this.#last = key;
    this.options.eventBus.emit("capacity.changed", payload, "capacity-observer");
  }
}
