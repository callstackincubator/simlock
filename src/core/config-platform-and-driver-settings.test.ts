import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { booleanValue, driverConfig, type DriverConfigEntry, loadConfig } from "./index.js";
import { dottedValue, configPath, createStats } from "./test-config.js";

describe("loadConfig", () => {
  it("defaults ios.defaultMode to full", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.ios.defaultMode).toBe("full");
  });

  it("applies a file-level ios.defaultMode override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultMode: "slim" } }));

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.ios.defaultMode).toBe("slim");
  });

  it("a driver's config entry adds its keys to its platform's section: defaulted, taken from the file, refused by its validator, and unknown to a loader without the entry", async () => {
    const entry: DriverConfigEntry<{ readonly turbo: boolean }> = {
      platform: "android",
      defaults: { turbo: false },
      validators: { turbo: booleanValue },
    };
    const load = async (file: unknown, driverSections = [entry]) => {
      const filesystem = new MemoryFilesystem();
      const warn = vi.fn();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify(file));
      const config = await loadConfig({
        configPath,
        driverSections,
        filesystem,
        systemStats: createStats(),
        warn,
      });
      return { config, section: driverConfig(config, entry), warn };
    };

    const defaulted = await load({});
    const set = await load({ android: { turbo: true } });
    const unknown = await load({ android: { turbo: true } }, []);

    expect(defaulted.section.turbo).toBe(false);
    expect([set.section.turbo, set.warn.mock.calls]).toEqual([true, []]);
    await expect(load({ android: { turbo: "yes" } })).rejects.toThrow(
      'Invalid config value for "android.turbo"',
    );
    expect(unknown.warn).toHaveBeenCalledWith('Unknown config key: "android.turbo"');
    expect(unknown.config.android).toEqual({ defaultModels: {} });
    expect(set.config.ios).toEqual({ defaultMode: "full", defaultModels: {} });
  });

  it.each(["fast", "worker", true])(
    "rejects an ios.defaultMode of %j, naming the key",
    async (value) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultMode: value } }));

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow("ios.defaultMode");
    },
  );

  it.each(["ios", "android"] as const)(
    "%s.defaultModels defaults to no class having a list",
    async (platform) => {
      const config = await loadConfig({
        configPath,
        filesystem: new MemoryFilesystem(),
        systemStats: createStats(),
      });

      expect(config[platform].defaultModels).toEqual({});
    },
  );

  it.each([
    ["ios", "phone", "iPhone 15"],
    ["ios", "tablet", ["iPad (A16)", "iPad (10th generation)"]],
    ["android", "phone", "Pixel 7"],
    ["android", "tv", ["Television (4K)"]],
  ] as const)(
    "%s.defaultModels.%s accepts one model name or a list of them",
    async (platform, deviceClass, value) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(
        configPath,
        JSON.stringify({ [platform]: { defaultModels: { [deviceClass]: value } } }),
      );

      const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

      expect(config[platform].defaultModels).toStrictEqual({
        [deviceClass]: typeof value === "string" ? [value] : value,
      });
    },
  );

  it.each([
    ["ios", { phone: "" }, "ios.defaultModels.phone"],
    ["ios", { phone: [] }, "ios.defaultModels.phone"],
    ["ios", { phone: ["iPhone 15", ""] }, "ios.defaultModels.phone"],
    ["ios", { phone: 15 }, "ios.defaultModels.phone"],
    ["ios", { phone: [15] }, "ios.defaultModels.phone"],
    ["ios", { phone: [["iPhone 15"]] }, "ios.defaultModels.phone"],
    ["ios", { mobile: "iPhone 15" }, "ios.defaultModels.mobile"],
    ["ios", { constructor: "iPhone 15" }, "ios.defaultModels.constructor"],
    ["android", { phone: [] }, "android.defaultModels.phone"],
    ["android", { fridge: "Pixel 8" }, "android.defaultModels.fridge"],
  ])("refuses %s.defaultModels %j, naming the key", async (platform, defaultModels, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ [platform]: { defaultModels } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(`Invalid config value for "${path}"`);
  });

  it("says what ios.defaultModels expects: a device class for a key, a name or a list of names for a value", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const load = async (defaultModels: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultModels } }));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    await expect(load({ mobile: "iPhone 15" })).rejects.toThrow(
      "expected a device class (phone, tablet, watch, tv, vision, auto, desktop)",
    );
    await expect(load({ phone: [] })).rejects.toThrow(
      "expected a model name or a non-empty list of model names",
    );
  });

  it("applies a file-level stalledTransition override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        stalledTransition: { thresholdMultiplier: 5, minimumThresholdMs: 120_000 },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.stalledTransition).toEqual({
      thresholdMultiplier: 5,
      minimumThresholdMs: 120_000,
    });
  });

  it.each([
    [{ stalledTransition: { thresholdMultiplier: 0.5 } }, "stalledTransition.thresholdMultiplier"],
    [{ stalledTransition: { minimumThresholdMs: -1 } }, "stalledTransition.minimumThresholdMs"],
  ])("rejects invalid stalledTransition values in every field", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("defaults to no driver settings at all", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.drivers).toEqual({});
  });

  it("keeps driver settings verbatim, including keys it has never heard of", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        drivers: {
          ios: { deviceRoot: "/Volumes/scratch/simlock-ios" },
          android: { adbServerPort: 5038, headless: true, somethingOnlyTheDriverKnows: "yes" },
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(config.drivers).toEqual({
      ios: { deviceRoot: "/Volumes/scratch/simlock-ios" },
      android: { adbServerPort: 5038, headless: true, somethingOnlyTheDriverKnows: "yes" },
    });
    // Warning about an unrecognised key here would mean the core knows which keys a
    // driver has, which is the whole thing this block is not allowed to know.
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a driver setting at the dotted path `simlock config get` walks", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ drivers: { ios: { deviceRoot: "/Volumes/scratch/simlock-ios" } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(dottedValue(config, "drivers.ios.deviceRoot")).toBe("/Volumes/scratch/simlock-ios");
  });

  it("merges driver settings across layers key by key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        drivers: { ios: { deviceRoot: "/from-file" }, android: { headless: true } },
      }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
      overrides: { drivers: { ios: { deviceRoot: "/from-override" } } },
    });

    expect(config.drivers).toEqual({
      ios: { deviceRoot: "/from-override" },
      android: { headless: true },
    });
  });

  it.each([
    [{ drivers: "everything" }, "drivers"],
    [{ drivers: { ios: "/Volumes/scratch" } }, "drivers.ios"],
    [{ drivers: { ios: { deviceRoot: { path: "/Volumes/scratch" } } } }, "drivers.ios.deviceRoot"],
    [{ drivers: { ios: { deviceRoot: ["/Volumes/scratch"] } } }, "drivers.ios.deviceRoot"],
  ])("rejects driver settings that are not plain scalars", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });
});
