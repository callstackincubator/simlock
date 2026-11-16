import { describe, expect, it } from "vitest";
import { MemoryFilesystem, FakeSystemStats } from "../ports/index.js";
import { loadConfig } from "./index.js";
import { configPath, gibibyte, createStats } from "./test-config.js";

describe("loadConfig", () => {
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

  describe("warmPool.targets and warmPool.maxConcurrentBoots", () => {
    async function load(warmPool?: unknown, cpuCount = 8) {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      if (warmPool !== undefined) {
        await filesystem.writeFileAtomic(configPath, JSON.stringify({ warmPool }));
      }
      const systemStats = new FakeSystemStats({ cpuCount, totalRamBytes: 32 * gibibyte });
      return loadConfig({ configPath, filesystem, systemStats });
    }

    it("defaults to no targets and max(1, floor(cpuCount / 4)) concurrent boots, and a file value wins", async () => {
      expect((await load()).warmPool.targets).toEqual([]);
      for (const [cpuCount, boots] of [
        [2, 1],
        [6, 1],
        [8, 2],
        [10, 2],
        [12, 3],
      ] as const) {
        expect(
          (await load(undefined, cpuCount)).warmPool.maxConcurrentBoots,
          `${cpuCount} CPUs`,
        ).toBe(boots);
      }
      expect((await load({ maxConcurrentBoots: 5 }, 2)).warmPool.maxConcurrentBoots).toBe(5);
    });

    it("loads warmPool.baselineLearnAfter, 3 when unset, and rejects anything but a positive integer naming the key", async () => {
      expect((await load()).warmPool.baselineLearnAfter).toBe(3);
      expect((await load({ baselineLearnAfter: 1 })).warmPool.baselineLearnAfter).toBe(1);
      expect((await load({ baselineLearnAfter: 5 })).warmPool.baselineLearnAfter).toBe(5);
      for (const bad of [0, -1, 2.5, "3"]) {
        await expect(load({ baselineLearnAfter: bad }), `${JSON.stringify(bad)}`).rejects.toThrow(
          'Invalid config value for "warmPool.baselineLearnAfter": expected a positive integer',
        );
      }
    });

    it("loads a target with a model, an OS range, a mode and a count, and a boot cap of two", async () => {
      const config = await load({
        maxConcurrentBoots: 2,
        targets: [
          { count: 2, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
          { count: 1, mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
          { count: 3, model: "Pixel 8", platform: "android" },
        ],
      });

      expect(config.warmPool.maxConcurrentBoots).toBe(2);
      expect(config.warmPool.targets).toEqual([
        { count: 2, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
        { count: 1, mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
        { count: 3, model: "Pixel 8", platform: "android" },
      ]);
    });

    it("rejects a target that names a class naming warmPool.targets[1].class", async () => {
      await expect(
        load({
          targets: [
            { count: 1, model: "iPhone 17", platform: "ios" },
            { class: "phone", count: 1, model: "iPhone 17", platform: "ios" },
          ],
        }),
      ).rejects.toThrow("warmPool.targets[1].class");
    });

    it.each([
      [
        "a missing model",
        { count: 1, platform: "ios" },
        'Invalid config value for "warmPool.targets[0].model": expected a non-empty string',
      ],
      [
        "an empty model",
        { count: 1, model: "", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].model": expected a non-empty string',
      ],
      [
        "a missing platform",
        { count: 1, model: "iPhone 17" },
        'Invalid config value for "warmPool.targets[0].platform"',
      ],
      [
        "a count of 0",
        { count: 0, model: "iPhone 17", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].count": expected a positive integer',
      ],
      [
        "an unknown platform",
        { count: 1, model: "iPhone 17", platform: "tvos" },
        'Invalid config value for "warmPool.targets[0].platform"',
      ],
      [
        "a missing count",
        { model: "iPhone 17", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].count": expected a positive integer',
      ],
      [
        "a mode that is neither slim nor full",
        { count: 1, mode: "lean", model: "iPhone 17", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].mode"',
      ],
      [
        "an OS range that does not parse",
        { count: 1, model: "iPhone 17", osVersion: ">=", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].osVersion": expected an OS version or an OS range',
      ],
      [
        "an empty OS version",
        { count: 1, model: "iPhone 17", osVersion: "", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].osVersion": expected a non-empty string',
      ],
      [
        "a count that is not an integer",
        { count: 1.5, model: "iPhone 17", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].count": expected a positive integer',
      ],
      [
        "a class",
        { class: "phone", count: 1, model: "iPhone 17", platform: "ios" },
        'Invalid config value for "warmPool.targets[0].class": expected a known target key',
      ],
      [
        "an inherited property name as a key",
        JSON.parse('{"count":1,"model":"iPhone 17","platform":"ios","constructor":1}') as object,
        'Invalid config value for "warmPool.targets[0].constructor": expected a known target key',
      ],
      [
        "a target that is not an object",
        "iPhone 17",
        'Invalid config value for "warmPool.targets[0]": expected an object',
      ],
    ])("rejects a target with %s naming the key", async (_name, target, message) => {
      await expect(load({ targets: [target] })).rejects.toThrow(message);
    });

    it("rejects a model or an OS version longer than status.get reports, and takes one of exactly that length", async () => {
      await expect(
        load({ targets: [{ count: 1, model: "m".repeat(257), platform: "ios" }] }),
      ).rejects.toThrow(
        'Invalid config value for "warmPool.targets[0].model": expected a string of at most 256 characters',
      );
      await expect(
        load({ targets: [{ count: 1, model: "m", osVersion: "1".repeat(257), platform: "ios" }] }),
      ).rejects.toThrow('Invalid config value for "warmPool.targets[0].osVersion"');
      const config = await load({
        targets: [
          { count: 1, model: "m".repeat(256), osVersion: "1".repeat(256), platform: "ios" },
        ],
      });
      expect(config.warmPool.targets[0]?.model).toHaveLength(256);
    });

    it("rejects more targets than status.get reports, and takes exactly that many", async () => {
      const target = { count: 1, model: "iPhone 17", platform: "ios" };
      await expect(load({ targets: Array.from({ length: 257 }, () => target) })).rejects.toThrow(
        'Invalid config value for "warmPool.targets": expected an array of at most 256 targets',
      );
      const config = await load({ targets: Array.from({ length: 256 }, () => target) });
      expect(config.warmPool.targets).toHaveLength(256);
    });

    it("rejects targets that are not an array naming warmPool.targets", async () => {
      await expect(load({ targets: { count: 1 } })).rejects.toThrow(
        'Invalid config value for "warmPool.targets": expected an array of targets',
      );
    });

    it.each([0, 1.5, "2", null])(
      "rejects a maxConcurrentBoots of %j naming the key",
      async (bad) => {
        await expect(load({ maxConcurrentBoots: bad })).rejects.toThrow(
          'Invalid config value for "warmPool.maxConcurrentBoots": expected a positive integer',
        );
      },
    );
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
});
