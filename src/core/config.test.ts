import { describe, expect, it, vi } from "vitest";

import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import { loadConfig } from "./index.js";

const configPath = "/home/agent/.pitlane/config.json";
const gibibyte = 1024 ** 3;

function createStats(): FakeSystemStats {
  return new FakeSystemStats({
    cpuCount: 8,
    freeRamBytes: 16 * gibibyte,
    totalRamBytes: 32 * gibibyte,
  });
}

describe("loadConfig", () => {
  it("derives device limits from the injected machine capacity", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.limits.ios.maxDevices).toBe(Math.max(1, Math.floor(8 / 2)));
    expect(config.limits.android.maxDevices).toBe(
      Math.max(1, Math.min(Math.floor(8 / 4), Math.floor(32 / 8))),
    );
    expect(config.limits).toMatchObject({
      android: { maxRunning: 2 },
      ios: { maxRunning: 4 },
      maxRunning: 6,
    });
  });

  it("uses the documented defaults for budgets, timeouts, and the event buffer", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config).toMatchObject({
      diskPressure: { freeBytesThreshold: 10 * gibibyte },
      eventBuffer: { capacity: 1000 },
      idle: { deleteAfterMs: 60 * 60_000, shutdownAfterMs: 10 * 60_000 },
      lease: {
        detachedTtlMs: 15 * 60_000,
        heldTtlBackstopMs: 60 * 60_000,
        heartbeatIntervalMs: 5 * 60_000,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
      log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
  });

  it("applies a file-level log override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ log: { level: "debug", rotateBytes: 1024 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.log).toEqual({ level: "debug", rotateBytes: 1024 });
  });

  it("rejects a log level outside the known set", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ log: { level: "verbose" } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("log.level");
  });

  it("rejects a non-positive-integer log rotation cap", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ log: { rotateBytes: 0 } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("log.rotateBytes");
  });

  it("applies file values over defaults and explicit overrides over file values", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        limits: { ios: { maxDevices: 3, maxRunning: 2 }, maxRunning: 4 },
        lease: { detachedTtlMs: 123 },
      }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      overrides: {
        lease: { detachedTtlMs: 456 },
        limits: { android: { maxRunning: 1 } },
      },
      systemStats: createStats(),
    });

    expect(config.limits.ios.maxDevices).toBe(3);
    expect(config.limits.android.maxDevices).toBe(2);
    expect(config.limits).toMatchObject({
      android: { maxRunning: 1 },
      ios: { maxRunning: 2 },
      maxRunning: 4,
    });
    expect(config.lease.detachedTtlMs).toBe(456);
  });

  it("deeply merges a partial config file", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ramBudget: { androidBytesPerDevice: 5 * gibibyte } }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
    });

    expect(config.ramBudget).toEqual({
      androidBytesPerDevice: 5 * gibibyte,
      iosBytesPerDevice: 1.5 * gibibyte,
    });
  });

  it("rejects malformed values with the offending key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ limits: { ios: { maxDevices: "many" } } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("limits.ios.maxDevices");
  });

  it.each([
    [{ limits: { maxRunning: 0 } }, "limits.maxRunning"],
    [{ limits: { ios: { maxRunning: 1.5 } } }, "limits.ios.maxRunning"],
    [{ limits: { android: { maxRunning: "many" } } }, "limits.android.maxRunning"],
  ])("rejects invalid maxRunning values in every scope", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("accepts a heartbeat interval at the boundary of a quarter of the backstop", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { heldTtlBackstopMs: 40_000, heartbeatIntervalMs: 10_000 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.lease).toMatchObject({ heartbeatIntervalMs: 10_000, heldTtlBackstopMs: 40_000 });
  });

  it("rejects a non-positive-integer heartbeat interval", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { heartbeatIntervalMs: 0 } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("lease.heartbeatIntervalMs");
  });

  it("rejects a heartbeat interval that exceeds a quarter of the backstop", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { heldTtlBackstopMs: 40_000, heartbeatIntervalMs: 10_001 } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("lease.heartbeatIntervalMs");
  });

  it("warns about unknown keys without rejecting the file", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.pitlane");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ limits: { web: {} } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats(), warn }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith('Unknown config key: "limits.web"');
  });
});
