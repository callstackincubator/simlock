import { describe, expect, it } from "vitest";

import { FakeClock, type Logger } from "../ports/index.js";
import { PassthroughRefusedError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog, NoDriverError, UnknownPassthroughToolError } from "./driver-catalog.js";

describe("DriverCatalog", () => {
  it("resolves a request through its registered driver", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const catalog = new DriverCatalog([driver]);

    await expect(
      catalog.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" }),
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
        modelAliases: {},
        modelRuntimes: { "iPhone 16": ["18.4", "26.5"] },
        models: ["iPhone 16"],
        platform: "ios",
        runtimes: ["18.4", "26.5"],
      },
      {
        defaultRuntime: "34",
        modelAliases: {},
        modelRuntimes: { "Pixel 8": ["34"] },
        models: ["Pixel 8"],
        platform: "android",
        runtimes: ["34"],
      },
    ]);
  });

  it("narrows to the requested platform without calling the other driver", async () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    const catalog = new DriverCatalog([ios, android]);

    await expect(catalog.listCatalog("ios")).resolves.toEqual([
      {
        defaultRuntime: "26.5",
        modelAliases: {},
        modelRuntimes: {},
        models: [],
        platform: "ios",
        runtimes: ["26.5"],
      },
    ]);
    expect(android.calls).toEqual([]);
  });

  it("still lists the other platforms when one driver's catalog rejects", async () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    android.failOn("listCatalog", 1, new Error("~/.android is not readable"));
    const catalog = new DriverCatalog([ios, android]);

    await expect(catalog.listCatalog()).resolves.toEqual([
      {
        defaultRuntime: "26.5",
        modelAliases: {},
        modelRuntimes: {},
        models: [],
        platform: "ios",
        runtimes: ["26.5"],
      },
    ]);
  });

  it("logs a warning naming the platform whose catalog it left out", async () => {
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
    const clock = new FakeClock();
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    android.failOn("listCatalog", 1, new Error("~/.android is not readable"));
    const catalog = new DriverCatalog([ios, android], { logger });

    await catalog.listCatalog();

    expect(warnings).toEqual([
      {
        fields: { error: "Error: ~/.android is not readable", platform: "android" },
        message: "A driver could not read its catalog",
      },
    ]);
  });

  it("fails with the driver's error when the named platform's catalog rejects", async () => {
    const clock = new FakeClock();
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["34"], clock, platform: "android" });
    const failure = new Error("~/.android is not readable");
    android.failOn("listCatalog", 1, failure);
    const catalog = new DriverCatalog([ios, android]);

    await expect(catalog.listCatalog("android")).rejects.toBe(failure);
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
