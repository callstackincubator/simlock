import { describe, expect, it } from "vitest";
import { FakeClock, type Logger } from "../ports/index.js";
import { ComponentInstallTimeoutError, type DriverComponent, DriverCrashError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import type { Registry } from "./registry.js";
import {
  gibibyte,
  timeoutMs,
  ManualClock,
  createHarness,
  installs,
  flush,
  track,
  ios,
} from "./test-component-installer.js";

describe("ComponentInstaller.inProgress", () => {
  it("lists an install at the front of its queue that is still checking whether it is needed as waiting", async () => {
    const harness = await createHarness();

    void harness.installer.install(ios("27.0", { stillNeeded: () => new Promise(() => {}) }));
    await flush();

    expect(harness.installer.inProgress()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "waiting", waiters: 1 },
    ]);
    expect(installs(harness.ios)).toEqual([]);
  });

  it("lists an install whose driver returned and whose record is being written as downloading", async () => {
    const harness = await createHarness({
      decisions: { run: () => new Promise(() => {}) },
    });

    void harness.installer.install(ios("27.0"));
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(harness.installer.inProgress()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 1 },
    ]);
  });

  it("does not list a waiting install once its only call has timed out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    expect(harness.installer.inProgress().map((install) => install.component)).toEqual([
      "27.0",
      "28.0",
    ]);
    (harness.clock as ManualClock).fire(1);
    await flush();

    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    expect(harness.installer.inProgress().map((install) => install.component)).toEqual(["27.0"]);
  });

  it("lists the 16 oldest installs across platforms, oldest first, when more are in progress", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: [], clock, platform: "android" }),
      ],
    });
    for (const driver of harness.drivers) driver.holdInstalls();

    // why: Alternating platforms, so the oldest are not the first ones of any one queue.
    for (let index = 0; index < 20; index += 1) {
      const platform = index % 2 === 0 ? "ios" : "android";
      void harness.installer.install({ component: `c${String(index)}`, platform });
      harness.clock.advance(1_000);
    }
    await flush();

    expect(harness.installer.inProgress().map((install) => install.component)).toEqual(
      Array.from({ length: 16 }, (_, index) => `c${String(index)}`),
    );
  });
});

class ListingDriver extends FakeDriver {
  constructor(
    clock: FakeClock,
    platform: "ios" | "android",
    private readonly listing: readonly DriverComponent[],
  ) {
    super({ availableOsVersions: [], clock, platform });
  }

  override listComponents(): Promise<readonly DriverComponent[]> {
    return Promise.resolve(this.listing);
  }
}

async function addDevice(
  registry: Registry,
  platform: "ios" | "android",
  osVersion: string,
): Promise<string> {
  const driverDeviceId = `${platform}-${osVersion}-${String(registry.snapshot.devices.length)}`;
  const device = await registry.registerDevice({
    driverData: { fakeDeviceId: driverDeviceId },
    driverDeviceId,
    provisionDuration: 0,
    spec: { physical: false, model: "Phone", osVersion, platform },
  });
  return device.id;
}

