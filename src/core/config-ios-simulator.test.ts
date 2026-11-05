import { describe, expect, it, vi } from "vitest";

import { FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { loadConfig } from "./index.js";

const configPath = "/home/agent/.simlock/config.json";

function createStats(): FakeSystemStats {
  return new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
}

describe("loadConfig ios.simulator", () => {
  it.each([
    { name: "unset", file: {}, simulator: { audio: true, headless: true } },
    {
      name: "true",
      file: { ios: { simulator: { audio: true, headless: true } } },
      simulator: { audio: true, headless: true },
    },
    {
      name: "false",
      file: { ios: { simulator: { audio: false, headless: false } } },
      simulator: { audio: false, headless: false },
    },
  ])("loads ios.simulator: $name", async ({ file, simulator }) => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(file));

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(config.ios.simulator).toEqual(simulator);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["audio", "headless"])(
    "refuses a non-boolean ios.simulator.%s, naming the key",
    async (key) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(
        configPath,
        JSON.stringify({ ios: { simulator: { [key]: "no" } } }),
      );

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow(`Invalid config value for "ios.simulator.${key}"`);
    },
  );
});
