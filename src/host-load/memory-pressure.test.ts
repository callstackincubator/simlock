import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { MemoryPressureTracker } from "./index.js";

const CONFIG = {
  clearAfterMs: 60_000,
  enabled: true,
  pauseNewDevices: { level: "critical", minAvailablePercent: 10 },
  pauseWarming: { level: "warn", minAvailablePercent: 20 },
} as const;

const memory = (pressure: "normal" | "warn" | "critical") => ({
  availableBytes: 3_400,
  limited: false,
  pressure,
  swapUsedBytes: 0,
  totalBytes: 10_000,
});

describe("MemoryPressureTracker", () => {
  it("drops the step at once when no reading arrives for 60 s", () => {
    const clock = new FakeClock(1_000);
    const tracker = new MemoryPressureTracker({
      clock,
      config: CONFIG,
      eventBus: new EventBus(clock),
    });
    tracker.observe({ memory: memory("warn") });
    expect(tracker.current()).toMatchObject({ since: 1_000, step: "warming-paused" });

    clock.advance(59_999);
    expect(tracker.current()).toMatchObject({ step: "warming-paused" });

    clock.advance(1);
    const dropped = tracker.current();
    expect(dropped?.step).toBe("none");
    expect(dropped).not.toHaveProperty("since");
    expect(dropped).not.toHaveProperty("cause");
  });
});
