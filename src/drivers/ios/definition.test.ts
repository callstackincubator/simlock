import { describe, expect, it, vi } from "vitest";

import { driverConfig, loadConfig } from "../../core/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../../ports/index.js";
import { iosDriverConfig } from "./definition.js";

const configPath = "/home/agent/.simlock/config.json";

async function load(file: unknown) {
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
  });
  return { section: driverConfig(config, iosDriverConfig), warn };
}

const accepted = {
  full: { bootTimeoutMs: 400_000 },
  simulator: { audio: false, lifecycleTimeoutMs: 240_000, headless: false },
  slim: { bootTimeoutMs: 900_000, categories: ["logging", "diagnostics"] },
};

describe("the iOS driver's keys of the ios config section", () => {
  it("default to a 5 minute full boot deadline, a 10 minute slim boot deadline with no category list, audio on, headless and a 30 second limit on the simctl commands of a simulator's lifecycle, and take each value a config file sets", async () => {
    const defaulted = await load({});
    const set = await load({ ios: accepted });

    expect(defaulted.section.full).toEqual({ bootTimeoutMs: 300_000 });
    expect(defaulted.section.slim).toEqual({ bootTimeoutMs: 600_000 });
    expect(defaulted.section.simulator).toEqual({
      audio: true,
      lifecycleTimeoutMs: 30_000,
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
    ["ios.simulator.lifecycleTimeoutMs", { simulator: { lifecycleTimeoutMs: 0 } }],
    ["ios.simulator.lifecycleTimeoutMs", { simulator: { lifecycleTimeoutMs: -1 } }],
    ["ios.simulator.lifecycleTimeoutMs", { simulator: { lifecycleTimeoutMs: "30000" } }],
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
    expect(section.simulator).toEqual({ audio: true, lifecycleTimeoutMs: 30_000, headless: true });
  });
});
