import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { loadTestRegistry } from "./testing.js";
import type { VirtualDevice, LeaseRecord } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";
import { NukeService, type NukeDeviceLifecycle, type NukeRegistryView } from "./nuke-service.js";

const device = (id: string, state: VirtualDevice["state"]): VirtualDevice => ({
  physical: false,
  createdAt: 0,
  driverData: { privateDriverData: id },
  driverDeviceId: `driver_${id}`,
  id,
  spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
  mode: "full",
  state,
});

class MutableRegistry implements NukeRegistryView {
  devices: VirtualDevice[];
  leases: LeaseRecord[] = [];

  constructor(devices: VirtualDevice[]) {
    this.devices = devices;
  }

  get snapshot() {
    return { leases: this.leases, virtualDevices: this.devices };
  }
}

function createHarness(devices: VirtualDevice[]) {
  const registry = new MutableRegistry(devices);
  const calls: string[] = [];
  const lifecycle: NukeDeviceLifecycle = {
    async shutdown(target) {
      calls.push(`shutdown:${target.id}`);
      const index = registry.devices.findIndex((candidate) => candidate.id === target.id);
      if (index === -1 || registry.devices[index]?.state !== "ready") return undefined;
      const updated = { ...target, state: "shutdown" as const };
      registry.devices[index] = updated;
      return updated;
    },
    async destroy(target) {
      calls.push(`destroy:${target.id}`);
      const index = registry.devices.findIndex((candidate) => candidate.id === target.id);
      if (index === -1 || registry.devices[index]?.state !== "shutdown") return undefined;
      const updated = { ...target, state: "deleted" as const };
      registry.devices[index] = updated;
      return updated;
    },
  };
  const service = new NukeService({
    acquisition: {
      async beginMaintenance() {
        calls.push("maintenance:begin");
      },
      async endMaintenance() {
        calls.push("maintenance:end");
      },
    },
    devices: lifecycle,
    leases: {
      async beginMaintenance() {
        calls.push("release-maintenance:begin");
      },
      async releaseAllDuringMaintenance(reason) {
        calls.push(`release:${reason}`);
        return ["lse_1", "lse_2"];
      },
      async endMaintenance() {
        calls.push("release-maintenance:end");
      },
    },
    registry,
  });
  return { calls, lifecycle, registry, service };
}

