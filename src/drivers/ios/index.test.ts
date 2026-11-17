import { afterEach, expect, it, describe } from "vitest";
import { UnknownModelError, DriverCrashError, RuntimeMissingError } from "../../core/index.js";
import { ScriptedProcessRunner, MemoryFilesystem } from "../../ports/index.js";
import { SLIM_CATEGORIES } from "./index.js";
import { deviceRoot, createSlimDriver } from "./test-slim.js";
import {
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  listInvocation,
  pairingFixture,
  scopedRunners,
  scriptedListRunner,
  spec,
} from "./test-index.js";

const modelRuntimesFixture = JSON.stringify({
  devicetypes: [
    deviceType("iPhone-16", "iPhone 16"),
    deviceType("iPhone-XS", "iPhone XS", 0x120600),
    deviceType("iPad-Pro", "iPad Pro"),
    deviceType("iPad-mini", "iPad mini"),
    deviceType("iPhone-8", "iPhone 8"),
  ],
  runtimes: [
    runtime("17.5", "21F79", false, ["iPhone-16", "iPhone-XS", "iPad-Pro", "iPad-mini"]),
    runtime("18.4", "22E238", true, ["iPhone-16", "iPhone-XS"]),
    runtime("26.0", "23A339", true, ["iPhone-16", "iPhone-XS", "iPad-Pro"]),
    runtime("26.0", "23A343", true, ["iPhone-16", "iPad-mini"]),
  ],
});

function deviceType(
  id: string,
  name: string,
  maxRuntimeVersion = 0xffffff,
  productFamily?: string,
) {
  return {
    identifier: `com.apple.CoreSimulator.SimDeviceType.${id}`,
    maxRuntimeVersion,
    minRuntimeVersion: 0,
    name,
    ...(productFamily === undefined ? {} : { productFamily }),
  };
}

