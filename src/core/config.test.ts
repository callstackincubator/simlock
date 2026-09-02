import { describe, expect, it, vi } from "vitest";

import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import type { ResourceStrategyOptions } from "./capacity/index.js";
import { type Config, loadConfig } from "./index.js";

/** Narrows the capacity block for assertions on resource-strategy configs. */
function resourceOptions(config: Config): ResourceStrategyOptions {
  if (config.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return config.capacity.config;
}

const configPath = "/home/agent/.simlock/config.json";
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

    expect(config.capacity.strategy).toBe("resource");
    expect(resourceOptions(config).limits.ios.maxDevices).toBe(Math.max(1, Math.floor(8 / 2)));
    expect(resourceOptions(config).limits.android.maxDevices).toBe(
      Math.max(1, Math.min(Math.floor(8 / 4), Math.floor(32 / 8))),
    );
    expect(resourceOptions(config).limits).toMatchObject({
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
      health: {
        enabled: true,
        probeIntervalMs: 30_000,
        stableObservations: 2,
        maxRecoveryAttempts: 3,
        recoveryBackoffMs: 5_000,
        maxConcurrentRecoveries: 1,
      },
      idle: { deleteAfterMs: 60 * 60_000, shutdownAfterMs: 10 * 60_000 },
      lease: {
        detachedTtlMs: 15 * 60_000,
        heldTtlBackstopMs: 60 * 60_000,
        heartbeatIntervalMs: 5 * 60_000,
      },
      capacity: {
        strategy: "resource",
        config: {
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
        },
      },
      log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
      http: { enabled: false, host: "127.0.0.1", port: 4700 },
      warmPool: {
        quarantine: {
          maxRetries: 3,
          retryBackoffMs: 30_000,
          retryBackoffMultiplier: 2,
          maxRetryBackoffMs: 5 * 60_000,
        },
      },
      stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(resourceOptions(config).limits)).toBe(true);
  });

  it("applies a file-level log override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ log: { level: "debug", rotateBytes: 1024 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.log).toEqual({ level: "debug", rotateBytes: 1024 });
  });

  it("rejects a log level outside the known set", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ log: { level: "verbose" } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("log.level");
  });

  it("rejects a non-positive-integer log rotation cap", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ log: { rotateBytes: 0 } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("log.rotateBytes");
  });

  it("applies a file-level warm-pool quarantine override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ warmPool: { quarantine: { maxRetries: 1, retryBackoffMs: 1_000 } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.warmPool.quarantine).toEqual({
      maxRetries: 1,
      retryBackoffMs: 1_000,
      retryBackoffMultiplier: 2,
      maxRetryBackoffMs: 5 * 60_000,
    });
  });

  it("rejects a non-positive-integer quarantine retry count", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ warmPool: { quarantine: { maxRetries: 0 } } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("warmPool.quarantine.maxRetries");
  });

  it("rejects a quarantine backoff multiplier below 1", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ warmPool: { quarantine: { retryBackoffMultiplier: 0.5 } } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("warmPool.quarantine.retryBackoffMultiplier");
  });

  it("applies file values over defaults and explicit overrides over file values", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
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

    expect(resourceOptions(config).limits.ios.maxDevices).toBe(3);
    expect(resourceOptions(config).limits.android.maxDevices).toBe(2);
    expect(resourceOptions(config).limits).toMatchObject({
      android: { maxRunning: 1 },
      ios: { maxRunning: 2 },
      maxRunning: 4,
    });
    expect(config.lease.detachedTtlMs).toBe(456);
  });

  it("deeply merges a partial config file", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ramBudget: { androidBytesPerDevice: 5 * gibibyte } }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
    });

    expect(resourceOptions(config).ramBudget).toEqual({
      androidBytesPerDevice: 5 * gibibyte,
      iosBytesPerDevice: 1.5 * gibibyte,
    });
  });

  it("rejects malformed values with the offending key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
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
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("accepts a heartbeat interval at the boundary of a quarter of the backstop", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { heldTtlBackstopMs: 40_000, heartbeatIntervalMs: 10_000 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.lease).toMatchObject({ heartbeatIntervalMs: 10_000, heldTtlBackstopMs: 40_000 });
  });

  it("rejects a non-positive-integer heartbeat interval", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
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
    await filesystem.mkdirp("/home/agent/.simlock");
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
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ limits: { web: {} } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats(), warn }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith('Unknown config key: "limits.web"');
  });

  it("applies a file-level health override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        health: {
          enabled: false,
          probeIntervalMs: 60_000,
          stableObservations: 3,
          maxRecoveryAttempts: 5,
          recoveryBackoffMs: 10_000,
          maxConcurrentRecoveries: 2,
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.health).toEqual({
      enabled: false,
      probeIntervalMs: 60_000,
      stableObservations: 3,
      maxRecoveryAttempts: 5,
      recoveryBackoffMs: 10_000,
      maxConcurrentRecoveries: 2,
    });
  });

  it("rejects a non-boolean health.enabled", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ health: { enabled: "yes" } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("health.enabled");
  });

  it.each([
    [{ health: { probeIntervalMs: 0 } }, "health.probeIntervalMs"],
    [{ health: { recoveryBackoffMs: -1 } }, "health.recoveryBackoffMs"],
    [{ health: { stableObservations: 0 } }, "health.stableObservations"],
    [{ health: { stableObservations: 1.5 } }, "health.stableObservations"],
    [{ health: { maxRecoveryAttempts: 0 } }, "health.maxRecoveryAttempts"],
    [{ health: { maxConcurrentRecoveries: 0 } }, "health.maxConcurrentRecoveries"],
  ])("rejects invalid health values in every field", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("warns about an unknown key nested under health without rejecting the file", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ health: { maxBoltCount: 7 } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats(), warn }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith('Unknown config key: "health.maxBoltCount"');
  });

  it("applies a file-level http override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ http: { enabled: true, host: "0.0.0.0", port: 8080 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.http).toEqual({ enabled: true, host: "0.0.0.0", port: 8080 });
  });

  it("applies an override-level http port over the file value", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ http: { port: 5000 } }));

    const config = await loadConfig({
      configPath,
      filesystem,
      overrides: { http: { port: 6000 } },
      systemStats: createStats(),
    });
    expect(config.http.port).toBe(6000);
  });

  it("rejects a non-boolean http.enabled", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ http: { enabled: "yes" } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("http.enabled");
  });

  it("rejects a non-string http.host", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ http: { host: 127 } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("http.host");
  });

  it.each([
    [{ http: { port: 0 } }, "http.port"],
    [{ http: { port: 65536 } }, "http.port"],
    [{ http: { port: 1.5 } }, "http.port"],
    [{ http: { port: "4700" } }, "http.port"],
  ])("rejects an out-of-range or malformed http.port", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
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
});

