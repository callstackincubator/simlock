import { describe, expect, it, vi } from "vitest";

import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import type { ResourceStrategyOptions } from "./capacity/index.js";
import { configSchema } from "../contract/schemas.js";
import {
  type Config,
  effectiveAllowDownload,
  loadConfig,
  REDACTED_VALUE,
  redactConfig,
} from "./index.js";

/** Narrows the capacity block for assertions on resource-strategy configs. */
function resourceOptions(config: Config): ResourceStrategyOptions {
  if (config.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return config.capacity.config;
}

/**
 * The walk `simlock config get <key>` performs over the daemon's config, reproduced here
 * so a driver block is proven reachable by dotted key and not just present in the object.
 */
function dottedValue(config: Config, key: string): unknown {
  let current: unknown = config;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Every leaf of a config object as a dotted key. Recursive on purpose: a first version of this
 * walked only one level and so would have missed a key dropped from a *nested* block such as
 * `capacity.config` or `warmPool.quarantine`.
 */
function dottedLeafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    dottedLeafKeys(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

const configPath = "/home/agent/.simlock/config.json";
const gibibyte = 1024 ** 3;

function createStats(): FakeSystemStats {
  return new FakeSystemStats({
    cpuCount: 8,
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
        defaultTtlMs: 15 * 60_000,
        maxTtlMs: 4 * 60 * 60_000,
        identity: { ios: "reusable", android: "reusable" },
        requestRetentionMs: 600_000,
        maxRequestRecords: 10_000,
      },
      capacity: {
        strategy: "resource",
        config: {
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
        },
      },
      log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
      eventLog: {
        rotateBytes: 5 * 1024 * 1024,
        retention: 7 * 24 * 60 * 60 * 1000,
        maxBytes: 256 * 1024 * 1024,
      },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
      http: { enabled: false, host: "127.0.0.1", port: 4700 },
      warmPool: {
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        quarantine: {
          maxRetries: 3,
          retryBackoffMs: 30_000,
          retryBackoffMultiplier: 2,
          maxRetryBackoffMs: 5 * 60_000,
        },
      },
      stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
      ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(resourceOptions(config).limits)).toBe(true);
  });

  it("defaults exec.timeoutMs to ten minutes and rejects a non-positive one", async () => {
    // ADR 0005 §19e's per-command bound. Rejected rather than clamped, like every other
    // duration here: a caller given a limit it did not write cannot tell which one applied.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    const defaulted = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(defaulted.exec).toEqual({ timeoutMs: 600_000 });

    await filesystem.writeFileAtomic(configPath, JSON.stringify({ exec: { timeoutMs: 30_000 } }));
    const overridden = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(overridden.exec.timeoutMs).toBe(30_000);

    await filesystem.writeFileAtomic(configPath, JSON.stringify({ exec: { timeoutMs: 0 } }));
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("exec.timeoutMs");
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

  it("defaults eventLog.rotateBytes to 5 MiB and rejects zero and negative values", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    const defaults = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(defaults.eventLog.rotateBytes).toBe(5 * 1024 * 1024);

    for (const rotateBytes of [0, -1]) {
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ eventLog: { rotateBytes } }));
      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow("eventLog.rotateBytes");
    }
  });

  it("reports eventLog.retention and eventLog.maxBytes at their defaults", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(config.eventLog).toEqual({
      rotateBytes: 5 * 1024 * 1024,
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    });
    expect(configSchema.shape.eventLog.parse(config.eventLog)).toEqual(config.eventLog);
  });

  it("rejects a non-positive or fractional eventLog.retention and eventLog.maxBytes, naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    for (const key of ["retention", "maxBytes"]) {
      for (const value of [0, -1, 1.5]) {
        await filesystem.writeFileAtomic(
          configPath,
          JSON.stringify({ eventLog: { [key]: value } }),
        );
        await expect(
          loadConfig({ configPath, filesystem, systemStats: createStats() }),
        ).rejects.toThrow(`eventLog.${key}`);
      }
    }
  });

  it("rejects a config with eventLog.maxBytes below twice eventLog.rotateBytes, naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ eventLog: { rotateBytes: 1_000, maxBytes: 1_999 } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow('"eventLog.maxBytes": expected at least twice eventLog.rotateBytes');

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ eventLog: { rotateBytes: 1_000, maxBytes: 2_000 } }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).resolves.toBeDefined();
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

  it("keeps the warm pool on by default and applies a file-level warmPool.enabled override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    expect(
      (await loadConfig({ configPath, filesystem, systemStats: createStats() })).warmPool.enabled,
    ).toBe(true);

    await filesystem.writeFileAtomic(configPath, JSON.stringify({ warmPool: { enabled: false } }));

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.warmPool.enabled).toBe(false);
    expect(config.warmPool.quarantine.maxRetries).toBe(3);
  });

  it("rejects a warmPool.enabled that is not a boolean", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ warmPool: { enabled: "no" } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("warmPool.enabled");
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

  it("defaults warmPool.reserveRunning to 0 on both platforms and applies a file-level value", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    expect(
      (await loadConfig({ configPath, filesystem, systemStats: createStats() })).warmPool
        .reserveRunning,
    ).toEqual({ android: 0, ios: 0 });

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ warmPool: { reserveRunning: { ios: 4 } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.warmPool.reserveRunning).toEqual({ android: 0, ios: 4 });

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ warmPool: { reserveRunning: { android: 0, ios: 0 } } }),
    );
    const zero = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(zero.warmPool.reserveRunning).toEqual({ android: 0, ios: 0 });
  });

  it.each(["ios", "android"] as const)(
    "rejects a negative or non-integer warmPool.reserveRunning.%s naming the key",
    async (platform) => {
      for (const bad of [-1, 1.5, "1", null]) {
        const filesystem = new MemoryFilesystem();
        await filesystem.mkdirp("/home/agent/.simlock");
        await filesystem.writeFileAtomic(
          configPath,
          JSON.stringify({ warmPool: { reserveRunning: { [platform]: bad } } }),
        );

        await expect(
          loadConfig({ configPath, filesystem, systemStats: createStats() }),
        ).rejects.toThrow(
          `Invalid config value for "warmPool.reserveRunning.${platform}": expected a non-negative integer`,
        );
      }
    },
  );

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
        lease: { defaultTtlMs: 123 },
      }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      overrides: {
        lease: { defaultTtlMs: 456 },
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
    expect(config.lease.defaultTtlMs).toBe(456);
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

  it("accepts a lease TTL pair at the boundary, where the default equals the cap", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { defaultTtlMs: 40_000, maxTtlMs: 40_000 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.lease).toMatchObject({ defaultTtlMs: 40_000, maxTtlMs: 40_000 });
  });

  it.each([
    [{ lease: { identity: { ios: "disposable" } } }, "lease.identity.ios"],
    [{ lease: { identity: { android: true } } }, "lease.identity.android"],
  ])(
    "rejects a lease.identity value other than reusable or fresh, naming the key (%#)",
    async (contents, path) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow(path);
    },
  );

  it("reads lease.requestRetentionMs and lease.maxRequestRecords", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { maxRequestRecords: 50, requestRetentionMs: 30_000 } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(config.lease).toMatchObject({ maxRequestRecords: 50, requestRetentionMs: 30_000 });
  });

  it.each([
    [{ lease: { requestRetentionMs: 0 } }, "lease.requestRetentionMs"],
    [{ lease: { maxRequestRecords: 1.5 } }, "lease.maxRequestRecords"],
  ])("rejects an invalid lease-request limit, naming the key (%#)", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("reads lease.identity per platform and leaves the unset platform reusable", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { identity: { ios: "fresh" } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(config.lease.identity).toEqual({ android: "reusable", ios: "fresh" });
  });

  it.each([
    [{ lease: { defaultTtlMs: 0 } }, "lease.defaultTtlMs"],
    [{ lease: { maxTtlMs: -1 } }, "lease.maxTtlMs"],
    [{ lease: { defaultTtlMs: "soon" } }, "lease.defaultTtlMs"],
  ])("rejects a non-positive lease TTL, naming the offending key (%#)", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("rejects a defaultTtlMs above maxTtlMs, naming the offending key (ADR 0004)", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { defaultTtlMs: 40_001, maxTtlMs: 40_000 } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("lease.defaultTtlMs");
  });

  it("catches the pair rule across layers, not just within one file", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { defaultTtlMs: 60_000 } }),
    );

    // The file's default is fine against the *default* cap; only the merged config is wrong.
    await expect(
      loadConfig({
        configPath,
        filesystem,
        overrides: { lease: { maxTtlMs: 30_000 } },
        systemStats: createStats(),
      }),
    ).rejects.toThrow("lease.defaultTtlMs");
  });

  it.each([["detachedTtlMs"], ["heldTtlBackstopMs"], ["heartbeatIntervalMs"]])(
    "warns about the retired lease.%s and ignores it, carrying no value over (ADR 0004)",
    async (retired) => {
      const filesystem = new MemoryFilesystem();
      const warn = vi.fn();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ lease: { [retired]: 1 } }));

      const config = await loadConfig({
        configPath,
        filesystem,
        systemStats: createStats(),
        warn,
      });

      expect(warn).toHaveBeenCalledWith(`Unknown config key: "lease.${retired}"`);
      // Not aliased onto anything: the new keys keep their own defaults.
      expect(config.lease).toEqual({
        defaultTtlMs: 15 * 60_000,
        identity: { android: "reusable", ios: "reusable" },
        maxRequestRecords: 10_000,
        maxTtlMs: 4 * 60 * 60_000,
        requestRetentionMs: 10 * 60_000,
      });
    },
  );

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

  it("applies a file-level downloads override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        downloads: { policy: "always", acceptAndroidLicenses: true, timeoutMs: 60_000 },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.downloads).toEqual({
      policy: "always",
      acceptAndroidLicenses: true,
      timeoutMs: 60_000,
    });
  });

  it("applies an override-level downloads policy over the file value", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ downloads: { policy: "never" } }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      overrides: { downloads: { policy: "always" } },
      systemStats: createStats(),
    });
    expect(config.downloads.policy).toBe("always");
  });

  it("rejects a downloads.policy outside the known set", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ downloads: { policy: "sometimes" } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("downloads.policy");
  });

  it("rejects a non-boolean downloads.acceptAndroidLicenses", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ downloads: { acceptAndroidLicenses: "yes" } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("downloads.acceptAndroidLicenses");
  });

  it.each([
    [{ downloads: { timeoutMs: 0 } }, "downloads.timeoutMs"],
    [{ downloads: { timeoutMs: -1 } }, "downloads.timeoutMs"],
    [{ downloads: { timeoutMs: "1200000" } }, "downloads.timeoutMs"],
  ])("rejects a non-positive or malformed downloads.timeoutMs", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
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

  it("defaults ios.defaultMode to full, and ios.slim to no categories and a slim boot timeout", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.ios.defaultMode).toBe("full");
    expect(config.ios.slim).toEqual({ bootTimeoutMs: 600_000 });
    expect(config.ios.slim.categories).toBeUndefined();
    expect("categories" in config.ios.slim).toBe(false);
  });

  it("applies a file-level ios.defaultMode and ios.slim override, including an explicit category list", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        ios: {
          defaultMode: "slim",
          slim: { categories: ["logging", "diagnostics"], bootTimeoutMs: 900_000 },
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.ios.defaultMode).toBe("slim");
    expect(config.ios.slim).toEqual({
      categories: ["logging", "diagnostics"],
      bootTimeoutMs: 900_000,
    });
  });

  it.each(["fast", "worker", true])(
    "rejects an ios.defaultMode of %j, naming the key",
    async (value) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultMode: value } }));

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow("ios.defaultMode");
    },
  );

  it("loads a config that still sets the removed ios.slim switch with the unknown-key warning and the full default", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ios: { slim: { enabled: true } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "ios.slim.enabled"');
    expect(config.ios.defaultMode).toBe("full");
    expect(config.ios.slim).not.toHaveProperty("enabled");
  });

  it.each([
    [{ ios: { slim: { bootTimeoutMs: 0 } } }, "ios.slim.bootTimeoutMs"],
    [{ ios: { slim: { bootTimeoutMs: -1 } } }, "ios.slim.bootTimeoutMs"],
    [{ ios: { slim: { bootTimeoutMs: "600000" } } }, "ios.slim.bootTimeoutMs"],
  ])("rejects a non-positive or malformed ios.slim.bootTimeoutMs", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it.each([
    [{ ios: { slim: { categories: "logging" } } }],
    [{ ios: { slim: { categories: [1, 2] } } }],
    [{ ios: { slim: { categories: [""] } } }],
  ])("rejects a malformed ios.slim.categories", async (contents) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("ios.slim.categories");
  });

  it("warns about an unknown key nested under ios.slim without rejecting the file", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ios: { slim: { turboMode: true } } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats(), warn }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith('Unknown config key: "ios.slim.turboMode"');
  });

  it("defaults android.emulator to a windowed launch with the emulator's GPU, audio, and boot animation", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.android.emulator).toEqual({
      audio: true,
      bootAnimation: true,
      gpu: "auto",
      headless: false,
    });
  });

  it("applies a file-level android.emulator override", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        android: {
          emulator: {
            audio: false,
            bootAnimation: false,
            gpu: "swiftshader_indirect",
            headless: true,
          },
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.android.emulator).toEqual({
      audio: false,
      bootAnimation: false,
      gpu: "swiftshader_indirect",
      headless: true,
    });
  });

  it.each([
    [
      { android: { defaultModels: {}, emulator: { headless: "yes" } } },
      "android.emulator.headless",
    ],
    [{ android: { defaultModels: {}, emulator: { audio: 0 } } }, "android.emulator.audio"],
    [
      { android: { defaultModels: {}, emulator: { bootAnimation: "false" } } },
      "android.emulator.bootAnimation",
    ],
    [{ android: { defaultModels: {}, emulator: { gpu: "" } } }, "android.emulator.gpu"],
    [{ android: { defaultModels: {}, emulator: { gpu: true } } }, "android.emulator.gpu"],
  ])("rejects a malformed android.emulator key at load, naming it", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(`Invalid config value for "${path}"`);
  });

  it("warns about and drops an unknown key under android.emulator", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        android: { defaultModels: {}, emulator: { launchArgs: ["-port", "5554"] } },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });
    expect(warn).toHaveBeenCalledWith('Unknown config key: "android.emulator.launchArgs"');
    expect(Object.keys(config.android.emulator).sort()).toEqual([
      "audio",
      "bootAnimation",
      "gpu",
      "headless",
    ]);
  });

  it.each(["ios", "android"] as const)(
    "%s.defaultModels defaults to no class having a list",
    async (platform) => {
      const config = await loadConfig({
        configPath,
        filesystem: new MemoryFilesystem(),
        systemStats: createStats(),
      });

      expect(config[platform].defaultModels).toEqual({});
    },
  );

  it.each([
    ["ios", "phone", "iPhone 15"],
    ["ios", "tablet", ["iPad (A16)", "iPad (10th generation)"]],
    ["android", "phone", "Pixel 7"],
    ["android", "tv", ["Television (4K)"]],
  ] as const)(
    "%s.defaultModels.%s accepts one model name or a list of them",
    async (platform, deviceClass, value) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(
        configPath,
        JSON.stringify({ [platform]: { defaultModels: { [deviceClass]: value } } }),
      );

      const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

      expect(config[platform].defaultModels[deviceClass]).toEqual(
        typeof value === "string" ? [value] : value,
      );
    },
  );

  it("stores a string ios.defaultModels value as a one-element list", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ios: { defaultModels: { phone: "iPhone 15" } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(config.ios.defaultModels).toStrictEqual({ phone: ["iPhone 15"] });
  });

  it.each([
    [{ phone: "" }, "ios.defaultModels.phone"],
    [{ phone: [] }, "ios.defaultModels.phone"],
    [{ phone: ["iPhone 15", ""] }, "ios.defaultModels.phone"],
    [{ phone: 15 }, "ios.defaultModels.phone"],
    [{ phone: [15] }, "ios.defaultModels.phone"],
    [{ phone: [["iPhone 15"]] }, "ios.defaultModels.phone"],
    [{ mobile: "iPhone 15" }, "ios.defaultModels.mobile"],
    [{ constructor: "iPhone 15" }, "ios.defaultModels.constructor"],
  ])("refuses ios.defaultModels %j, naming the key", async (defaultModels, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultModels } }));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(`Invalid config value for "${path}"`);
  });

  it("says what ios.defaultModels expects: a device class for a key, a name or a list of names for a value", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const load = async (defaultModels: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ ios: { defaultModels } }));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    await expect(load({ mobile: "iPhone 15" })).rejects.toThrow(
      "expected a device class (phone, tablet, watch, tv, vision, auto, desktop)",
    );
    await expect(load({ phone: [] })).rejects.toThrow(
      "expected a model name or a non-empty list of model names",
    );
  });

  it("refuses an empty android.defaultModels list and a key that is not a class, naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ android: { defaultModels: { phone: [] } } }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow('Invalid config value for "android.defaultModels.phone"');

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ android: { defaultModels: { fridge: "Pixel 8" } } }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow('Invalid config value for "android.defaultModels.fridge"');
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

  it("defaults to no driver settings at all", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.drivers).toEqual({});
  });

  it("keeps driver settings verbatim, including keys it has never heard of", async () => {
    const filesystem = new MemoryFilesystem();
    const warn = vi.fn();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        drivers: {
          ios: { deviceRoot: "/Volumes/scratch/simlock-ios" },
          android: { adbServerPort: 5038, headless: true, somethingOnlyTheDriverKnows: "yes" },
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(config.drivers).toEqual({
      ios: { deviceRoot: "/Volumes/scratch/simlock-ios" },
      android: { adbServerPort: 5038, headless: true, somethingOnlyTheDriverKnows: "yes" },
    });
    // Warning about an unrecognised key here would mean the core knows which keys a
    // driver has, which is the whole thing this block is not allowed to know.
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a driver setting at the dotted path `simlock config get` walks", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ drivers: { ios: { deviceRoot: "/Volumes/scratch/simlock-ios" } } }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(dottedValue(config, "drivers.ios.deviceRoot")).toBe("/Volumes/scratch/simlock-ios");
  });

  it("merges driver settings across layers key by key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        drivers: { ios: { deviceRoot: "/from-file" }, android: { headless: true } },
      }),
    );

    const config = await loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
      overrides: { drivers: { ios: { deviceRoot: "/from-override" } } },
    });

    expect(config.drivers).toEqual({
      ios: { deviceRoot: "/from-override" },
      android: { headless: true },
    });
  });

  it.each([
    [{ drivers: "everything" }, "drivers"],
    [{ drivers: { ios: "/Volumes/scratch" } }, "drivers.ios"],
    [{ drivers: { ios: { deviceRoot: { path: "/Volumes/scratch" } } } }, "drivers.ios.deviceRoot"],
    [{ drivers: { ios: { deviceRoot: ["/Volumes/scratch"] } } }, "drivers.ios.deviceRoot"],
  ])("rejects driver settings that are not plain scalars", async (contents, path) => {
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

  it("loads the slim sizes from capacity.config.ramBudget and from the legacy top-level ramBudget, absent by default", async () => {
    const fromCapacity = await load({
      capacity: {
        strategy: "resource",
        config: {
          ramBudget: {
            androidSlimBytesPerDevice: 2 * gibibyte,
            iosSlimBytesPerDevice: 0.75 * gibibyte,
          },
        },
      },
    });
    const fromLegacy = await load({ ramBudget: { iosSlimBytesPerDevice: 0.5 * gibibyte } });
    const byDefault = await load({});

    expect(resourceOptions(fromCapacity).ramBudget).toEqual({
      androidBytesPerDevice: 4 * gibibyte,
      androidSlimBytesPerDevice: 2 * gibibyte,
      iosBytesPerDevice: 1.5 * gibibyte,
      iosSlimBytesPerDevice: 0.75 * gibibyte,
    });
    expect(resourceOptions(fromLegacy).ramBudget.iosSlimBytesPerDevice).toBe(0.5 * gibibyte);
    expect(resourceOptions(byDefault).ramBudget).not.toHaveProperty("iosSlimBytesPerDevice");
    expect(resourceOptions(byDefault).ramBudget).not.toHaveProperty("androidSlimBytesPerDevice");
  });

  it.each([
    ["iosSlimBytesPerDevice", -1],
    ["iosSlimBytesPerDevice", "1GiB"],
    ["androidSlimBytesPerDevice", -1],
    ["androidSlimBytesPerDevice", null],
  ])("rejects a %s of %j, naming the key", async (key, value) => {
    await expect(
      load({ capacity: { strategy: "resource", config: { ramBudget: { [key]: value } } } }),
    ).rejects.toThrow(`capacity.config.ramBudget.${key}`);
    await expect(load({ ramBudget: { [key]: value } })).rejects.toThrow(`ramBudget.${key}`);
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

/**
 * ADR 0005 §1/§2: `mode` selects what the daemon is, and a gateway reads only `mode`, `http.*`,
 * `log.*`, `lease.*`, `eventBuffer.*` and `gateway.*`.
 */
describe("loadConfig modes (ADR 0005)", () => {
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

  it("defaults to worker mode, with HTTP off and a 24h disconnected-view retention", async () => {
    const config = await load({});

    expect(config.mode).toBe("worker");
    expect(config.http.enabled).toBe(false);
    expect(config.gateway).toEqual({
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free",
    });
  });

  it("rejects a mode outside the two the ADR names", async () => {
    await expect(load({ mode: "hybrid" })).rejects.toThrow("mode");
  });

  it("turns HTTP on by default in gateway mode -- a gateway is the fleet's contact point", async () => {
    const config = await load({ mode: "gateway" });

    expect(config.http.enabled).toBe(true);
    expect(config.http.port).toBe(4700);
  });

  it("refuses a gateway that switches HTTP off, naming the key, and loads a worker that does", async () => {
    await expect(load({ mode: "gateway", http: { enabled: false } })).rejects.toThrow(
      "http.enabled",
    );
    // HTTP is genuinely optional for a worker.
    await expect(load({ mode: "worker", http: { enabled: false } })).resolves.toMatchObject({
      http: { enabled: false },
      mode: "worker",
    });
  });

  it("keeps an explicit gateway http host/port", async () => {
    const config = await load({ mode: "gateway", http: { host: "0.0.0.0", port: 4800 } });

    expect(config.http).toEqual({ enabled: true, host: "0.0.0.0", port: 4800 });
  });

  it("warns about worker-only keys in a gateway's config and ignores them", async () => {
    const warn = vi.fn();
    const config = await load(
      {
        mode: "gateway",
        capacity: { strategy: "fixed", config: { maxRunning: 3 } },
        ios: { defaultMode: "slim" },
        lease: { defaultTtlMs: 60_000 },
      },
      { warn },
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "capacity"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "ios"'));
    // Ignored, not rejected: the file still loads, and the gateway-readable keys still apply.
    expect(config.lease.defaultTtlMs).toBe(60_000);
    // "Ignored" means "nothing in gateway mode reads it" -- the value is still parsed and
    // merged, so a config file can be shared between a worker and a gateway with only `mode`
    // differing. The warning is what makes that visible rather than silent.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring "lease"'));
  });

  it("raises no unknown-key warning for eventLog.rotateBytes in a gateway config", async () => {
    const warn = vi.fn();
    const config = await load({ mode: "gateway", eventLog: { rotateBytes: 1024 } }, { warn });

    expect(warn).not.toHaveBeenCalled();
    expect(config.eventLog.rotateBytes).toBe(1024);
  });

  it("warns about android.emulator on a gateway without refusing the config", async () => {
    const warn = vi.fn();
    const config = await load(
      { mode: "gateway", android: { defaultModels: {}, emulator: { headless: true } } },
      { warn },
    );

    expect(warn).toHaveBeenCalledWith(
      'Ignoring "android": it configures a worker, and this daemon runs in gateway mode.',
    );
    // Ignored, not rejected: the gateway still starts.
    expect(config.mode).toBe("gateway");
  });

  it("warns about the worker-side gateway.* keys on a gateway, but not the gateway's own", async () => {
    const warn = vi.fn();
    const config = await load({
      mode: "gateway",
      gateway: {
        url: "ws://127.0.0.1:4700/v1/uplink",
        token: "secret",
        label: "ignored",
        disconnectedRetentionMs: 60_000,
      },
    });

    expect(config.gateway.disconnectedRetentionMs).toBe(60_000);

    const warned = await load(
      { mode: "gateway", gateway: { url: "ws://127.0.0.1:4700/v1/uplink" } },
      { warn },
    );
    expect(warned.mode).toBe("gateway");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "gateway.url"'));
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring "gateway.disconnectedRetentionMs"'),
    );
  });

  it("says nothing about worker keys on a worker, which is every daemon today", async () => {
    const warn = vi.fn();
    await load({ capacity: { strategy: "fixed", config: { maxRunning: 3 } } }, { warn });

    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a worker's gateway.url/token/label", async () => {
    const config = await load({
      gateway: { url: "wss://fleet.example", token: "join-secret", label: "mac-1" },
    });

    expect(config.gateway.url).toBe("wss://fleet.example");
    expect(config.gateway.token).toBe("join-secret");
    expect(config.gateway.label).toBe("mac-1");
  });

  it("refuses a worker that names a gateway but no join token, and the reverse", async () => {
    // Either alone is an operator half-finishing a join, and a worker that silently never
    // joined looks exactly like one whose gateway is down -- so this fails the start instead.
    await expect(load({ gateway: { url: "ws://fleet.example" } })).rejects.toThrow("gateway.token");
    await expect(load({ gateway: { token: "join-secret" } })).rejects.toThrow("gateway.url");
  });

  it("does not pair those keys on a gateway, which reads neither", async () => {
    const warn = vi.fn();
    await expect(
      load({ mode: "gateway", gateway: { url: "ws://fleet.example" } }, { warn }),
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "gateway.url"'));
  });

  it.each(["http://fleet.example/v1/uplink", "fleet.example", "not a url"])(
    "rejects a gateway.url that is not a WebSocket URL: %s",
    async (url) => {
      await expect(load({ gateway: { url } })).rejects.toThrow("gateway.url");
    },
  );

  it("rejects a non-positive disconnected retention", async () => {
    await expect(load({ gateway: { disconnectedRetentionMs: 0 } })).rejects.toThrow(
      "gateway.disconnectedRetentionMs",
    );
  });

  it("rejects a non-positive lease-request timeout", async () => {
    // P2 (round 2 review): bounds the one forwarded uplink call that used to have none of its
    // own -- see FleetLeaseCoordinator#withLeaseRequestTimeout.
    await expect(load({ gateway: { leaseRequestTimeoutMs: 0 } })).rejects.toThrow(
      "gateway.leaseRequestTimeoutMs",
    );
  });

  it("defaults the gateway lease-request timeout well under the exec backstop", async () => {
    const config = await load({ mode: "gateway" });
    expect(config.gateway.leaseRequestTimeoutMs).toBeLessThan(config.gateway.execTimeoutMs);
  });

  it("lets an override name the mode, like every other key", async () => {
    const config = await load({}, { overrides: { mode: "gateway" } });

    expect(config.mode).toBe("gateway");
    expect(config.http.enabled).toBe(true);
  });
});

describe("effectiveAllowDownload", () => {
  it("grants downloads for every request under the always policy", () => {
    expect(effectiveAllowDownload("always", false)).toBe(true);
    expect(effectiveAllowDownload("always", true)).toBe(true);
  });

  it("forbids downloads for every request under the never policy, even an explicit true", () => {
    expect(effectiveAllowDownload("never", false)).toBe(false);
    expect(effectiveAllowDownload("never", true)).toBe(false);
  });

  it("defers to the request's own flag under the on-request policy", () => {
    expect(effectiveAllowDownload("on-request", false)).toBe(false);
    expect(effectiveAllowDownload("on-request", true)).toBe(true);
  });
});

describe("redactConfig", () => {
  async function load(contents: unknown): Promise<Config> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
    return loadConfig({ configPath, filesystem, systemStats: createStats() });
  }

  it("replaces a set gateway.token with the marker, keeps every other key, and leaves the input untouched", async () => {
    const config = await load({
      gateway: { label: "mac-1", token: "secret-join-token", url: "wss://gw.example:4700" },
    });

    const before = structuredClone(config);

    const redacted = redactConfig(config);

    expect(redacted).toEqual({ ...before, gateway: { ...before.gateway, token: REDACTED_VALUE } });
    expect(config).toEqual(before);
    expect(config.gateway.token).toBe("secret-join-token");
  });

  it("adds no gateway.token to a config that has none, so unset still reads as unset", async () => {
    const config = await load({});

    const redacted = redactConfig(config);

    expect(redacted).toEqual(config);
    expect(Object.keys(redacted.gateway)).not.toContain("token");
  });
});

describe("configSchema agrees with the config the daemon actually loads", () => {
  /**
   * `config.get` declares `configSchema` as its output (`contract/operations.ts`), and zod's
   * object mode strips unknown keys -- so a key this schema does not list is not a type error
   * anywhere, it simply vanishes on the way to the caller.
   *
   * Round 6 review found `gateway.leaseRequestTimeoutMs` doing exactly that: declared on
   * `Config`, validated by `loadConfig`, documented in CONFIGURATION.md as inspectable via
   * `simlock config get`, and silently dropped. Nothing referenced `configSchema` from any test,
   * so the drift was invisible in both directions.
   *
   * This compares key sets per block rather than asserting one key, so the next block that gains
   * a field fails here instead of shipping a `config get` that quietly omits it (testing rule 4:
   * a test that enforces a rule has to see everything the rule covers).
   */
  it("strips no key from any block of a freshly loaded config", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    const parsed = configSchema.parse(config);
    // `drivers` is deliberately off the wire: an open-ended
    // `Record<string, Record<string, …>>` whose contents are each driver's own business
    // (architecture rule 2), so the contract cannot declare its shape. Excluded by name and
    // asserted separately below rather than skipped silently -- it defaults to `{}`, so a
    // key-walk would otherwise "cover" it by finding nothing to lose and keep passing if it
    // ever gained something.
    const declared = dottedLeafKeys(config).filter((key) => !key.startsWith("drivers"));
    const onTheWire = new Set(dottedLeafKeys(parsed));

    expect(declared.filter((key) => !onTheWire.has(key))).toEqual([]);
    // The one intentional omission, stated as an assertion so it is a decision and not an
    // accident: if `drivers` is ever added to the wire, this fails and the filter is revisited.
    expect(Object.keys(parsed)).not.toContain("drivers");
  });

  it("carries gateway.leaseRequestTimeoutMs through to what config get answers", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    const parsed = configSchema.parse(config) as unknown as Config;
    expect(dottedValue(parsed, "gateway.leaseRequestTimeoutMs")).toBe(
      config.gateway.leaseRequestTimeoutMs,
    );
  });
});
