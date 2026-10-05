import { describe, expect, it, vi } from "vitest";

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
        classDefaults: {},
        defaultRuntime: "26.5",
        modelAliases: {},
        modelClasses: {},
        modelRuntimes: { "iPhone 16": ["18.4", "26.5"] },
        models: ["iPhone 16"],
        platform: "ios",
        runtimes: ["18.4", "26.5"],
      },
      {
        classDefaults: {},
        defaultRuntime: "34",
        modelAliases: {},
        modelClasses: {},
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
        classDefaults: {},
        defaultRuntime: "26.5",
        modelAliases: {},
        modelClasses: {},
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
        classDefaults: {},
        defaultRuntime: "26.5",
        modelAliases: {},
        modelClasses: {},
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

  describe("classDefaults", () => {
    type Classes = Readonly<Record<string, "phone" | "tablet" | "watch">>;

    async function defaultsOf(options: {
      readonly models: readonly string[];
      readonly classes: Classes;
      readonly preferences: readonly string[];
      readonly tabletPreferences?: readonly string[];
      readonly modelRuntimes?: Readonly<Record<string, readonly string[]>>;
      readonly modelAliases?: Readonly<Record<string, readonly string[]>>;
    }) {
      const driver = new FakeDriver({
        availableOsVersions: ["18.4", "26.5"],
        clock: new FakeClock(),
        knownModels: options.models,
        modelAliases: options.modelAliases ?? {},
        modelClasses: options.classes,
        ...(options.modelRuntimes === undefined ? {} : { modelRuntimes: options.modelRuntimes }),
        platform: "ios",
      });
      const catalog = new DriverCatalog([driver], {
        preferences: {
          ios: {
            phone: options.preferences,
            ...(options.tabletPreferences === undefined
              ? {}
              : { tablet: options.tabletPreferences }),
          },
        },
      });
      return (await catalog.listCatalog())[0]?.classDefaults;
    }

    it("is the first name on the preference list the catalog lists", async () => {
      await expect(
        defaultsOf({
          classes: { "iPhone 15": "phone", "iPhone 16": "phone" },
          models: ["iPhone 15", "iPhone 16"],
          preferences: ["iPhone 17", "iPhone 16", "iPhone 15"],
        }),
      ).resolves.toEqual({ phone: "iPhone 16" });
    });

    it("matches a listed name by its alias in any letter case, and names the listed model", async () => {
      await expect(
        defaultsOf({
          classes: { "Pixel 9": "phone" },
          modelAliases: { "Pixel 9": ["pixel_9"] },
          models: ["Pixel 9"],
          preferences: ["PIXEL_9"],
        }),
      ).resolves.toEqual({ phone: "Pixel 9" });
    });

    it("matches a listed name in any letter case", async () => {
      await expect(
        defaultsOf({
          classes: { "iPhone 17": "phone" },
          models: ["iPhone 17"],
          preferences: ["iphone 17"],
        }),
      ).resolves.toEqual({ phone: "iPhone 17" });
    });

    it("skips a configured name of another class and falls to the next name that counts", async () => {
      await expect(
        defaultsOf({
          classes: { "iPad (A16)": "tablet", "iPhone 17": "phone", "iPhone 16": "phone" },
          models: ["iPad (A16)", "iPhone 17", "iPhone 16"],
          // The merged list: the configured iPad first, the built-in phones after it.
          preferences: ["iPad (A16)", "iPhone 17", "iPhone 16"],
        }),
      ).resolves.toEqual({ phone: "iPhone 17" });
    });

    it("skips a name whose model has no class", async () => {
      await expect(
        defaultsOf({
          classes: { "iPhone 16": "phone" },
          models: ["Mystery", "iPhone 16"],
          preferences: ["Mystery", "iPhone 16"],
        }),
      ).resolves.toEqual({ phone: "iPhone 16" });
    });

    it("skips a name with no paired runtime for a later one that pairs", async () => {
      await expect(
        defaultsOf({
          classes: { "iPhone 16": "phone", "iPhone 17": "phone" },
          modelRuntimes: { "iPhone 16": ["18.4"], "iPhone 17": [] },
          models: ["iPhone 17", "iPhone 16"],
          preferences: ["iPhone 17", "iPhone 16"],
        }),
      ).resolves.toEqual({ phone: "iPhone 16" });
    });

    it("shows the first name of the class when none of them pairs with a runtime", async () => {
      await expect(
        defaultsOf({
          classes: { "iPhone 16": "phone", "iPhone 17": "phone" },
          modelRuntimes: { "iPhone 16": [], "iPhone 17": [] },
          models: ["iPhone 17", "iPhone 16"],
          preferences: ["iPhone 17", "iPhone 16"],
        }),
      ).resolves.toEqual({ phone: "iPhone 17" });
    });

    it("has no entry for a class in which no name is listed, or in which every listed name is of another class", async () => {
      await expect(
        defaultsOf({
          classes: { "iPad (A16)": "tablet", "iPhone 16": "phone" },
          models: ["iPad (A16)", "iPhone 16"],
          preferences: ["iPhone 15", "iPad (A16)"],
          tabletPreferences: ["iPad Pro"],
        }),
      ).resolves.toEqual({});
    });

    it("reads only a model's own class and runtimes: a model named constructor has neither, and a listed model with no runtimes entry pairs with nothing", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(),
        platform: "ios",
      });
      vi.spyOn(driver, "listCatalog").mockResolvedValue({
        defaultRuntime: "26.5",
        modelAliases: {},
        modelClasses: { "iPhone 15": "phone", "iPhone 16": "phone" },
        modelRuntimes: { "iPhone 16": ["26.5"] },
        models: ["constructor", "iPhone 15", "iPhone 16"],
        runtimes: ["26.5"],
      });
      const catalog = new DriverCatalog([driver], {
        preferences: {
          ios: { phone: ["constructor", "iPhone 15", "iPhone 16"], tablet: ["constructor"] },
        },
      });

      const [entry] = await catalog.listCatalog();

      // `constructor` has no class of its own, `iPhone 15` has no runtimes entry.
      expect(entry?.classDefaults).toEqual({ phone: "iPhone 16" });
    });

    it("has no entry for a class that has no preference list", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(),
        knownModels: ["iPhone 16"],
        modelClasses: { "iPhone 16": "phone" },
        platform: "ios",
      });

      const [entry] = await new DriverCatalog([driver]).listCatalog();

      expect(entry?.classDefaults).toEqual({});
    });
  });
});
