import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../../ports/index.js";
import { capacityStrategies, type CapacityStrategyName } from "./strategies/index.js";
import type { CapacityDevice, CapacityStrategy } from "./strategy.js";

const gibibyte = 1024 ** 3;

/**
 * Behaviour every strategy owes its callers, whatever policy it implements.
 * A new strategy is wired into this suite by the registry alone.
 */
function build(name: CapacityStrategyName): CapacityStrategy {
  const systemStats = new FakeSystemStats({
    cpuCount: 8,
    freeRamBytes: 32 * gibibyte,
    totalRamBytes: 32 * gibibyte,
  });
  const definition = capacityStrategies[name];
  return definition.create(definition.defaults(systemStats) as never, systemStats);
}

describe.each(Object.keys(capacityStrategies) as CapacityStrategyName[])(
  "capacity strategy contract: %s",
  (name) => {
    it("permits provisioning on an empty machine", () => {
      expect(build(name).canProvision({ mode: "full", platform: "ios" }, [])).toEqual({ ok: true });
    });

    it("reports a positive device limit for both platforms", () => {
      const strategy = build(name);

      expect(strategy.deviceLimit("ios")).toBeGreaterThan(0);
      expect(strategy.deviceLimit("android")).toBeGreaterThan(0);
    });

    it("ignores deleted devices when deciding whether another may be created", () => {
      const strategy = build(name);
      const deleted: CapacityDevice[] = Array.from({ length: 50 }, () => ({
        mode: "full",
        platform: "ios",
        state: "deleted",
      }));

      expect(strategy.canProvision({ mode: "full", platform: "ios" }, deleted)).toEqual({
        ok: true,
      });
    });

    it("counts a reservation against running capacity exactly like a running device", () => {
      const strategy = build(name);
      const reserved = strategy.runningCapacity([], ["ios"]).ios;
      const running = strategy.runningCapacity(
        [{ mode: "full" as const, platform: "ios", state: "ready" }],
        [],
      ).ios;

      expect(reserved.reserved).toBe(1);
      expect(running.running).toBe(1);
      expect(reserved.maxRunning).toBe(running.maxRunning);
    });

    it("refuses a running reservation once the platform is saturated, with a limit reason", () => {
      const strategy = build(name);
      const saturated: CapacityDevice[] = Array.from(
        { length: strategy.runningCapacity([], []).global.maxRunning },
        () => ({ mode: "full" as const, platform: "ios", state: "ready" }),
      );
      const decision = strategy.canReserveRunning("ios", saturated, []);

      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error("expected a refusal");
      expect(["global-running-limit", "platform-running-limit"]).toContain(decision.reason);
    });

    it("counts running slots without regard to mode", () => {
      const strategy = build(name);
      const slim = strategy.runningCapacity(
        [{ mode: "slim", platform: "ios", state: "ready" }],
        [],
      );
      const full = strategy.runningCapacity(
        [{ mode: "full", platform: "ios", state: "ready" }],
        [],
      );

      expect(slim).toEqual(full);
      expect(slim.ios.running).toBe(1);

      const saturated = (mode: "slim" | "full"): CapacityDevice[] =>
        Array.from({ length: slim.global.maxRunning }, () => ({
          mode,
          platform: "ios",
          state: "ready",
        }));
      expect(strategy.canReserveRunning("ios", saturated("slim"), [])).toEqual(
        strategy.canReserveRunning("ios", saturated("full"), []),
      );
      expect(strategy.canReserveRunning("ios", saturated("slim"), []).ok).toBe(false);
    });

    it("does not count devices in non-running states towards running capacity", () => {
      const capacity = build(name).runningCapacity(
        [{ mode: "full" as const, platform: "ios", state: "shutdown" }],
        [],
      );

      expect(capacity.ios.running).toBe(0);
      expect(capacity.global.running).toBe(0);
    });

    it("treats an unknown lifecycle state as not running rather than throwing", () => {
      const capacity = build(name).runningCapacity(
        [{ mode: "full" as const, platform: "android", state: "unknown-to-core" }],
        [],
      );

      expect(capacity.android.running).toBe(0);
    });
  },
);
