import { describe, expect, it, vi } from "vitest";

import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import type { ResourceStrategyOptions } from "./capacity/index.js";
import { type Config, effectiveAllowDownload, loadConfig } from "./index.js";

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
      lease: { defaultTtlMs: 15 * 60_000, maxTtlMs: 4 * 60 * 60_000 },
      capacity: {
        strategy: "resource",
        config: {
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
        },
      },
      log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
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
      ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(resourceOptions(config).limits)).toBe(true);
  });

  it("defaults mode to worker and accepts only the two it knows", async () => {
    // ADR 0005 §1: one daemon, one mode, and it decides what the process *is* -- so it is
    // config rather than a flag, and a typo has to fail at load rather than leave a daemon
    // running as something nobody asked for.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    const defaulted = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(defaulted.mode).toBe("worker");

    // `http.enabled: true` here because a gateway with HTTP off is its own rejection --
    // see the next test -- and this one is only about the two spellings `mode` accepts.
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ http: { enabled: true }, mode: "gateway" }),
    );
    const gateway = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(gateway.mode).toBe("gateway");

    await filesystem.writeFileAtomic(configPath, JSON.stringify({ mode: "broker" }));
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("mode");
  });

  it("rejects mode: gateway with http.enabled: false at load", async () => {
    // ADR 0005 §2: a gateway is the fleet's contact point over both HTTP and its unix socket,
    // so one with HTTP off is unreachable by any worker or agent -- a config with no safe
    // reading, rejected the same way a self-contradicting lease TTL pair is (naming the key,
    // daemon does not start) rather than started and left silently useless.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");

    // The default is `http.enabled: false`, so naming only `mode` already triggers this.
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ mode: "gateway" }));
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("http.enabled");

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ http: { enabled: false }, mode: "gateway" }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("http.enabled");

    // A worker with HTTP off is unaffected: HTTP is genuinely optional for that mode.
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ http: { enabled: false }, mode: "worker" }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).resolves.toMatchObject({ http: { enabled: false }, mode: "worker" });
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
      expect(config.lease).toEqual({ defaultTtlMs: 15 * 60_000, maxTtlMs: 4 * 60 * 60_000 });
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

  it("defaults ios.slim to disabled with no categories and a slim boot timeout", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.ios.slim).toEqual({ enabled: false, bootTimeoutMs: 600_000 });
    expect(config.ios.slim.categories).toBeUndefined();
    expect("categories" in config.ios.slim).toBe(false);
  });

  it("applies a file-level ios.slim override, including an explicit category list", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({
        ios: {
          slim: { enabled: true, categories: ["logging", "diagnostics"], bootTimeoutMs: 900_000 },
        },
      }),
    );

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    expect(config.ios.slim).toEqual({
      enabled: true,
      categories: ["logging", "diagnostics"],
      bootTimeoutMs: 900_000,
    });
  });

  it("rejects a non-boolean ios.slim.enabled", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ ios: { slim: { enabled: "yes" } } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow("ios.slim.enabled");
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
