import { describe, expect, it, vi } from "vitest";

import { driverConfig, loadConfig } from "../../core/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../../ports/index.js";
import { androidDriverConfig } from "./definition.js";

const configPath = "/home/agent/.simlock/config.json";

async function load(file: unknown) {
  const filesystem = new MemoryFilesystem();
  const warn = vi.fn();
  await filesystem.mkdirp("/home/agent/.simlock");
  await filesystem.writeFileAtomic(configPath, JSON.stringify(file));
  const config = await loadConfig({
    configPath,
    driverSections: [androidDriverConfig],
    filesystem,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
    warn,
  });
  return { section: driverConfig(config, androidDriverConfig), warn };
}

const accepted = {
  bootTimeoutMs: 600_000,
  emulator: { audio: false, bootAnimation: false, gpu: "swiftshader_indirect", headless: true },
};
const defaults = { audio: true, bootAnimation: true, gpu: "auto", headless: false };

describe("the Android driver's keys of the android config section", () => {
  it("default android.bootTimeoutMs to 5 minutes and android.emulator to a windowed launch with the emulator's own GPU, audio and the boot animation, and take each value a config file sets", async () => {
    const defaulted = await load({});
    const set = await load({ android: accepted });

    expect(defaulted.section.bootTimeoutMs).toBe(300_000);
    expect(defaulted.section.emulator).toEqual(defaults);
    expect(defaulted.warn).not.toHaveBeenCalled();
    expect(set.section.bootTimeoutMs).toBe(600_000);
    expect(set.section.emulator).toEqual(accepted.emulator);
    expect(set.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["android.emulator.headless", { headless: "yes" }],
    ["android.emulator.audio", { audio: 0 }],
    ["android.emulator.bootAnimation", { bootAnimation: "false" }],
    ["android.emulator.gpu", { gpu: "" }],
    ["android.emulator.gpu", { gpu: true }],
  ])("refuse a bad %s, naming the key: %j", async (key, emulator) => {
    await expect(load({ android: accepted })).resolves.toBeDefined();

    await expect(load({ android: { emulator } })).rejects.toThrow(
      `Invalid config value for "${key}"`,
    );
  });

  it("take android.emulator.cores as a positive integer, refuse anything else naming the key, and load with no cores when unset", async () => {
    for (const cores of [1, 2]) {
      expect((await load({ android: { emulator: { cores } } })).section.emulator.cores).toBe(cores);
    }
    for (const cores of [0, -1, 2.5, "abc", "2", true]) {
      await expect(load({ android: { emulator: { cores } } })).rejects.toThrow(
        'Invalid config value for "android.emulator.cores"',
      );
    }
    expect("cores" in (await load({})).section.emulator).toBe(false);
  });

  it.each([0, -1, "300000"])(
    "refuse a bad android.bootTimeoutMs, naming the key: %j",
    async (bootTimeoutMs) => {
      await expect(load({ android: { bootTimeoutMs } })).rejects.toThrow(
        'Invalid config value for "android.bootTimeoutMs"',
      );
    },
  );

  it("warn about an unknown key under android.emulator and drop it, keeping the defaults", async () => {
    const { section, warn } = await load({
      android: { emulator: { launchArgs: ["-port", "5554"] } },
    });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "android.emulator.launchArgs"');
    expect(section.emulator).toEqual(defaults);
  });

  it("take android.networkDevices true or false, default it to false, and refuse a string naming the key", async () => {
    expect((await load({})).section.networkDevices).toBe(false);
    expect((await load({ android: { networkDevices: true } })).section.networkDevices).toBe(true);
    expect((await load({ android: { networkDevices: false } })).section.networkDevices).toBe(false);

    await expect(load({ android: { networkDevices: "yes" } })).rejects.toThrow(
      'Invalid config value for "android.networkDevices"',
    );
  });
});
