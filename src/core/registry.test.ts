import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { type DeviceSpec, Registry, RegistryEventError, UnknownDeviceError } from "./index.js";

const statePath = "/home/agent/.pitlane/state.json";
const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

class ObservingFilesystem extends MemoryFilesystem {
  readonly operations: string[] = [];

  override async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.operations.push("save");
    await super.writeFileAtomic(path, contents);
  }
}

describe("Registry", () => {
  it("loads an empty registry when no state file exists", async () => {
    const clock = new FakeClock(1_000);
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });

    expect(registry.snapshot).toEqual({ devices: [], leases: [] });
  });

  it("atomically persists a registered device before emitting device.provisioned", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const bus = new EventBus(clock);
    bus.subscribe("device.provisioned", () => filesystem.operations.push("event"));
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });

    await registry.registerDevice({
      driverData: { driverOnly: "value" },
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    expect(filesystem.operations).toEqual(["save", "event"]);
    await expect(filesystem.readFile(statePath)).resolves.toMatch(/"id":"dev_test"/);
    expect(registry.snapshot.devices).toEqual([
      {
        createdAt: 1_000,
        driverData: { driverOnly: "value" },
        driverDeviceId: "driver_test",
        id: "dev_test",
        spec,
        state: "provisioning",
      },
    ]);
  });

  it("restores persisted device records after a reload", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    };
    const registry = await Registry.load(options);
    await registry.registerDevice({
      driverData: { driverOnly: "value" },
      driverDeviceId: "driver_test",
      provisionDuration: 25,
      spec,
    });

    const reloaded = await Registry.load(options);

    expect(reloaded.snapshot).toEqual(registry.snapshot);
  });

  it("loads a legacy warm record as busy reclaiming rather than eligible ready inventory", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: {},
            driverDeviceId: "driver_legacy",
            id: "dev_legacy",
            lastLeaseEndedAt: 900,
            spec,
            state: "warm",
          },
        ],
        leases: [],
      }),
    );

    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    expect(registry.snapshot.devices).toMatchObject([{ id: "dev_legacy", state: "reclaiming" }]);
  });

  it("preserves unknown persisted fields when saving a later mutation", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 500,
            driverData: { driverOnly: "existing" },
            driverDeviceId: "driver_existing",
            futureDeviceField: "keep me",
            id: "dev_existing",
            spec,
            state: "provisioning",
          },
        ],
        futureTopLevelField: { version: 2 },
        leases: [],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => "new" },
      statePath,
    });

    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_new",
      provisionDuration: 0,
      spec,
    });

    const saved = JSON.parse(await filesystem.readFile(statePath)) as {
      readonly devices: Array<Record<string, unknown>>;
      readonly futureTopLevelField: unknown;
    };
    expect(saved.futureTopLevelField).toEqual({ version: 2 });
    expect(saved.devices[0]).toMatchObject({ futureDeviceField: "keep me" });
  });

  it("persists a transition before emitting its device.ready fact", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new ObservingFilesystem();
    const bus = new EventBus(clock);
    bus.subscribe("device.ready", () => filesystem.operations.push("event"));
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });
    filesystem.operations.length = 0;

    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 50, deviceId: device.id },
    });

    expect(filesystem.operations).toEqual(["save", "event"]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("rejects a device event whose payload identifies another device", async () => {
    const clock = new FakeClock();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_test",
      provisionDuration: 0,
      spec,
    });

    await expect(
      registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: "dev_someone_else" },
      }),
    ).rejects.toThrow(RegistryEventError);
    expect(registry.snapshot.devices[0]?.state).toBe("provisioning");
  });

  it("round-trips leases and never deletes a device with an active lease", async () => {
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const suffixes = ["device", "lease"];
    const options = {
      clock,
      eventBus: new EventBus(clock),
      filesystem,
      idGenerator: { generate: () => suffixes.shift() ?? "unexpected" },
      statePath,
    };
    const registry = await Registry.load(options);
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver_device",
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });

    const lease = await registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent-1",
      ttlDeadline: 2_000,
    });
    const reloaded = await Registry.load(options);

    expect(lease).toMatchObject({ deviceId: device.id, id: "lse_lease", grantedAt: 1_000 });
    expect(reloaded.snapshot).toEqual(registry.snapshot);

    await registry.transitionDevice(device.id, "reclaiming");
    await registry.transitionDevice(device.id, "shutdown", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 1, strategy: "erase" },
    });
    await expect(
      registry.transitionDevice(device.id, "deleted", {
        event: "device.deleted",
        payload: { deviceId: device.id, initiator: "test" },
      }),
    ).rejects.toThrow(RegistryEventError);
  });

  it("rejects mutations for a device that is not registered", async () => {
    const clock = new FakeClock();
    const registry = await Registry.load({
      clock,
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "test" },
      statePath,
    });

    await expect(registry.transitionDevice("dev_missing", "ready")).rejects.toThrow(
      UnknownDeviceError,
    );
    await expect(
      registry.transitionDevice("dev_missing", "deleted", {
        event: "device.deleted",
        payload: { deviceId: "dev_missing", initiator: "test" },
      }),
    ).rejects.toThrow(UnknownDeviceError);
  });
});
