import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { loadConfig } from "./index.js";
import { configPath, createStats } from "./test-config.js";

describe("loadConfig", () => {
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

  it("an operator's lease.endedIdRetentionMs is checked at load: unset is 24 h, a positive number is read, and 0, a negative number or text are refused", async () => {
    const load = async (written: unknown) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      if (written !== undefined) {
        await filesystem.writeFileAtomic(
          configPath,
          JSON.stringify({ lease: { endedIdRetentionMs: written } }),
        );
      }
      return loadConfig({ configPath, filesystem, systemStats: createStats() });
    };

    await expect(load(undefined)).resolves.toMatchObject({
      lease: { endedIdRetentionMs: 86_400_000 },
    });
    await expect(load(5_000)).resolves.toMatchObject({ lease: { endedIdRetentionMs: 5_000 } });
    for (const refused of [0, -1, "1d"]) {
      await expect(load(refused), String(refused)).rejects.toThrow("lease.endedIdRetentionMs");
    }
  });

  it.each([
    [undefined, 1],
    [2, 2],
    [
      { ios: 1, android: 1 },
      { ios: 1, android: 1 },
    ],
    [{ ios: 2 }, { ios: 2 }],
    [{}, {}],
  ])("reads an operator's lease.maxPerRequester %j as %j (absent: 1)", async (written, read) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    if (written !== undefined) {
      await filesystem.writeFileAtomic(
        configPath,
        JSON.stringify({ lease: { maxPerRequester: written } }),
      );
    }

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(config.lease.maxPerRequester).toEqual(read);
  });

  it.each([
    [0, "lease.maxPerRequester"],
    [-1, "lease.maxPerRequester"],
    [1.5, "lease.maxPerRequester"],
    ["2", "lease.maxPerRequester"],
    [{ ios: 0 }, "lease.maxPerRequester.ios"],
    [{ ios: 1.5 }, "lease.maxPerRequester.ios"],
    [{ ios: "1" }, "lease.maxPerRequester.ios"],
  ])("rejects lease.maxPerRequester %j, naming %s", async (value, path) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { maxPerRequester: value } }),
    );

    await expect(
      loadConfig({ configPath, filesystem, systemStats: createStats() }),
    ).rejects.toThrow(path);
  });

  it("accepts a platform lease.maxPerRequester does not know, with a warning, and ignores it", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { maxPerRequester: { ios: 1, tvos: 1 } } }),
    );
    const warn = vi.fn();

    const config = await loadConfig({ configPath, filesystem, systemStats: createStats(), warn });

    expect(config.lease.maxPerRequester).toEqual({ ios: 1 });
    expect(warn).toHaveBeenCalledWith('Unknown config key: "lease.maxPerRequester.tvos"');
  });

  it("lease.endWaitMs defaults to 600000 and accepts a positive number and 2147483647", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    const unset = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    await filesystem.writeFileAtomic(configPath, JSON.stringify({ lease: { endWaitMs: 5_000 } }));
    const small = await loadConfig({ configPath, filesystem, systemStats: createStats() });
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify({ lease: { endWaitMs: 2_147_483_647 } }),
    );
    const largest = await loadConfig({ configPath, filesystem, systemStats: createStats() });

    expect(unset.lease.endWaitMs).toBe(600_000);
    expect(small.lease.endWaitMs).toBe(5_000);
    expect(largest.lease.endWaitMs).toBe(2_147_483_647);
  });

  it.each([[0], [-1], [2_147_483_648], ["600000"]])(
    "refuses lease.endWaitMs %j with a message naming the key, where 5000 loads",
    async (value) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ lease: { endWaitMs: 5_000 } }));
      const accepted = await loadConfig({ configPath, filesystem, systemStats: createStats() });
      expect(accepted.lease.endWaitMs).toBe(5_000);
      await filesystem.writeFileAtomic(configPath, JSON.stringify({ lease: { endWaitMs: value } }));

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats() }),
      ).rejects.toThrow("lease.endWaitMs");
    },
  );

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
        maxPerRequester: 1,
        endWaitMs: 600_000,
        maxRequestRecords: 10_000,
        maxTtlMs: 4 * 60 * 60_000,
        requestRetentionMs: 10 * 60_000,
        endedIdRetentionMs: 24 * 60 * 60_000,
      });
    },
  );

  it.each([
    [{ limits: { web: {} } }, "limits.web"],
    [{ health: { maxBoltCount: 7 } }, "health.maxBoltCount"],
    [{ ios: { turboMode: true } }, "ios.turboMode"],
  ])(
    "warns about an unknown key, nested or not, without rejecting the file: %j",
    async (contents, key) => {
      const filesystem = new MemoryFilesystem();
      const warn = vi.fn();
      await filesystem.mkdirp("/home/agent/.simlock");
      await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));

      await expect(
        loadConfig({ configPath, filesystem, systemStats: createStats(), warn }),
      ).resolves.toBeDefined();
      expect(warn).toHaveBeenCalledWith(`Unknown config key: "${key}"`);
    },
  );
});
