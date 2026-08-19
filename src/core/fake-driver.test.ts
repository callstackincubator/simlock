import { describe, expect, it } from "vitest";

import {
  DriverCrashError,
  type Driver,
  FakeDriver,
  FakeDriverUnknownDeviceError,
  RuntimeMissingError,
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

    expect(driver.estimate("provision", spec)).toBe(10);
    expect(driver.estimate("boot", spec)).toBe(20);
    expect(driver.estimate("reclaim", spec)).toBe(30);
  });

  it("implements the platform-agnostic Driver contract", () => {
    const driver: Driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });

    expect(driver.platform).toBe("ios");
  });

  it("keeps makeReady pending until released when instructed to hang", async () => {
    const driver = new FakeDriver({ clock: new FakeClock(), platform: "ios" });
    const device = await driver.provision({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    driver.hangMakeReady();

    let ready = false;
    const makeReady = driver.makeReady(device).then(() => {
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
    const makeReady = driver.makeReady(device).then(() => {
      ready = true;
    });
    clock.advance(49);
    await Promise.resolve();
    expect(ready).toBe(false);

    clock.advance(1);
    await makeReady;
    expect(ready).toBe(true);
  });

  it("records calls and enforces resolve policy and known-device destruction", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(),
      knownModels: ["iPhone 16"],
      platform: "ios",
    });

    await expect(
      driver.resolveSpec(
        { model: "Unknown", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).rejects.toBeInstanceOf(UnknownModelError);
    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "27", platform: "ios" },
        { allowDownload: false },
      ),
    ).rejects.toBeInstanceOf(RuntimeMissingError);
    await expect(
      driver.resolveSpec(
        { model: "iPhone 16", osVersion: "27", platform: "ios" },
        { allowDownload: true },
      ),
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
      models: ["iPhone 16", "iPhone 17 Pro"],
      runtimes: ["18.4", "26.5"],
    });
  });
});