describe("ComponentInstaller.list", () => {
  it("lists a component Simlock installed with installedBySimlock true and the time its record was written", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    harness.clock.advance(4_000);

    await harness.installer.install(ios("27.0"));

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 0,
        installedAt: 5_000,
        installedBySimlock: true,
        platform: "ios",
        version: "27.0",
      },
    ]);
  });

  it("lists a component that was on the machine before with installedBySimlock false and no installedAt", async () => {
    const harness = await createHarness();

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 0,
        installedBySimlock: false,
        platform: "ios",
        version: "26.5",
      },
    ]);
  });

  it("marks nothing as Simlock's for a record of that platform and version whose receipt no longer equals the installed one", async () => {
    const harness = await createHarness();
    await harness.registry.recordComponent({
      installedAt: 1_000,
      platform: "ios",
      receipt: { install: "1", version: "26.5" },
      version: "26.5",
    });

    const [listed] = await harness.installer.list();

    expect(listed).toMatchObject({ installedBySimlock: false, version: "26.5" });
    expect(listed).not.toHaveProperty("installedAt");
  });

  it("does not take a record of another platform with an equal receipt as proof", async () => {
    const harness = await createHarness();
    await harness.registry.recordComponent({
      installedAt: 1_000,
      platform: "android",
      receipt: { preinstalled: "26.5" },
      version: "26.5",
    });

    const [listed] = await harness.installer.list();

    expect(listed).toMatchObject({ installedBySimlock: false, platform: "ios" });
  });

  it("counts registry devices of that platform and version, and not deleted ones", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5", "27.0"], clock, platform: "ios" }),
      ],
    });
    await addDevice(harness.registry, "ios", "26.5");
    await addDevice(harness.registry, "ios", "26.5");
    const deleted = await addDevice(harness.registry, "ios", "26.5");
    await harness.registry.markDeviceMissing(deleted, "test");
    await addDevice(harness.registry, "ios", "27.0");
    await addDevice(harness.registry, "android", "26.5");

    const listed = await harness.installer.list();

    expect(listed.map(({ devices, version }) => ({ devices, version }))).toEqual([
      { devices: 2, version: "26.5" },
      { devices: 1, version: "27.0" },
    ]);
  });

  it("shows the devices of a version on both of its variants", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "android", [
          {
            foreignDevices: 0,
            receipt: { image: "a" },
            variant: "google_apis/arm64-v8a",
            version: "35",
          },
          {
            foreignDevices: 0,
            receipt: { image: "b" },
            variant: "default/arm64-v8a",
            version: "35",
          },
        ]),
      ],
    });
    await addDevice(harness.registry, "android", "35");
    await addDevice(harness.registry, "android", "35");

    const listed = await harness.installer.list();

    expect(listed.map(({ devices, variant }) => ({ devices, variant }))).toEqual([
      { devices: 2, variant: "default/arm64-v8a" },
      { devices: 2, variant: "google_apis/arm64-v8a" },
    ]);
  });

  it("carries the driver's size, variant and foreign devices through unread", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "ios", [
          {
            foreignDevices: 3,
            receipt: { image: "x" },
            sizeBytes: 9 * gibibyte,
            variant: "23A343",
            version: "26.0",
          },
        ]),
      ],
    });

    expect(await harness.installer.list()).toEqual([
      {
        devices: 0,
        foreignDevices: 3,
        installedBySimlock: false,
        platform: "ios",
        sizeBytes: 9 * gibibyte,
        variant: "23A343",
        version: "26.0",
      },
    ]);
  });

  it("orders by platform, then version as numbers, then variant", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new ListingDriver(clock, "ios", [
          { foreignDevices: 0, receipt: { r: "1" }, version: "26.4" },
          { foreignDevices: 0, receipt: { r: "2" }, version: "9.3" },
        ]),
        new ListingDriver(clock, "android", [
          { foreignDevices: 0, receipt: { r: "3" }, variant: "z", version: "35" },
          { foreignDevices: 0, receipt: { r: "4" }, variant: "a", version: "35" },
          { foreignDevices: 0, receipt: { r: "5" }, variant: "a", version: "9" },
        ]),
      ],
    });

    const listed = await harness.installer.list();

    expect(listed.map(({ platform, variant, version }) => [platform, version, variant])).toEqual([
      ["android", "9", "a"],
      ["android", "35", "a"],
      ["android", "35", "z"],
      ["ios", "9.3", undefined],
      ["ios", "26.4", undefined],
    ]);
  });

  it("asks only the named platform's driver when given a platform", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }),
      ],
    });

    const listed = await harness.installer.list("android");

    expect(listed.map((component) => component.platform)).toEqual(["android"]);
    expect(harness.ios.calls.some((call) => call.operation === "listComponents")).toBe(false);
  });

  it("leaves out a driver whose listing rejects, logs why, and still lists the other platform", async () => {
    const warnings: { readonly message: string; readonly fields: unknown }[] = [];
    const logger: Logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message, fields) => {
        warnings.push({ fields, message });
      },
    };
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }),
        new FakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }),
      ],
      logger,
    });
    harness.ios.failOn("listComponents", 1, new DriverCrashError("simctl runtime list failed"));

    const listed = await harness.installer.list();

    expect(listed.map((component) => [component.platform, component.version])).toEqual([
      ["android", "35"],
    ]);
    expect(warnings).toEqual([
      {
        fields: { error: "DriverCrashError: simctl runtime list failed", platform: "ios" },
        message: "A driver could not list its installed components",
      },
    ]);
  });

  it("starts no install, takes no reservation and emits no event", async () => {
    const harness = await createHarness();

    await harness.installer.list();

    expect(installs(harness.ios)).toEqual([]);
    expect(harness.reservations).toEqual([]);
    expect(harness.events).toEqual([]);
  });
});
