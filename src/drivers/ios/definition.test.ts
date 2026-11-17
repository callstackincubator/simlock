import { describe, expect, it, vi } from "vitest";

import { driverConfig, loadConfig } from "../../core/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../../ports/index.js";
import { iosDriverConfig } from "./definition.js";

const configPath = "/home/agent/.simlock/config.json";

async function load(file: unknown, overrides?: unknown) {
  const filesystem = new MemoryFilesystem();
  const warn = vi.fn();
  await filesystem.mkdirp("/home/agent/.simlock");
  await filesystem.writeFileAtomic(configPath, JSON.stringify(file));
  const config = await loadConfig({
    configPath,
    driverSections: [iosDriverConfig],
    filesystem,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
    warn,
    ...(overrides === undefined ? {} : { overrides: overrides as never }),
  });
  return { section: driverConfig(config, iosDriverConfig), warn };
}

const accepted = {
  full: { bootTimeoutMs: 400_000 },
  simulator: { audio: false, createTimeoutMs: 90_000, headless: false },
  slim: { bootTimeoutMs: 900_000, categories: ["logging", "diagnostics"] },
};

describe("the iOS driver's keys of the ios config section", () => {
  it("default to a 5 minute full boot deadline, a 10 minute slim boot deadline with no category list, audio on and headless, and take each value a config file sets", async () => {
    const defaulted = await load({});
    const set = await load({ ios: accepted });

    expect(defaulted.section.full).toEqual({ bootTimeoutMs: 300_000 });
    expect(defaulted.section.slim).toEqual({ bootTimeoutMs: 600_000 });
    expect(defaulted.section.simulator).toEqual({
      audio: true,
      createTimeoutMs: 30_000,
      headless: true,
    });
    expect(defaulted.warn).not.toHaveBeenCalled();
    expect(set.section.full).toEqual(accepted.full);
    expect(set.section.slim).toEqual(accepted.slim);
    expect(set.section.simulator).toEqual(accepted.simulator);
    expect(set.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["ios.slim.bootTimeoutMs", { slim: { bootTimeoutMs: 0 } }],
    ["ios.slim.bootTimeoutMs", { slim: { bootTimeoutMs: -1 } }],
    ["ios.slim.bootTimeoutMs", { slim: { bootTimeoutMs: "600000" } }],
    ["ios.slim.categories", { slim: { categories: "logging" } }],
    ["ios.slim.categories", { slim: { categories: [1, 2] } }],
    ["ios.slim.categories", { slim: { categories: [""] } }],
    ["ios.simulator.audio", { simulator: { audio: "no" } }],
    ["ios.simulator.headless", { simulator: { headless: "no" } }],
    ["ios.simulator.createTimeoutMs", { simulator: { createTimeoutMs: 0 } }],
    ["ios.full.bootTimeoutMs", { full: { bootTimeoutMs: 0 } }],
    ["ios.full.bootTimeoutMs", { full: { bootTimeoutMs: -1 } }],
    ["ios.full.bootTimeoutMs", { full: { bootTimeoutMs: "300000" } }],
  ])("refuse a bad %s, naming the key: %j", async (key, ios) => {
    await expect(load({ ios: accepted })).resolves.toBeDefined();

    await expect(load({ ios })).rejects.toThrow(`Invalid config value for "${key}"`);
  });

  it.each([
    ["ios.slim.enabled", { slim: { enabled: true } }],
    ["ios.slim.turboMode", { slim: { turboMode: true } }],
    ["ios.simulator.window", { simulator: { window: true } }],
  ])("warn about the unknown key %s and drop it, keeping the defaults", async (key, ios) => {
    const { section, warn } = await load({ ios });

    expect(warn).toHaveBeenCalledWith(`Unknown config key: "${key}"`);
    expect(section.slim).toEqual({ bootTimeoutMs: 600_000 });
    expect(section.simulator).toEqual({ audio: true, createTimeoutMs: 30_000, headless: true });
  });
});

describe("the iOS driver's ios.slim.include and ios.slim.exclude", () => {
  const bothLists = (names: string) =>
    `Invalid config value for "ios.slim": expected no service in both include and exclude (${names})`;

  it("load as lists of service names, and fail the load for a name in both lists or a value that is no list of names", async () => {
    const both = await load({
      ios: { slim: { include: ["com.apple.apsd"], exclude: ["com.apple.diagnosticd"] } },
    });
    expect(both.section.slim).toEqual({
      bootTimeoutMs: 600_000,
      exclude: ["com.apple.diagnosticd"],
      include: ["com.apple.apsd"],
    });
    expect(both.warn).not.toHaveBeenCalled();
    expect((await load({ ios: { slim: { include: [] } } })).section.slim.include).toEqual([]);
    expect((await load({ ios: { slim: { exclude: ["a", "a"] } } })).section.slim.exclude).toEqual([
      "a",
      "a",
    ]);

    const refused = [
      [{ ios: { slim: { include: ["x", "y"], exclude: ["y", "x", "z"] } } }, bothLists("x, y")],
      [
        { ios: { slim: { include: ["x"] } } },
        bothLists("x"),
        { ios: { slim: { exclude: ["x"] } } },
      ],
      [
        { ios: { slim: { exclude: "com.apple.diagnosticd" } } },
        'Invalid config value for "ios.slim.exclude": expected an array of strings',
      ],
      [
        { ios: { slim: { exclude: [""] } } },
        'Invalid config value for "ios.slim.exclude": expected an array of strings',
      ],
    ] as const;
    for (const [file, message, overrides] of refused) {
      await expect(load(file, overrides), message).rejects.toThrow(message);
    }
  });
});
