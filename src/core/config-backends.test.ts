import { describe, expect, it } from "vitest";

import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import { booleanValue, type BackendDefinition, loadConfig } from "./index.js";

describe("backend configuration", () => {
  it("validates and defaults only the selected backend, and refuses an unknown backend", async () => {
    const local: BackendDefinition<unknown> = {
      id: "local",
      platform: "android",
      defaults: { turbo: false },
      validators: { turbo: booleanValue },
      settings: { defaults: { localMode: true }, validators: { localMode: booleanValue } },
      capabilities: { baselines: true, physical: true, except: true },
    };
    const remote: BackendDefinition<unknown> = {
      ...local,
      id: "remote",
      defaults: { turbo: true },
      settings: { defaults: { remoteMode: false }, validators: { remoteMode: booleanValue } },
    };
    const filesystem = new MemoryFilesystem();
    const path = "/configuration.json";
    const file = JSON.stringify({
      drivers: { android: { localMode: "unused", remoteMode: true } },
    });
    await filesystem.writeFileAtomic(path, file);
    const options = {
      filesystem,
      configPath: path,
      driverSections: [local, remote],
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
    };

    const config = await loadConfig({
      ...options,
      overrides: { drivers: { android: { backend: "remote" } } },
    });

    expect(config.android["turbo"]).toBe(true);
    expect(config.drivers["android"]).toEqual({
      backend: "remote",
      localMode: "unused",
      remoteMode: true,
    });
    const invalid = loadConfig({
      ...options,
      overrides: { drivers: { android: { backend: "unknown" } } },
    });
    await expect(invalid).rejects.toThrow('Unknown android backend "unknown"');
  });
});
