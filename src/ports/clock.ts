export interface TimerHandle {
  readonly _timerHandle?: never;
}

export interface Clock {
  now(): number;
  setTimer(delayMs: number, callback: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimer(delayMs: number, callback: () => void): TimerHandle {
    return setTimeout(callback, delayMs) as unknown as TimerHandle;
  }

  cancel(handle: TimerHandle): void {
    clearTimeout(handle as unknown as NodeJS.Timeout);
  }
}

interface ScheduledTimer {
  readonly deadline: number;
  readonly id: number;
  readonly callback: () => void;
}

export class FakeClock implements Clock {
  #now: number;
  #nextTimerId = 0;
  readonly #timers = new Map<number, ScheduledTimer>();

  constructor(initialNow = 0) {
    this.#now = initialNow;
  }

  now(): number {
    return this.#now;
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  setTimer(delayMs: number, callback: () => void): TimerHandle {
    const id = this.#nextTimerId;
    this.#nextTimerId += 1;
    this.#timers.set(id, {
      deadline: this.#now + Math.max(0, delayMs),
      id,
      callback,
    });

    return { id } as TimerHandle & { readonly id: number };
  }

  cancel(handle: TimerHandle): void {
    const timer = handle as TimerHandle & { readonly id: number };
    this.#timers.delete(timer.id);
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    let nextTimer = this.#nextTimerDueBy(target);

    while (nextTimer !== undefined) {
      this.#timers.delete(nextTimer.id);
      this.#now = nextTimer.deadline;
      nextTimer.callback();
      nextTimer = this.#nextTimerDueBy(target);
    }

    this.#now = target;
  }

  #nextTimerDueBy(target: number): ScheduledTimer | undefined {
    let selected: ScheduledTimer | undefined;

    for (const timer of this.#timers.values()) {
      if (
        timer.deadline <= target &&
        (selected === undefined ||
          timer.deadline < selected.deadline ||
          (timer.deadline === selected.deadline && timer.id < selected.id))
      ) {
        selected = timer;
      }
    }

    return selected;
  }
}