describe("loadConfig capacity strategies", () => {
  async function load(
    contents: unknown,
    options: {
      readonly overrides?: Parameters<typeof loadConfig>[0]["overrides"];
      readonly warn?: (message: string) => void;
    } = {},
  ) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
    return loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  it("selects the resource strategy when nothing names one", async () => {
    const config = await load({});

    expect(config.capacity.strategy).toBe("resource");
  });

  it("defaults the fixed strategy to a machine-independent pin", async () => {
    const config = await load({ capacity: { strategy: "fixed" } });

    expect(config.capacity).toEqual({ strategy: "fixed", config: { maxRunning: 2 } });
  });

  it("pins concurrency from a single key", async () => {
    const config = await load({ capacity: { strategy: "fixed", config: { maxRunning: 4 } } });

    expect(config.capacity.config).toEqual({ maxRunning: 4 });
  });

  it("lets an override switch the strategy chosen by the file", async () => {
    const config = await load(
      { capacity: { strategy: "resource" } },
      { overrides: { capacity: { strategy: "fixed", config: { maxRunning: 6 } } } },
    );

    expect(config.capacity).toEqual({ strategy: "fixed", config: { maxRunning: 6 } });
  });

  it("starts from the selected strategy's defaults, not the default strategy's", async () => {
    const config = await load({ capacity: { strategy: "fixed", config: { maxRunning: 3 } } });

    expect(config.capacity.config).not.toHaveProperty("ramBudget");
    expect(config.capacity.config).not.toHaveProperty("limits");
  });

  it("rejects a strategy name with no registered implementation", async () => {
    await expect(load({ capacity: { strategy: "vibes" } })).rejects.toThrow("capacity.strategy");
  });

  it("hands capacity.config to the selected strategy's own validator", async () => {
    await expect(
      load({ capacity: { strategy: "fixed", config: { maxRunning: 0 } } }),
    ).rejects.toThrow("capacity.config.maxRunning");
  });

  it("warns when capacity.config carries another strategy's keys", async () => {
    const warn = vi.fn();
    await load({ capacity: { strategy: "fixed", config: { ramBudget: {} } } }, { warn });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "capacity.config.ramBudget"');
  });
});

describe("loadConfig legacy capacity keys", () => {
  async function load(
    contents: unknown,
    options: {
      readonly overrides?: Parameters<typeof loadConfig>[0]["overrides"];
      readonly warn?: (message: string) => void;
    } = {},
  ) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
    return loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  it("folds top-level limits and ramBudget into the resource strategy's options", async () => {
    const warn = vi.fn();
    const config = await load(
      {
        limits: { ios: { maxDevices: 3, maxRunning: 3 }, maxRunning: 5 },
        ramBudget: { iosBytesPerDevice: 2 * gibibyte },
      },
      { warn },
    );

    expect(config.capacity.strategy).toBe("resource");
    expect(resourceOptions(config).limits).toMatchObject({
      ios: { maxDevices: 3, maxRunning: 3 },
      maxRunning: 5,
    });
    expect(resourceOptions(config).ramBudget.iosBytesPerDevice).toBe(2 * gibibyte);
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers capacity.config over the legacy spelling within one layer", async () => {
    const config = await load({
      capacity: { strategy: "resource", config: { limits: { maxRunning: 9 } } },
      limits: { maxRunning: 2 },
    });

    expect(resourceOptions(config).limits.maxRunning).toBe(9);
  });

  it("keeps layer precedence when the layers disagree about spelling", async () => {
    const config = await load(
      { limits: { maxRunning: 8 } },
      { overrides: { capacity: { strategy: "resource", config: { limits: { maxRunning: 4 } } } } },
    );

    expect(resourceOptions(config).limits.maxRunning).toBe(4);
  });

  it("lets a legacy override win over a capacity.config file value", async () => {
    const config = await load(
      { capacity: { strategy: "resource", config: { limits: { maxRunning: 8 } } } },
      { overrides: { limits: { maxRunning: 4 } } },
    );

    expect(resourceOptions(config).limits.maxRunning).toBe(4);
  });

  it("warns and ignores legacy keys when another strategy is selected", async () => {
    const warn = vi.fn();
    const config = await load(
      { capacity: { strategy: "fixed", config: { maxRunning: 3 } }, limits: { maxRunning: 8 } },
      { warn },
    );

    expect(config.capacity).toEqual({ strategy: "fixed", config: { maxRunning: 3 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring limits"));
  });
});
