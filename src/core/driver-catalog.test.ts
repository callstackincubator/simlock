import { describe, expect, it, vi } from "vitest";

import { FakeClock, type Logger } from "../ports/index.js";
import {
  PassthroughRefusedError,
  type PassthroughCommand,
  type PassthroughContext,
} from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog, NoDriverError, UnknownPassthroughToolError } from "./driver-catalog.js";

type FakeDriverOptions = ConstructorParameters<typeof FakeDriver>[0];

interface PassthroughFakeOptions {
  readonly clock: FakeClock;
  readonly passthrough?: (
    tool: string,
    device: unknown,
    args: readonly string[],
    context?: PassthroughContext,
  ) => PassthroughCommand;
  readonly passthroughTools: readonly string[];
  readonly platform: "android" | "ios";
}

function fakeOptions(options: PassthroughFakeOptions): FakeDriverOptions {
  return options;
}

/** why: a test hands the device as `unknown`, so a malformed device record can reach the catalog too. */
function route(
  catalog: DriverCatalog,
  tool: string,
  device: unknown,
  args: readonly string[],
  context?: PassthroughContext,
): Promise<PassthroughCommand> {
  return catalog.passthrough(
    tool,
    device as Parameters<DriverCatalog["passthrough"]>[1],
    args,
    context,
  );
}

describe("DriverCatalog", () => {
  it("resolves a request through its registered driver", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const catalog = new DriverCatalog([driver]);

    await expect(
      catalog.resolveSpec({
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      }),
    ).resolves.toEqual({ physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" });
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

  it("routes a passthrough to the driver whose passthroughTools holds the tool name", async () => {
    const clock = new FakeClock();
    const seen: unknown[] = [];
    const ios = new FakeDriver(
      fakeOptions({
        clock,
        passthrough: (tool, device, args) => {
          seen.push({ device, tool });
          return { args: ["--set", "/root", ...args], command: "xcrun", env: {} };
        },
        passthroughTools: ["simctl", "devicectl"],
        platform: "ios",
      }),
    );
    const android = new FakeDriver(
      fakeOptions({
        clock,
        passthrough: () => ({ args: [], command: "adb", env: {} }),
        passthroughTools: ["adb"],
        platform: "android",
      }),
    );
    const catalog = new DriverCatalog([ios, android]);

    await expect(route(catalog, "simctl", undefined, ["list", "devices"])).resolves.toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "xcrun",
      env: {},
    });
    await expect(route(catalog, "devicectl", undefined, ["list", "devices"])).resolves.toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "xcrun",
      env: {},
    });
    expect(seen).toEqual([
      { device: undefined, tool: "simctl" },
      { device: undefined, tool: "devicectl" },
    ]);
  });

  it("hands the lease's device and the tool name to the driver's passthrough", async () => {
    const clock = new FakeClock();
    const seen: unknown[] = [];
    const driver = new FakeDriver(
      fakeOptions({
        clock,
        passthrough: (tool, device, args, context) => {
          seen.push({ args, context, device, tool });
          return { args: [], command: "xcrun", env: {} };
        },
        passthroughTools: ["simctl", "devicectl"],
        platform: "ios",
      }),
    );
    const device = { deviceId: "00008110-001A", driverData: {}, physical: true } as const;

    await route(new DriverCatalog([driver]), "devicectl", device, ["device", "info", "apps"], {
      hasTerminal: false,
    });

    expect(seen).toEqual([
      {
        args: ["device", "info", "apps"],
        context: { hasTerminal: false },
        device,
        tool: "devicectl",
      },
    ]);
  });

  it("lets a driver's refusal out as a rejection rather than translating it here", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver(
      fakeOptions({
        clock,
        passthrough: () => {
          throw new PassthroughRefusedError("simctl", "Refusing `simlock simctl delete`");
        },
        passthroughTools: ["simctl"],
        platform: "ios",
      }),
    );

    await expect(
      route(new DriverCatalog([driver]), "simctl", undefined, ["delete", "ABCD"]),
    ).rejects.toBeInstanceOf(PassthroughRefusedError);
  });

  it("rejects a tool no registered driver answers to with UnknownPassthroughToolError", async () => {
    const clock = new FakeClock();
    const catalog = new DriverCatalog([
      new FakeDriver(
        fakeOptions({ clock, passthroughTools: ["simctl", "devicectl"], platform: "ios" }),
      ),
    ]);

    await expect(route(catalog, "adb", undefined, ["devices"])).rejects.toBeInstanceOf(
      UnknownPassthroughToolError,
    );
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

    it("is Pixel 9 for a phone list that starts at Pixel 9 when the catalog lists Pixel 9 paired and no Pixel 8", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["35"],
        clock: new FakeClock(),
        knownModels: ["Pixel 9", "Pixel 7"],
        modelAliases: { "Pixel 9": ["pixel_9"] },
        modelClasses: { "Pixel 7": "phone", "Pixel 9": "phone" },
        modelRuntimes: { "Pixel 7": [], "Pixel 9": ["35"] },
        platform: "android",
      });
      const catalog = new DriverCatalog([driver], {
        preferences: {
          android: { phone: ["Pixel 9", "Pixel 8", "Pixel 7", "Pixel 6", "Medium Phone"] },
        },
      });

      expect((await catalog.listCatalog())[0]?.classDefaults).toEqual({ phone: "Pixel 9" });
    });

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

    it.each([
      {
        case: "a configured name of another class",
        options: {
          classes: { "iPad (A16)": "tablet", "iPhone 17": "phone", "iPhone 16": "phone" },
          models: ["iPad (A16)", "iPhone 17", "iPhone 16"],
          preferences: ["iPad (A16)", "iPhone 17", "iPhone 16"],
        },
        expected: { phone: "iPhone 17" },
      },
      {
        case: "a name whose model has no class",
        options: {
          classes: { "iPhone 16": "phone" },
          models: ["Mystery", "iPhone 16"],
          preferences: ["Mystery", "iPhone 16"],
        },
        expected: { phone: "iPhone 16" },
      },
      {
        case: "a name with no paired runtime",
        options: {
          classes: { "iPhone 16": "phone", "iPhone 17": "phone" },
          modelRuntimes: { "iPhone 16": ["18.4"], "iPhone 17": [] },
          models: ["iPhone 17", "iPhone 16"],
          preferences: ["iPhone 17", "iPhone 16"],
        },
        expected: { phone: "iPhone 16" },
      },
    ] satisfies readonly {
      readonly case: string;
      readonly options: Parameters<typeof defaultsOf>[0];
      readonly expected: Readonly<Record<string, string>>;
    }[])("skips $case and falls to the next name that counts", async ({ options, expected }) => {
      await expect(defaultsOf(options)).resolves.toEqual(expected);
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

    it("reads only a model's own runtimes: a classed model named constructor pairs with nothing, and a listed model with no runtimes entry pairs with nothing", async () => {
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(),
        platform: "ios",
      });
      vi.spyOn(driver, "listCatalog").mockResolvedValue({
        defaultRuntime: "26.5",
        modelAliases: {},
        modelClasses: { constructor: "phone", "iPhone 15": "phone", "iPhone 16": "phone" } as const,
        modelRuntimes: { "iPhone 16": ["26.5"] },
        models: ["constructor", "iPhone 15", "iPhone 16"],
        runtimes: ["26.5"],
      });
      const catalog = new DriverCatalog([driver], {
        preferences: { ios: { phone: ["constructor", "iPhone 15", "iPhone 16"] } },
      });

      const [entry] = await catalog.listCatalog();

      // Inherited `Object.prototype.constructor` has a length; a read of it would count as paired.
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
