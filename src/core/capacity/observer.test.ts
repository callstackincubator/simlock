import { describe, expect, it } from "vitest";

import { EventBus } from "../../bus/index.js";
import { FakeClock } from "../../ports/index.js";
import type { CapacityFigures } from "./figures.js";
import { CapacityObserver, capacityChangedPayload } from "./observer.js";

function figures(running: number, options: { ramBudget?: boolean } = {}): CapacityFigures {
  const entry = { maxRunning: 2, overLimit: false, reserved: 0, running };
  return {
    android: { ...entry, atRamBudget: false, limit: 4, running: 0, used: 0, warm: 0 },
    global: { ...entry, warm: 1 },
    ios: { ...entry, atRamBudget: true, limit: 4, used: 3, warm: 1 },
    ...(options.ramBudget === true
      ? { ramBudget: { limitBytes: 100, overLimit: false, usedBytes: 40 } }
      : {}),
  };
}

function observer(current: () => CapacityFigures) {
  const bus = new EventBus(new FakeClock(1_000));
  const emitted = () =>
    bus
      .replay()
      .filter((event) => event.event === "capacity.changed")
      .map((event) => event.payload);
  return { emitted, observer: new CapacityObserver({ eventBus: bus, figures: current }) };
}

describe("CapacityObserver", () => {
  it("emits nothing until it is started, then once", () => {
    const { emitted, observer: subject } = observer(() => figures(1));

    subject.changed();
    expect(emitted()).toEqual([]);

    subject.start();
    expect(emitted()).toHaveLength(1);
  });

  it("emits again only when the figures differ from the last emitted", () => {
    let running = 1;
    const { emitted, observer: subject } = observer(() => figures(running));
    subject.start();

    subject.changed();
    running = 2;
    subject.changed();
    subject.changed();

    expect(
      emitted().map((payload) => (payload as { ios: { running: number } }).ios.running),
    ).toEqual([1, 2]);
  });

  it("carries only running, maxRunning, reserved and warm per platform, and the budget's used and limit bytes", () => {
    expect(capacityChangedPayload(figures(1, { ramBudget: true }))).toEqual({
      android: { maxRunning: 2, reserved: 0, running: 0, warm: 0 },
      global: { maxRunning: 2, reserved: 0, running: 1, warm: 1 },
      ios: { maxRunning: 2, reserved: 0, running: 1, warm: 1 },
      ramBudget: { limitBytes: 100, usedBytes: 40 },
    });
    expect(capacityChangedPayload(figures(1))).not.toHaveProperty("ramBudget");
  });
});
