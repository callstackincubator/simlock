import { describe, expect, it } from "vitest";
import type { VirtualDevice } from "../domain.js";
import { device, fakeMemoryPressure, harness, iosListing, iphone15, now } from "./test-fixtures.js";

type Rig = ReturnType<typeof harness>;

const pixel = { count: 1, model: "Pixel 8", osVersion: "35", platform: "android" as const };
const refillDelayMs = 60_000;

function grant(rig: Rig, deviceId: string, platform: "ios" | "android" = "ios"): void {
  rig.eventBus.emit(
    "lease.granted",
    {
      deviceId,
      leaseId: `lease-${deviceId}`,
      platform,
      requestId: "req",
      requester: "a",
      source: "warm",
    },
    "test",
  );
}

/** why: the work the pool has started for a refill: a boot, a creation or a shutdown. */
const started = (rig: Rig): number =>
  rig.bootCalls.length + rig.provisionCalls.length + rig.shutdownCalls.length;

describe("warm pool refill delay", () => {
  it("a grant holds every refill until refillDelayMs after the latest grant, with no short, no displaced shutdown and no warm-pool.target-missed meanwhile", async () => {
    const leased = (id: string, platform: "ios" | "android" = "ios"): VirtualDevice =>
      device(id, "leased", 0, platform);
    const pad: VirtualDevice = {
      ...device("pad", "ready", 30 * 60_000),
      spec: { model: "iPad Pro", osVersion: "26.0", physical: false, platform: "ios" },
    };
    // why: each case grants at the given offsets, then the refill must start exactly at `at` and not a ms before.
    const table: readonly {
      name: string;
      at: number;
      devices: readonly VirtualDevice[];
      grants: readonly (readonly [number, string])[];
      options: Parameters<typeof harness>[1];
    }[] = [
      {
        name: "a configured target with a shut-down device to boot",
        at: 60_000,
        devices: [leased("l1"), device("s1", "shutdown", 0)],
        grants: [[0, "l1"]],
        options: { targets: [iphone15] },
      },
      {
        name: "a configured target needing a creation",
        at: 60_000,
        devices: [leased("l1")],
        grants: [[0, "l1"]],
        options: { targets: [iphone15] },
      },
      {
        name: "a learned kind's spare",
        at: 60_000,
        devices: [leased("l1"), device("s1", "shutdown", 0)],
        grants: [[0, "l1"]],
        options: { catalog: async () => [iosListing] },
      },
      {
        name: "a second grant at 30 000 ms moves it to 90 000 ms",
        at: 90_000,
        devices: [leased("l1"), leased("l2"), device("s1", "shutdown", 0)],
        grants: [
          [0, "l1"],
          [30_000, "l2"],
        ],
        options: { targets: [iphone15] },
      },
      {
        name: "an iOS grant holds an Android target",
        at: 60_000,
        devices: [leased("l1"), device("a1", "shutdown", 0, "android")],
        grants: [[0, "l1"]],
        options: { targets: [pixel] },
      },
      {
        name: "a target that would displace a learned device",
        at: 60_000,
        devices: [leased("l1"), pad],
        grants: [[0, "l1"]],
        options: { limit: 2, targets: [iphone15] },
      },
    ];
    for (const { name, at, devices, grants, options } of table) {
      const rig = harness(devices, { ...options, refillDelayMs });
      const missed: string[] = [];
      rig.eventBus.subscribe("warm-pool.target-missed", ({ payload }) => {
        missed.push(payload.model);
      });
      rig.pool.start();
      let elapsed = 0;
      for (const [offset, deviceId] of grants) {
        rig.clock.advance(offset - elapsed);
        elapsed = offset;
        grant(rig, deviceId);
        await rig.pool.settle();
      }
      rig.clock.advance(at - 1 - elapsed);
      await rig.pool.pass();
      await rig.pool.settle();
      expect(started(rig), `${name}: nothing at ${at - 1} ms`).toBe(0);
      expect(
        rig.pool.figures().targets.map((target) => target.short),
        `${name}: no short while held`,
      ).toEqual(rig.pool.figures().targets.map(() => undefined));
      expect(missed, `${name}: no target-missed while held`).toEqual([]);

      rig.clock.advance(1);
      await rig.pool.settle();
      expect(started(rig), `${name}: the timer's pass at ${at} ms`).toBeGreaterThan(0);
      rig.pool.dispose();
    }
  });

  it("a physical device's grant starts no wait", async () => {
    const rig = harness([device("s1", "shutdown", 0)], { refillDelayMs, targets: [iphone15] });
    rig.pool.start();
    grant(rig, "phone-1");
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["s1"]);
    rig.pool.dispose();
  });

  it("at warming-paused a held target reports memory-pressure", async () => {
    const pressure = fakeMemoryPressure({
      cause: { availablePercent: 12, level: "warn", trigger: "level" },
      readingAt: now,
      since: now,
      step: "warming-paused",
    });
    const rig = harness([device("l1", "leased", 0)], {
      memoryPressure: pressure.reader,
      refillDelayMs,
      targets: [iphone15],
    });
    rig.pool.start();
    grant(rig, "l1");
    await rig.pool.settle();
    expect(rig.pool.figures().targets.map((target) => target.short)).toEqual(["memory-pressure"]);
    rig.pool.dispose();
  });
});
