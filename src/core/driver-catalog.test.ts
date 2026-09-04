import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { PassthroughRefusedError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog, NoDriverError, UnknownPassthroughToolError } from "./driver-catalog.js";

describe("DriverCatalog", () => {
  it("resolves a request through its registered driver", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const catalog = new DriverCatalog([driver]);

    await expect(
      catalog.resolveSpec(
        { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
  });

  it("retains NoDriverError-compatible platform, name, and message", () => {
    const catalog = new DriverCatalog([]);

    expect(() => catalog.get("android")).toThrow(NoDriverError);
    try {
      catalog.get("android");
    } catch (error) {
      expect(error).toMatchObject({
        message: "No driver registered for platform: android",
        name: "NoDriverError",
        platform: "android",
      });
    }
  });

  it("aggregates catalogs across every registered driver, tagged with platform", async () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock,
      knownModels: ["iPhone 16"],
      platform: "ios",
    });
    const android = new FakeDriver({
      availableOsVersions: ["34"],
      clock,
      knownModels: ["Pixel 8"],
      platform: "android",
    });
    const catalog = new DriverCatalog([ios, android]);

    await expect(catalog.listCatalog()).resolves.toEqual([
      {
        defaultRuntime: "26.5",
        models: ["iPhone 16"],
        platform: "ios",
        runtimes: ["18.4", "26.5"],
      },
      { defaultRuntime: "34", models: ["Pixel 8"], platform: "android", runtimes: ["34"] },
    ]);
  });

  it("narrows to the requested platform without calling the other driver", async () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    const catalog = new DriverCatalog([ios, android]);

    await expect(catalog.listCatalog("ios")).resolves.toEqual([
      { defaultRuntime: "26.5", models: [], platform: "ios", runtimes: ["26.5"] },
    ]);
    expect(android.calls).toEqual([]);
  });

  it("omits a platform with no registered driver instead of erroring", async () => {
    const catalog = new DriverCatalog([]);

    await expect(catalog.listCatalog()).resolves.toEqual([]);
    await expect(catalog.listCatalog("android")).resolves.toEqual([]);
  });

  it("routes a passthrough to the driver that claims its tool name", () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({
      clock,
      passthrough: (args) => ({ args: ["--set", "/root", ...args], command: "xcrun", env: {} }),
      passthroughTool: "simctl",
      platform: "ios",
    });
    const android = new FakeDriver({
      clock,
      passthrough: () => ({ args: [], command: "adb", env: {} }),
      passthroughTool: "adb",
      platform: "android",
    });
    const catalog = new DriverCatalog([ios, android]);

    expect(catalog.passthrough("simctl", ["list", "devices"])).toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "xcrun",
      env: {},
    });
  });

  it("lets a driver's refusal out untouched rather than translating it here", () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({
      clock,
      passthrough: () => {
        throw new PassthroughRefusedError("simctl", "Refusing `simlock simctl delete`");
      },
      passthroughTool: "simctl",
      platform: "ios",
    });

    expect(() => new DriverCatalog([driver]).passthrough("simctl", ["delete", "ABCD"])).toThrow(
      PassthroughRefusedError,
    );
  });

  it("refuses a tool no registered driver answers to", () => {
    const clock = new FakeClock();
    const catalog = new DriverCatalog([new FakeDriver({ clock, platform: "ios" })]);

    expect(() => catalog.passthrough("adb", ["devices"])).toThrow(UnknownPassthroughToolError);
  });
});
