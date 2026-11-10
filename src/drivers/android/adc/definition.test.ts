import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../../core/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../../../ports/index.js";
import { backendDefinitions } from "../../../driver-registry/index.js";

async function load(apiUrl?: unknown) {
  const filesystem = new MemoryFilesystem();
  const configPath = "/home/agent/.simlock/config.json";
  await filesystem.mkdirp("/home/agent/.simlock");
  const settings = apiUrl === undefined ? { backend: "adc" } : { backend: "adc", apiUrl };
  const file = { drivers: { android: settings } };
  const contents = JSON.stringify(file);
  await filesystem.writeFileAtomic(configPath, contents);
  const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
  return await loadConfig({
    configPath,
    filesystem,
    systemStats,
    driverSections: backendDefinitions,
  });
}

describe("the selected ADC backend's API origin", () => {
  it("rejects malformed, insecure or non-origin URLs during public configuration loading", async () => {
    const invalid = [
      "not a URL",
      "http://api.example.com",
      "https://user:secret@api.example.com",
      "https://api.example.com/path",
      "https://api.example.com?key=secret",
      "https://api.example.com#fragment",
      "",
      123,
    ];
    for (const apiUrl of invalid) {
      const loading = load(apiUrl);
      await expect(loading).rejects.toBeInstanceOf(ConfigError);
      await expect(loading).rejects.toThrow('Invalid config value for "drivers.android.apiUrl"');
    }
  });

  it("defaults to the public API and normalizes secure or loopback origins", async () => {
    const cases = [
      [undefined, "https://api.agentdevicecloud.xyz"],
      ["HTTPS://API.EXAMPLE.COM:443/", "https://api.example.com"],
      ["http://LOCALHOST:8000/", "http://localhost:8000"],
      ["http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
      ["http://[::1]:8000/", "http://[::1]:8000"],
    ] as const;
    for (const [apiUrl, expected] of cases) {
      const config = await load(apiUrl);
      expect(config.drivers.android?.apiUrl).toBe(expected);
    }
  });
});
