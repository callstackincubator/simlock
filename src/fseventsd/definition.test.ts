import { describe, expect, it } from "vitest";

import { loadConfig, type ConfigOverrides } from "../core/index.js";
import { fakeWorkerContext } from "../modules/testing.js";
import { FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { fseventsdModule } from "./index.js";

async function enabledOn(
  hostPlatform: NodeJS.Platform,
  overrides: Record<string, unknown>,
  role?: "gateway",
): Promise<unknown> {
  const config = await loadConfig({
    filesystem: new MemoryFilesystem(),
    hostPlatform,
    modules: [
      {
        ...fseventsdModule.config,
        enabledByDefault: fseventsdModule.enabledByDefault as "macos-worker",
        name: fseventsdModule.name,
      },
    ],
    overrides: overrides as ConfigOverrides,
    ...(role === undefined ? {} : { role }),
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
  });
  return (config.capabilities as Record<string, { enabled?: boolean }>)["fseventsd"]?.enabled;
}

describe("fseventsd's definition: capabilities.fseventsd.enabled", () => {
  it("defaults to on for a macOS worker, joined or not, and off elsewhere, and is unavailable on another OS when turned on", async () => {
    const joined = { gateway: { token: "join-secret", url: "wss://fleet.example" } };
    const off = { capabilities: { fseventsd: { enabled: false } } };

    expect(await enabledOn("darwin", {})).toBe(true);
    expect(await enabledOn("darwin", joined)).toBe(true);
    expect(await enabledOn("darwin", off)).toBe(false);
    expect(await enabledOn("linux", {})).toBe(false);
    expect(await enabledOn("darwin", {}, "gateway")).toBe(false);
    expect(await enabledOn("linux", { capabilities: { fseventsd: { enabled: true } } })).toBe(true);

    const { ctx, processRunner } = await fakeWorkerContext("fseventsd", {});
    const worker = (await fseventsdModule.loadWorker()).createWorker(ctx);
    expect(await worker.capability.read()).toEqual({
      reason: "fseventsd exists only on macOS",
      state: "unavailable",
    });
    const found = await worker.findings?.();
    expect(found).toEqual([
      {
        message: "capabilities.fseventsd.enabled is true, but this host is not macOS.",
        remedy: "Set capabilities.fseventsd.enabled to false.",
      },
    ]);
    expect(processRunner.calls).toEqual([]);
  });
});
