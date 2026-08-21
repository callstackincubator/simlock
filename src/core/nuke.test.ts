import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import type { Config } from "./config.js";
import { FakeDriver } from "./fake-driver.js";
import { LeaseEngine } from "./lease-engine.js";
import { Nuke } from "./nuke.js";
import { Registry } from "./registry.js";

describe("Nuke", () => {
  it("destroys every registry device and never targets a foreign device", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        { deviceId: "managed", driverData: { fakeDeviceId: "managed" }, runState: "running" },
        { deviceId: "foreign", driverData: { fakeDeviceId: "foreign" }, runState: "running" },
      ],
      processes: [],
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "managed" },
      driverDeviceId: "managed",
      provisionDuration: 0,
      spec: { model: "Phone", osVersion: "1", platform: "ios" },
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const engine = new LeaseEngine({
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      idGenerator: sequence(),
      registry,
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * 1024 ** 3,
        totalRamBytes: 32 * 1024 ** 3,
      }),
    });

    await new Nuke({ executor: engine, registry }).run({ deleteDevices: true });

    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(driver.calls.filter((call) => call.operation === "destroy")).toEqual([
      expect.objectContaining({ arguments: [expect.objectContaining({ deviceId: "managed" })] }),
    ]);
    expect(driver.calls.flatMap((call) => call.arguments)).not.toContainEqual(
      expect.objectContaining({ deviceId: "foreign" }),
    );
  });

  it("waits for a blocked reclaim before deleting the registry-owned device", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: sequence(),
      statePath: "/state.json",
    });
    const driver = new FakeDriver({
      availableOsVersions: ["1"],
      clock,
      latencyMs: { reclaim: 20 },
      platform: "ios",
    });
    const engine = new LeaseEngine({
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      idGenerator: sequence(),
      registry,
      systemStats: new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * 1024 ** 3,
        totalRamBytes: 32 * 1024 ** 3,
      }),
    });
    const grant = await engine.request(
      { model: "Phone", osVersion: "1", platform: "ios" },
      { mode: "held", requesterId: "agent" },
    );

    const release = engine.release(grant.lease.id, "explicit");
    await flush();
    expect(registry.snapshot.devices).toMatchObject([{ id: grant.device.id, state: "reclaiming" }]);

    let nukeComplete = false;
    const nuke = engine.nuke(true).then((result) => {
      nukeComplete = true;
      return result;
    });
    await flush();
    expect(nukeComplete).toBe(false);

    clock.advance(20);
    await release;
    await expect(nuke).resolves.toEqual({ releasedLeaseIds: [] });
    expect(registry.snapshot.devices).toMatchObject([{ id: grant.device.id, state: "deleted" }]);

    clock.advance(100);
    await flush();
    expect(registry.snapshot.devices).toMatchObject([{ id: grant.device.id, state: "deleted" }]);
    expect(
      registry.snapshot.devices.some(
        (device) => device.state === "ready" || device.state === "shutdown",
      ),
    ).toBe(false);
  });
});

async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function config(): Config {
  return {
    diskPressure: { freeBytesThreshold: 1 },
    eventBuffer: { capacity: 10 },
    idle: { deleteAfterMs: 10, shutdownAfterMs: 5 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000, heartbeatIntervalMs: 15_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}
