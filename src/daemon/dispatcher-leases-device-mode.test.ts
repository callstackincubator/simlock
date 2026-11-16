import { describe, expect, it } from "vitest";
import { capacityChangedPayload, FakeDriver } from "../core/testing.js";
import { type LatestPresence } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: device mode on every surface", () => {
  const request = { model: "iPhone 17 Pro", platform: "ios" } as const;

  it.each([
    ["slim", "a slim boot", "slim"],
    ["full", "no mode", undefined],
  ] as const)(
    "a lease grant's device carries mode: %s when the driver reported %s",
    async (expected, _reported, driverMode) => {
      const { dispatcher } = await buildDispatcher({ driverOptions: { mode: driverMode } });

      const grant = await dispatcher.dispatch("lease.request", request, session());

      expect(grant.device.mode).toBe(expected);
    },
  );

  it("status.get reports the capacity figures the last capacity.changed carries", async () => {
    const { dispatcher, engine, eventBus } = await buildDispatcher();
    await engine.convergeRunningCapacity();
    await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());

    const last = eventBus
      .replay()
      .filter((event) => event.event === "capacity.changed")
      .at(-1);
    const capacity = status.capacity as NonNullable<typeof status.capacity>;
    expect(last?.payload).toEqual(capacityChangedPayload(capacity));
    expect(status.capacity?.ios).toMatchObject({ running: 1, warm: 0, used: 1 });
  });

  it("lease.request grants a physical device with physical true and its class on the device", async () => {
    const { dispatcher, driver, engine } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: {
            class: "tablet",
            model: "iPad Pro",
            osVersion: "18.4",
          },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);

    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPad Pro", physical: true, platform: "ios" },
      session(),
    );

    expect(grant.device).toMatchObject({ class: "tablet", id: "dev_phys", physical: true });
  });

  it("status.get and list.get show a physical record with physical, its class and no mode or enrolledApps, and count nothing of it in the capacity figures", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: ["com.example.kept"],
          id: "dev_phys",
          spec: {
            class: "tablet",
            model: "iPad Pro",
            osVersion: "18.4",
          },
          state: "ready",
        },
      ],
    });
    await engine.convergeRunningCapacity();
    const lease = await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());
    const listed = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; class?: string; mode?: string; physical: boolean }[];

    for (const devices of [status.devices ?? [], listed]) {
      const phys = devices.find((device) => device.id === "dev_phys");
      expect(phys).toMatchObject({ class: "tablet", physical: true, state: "ready" });
      expect(phys).not.toHaveProperty("mode");
      expect(phys).not.toHaveProperty("enrolledApps");
      const simulator = devices.find((device) => device.id === lease.device.id);
      expect(simulator).toMatchObject({ mode: "full", physical: false });
      expect(simulator).not.toHaveProperty("class");
    }
    expect(status.capacity?.ios).toMatchObject({ running: 1, used: 1, warm: 0 });
  });

  it("status.get and list.get carry the latest presence read as presence on a physical device; a virtual device, and a physical device not yet read, carry none", async () => {
    const physical = (id: string, driverDeviceId: string) => ({
      createdAt: 1,
      driverDeviceId,
      enrolledApps: [],
      id,
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "ready",
    });
    const reads = new Map<string, LatestPresence>([
      ["UDID-READ", { present: false, reason: "locked" }],
      ["UDID-PRESENT", { present: true }],
    ]);
    const { dispatcher, engine } = await buildDispatcher({
      // why: every ID but the unread one answers a read, so a virtual device's own driver ID does too and only the physical guard keeps it off the wire.
      presence: (driverDeviceId) =>
        driverDeviceId === "UDID-UNREAD"
          ? undefined
          : (reads.get(driverDeviceId) ?? { present: true }),
      physicalDevices: [
        physical("dev_read", "UDID-READ"),
        physical("dev_present", "UDID-PRESENT"),
        physical("dev_unread", "UDID-UNREAD"),
      ],
    });
    await engine.convergeRunningCapacity();
    const lease = await dispatcher.dispatch("lease.request", request, session());

    const status = await dispatcher.dispatch("status.get", {}, session());
    const listed = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; presence?: unknown }[];

    for (const devices of [status.devices ?? [], listed]) {
      const byId = (id: string) => devices.find((device) => device.id === id);
      expect(byId("dev_read")).toMatchObject({ presence: { present: false, reason: "locked" } });
      expect(byId("dev_present")).toMatchObject({ presence: { present: true } });
      expect(byId("dev_unread")).not.toHaveProperty("presence");
      expect(byId(lease.device.id)).not.toHaveProperty("presence");
    }
  });

  it("a reclaiming physical device's status entry has no reclaimingSince", async () => {
    const { dispatcher } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          lastLeaseEndedAt: 200,
          reclaimingSince: 600,
          spec: {
            class: "phone",
            model: "iPhone 15 Pro",
            osVersion: "18.4",
          },
          state: "reclaiming",
        },
      ],
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    const entry = status.devices?.find((device) => device.id === "dev_phys");
    expect(entry).toMatchObject({ state: "reclaiming", transitionAgeMs: 400 });
    expect(entry).not.toHaveProperty("reclaimingSince");
  });

  it("status.get carries the warm pool's figures: the reserve, and a target the pass could not meet with its reason", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      warmPool: {
        reserveRunning: { android: 0, ios: 1 },
        targets: [{ count: 1, model: "iPhone 17", osVersion: "27.0", platform: "ios" }],
      },
    });
    await engine.convergeRunningCapacity();
    await engine.core.passWarmPool();

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.warmPool).toStrictEqual({
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 0,
          count: 1,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "27.0",
          platform: "ios",
          ready: 0,
          short: "runtime-missing",
        },
      ],
    });
  });

  it("status.get on a daemon whose pool is off carries enabled false, the reserve and every configured target with ready 0, booting 0 and short disabled", async () => {
    const { dispatcher } = await buildDispatcher({
      warmPool: {
        enabled: false,
        reserveRunning: { android: 1, ios: 0 },
        targets: [
          { count: 2, model: "iPhone 17", osVersion: "26.5", platform: "ios" },
          { count: 1, mode: "slim", model: "Pixel 8", platform: "android" },
        ],
      },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.warmPool).toStrictEqual({
      enabled: false,
      reserveRunning: { android: 1, ios: 0 },
      targets: [
        {
          booting: 0,
          count: 2,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "26.5",
          platform: "ios",
          ready: 0,
          short: "disabled",
        },
        {
          booting: 0,
          count: 1,
          mode: "slim",
          model: "Pixel 8",
          origin: "configured",
          platform: "android",
          ready: 0,
          short: "disabled",
        },
      ],
    });
  });

  it("status.get and list.get return mode for every device, including one still provisioning", async () => {
    const { dispatcher, registry } = await buildDispatcher({ driverOptions: { mode: "slim" } });
    const granted = await dispatcher.dispatch("lease.request", request, session());
    const provisioning = await registry.registerDevice({
      driverData: { fakeDeviceId: "driver-provisioning" },
      driverDeviceId: "driver-provisioning",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    );

    const expected = [
      { id: granted.device.id, mode: "slim" },
      { id: provisioning.id, mode: "full" },
    ];
    expect(status.devices?.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
    expect((list as { id: string; mode: string }[]).map(({ id, mode }) => ({ id, mode }))).toEqual(
      expected,
    );
  });

  it.each([
    ["slim", true, false],
    ["full", false, true],
  ] as const)(
    "status.get and list.get report servesDefaultMode for every device: on a worker whose default is %s, a slim pool is %s and a full pool is %s",
    async (defaultMode, slimServes, fullServes) => {
      const { dispatcher, registry } = await buildDispatcher({
        engine: { defaultModes: { ios: defaultMode } },
      });
      const register = (driverDeviceId: string, slim: boolean) =>
        registry.registerDevice({
          driverData: { fakeDeviceId: driverDeviceId },
          driverDeviceId,
          provisionDuration: 0,
          spec: {
            physical: false,
            model: "iPhone 17 Pro",
            osVersion: "26.5",
            platform: "ios",
            ...(slim ? { mode: "slim" as const } : {}),
          },
        });
      const slim = await register("driver-slim", true);
      const full = await register("driver-full", false);

      const status = await dispatcher.dispatch("status.get", {}, session());
      const list = await dispatcher.dispatch(
        "list.get",
        { kind: "devices" },
        session({ role: "admin" }),
      );

      const expected = [
        { id: slim.id, servesDefaultMode: slimServes },
        { id: full.id, servesDefaultMode: fullServes },
      ];
      const project = (devices: readonly { id: string; servesDefaultMode?: boolean }[]) =>
        devices.map(({ id, servesDefaultMode }) => ({ id, servesDefaultMode }));
      expect(project(status.devices ?? [])).toEqual(expected);
      expect(project(list as { id: string; servesDefaultMode?: boolean }[])).toEqual(expected);
    },
  );

  it("status marks a stalled device with stalled: true and leaves others without it", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher();
    const leased = await dispatcher.dispatch("lease.request", request, session());
    const register = (driverDeviceId: string) =>
      registry.registerDevice({
        driverData: { fakeDeviceId: driverDeviceId },
        driverDeviceId,
        provisionDuration: 0,
        spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      });
    const stuck = await register("driver-stuck");
    clock.advance(60_001);
    const fresh = await register("driver-fresh");

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; stalled?: boolean }[];
    const { workers } = await dispatcher.dispatch(
      "worker.list",
      {},
      session({ principal: "operator", role: "admin" }),
    );

    for (const devices of [status.devices, list, workers[0]?.devices ?? []]) {
      const byId = new Map(devices?.map((device) => [device.id, device]));
      expect(byId.get(stuck.id)?.stalled).toBe(true);
      expect(byId.get(fresh.id)).toBeDefined();
      expect(byId.get(fresh.id)).not.toHaveProperty("stalled");
      expect(byId.get(leased.device.id)).toBeDefined();
      expect(byId.get(leased.device.id)).not.toHaveProperty("stalled");
    }
  });

  it("status leaves stalled off a device past its threshold that a live operation holds", async () => {
    const claimed = new Set<string>();
    const { clock, dispatcher, registry } = await buildDispatcher({
      claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "driver-booting" },
      driverDeviceId: "driver-booting",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);
    const stalled = async () =>
      (await dispatcher.dispatch("status.get", {}, session())).devices?.find(
        (entry) => entry.id === device.id,
      )?.stalled;

    claimed.add(device.id);
    expect(await stalled()).toBeUndefined();
    claimed.delete(device.id);
    expect(await stalled()).toBe(true);
  });

  it("status measures a stall against the driver for the device's own platform", async () => {
    const android = new FakeDriver({
      clock: new FakeClock(1_000),
      estimateMs: { boot: 300_000, provision: 300_000 },
      platform: "android",
    });
    const { clock, dispatcher, registry } = await buildDispatcher({ otherStallDrivers: [android] });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "driver-ios-stuck" },
      driverDeviceId: "driver-ios-stuck",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.devices?.find((entry) => entry.id === device.id)?.stalled).toBe(true);
  });

  it("no lease.request, list.get, or status.get response carries featureProfile or slim", async () => {
    const { dispatcher } = await buildDispatcher({ driverOptions: { mode: "slim" } });

    const responses = [
      await dispatcher.dispatch("lease.request", request, session()),
      await dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
      await dispatcher.dispatch("status.get", {}, session()),
    ];

    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).toContain('"mode":"slim"');
      expect(json).not.toContain('"featureProfile"');
      expect(json).not.toContain('"slim":');
    }
  });
});
