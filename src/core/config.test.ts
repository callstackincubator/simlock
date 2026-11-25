import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { configSchema } from "../contract/schemas.js";
import { type Config, loadConfig } from "./index.js";
import { resourceOptions, dottedValue, configPath, gibibyte, createStats } from "./test-config.js";

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

describe("loadConfig", () => {
  it("derives device limits from the injected machine capacity", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect(config.capacity.strategy).toBe("resource");
    expect(resourceOptions(config).limits.ios.maxDevices).toBe(4);
    expect(resourceOptions(config).limits.android.maxDevices).toBe(2);
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
      update: { check: true },
      devices: { autoEnroll: false, deletedRetentionMs: 60 * 60_000 },
      lease: {
        defaultTtlMs: 15 * 60_000,
        maxTtlMs: 4 * 60 * 60_000,
        identity: { ios: "reusable", android: "reusable" },
        requestRetentionMs: 600_000,
        endedIdRetentionMs: 86_400_000,
        maxRequestRecords: 10_000,
        maxPerRequester: 1,
        endWaitMs: 600_000,
      },
      capacity: {
        strategy: "resource",
        config: {
          ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 1.5 * gibibyte },
        },
      },
      log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
      eventLog: {
        retention: 7 * 24 * 60 * 60 * 1000,
        maxBytes: 256 * 1024 * 1024,
      },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
      http: { enabled: true, host: "127.0.0.1", port: 4701 },
      warmPool: {
        enabled: true,
        learn: true,
        maxConcurrentBoots: 2,
        reserveRunning: { android: 0, ios: 0 },
        targets: [],
        quarantine: {
          maxRetries: 3,
          retryBackoffMs: 30_000,
          retryBackoffMultiplier: 2,
          maxRetryBackoffMs: 5 * 60_000,
        },
      },
      stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
      ios: {
        defaultMode: "full",
        defaultModels: {},
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(resourceOptions(config).limits)).toBe(true);
    expect(configSchema.shape.eventLog.parse(config.eventLog)).toEqual(config.eventLog);
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

  it("loads a config with eventLog.rotateBytes with the unknown-key warning, and drops the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ eventLog: { rotateBytes: 1_048_576 } }),
    );
    const warn = vi.fn();

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "eventLog.rotateBytes"');
    expect(config.eventLog).toEqual({
      maxBytes: 256 * 1024 * 1024,
      retention: 7 * 24 * 60 * 60 * 1000,
    });
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

  it("accepts eventLog.maxBytes of 16 MiB and rejects one byte less, naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const sixteenMiB = 16 * 1024 * 1024;
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ eventLog: { maxBytes: sixteenMiB } }),
    );
    const accepted = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ eventLog: { maxBytes: sixteenMiB - 1 } }),
    );
    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(/"eventLog\.maxBytes".*at least 16 MiB/);

    expect(accepted.eventLog.maxBytes).toBe(sixteenMiB);
  });

  it("devices.autoEnroll defaults to false, accepts true and false, and refuses a non-boolean naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const loadWith = async (contents: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    expect((await loadWith({})).devices.autoEnroll).toBe(false);
    expect((await loadWith({ devices: { autoEnroll: true } })).devices.autoEnroll).toBe(true);
    expect((await loadWith({ devices: { autoEnroll: false } })).devices.autoEnroll).toBe(false);
    await expect(loadWith({ devices: { autoEnroll: "yes" } })).rejects.toThrow(
      'Invalid config value for "devices.autoEnroll": expected a boolean',
    );
  });

  it("devices.deletedRetentionMs defaults to 3600000, is accepted from lease.requestRetentionMs up, and a smaller value is refused naming both keys", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const loadWith = async (contents: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    const defaulted = await loadWith({});
    const written = await loadWith({ devices: { deletedRetentionMs: 7_200_000 } });
    const atTheLeaseKey = await loadWith({ devices: { deletedRetentionMs: 600_000 } });
    const bothRaised = await loadWith({
      devices: { deletedRetentionMs: 9_000_000 },
      lease: { requestRetentionMs: 8_000_000 },
    });

    expect(defaulted.devices.deletedRetentionMs).toBe(3_600_000);
    expect(written.devices.deletedRetentionMs).toBe(7_200_000);
    expect(atTheLeaseKey.devices.deletedRetentionMs).toBe(600_000);
    expect(bothRaised.devices.deletedRetentionMs).toBe(9_000_000);
    for (const contents of [
      { devices: { deletedRetentionMs: 599_999 } },
      { lease: { requestRetentionMs: 7_200_000 } },
    ]) {
      await expect(loadWith(contents)).rejects.toThrow(
        /"devices\.deletedRetentionMs".*lease\.requestRetentionMs/,
      );
    }
    await expect(loadWith({ devices: { deletedRetentionMs: 0 } })).rejects.toThrow(
      /"devices\.deletedRetentionMs"/,
    );
    // why: a gateway holds no device records, so a lease key above the hour it ignores is no refusal.
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { requestRetentionMs: 7_200_000 } }),
    );
    const gateway = await loadConfig({
      configPath,
      filesystem,
      role: "gateway",
      systemStats: createStats(),
    });
    expect(gateway.lease.requestRetentionMs).toBe(7_200_000);
  });

  it("metrics.retention defaults to the larger of 90 days and eventLog.retention, and is accepted as written", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const DAY = 24 * 60 * 60 * 1000;
    const loadWith = async (contents: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    const defaulted = await loadWith({});
    const longer = await loadWith({ eventLog: { retention: 100 * DAY } });
    const shorter = await loadWith({ eventLog: { retention: 30 * DAY } });
    const written = await loadWith({ metrics: { retention: 120 * DAY } });
    const empty = await loadWith({ eventLog: { retention: 100 * DAY }, metrics: {} });
    const mistyped = await loadWith({ metrics: { retenton: 5 } });

    expect(empty.metrics).toEqual({ retention: 100 * DAY });
    expect(mistyped.metrics).toEqual({ retention: 90 * DAY });
    expect(defaulted.metrics).toEqual({ retention: 90 * DAY });
    expect(longer.metrics).toEqual({ retention: 100 * DAY });
    expect(shorter.metrics).toEqual({ retention: 90 * DAY });
    expect(written.metrics).toEqual({ retention: 120 * DAY });
  });

  it("rejects a metrics.retention shorter than eventLog.retention, or not a positive integer, naming the key", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const DAY = 24 * 60 * 60 * 1000;
    const loadWith = async (contents: unknown) => {
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    const equal = await loadWith({
      eventLog: { retention: 7 * DAY },
      metrics: { retention: 7 * DAY },
    });
    await expect(
      loadWith({ eventLog: { retention: 7 * DAY }, metrics: { retention: 7 * DAY - 1 } }),
    ).rejects.toThrow("metrics.retention");
    for (const value of [0, -1, 1.5]) {
      await expect(loadWith({ metrics: { retention: value } })).rejects.toThrow(
        "metrics.retention",
      );
    }

    await expect(
      loadWith({ eventLog: { retention: 1 }, metrics: { retention: 1.5 } }),
    ).rejects.toThrow("metrics.retention");

    expect(equal.metrics).toEqual({ retention: 7 * DAY });
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

  it.each([
    [{ limits: { ios: { maxDevices: "many" } } }, "limits.ios.maxDevices"],
    [{ limits: { maxRunning: 0 } }, "limits.maxRunning"],
    [{ limits: { ios: { maxRunning: 1.5 } } }, "limits.ios.maxRunning"],
    [{ limits: { android: { maxRunning: "many" } } }, "limits.android.maxRunning"],
  ])("rejects an invalid limits value naming its key", async (contents, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("a loaded config parsed through configSchema keeps lease.endWaitMs", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    expect((configSchema.parse(config) as unknown as Config).lease.endWaitMs).toBe(600_000);
  });
});

describe("configSchema agrees with the config the daemon actually loads", () => {
  /** why: zod's object mode strips a key `configSchema` does not list, so a config key missing
   * from it vanishes from `config get` with no type error anywhere. */
  it("strips no key from any block of a freshly loaded config", async () => {
    const config = await loadConfig({
      configPath,
      filesystem: new MemoryFilesystem(),
      systemStats: createStats(),
    });

    const parsed = configSchema.parse(config);
    const declared = dottedLeafKeys(config);
    const onTheWire = new Set(dottedLeafKeys(parsed));

    expect(declared.filter((key) => !onTheWire.has(key))).toEqual([]);
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