function runtime(version: string, build: string, isAvailable: boolean, supports: string[]) {
  return {
    buildversion: build,
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}-${build}`,
    isAvailable,
    name: `iOS ${version}`,
    supportedDeviceTypes: supports.map((id) => ({
      identifier: `com.apple.CoreSimulator.SimDeviceType.${id}`,
    })),
    version,
  };
}

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver", () => {
  it("resolves an exact model and requested installed runtime", async () => {
    const runner = scriptedListRunner();
    const driver = await createDriver(runner);

    await expect(
      driver.resolveSpec({
        model: "iPhone 16",
        osVersion: "18.4",
        platform: "ios",
      }),
    ).resolves.toEqual({ physical: false, model: "iPhone 16", osVersion: "18.4", platform: "ios" });
    expect(runner.calls).toEqual([{ ...listInvocation, options: { timeoutMs: 30_000 } }]);
  });

  it("refuses a request naming an image tag as an option iOS does not have", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({
        imageTag: "google_apis",
        model: "iPhone 16",
        osVersion: "18.4",
        platform: "ios",
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedRequestOptionError",
      option: "imageTag",
      platform: "ios",
    });
  });

  it("selects the newest installed iOS runtime by default", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(driver.resolveSpec({ model: "iPhone 16", platform: "ios" })).resolves.toEqual(
      spec,
    );
  });

  it("matches model names case-insensitively while preserving the simctl name", async () => {
    const driver = await createDriver(scriptedListRunner());

    await expect(
      driver.resolveSpec({
        model: "iphone 16",
        osVersion: "26.5",
        platform: "ios",
      }),
    ).resolves.toEqual(spec);
  });

  it("rejects an unknown model, pointing at a newer Xcode", async () => {
    const driver = await createDriver(scriptedListRunner());
    const result = await driver
      .resolveSpec({ model: "iPhone 99", platform: "ios" })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(UnknownModelError);
    expect(result).toMatchObject({ message: expect.stringContaining("newer Xcode") });
  });

  it("rejects malformed simctl catalog JSON without trusting partial data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: '{"devicetypes":[]}' },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(
      driver.resolveSpec({ model: "iPhone 16", platform: "ios" }),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it("rejects a missing runtime naming it as the component to install, and starts no xcodebuild", async () => {
    const runner = scriptedListRunner();
    const driver = await createDriver(runner);
    const result = await driver
      .resolveSpec({ model: "iPhone 16", osVersion: "18.6", platform: "ios" })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      component: "18.6",
      downloadable: true,
      message: expect.stringMatching(/18\.6.*(allow-download|downloads\.policy)/),
    });
    expect(runner.calls.map((call) => call.command)).toEqual(["xcrun"]);
  });

  it("rejects an out-of-range OS version before ever considering a download", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: pairingFixture } },
    ]);
    const driver = await createDriver(runner);

    const result = await driver
      .resolveSpec({ model: "iPhone Xs", osVersion: "26.5", platform: "ios" })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      downloadable: false,
      message: expect.stringContaining("iPhone Xs supports iOS 12.0-18.6"),
    });
    // why: No xcodebuild (or any further simctl) call: out-of-range is checked before download logic.
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects an installed runtime whose supportedDeviceTypes omits the requested model, without ever calling simctl create", async () => {
    const catalog = JSON.stringify({
      devicetypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          maxRuntimeVersion: 16_777_215,
          minRuntimeVersion: 0,
          name: "iPhone 16",
        },
      ],
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
          isAvailable: true,
          name: "iOS 18.4",
          supportedDeviceTypes: [],
          version: "18.4",
        },
      ],
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: catalog } },
    ]);
    const driver = await createDriver(runner);

    const result = await driver
      .resolveSpec({ model: "iPhone 16", osVersion: "18.4", platform: "ios" })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(RuntimeMissingError);
    expect(result).toMatchObject({
      downloadable: false,
      message: "iOS 18.4 is installed but does not support iPhone 16",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("selects the newest installed runtime that actually pairs with the model, not the newest overall", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: pairingFixture } },
    ]);
    const driver = await createDriver(runner);

    // why: iOS 26.5 is newer and installed, but only iOS 18.4 still lists iPhone Xs as supported.
    await expect(driver.resolveSpec({ model: "iPhone Xs", platform: "ios" })).resolves.toEqual({
      physical: false,
      model: "iPhone Xs",
      osVersion: "18.4",
      platform: "ios",
    });
  });

  it("names the major of the model's upper bound as the component when no installed runtime pairs", async () => {
    const catalog = JSON.stringify({
      devicetypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Xs",
          maxRuntimeVersion: 0x120600,
          minRuntimeVersion: 0x0c0000,
          name: "iPhone Xs",
        },
      ],
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
          isAvailable: true,
          name: "iOS 26.5",
          supportedDeviceTypes: [],
          version: "26.5",
        },
      ],
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: catalog } },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.resolveSpec({ model: "iPhone Xs", platform: "ios" })).rejects.toMatchObject(
      { component: "18", downloadable: true },
    );
    expect(runner.calls.map((call) => call.command)).toEqual(["xcrun"]);
  });

  describe("empty runtime catalog", () => {
    // why: Devicetypes come from the Xcode install itself and are never empty on a working
    // toolchain (an empty list there still means malformed JSON), but a fresh Xcode with zero
    // simulator runtimes installed is a normal starting state -- `parseCatalog` must let it
    // through so `resolveSpec` can reach the download-latest path instead of failing before any
    // resolution is attempted.
    const emptyRuntimesCatalog = JSON.stringify({
      devicetypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          maxRuntimeVersion: 16_777_215,
          minRuntimeVersion: 0,
          name: "iPhone 16",
        },
      ],
      runtimes: [],
    });

    it("names latest as the component when no runtime is installed and the model has no upper bound", async () => {
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: emptyRuntimesCatalog } },
      ]);
      const driver = await createDriver(runner);

      await expect(
        driver.resolveSpec({ model: "iPhone 16", platform: "ios" }),
      ).rejects.toMatchObject({ component: "latest", downloadable: true, osVersion: "default" });
    });

    it("lists an empty runtimes catalog with defaultRuntime undefined instead of throwing", async () => {
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: emptyRuntimesCatalog } },
      ]);
      const driver = await createDriver(runner);

      await expect(driver.listCatalog()).resolves.toEqual({
        defaultRuntime: undefined,
        modelAliases: {},
        modelClasses: {},
        modelRuntimes: { "iPhone 16": [] },
        models: ["iPhone 16"],
        runtimes: [],
        slimCategories: expect.any(Array),
      });
    });
  });

  it("lists resolvable models and installed runtimes, defaulting to the newest", async () => {
    const driver = await createDriver(scriptedListRunner());

    // why: Strict: a catalog key an iOS driver does not fill (`images`, `customModels`) must be
    // absent, not present as undefined.
    await expect(driver.listCatalog()).resolves.toStrictEqual({
      defaultRuntime: "26.5",
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: {
        "iPhone 15 Pro": ["18.4", "26.5"],
        "iPhone 16": ["18.4", "26.5"],
        "iPhone 17 Pro": ["18.4", "26.5"],
      },
      models: ["iPhone 17 Pro", "iPhone 16", "iPhone 15 Pro"],
      runtimes: ["18.4", "26.5"],
      slimCategories: expect.any(Array),
    });
  });

  it("lists every slim category with none configured, and only the configured ones otherwise", async () => {
    const unset = await createDriver(scriptedListRunner());
    const configured = await createSlimDriver(scriptedListRunner(), new MemoryFilesystem(), {
      bootTimeoutMs: 1000,
      categories: ["store"],
    });

    expect((await unset.listCatalog()).slimCategories).toEqual(
      SLIM_CATEGORIES.map((category) => category.name),
    );
    expect((await configured.listCatalog()).slimCategories).toEqual(["store"]);
  });

  describe("model classes", () => {
    function classesRunner(deviceTypes: unknown[]): ScriptedProcessRunner {
      return new ScriptedProcessRunner([
        {
          match: listInvocation,
          result: {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              devicetypes: deviceTypes,
              runtimes: [runtime("26.0", "23A339", true, [])],
            }),
          },
        },
      ]);
    }

    it("classes a device type by its product family: iPhone is phone, iPad is tablet, Apple Watch is watch, Apple TV is tv, Apple Vision is vision", async () => {
      const driver = await createDriver(
        classesRunner([
          deviceType("iPhone-17", "iPhone 17", 0xffffff, "iPhone"),
          deviceType("iPad-Pro", "iPad Pro", 0xffffff, "iPad"),
          deviceType("Watch-11", "Apple Watch Series 11 (46mm)", 0xffffff, "Apple Watch"),
          deviceType("TV-4K", "Apple TV 4K", 0xffffff, "Apple TV"),
          deviceType("Vision-Pro", "Apple Vision Pro", 0xffffff, "Apple Vision"),
        ]),
      );

      expect((await driver.listCatalog()).modelClasses).toEqual({
        "Apple TV 4K": "tv",
        "Apple Vision Pro": "vision",
        "Apple Watch Series 11 (46mm)": "watch",
        "iPad Pro": "tablet",
        "iPhone 17": "phone",
      });
    });

    it("keeps a device type with no product family, or one outside those five, in models with no modelClasses entry", async () => {
      const driver = await createDriver(
        classesRunner([
          deviceType("iPhone-17", "iPhone 17", 0xffffff, "iPhone"),
          deviceType("Mystery", "Mystery Device"),
          deviceType("HomePod", "HomePod", 0xffffff, "HomePod"),
        ]),
      );

      const catalog = await driver.listCatalog();

      expect(catalog.models).toEqual(["iPhone 17", "Mystery Device", "HomePod"]);
      expect(catalog.modelClasses).toEqual({ "iPhone 17": "phone" });
    });
  });

  describe("model and runtime pairing", () => {
    function pairingRunner(calls = 1): ScriptedProcessRunner {
      return new ScriptedProcessRunner(
        Array.from({ length: calls }, () => ({
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: modelRuntimesFixture },
        })),
      );
    }

    it("lists for each model exactly the installed runtimes that support its device type and fall in its version range", async () => {
      const driver = await createDriver(pairingRunner());

      const catalog = await driver.listCatalog();

      expect(catalog.runtimes).toEqual(["18.4", "26.0", "26.0"]);
      expect(catalog.modelRuntimes).toEqual({
        "iPhone 16": ["18.4", "26.0"],
        "iPhone XS": ["18.4"],
        "iPad Pro": ["26.0"],
        "iPad mini": ["26.0"],
        "iPhone 8": [],
      });
    });

    it("resolveSpec accepts every listed pair and refuses every unlisted pair of a listed model and an installed runtime", async () => {
      const models = ["iPhone 16", "iPhone XS", "iPad Pro", "iPad mini", "iPhone 8"];
      const installed = ["18.4", "26.0"];
      const driver = await createDriver(pairingRunner(1 + models.length * installed.length));
      const catalog = await driver.listCatalog();
      expect(catalog.models).toEqual(models);

      let accepted = 0;
      let refused = 0;
      for (const model of models) {
        for (const osVersion of installed) {
          const resolution = driver.resolveSpec({
            model,
            osVersion,
            platform: "ios",
          });
          if (catalog.modelRuntimes[model]?.includes(osVersion) === true) {
            await expect(resolution).resolves.toEqual({
              physical: false,
              model,
              osVersion,
              platform: "ios",
            });
            accepted += 1;
          } else {
            // why: Every runtime here is installed, so the refusal is the range or the pairing
            // check -- never a missing runtime, and never a download.
            await expect(resolution).rejects.toThrow(
              /is out of range|is installed but does not support/,
            );
            refused += 1;
          }
        }
      }
      expect({ accepted, refused }).toEqual({ accepted: 5, refused: 5 });
    });

    it("pairs two device types that differ only in letter case through the first, as resolveSpec matches them", async () => {
      const fixture = JSON.stringify({
        devicetypes: [
          deviceType("iPhone-16", "iPhone 16"),
          deviceType("iphone-16-dup", "iphone 16"),
        ],
        runtimes: [runtime("26.0", "23A339", true, ["iPhone-16"])],
      });
      const runner = new ScriptedProcessRunner(
        Array.from({ length: 2 }, () => ({
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: fixture },
        })),
      );
      const driver = await createDriver(runner);

      const catalog = await driver.listCatalog();

      expect(catalog.models).toEqual(["iPhone 16", "iphone 16"]);
      expect(catalog.modelRuntimes).toEqual({ "iPhone 16": ["26.0"], "iphone 16": ["26.0"] });
      await expect(
        driver.resolveSpec({
          model: "iphone 16",
          osVersion: "26.0",
          platform: "ios",
        }),
      ).resolves.toEqual({
        physical: false,
        model: "iPhone 16",
        osVersion: "26.0",
        platform: "ios",
      });
    });
  });
});
