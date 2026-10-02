import { describe, expect, it } from "vitest";

import {
  DriverCrashError,
  type Driver,
  FakeDriver,
  FakeDriverUnknownDeviceError,
  type DriverDevice,
  UnknownModelError,
} from "./index.js";
import { FakeClock } from "../ports/index.js";

describe("FakeDriver", () => {
  it("delays provision until its FakeClock latency elapses", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({
      clock,
      latencyMs: { provision: 100 },
      platform: "ios",
    });

    let result: DriverDevice | undefined;
    const provision = driver
      .provision({ model: "iPhone 16", osVersion: "26.5", platform: "ios" })
      .then((device) => {
        result = device;
      });

    clock.advance(99);
    await Promise.resolve();
    expect(result).toBeUndefined();

    clock.advance(1);
    await provision;
    expect(result).toEqual({
      address: "fake-ios-1-addr-0",
      deviceId: "fake-ios-1",
      driverData: { fakeDeviceId: "fake-ios-1" },
    });
  });

  it("surfaces a scripted typed failure on the selected provision call", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "android" });
    const crash = new DriverCrashError("emulator exited");
    driver.failOn("provision", 2, crash);
    const spec = { model: "Pixel 10", osVersion: "36", platform: "android" } as const;

    await expect(driver.provision(spec)).resolves.toMatchObject({ deviceId: "fake-android-1" });
    await expect(driver.provision(spec)).rejects.toBe(crash);
  });

  it("returns configured estimates", () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      estimateMs: { boot: 20, provision: 10, reclaim: 30 },
      platform: "ios",
    });
    const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

    expect(driver.estimate({ operation: "provision" }, spec)).toBe(10);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(20);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(30);
  });

  it("implements the platform-agnostic Driver contract", () => {
    const driver: Driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });

    expect(driver.platform).toBe("ios");
    expect(driver.deviceRoot).toBe("/fake/ios");
    expect(driver.leaseEnvironment()).toEqual({});
  });

  it("carries the root and lease environment a test gives it", () => {
    const driver = new FakeDriver({
      clock: new FakeClock(),
      deviceRoot: "/tmp/devices/ios",
      leaseEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/tmp/devices/ios" },
      platform: "ios",
    });

    expect(driver.deviceRoot).toBe("/tmp/devices/ios");
    expect(driver.leaseEnvironment()).toEqual({ SIMLOCK_IOS_DEVICE_SET: "/tmp/devices/ios" });
  });

  it("reports a staged reality entry whatever it is named, the way a root does", () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    driver.setManagedReality({
      devices: [
        { address: "addr", deviceId: "not-a-simlock-name", driverData: {}, runState: "running" },
      ],
      processes: [],
    });

    return expect(driver.listManaged()).resolves.toMatchObject({
      devices: [{ deviceId: "not-a-simlock-name" }],
    });
  });

  it.each([
    ["a prepare boot of a slim-spec device", { mode: "slim", purpose: "prepare" }, "slim"],
    ["a recover boot of a slim-spec device", { mode: "slim", purpose: "recover" }, "full"],
    ["a prepare boot of a full-spec device", { mode: "full", purpose: "prepare" }, "full"],
  ] as const)(
    "a slimming fake reports the mode the iOS driver would for %s",
    async (_label, options, reported) => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(),
        platform: "ios",
        slimmableOsVersions: ["26.5"],
      });
      const device = await driver.provision({
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await expect(driver.makeReady(device, options)).resolves.toMatchObject({ mode: reported });
    },
  );

  it("keeps makeReady pending until released when instructed to hang", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    const device = await driver.provision({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    driver.hangMakeReady();

    let ready = false;
    const makeReady = driver.makeReady(device, prepare).then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(false);

    driver.releaseMakeReady();
    await makeReady;
    expect(ready).toBe(true);
  });

  it("applies the configured latency to makeReady", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const device = await driver.provision({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    let ready = false;
    const makeReady = driver.makeReady(device, prepare).then(() => {
      ready = true;
    });
    clock.advance(49);
    await Promise.resolve();
    expect(ready).toBe(false);

    clock.advance(1);
    await makeReady;
    expect(ready).toBe(true);
  });

  it("records calls, refuses a missing runtime until it is installed, and enforces known-device destruction", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16"],
      platform: "ios",
    });

    await expect(
      driver.resolveSpec({ model: "Unknown", osVersion: "26.5", platform: "ios" }),
    ).rejects.toBeInstanceOf(UnknownModelError);
    await expect(
      driver.resolveSpec({ model: "iPhone 16", osVersion: "27", platform: "ios" }),
    ).rejects.toMatchObject({ component: "27", downloadable: true, name: "RuntimeMissingError" });
    await expect(
      driver.installComponent("27", {
        onProgress: () => undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ outcome: "installed", version: "27" });
    await expect(
      driver.resolveSpec({ model: "iPhone 16", osVersion: "27", platform: "ios" }),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "27", platform: "ios" });

    const device = await driver.provision({
      model: "iPhone 16",
      osVersion: "27",
      platform: "ios",
    });
    await driver.destroy(device);
    await expect(driver.destroy(device)).rejects.toBeInstanceOf(FakeDriverUnknownDeviceError);

    expect(driver.calls.map((call) => call.operation)).toEqual([
      "resolveSpec",
      "resolveSpec",
      "installComponent",
      "resolveSpec",
      "provision",
      "destroy",
      "destroy",
    ]);
  });

  it("reports its known models and installed runtimes, marking the newest as default", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16", "iPhone 17 Pro"],
      platform: "ios",
    });

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "26.5",
      modelAliases: {},
      modelRuntimes: { "iPhone 16": ["18.4", "26.5"], "iPhone 17 Pro": ["18.4", "26.5"] },
      models: ["iPhone 16", "iPhone 17 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });

  it("pairs a model with only the runtimes its modelRuntimes option names", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16", "iPhone XS"],
      modelRuntimes: { "iPhone XS": ["18.4"] },
      platform: "ios",
    });

    expect((await driver.listCatalog()).modelRuntimes).toEqual({
      "iPhone 16": ["18.4", "26.5"],
      "iPhone XS": ["18.4"],
    });
  });

  it("reports the other names and images its options name, and no images field without them", async () => {
    const options = {
      availableOsVersions: ["35"],
      clock: new FakeClock(),
      knownModels: ["Pixel 8"],
      platform: "android" as const,
    };
    const scripted = new FakeDriver({
      ...options,
      images: [{ abi: "x86_64", runtime: "35", tag: "default" }],
      modelAliases: { "Pixel 8": ["pixel_8"] },
    });

    await expect(scripted.listCatalog()).resolves.toMatchObject({
      images: [{ abi: "x86_64", runtime: "35", tag: "default" }],
      modelAliases: { "Pixel 8": ["pixel_8"] },
    });
    expect(await new FakeDriver(options).listCatalog()).not.toHaveProperty("images");
  });
});

const prepare = { mode: "full", purpose: "prepare" } as const;
