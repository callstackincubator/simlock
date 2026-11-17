import { describe, expect, it, vi } from "vitest";
import { FakeDriver, openTestState } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, flush, request } from "./test-create-leasing.js";

const LIMITS = {
  android: { maxDevices: 2, maxRunning: 2 },
  ios: { maxDevices: 2, maxRunning: 2 },
  maxRunning: 2,
};

describe("the warm pool on a worker whose android.virtualDevices is false", () => {
  it("boots nothing on the platform, reports its configured target short unknown-model, forgets its learned kind, counts its reserve as 0, and fills an iOS target", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({
      availableOsVersions: ["36"],
      clock,
      knownModels: [androidRequest.model],
      platform: "android",
    });
    const state = await openTestState();
    const before = await createHarness({
      drivers: [ios, android],
      limits: LIMITS,
      startPool: true,
      state,
    });
    before.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    const learning = await before.engine.request(androidRequest, {
      ownerId: "learner",
      requesterId: "learner",
    });
    await before.engine.release(learning.lease.id, "explicit");
    await flush();
    await before.engine.core.passWarmPool();
    expect(
      before.engine.figures().targets.map((target) => [target.origin, target.platform]),
    ).toContainEqual(["learned", "android"]);
    before.engine.dispose();
    const androidBoots = () =>
      android.calls.filter((call) => ["makeReady", "provision"].includes(call.operation)).length;
    const bootsBefore = androidBoots();

    const after = await createHarness({
      drivers: [ios, android],
      firstId: 5_000,
      limits: LIMITS,
      startPool: true,
      state,
      virtualDevices: { android: false },
      warmPool: {
        reserveRunning: { android: 2, ios: 0 },
        targets: [
          { count: 1, model: androidRequest.model, osVersion: "36", platform: "android" },
          { count: 1, model: request.model, osVersion: "26.5", platform: "ios" },
        ],
      },
    });
    await after.engine.core.passWarmPool();
    await vi.waitFor(() =>
      expect(
        after.engine.figures().targets.find((target) => target.platform === "ios"),
      ).toMatchObject({ ready: 1 }),
    );
    await after.engine.settle();

    const figures = after.engine.figures().targets;
    expect(figures.find((target) => target.platform === "android")).toMatchObject({
      booting: 0,
      origin: "configured",
      ready: 0,
      short: "unknown-model",
    });
    expect(figures.filter((target) => target.platform === "android")).toHaveLength(1);
    expect(figures.find((target) => target.platform === "ios")).toMatchObject({
      origin: "configured",
      ready: 1,
    });
    expect(figures.find((target) => target.platform === "ios")).not.toHaveProperty("short");
    expect(androidBoots()).toBe(bootsBefore);
  });
});
