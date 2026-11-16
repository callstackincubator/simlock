import { describe, expect, it } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { loadConfig } from "./index.js";
import { configPath, createStats } from "./test-config.js";

describe("loadConfig", () => {
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
});
