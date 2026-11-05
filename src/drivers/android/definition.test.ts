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
  emulator: { audio: false, bootAnimation: false, gpu: "swiftshader_indirect", headless: true },
};
const defaults = { audio: true, bootAnimation: true, gpu: "auto", headless: false };

describe("the Android driver's keys of the android config section", () => {
  it("default android.emulator to a windowed launch with the emulator's own GPU, audio and the boot animation, and take each value a config file sets", async () => {
    const defaulted = await load({});
    const set = await load({ android: accepted });

    expect(defaulted.section.emulator).toEqual(defaults);
    expect(defaulted.warn).not.toHaveBeenCalled();
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

  it("warn about an unknown key under android.emulator and drop it, keeping the defaults", async () => {
    const { section, warn } = await load({
      android: { emulator: { launchArgs: ["-port", "5554"] } },
    });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "android.emulator.launchArgs"');
    expect(section.emulator).toEqual(defaults);
  });
});
