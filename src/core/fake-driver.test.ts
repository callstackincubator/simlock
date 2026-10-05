import { describe, expect, it } from "vitest";

import { DriverCrashError, type Driver, UnknownModelError } from "./index.js";
import { FakeDriver, FakeDriverUnknownDeviceError } from "./fake-driver.js";
import * as publicIndex from "./index.js";
import * as testing from "./testing.js";
import { FakeClock } from "../ports/index.js";

describe("FakeDriver", () => {
  it("is exported from core/testing.ts and not from the public index", () => {
    expect(testing.FakeDriver).toBe(FakeDriver);
    expect("FakeDriver" in publicIndex).toBe(false);
    expect("FakeDriverUnknownDeviceError" in publicIndex).toBe(false);
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
      modelClasses: {},
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

  it("reports the model classes its options name, and none without them", async () => {
    const options = {
      availableOsVersions: ["35"],
      clock: new FakeClock(),
      knownModels: ["Pixel 8", "Television (1080p)"],
      platform: "android" as const,
    };

    await expect(
      new FakeDriver({
        ...options,
        modelClasses: { "Pixel 8": "phone", "Television (1080p)": "tv" },
      }).listCatalog(),
    ).resolves.toMatchObject({ modelClasses: { "Pixel 8": "phone", "Television (1080p)": "tv" } });
    expect((await new FakeDriver(options).listCatalog()).modelClasses).toEqual({});
  });

  it("reports the built-in preference lists its options name, and none without them", () => {
    const options = { clock: new FakeClock(), platform: "ios" as const };

    expect(
      new FakeDriver({ ...options, defaultModels: { phone: ["iPhone 17"] } }).defaultModels,
    ).toEqual({ phone: ["iPhone 17"] });
    expect(new FakeDriver(options).defaultModels).toEqual({});
  });

  it("reports the custom models its options name, and no customModels field without them", async () => {
    const options = {
      availableOsVersions: ["35"],
      clock: new FakeClock(),
      knownModels: ["Pixel 8", "My Tablet"],
      platform: "android" as const,
    };

    await expect(
      new FakeDriver({ ...options, customModels: ["My Tablet"] }).listCatalog(),
    ).resolves.toMatchObject({ customModels: ["My Tablet"] });
    expect(await new FakeDriver(options).listCatalog()).not.toHaveProperty("customModels");
  });
});
