import { describe, expect, it } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import {
  type Config,
  effectiveAllowDownload,
  loadConfig,
  REDACTED_VALUE,
  redactConfig,
} from "./index.js";
import { configPath, createStats } from "./test-config.js";

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
  async function load(contents: unknown, role?: "gateway" | "worker"): Promise<Config> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
    return loadConfig({
      configPath,
      filesystem,
      ...(role ? { role } : {}),
      systemStats: createStats(),
    });
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

  it("masks every destination's url and secret, keeps name, format and events, and leaves its input untouched (a slack destination gets no secret key)", async () => {
    const destinations = [
      {
        name: "audit",
        format: "generic",
        url: "https://n8n.example.com/hook-token",
        events: ["worker.connected"],
        secret: "s3cr3t",
      },
      {
        name: "ops",
        format: "generic",
        url: "http://localhost:5678/x",
        events: ["worker.disconnected"],
        secret: "other",
      },
      {
        name: "chat",
        format: "slack",
        url: "https://hooks.slack.com/services/T0/B0/token",
        events: ["worker.connected"],
      },
    ];
    for (const token of ["join-token", undefined]) {
      const config = await load({ gateway: { token, alerts: { destinations } } }, "gateway");
      const before = structuredClone(config);

      const redacted = redactConfig(config);

      expect(redacted.gateway.alerts.destinations).toEqual(
        destinations.map((destination) => ({
          ...destination,
          url: REDACTED_VALUE,
          ...("secret" in destination ? { secret: REDACTED_VALUE } : {}),
        })),
      );
      expect(redacted.gateway.token).toBe(token === undefined ? undefined : REDACTED_VALUE);
      expect(config).toEqual(before);
    }
  });

  it("adds no gateway.token to a config that has none, so unset still reads as unset", async () => {
    const config = await load({});

    const redacted = redactConfig(config);

    expect(redacted).toEqual(config);
    expect(Object.keys(redacted.gateway)).not.toContain("token");
  });
});