describe("NukeService", () => {
  it("fences acquisition before releasing killed leases and returns their ids", async () => {
    const harness = createHarness([]);

    await expect(harness.service.nuke(false)).resolves.toEqual({
      releasedLeaseIds: ["lse_1", "lse_2"],
    });

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("targets only non-deleted registry records and supports shutdown-only mode", async () => {
    const ready = device("registered", "ready");
    const harness = createHarness([ready, device("already-deleted", "deleted")]);

    await harness.service.nuke(false);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:registered",
      "release-maintenance:end",
      "maintenance:end",
    ]);
    expect(harness.registry.devices).toMatchObject([
      { id: "registered", state: "shutdown" },
      { id: "already-deleted", state: "deleted" },
    ]);
  });

  it("deletes ready and shutdown registry records only after they are shutdown", async () => {
    const harness = createHarness([device("ready", "ready"), device("shutdown", "shutdown")]);

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:ready",
      "destroy:ready",
      "destroy:shutdown",
      "release-maintenance:end",
      "maintenance:end",
    ]);
    expect(harness.registry.devices.map((candidate) => candidate.state)).toEqual([
      "deleted",
      "deleted",
    ]);
  });

  it("never asks the lifecycle to touch a currently leased device", async () => {
    const leased = device("leased", "ready");
    const harness = createHarness([leased]);
    harness.registry.leases = [
      {
        deviceId: leased.id,
        grantedAt: 0,
        id: "lse_live",
        requesterId: "agent",
        ownerId: "agent",
        lastRenewedAt: 0,
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: 1,
      },
    ];

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("skips lifecycle-refused and state-changed targets without forcing destruction", async () => {
    const refused = device("refused", "ready");
    const changed = device("changed", "ready");
    const harness = createHarness([refused, changed]);
    harness.lifecycle.shutdown = async (target) => {
      harness.calls.push(`shutdown:${target.id}`);
      if (target.id === "refused") {
        harness.registry.devices[0] = { ...target, state: "shutdown" };
      }
      if (target.id === "changed") {
        harness.registry.devices[1] = { ...target, state: "deleted" };
      }
      return undefined;
    };

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:refused",
      "shutdown:changed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("reopens admission even when reset work fails", async () => {
    const harness = createHarness([]);
    let fail = true;
    harness.service = new NukeService({
      acquisition: {
        async beginMaintenance() {
          harness.calls.push("maintenance:begin");
        },
        async endMaintenance() {
          harness.calls.push("maintenance:end");
        },
      },
      devices: harness.lifecycle,
      leases: {
        async beginMaintenance() {
          harness.calls.push("release-maintenance:begin");
        },
        async releaseAllDuringMaintenance() {
          if (fail) {
            fail = false;
            throw new Error("release failed");
          }
          harness.calls.push("release:killed");
          return [];
        },
        async endMaintenance() {
          harness.calls.push("release-maintenance:end");
        },
      },
      registry: harness.registry,
    });

    await expect(harness.service.nuke(false)).rejects.toThrow("release failed");
    await expect(harness.service.nuke(false)).resolves.toEqual({ releasedLeaseIds: [] });
    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release-maintenance:end",
      "maintenance:end",
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("does not abort the reset on a device whose platform has no driver, and still resets every device after it", async () => {
    // why: the driverless records are registered first so the attempts that must throw precede
    // the healthy ones — that order is what a whole-run abort turns on. Only an ios driver is
    // catalogued, so acting on an android record throws NoDriverError, as it does for a platform
    // discovery refused. The ready ghost exercises the shutdown verb, the shut-down ghost the
    // destroy verb; a healthy ios device follows each. `--delete-devices` makes one pass prove
    // both verbs.
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ availableOsVersions: ["1"], clock, platform: "ios" });
    let nextId = 1;
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: { generate: () => `${nextId++}` },
    });
    const lifecycle = new ManagedDeviceLifecycle(
      new DriverCatalog([driver]),
      registry,
      new SerializedDecision(),
      new DeviceOperationClaims(),
      clock,
    );
    const service = new NukeService({
      acquisition: {
        async beginMaintenance() {},
        async endMaintenance() {},
      },
      devices: lifecycle,
      leases: {
        async beginMaintenance() {},
        async releaseAllDuringMaintenance() {
          return [];
        },
        async endMaintenance() {},
      },
      registry,
    });

    async function register(
      spec: VirtualDevice["spec"],
      driverData: unknown,
      driverDeviceId: string,
    ) {
      const device = await registry.registerDevice({
        driverData,
        driverDeviceId,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      return device;
    }
    const android = {
      physical: false,
      model: "Pixel 8",
      osVersion: "35",
      platform: "android",
    } as const;
    const ios = { physical: false, model: "Phone", osVersion: "1", platform: "ios" } as const;

    const ghostReady = await register(
      android,
      { fakeDeviceId: "ghost-ready-android" },
      "ghost-ready-android",
    );
    const provisionedReady = await driver.provision(ios);
    const healthyReady = await register(
      ios,
      provisionedReady.driverData,
      provisionedReady.deviceId,
    );
    const ghostShutdown = await register(
      android,
      { fakeDeviceId: "ghost-shutdown-android" },
      "ghost-shutdown-android",
    );
    await registry.transitionDevice(ghostShutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ghostShutdown.id, initiator: "test" },
    });
    const provisionedShutdown = await driver.provision(ios);
    const healthyShutdown = await register(
      ios,
      provisionedShutdown.driverData,
      provisionedShutdown.deviceId,
    );
    await registry.transitionDevice(healthyShutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: healthyShutdown.id, initiator: "test" },
    });

    await expect(service.nuke(true)).resolves.toEqual({ releasedLeaseIds: [] });

    const stateOf = (deviceId: string) =>
      registry.snapshot.devices.find((candidate) => candidate.id === deviceId)?.state;
    expect([
      stateOf(ghostReady.id),
      stateOf(healthyReady.id),
      stateOf(ghostShutdown.id),
      stateOf(healthyShutdown.id),
    ]).toEqual(["ready", "deleted", "shutdown", "deleted"]);
    expect(
      driver.calls
        .filter((call) => call.operation === "shutdown" || call.operation === "destroy")
        .map((call) => `${call.operation} ${(call.arguments[0] as { deviceId: string }).deviceId}`)
        .sort(),
    ).toEqual(
      [
        `destroy ${healthyShutdown.driverDeviceId}`,
        `destroy ${healthyReady.driverDeviceId}`,
        `shutdown ${healthyReady.driverDeviceId}`,
      ].sort(),
    );
  });

  it("logs a device it cannot reset at error, naming the device, platform and error", async () => {
    const sink = new MemoryLogSink();
    const harness = createHarness([device("dev_1", "ready")]);
    harness.lifecycle.shutdown = async () => {
      throw new Error("reset exploded");
    };
    const service = new NukeService({
      acquisition: { async beginMaintenance() {}, async endMaintenance() {} },
      devices: harness.lifecycle,
      leases: {
        async beginMaintenance() {},
        async releaseAllDuringMaintenance() {
          return [];
        },
        async endMaintenance() {},
      },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
      registry: harness.registry,
    });

    await service.nuke(false);
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "error",
        module: "daemon.nuke",
        fields: { deviceId: "dev_1", error: "Error: reset exploded", platform: "ios" },
      }),
    ]);
  });
});
