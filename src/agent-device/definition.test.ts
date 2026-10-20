import { describe, expect, it, vi } from "vitest";

import { OPERATIONS } from "../contract/index.js";
import { type Config, loadConfig } from "../core/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { agentDeviceModule } from "./definition.js";

const configPath = "/home/agent/.simlock/config.json";

async function loadWith(
  contents: unknown,
  warn?: (message: string) => void,
  role?: "gateway",
): Promise<Config> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/home/agent/.simlock");
  await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
  return loadConfig({
    configPath,
    filesystem,
    modules: [{ ...agentDeviceModule.config, name: agentDeviceModule.name }],
    ...(role === undefined ? {} : { role }),
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
    ...(warn === undefined ? {} : { warn }),
  });
}

function section(config: Config): Record<string, unknown> | undefined {
  return (config.capabilities as Record<string, Record<string, unknown> | undefined>)[
    "agent-device"
  ];
}

describe("agent-device's definition: capabilities.agent-device config", () => {
  it("is named agent-device", () => {
    expect(agentDeviceModule.name).toBe("agent-device");
  });

  it("defaults capabilities.agent-device.enabled to false and command to agent-device, with leaseTtlCapMs unset", async () => {
    const config = await loadWith({});

    expect(section(config)).toEqual({ command: "agent-device", enabled: false });
  });

  it("keeps an explicit capabilities.agent-device section", async () => {
    const config = await loadWith({
      capabilities: {
        "agent-device": { command: "/opt/ad/bin/agent-device", enabled: true },
      },
    });

    expect(section(config)).toEqual({ command: "/opt/ad/bin/agent-device", enabled: true });
  });

  it.each([
    ["an empty string", ""],
    ["a number", 7],
  ])("refuses capabilities.agent-device.command as %s, naming the key", async (_case, command) => {
    await expect(
      loadWith({ capabilities: { "agent-device": { command: "agent-device" } } }),
    ).resolves.toBeDefined();

    await expect(loadWith({ capabilities: { "agent-device": { command } } })).rejects.toThrow(
      "capabilities.agent-device.command",
    );
  });

  it("accepts capabilities.agent-device.leaseTtlCapMs of 5000 and of lease.maxTtlMs", async () => {
    const lowest = await loadWith({ capabilities: { "agent-device": { leaseTtlCapMs: 5_000 } } });
    const highest = await loadWith({
      capabilities: { "agent-device": { leaseTtlCapMs: 7_200_000 } },
      lease: { maxTtlMs: 7_200_000 },
    });

    expect(section(lowest)?.["leaseTtlCapMs"]).toBe(5_000);
    expect(section(highest)?.["leaseTtlCapMs"]).toBe(7_200_000);
  });

  it.each([
    ["4999", 4_999],
    ["a fraction", 5_000.5],
  ])(
    "refuses capabilities.agent-device.leaseTtlCapMs of %s, naming the key",
    async (_case, cap) => {
      await expect(
        loadWith({ capabilities: { "agent-device": { leaseTtlCapMs: 5_000 } } }),
      ).resolves.toBeDefined();

      await expect(
        loadWith({ capabilities: { "agent-device": { leaseTtlCapMs: cap } } }),
      ).rejects.toThrow("capabilities.agent-device.leaseTtlCapMs");
    },
  );

  it("refuses capabilities.agent-device.leaseTtlCapMs above lease.maxTtlMs with `expected at most lease.maxTtlMs`", async () => {
    await expect(
      loadWith({ capabilities: { "agent-device": { leaseTtlCapMs: 14_400_000 } } }),
    ).resolves.toBeDefined();

    await expect(
      loadWith({ capabilities: { "agent-device": { leaseTtlCapMs: 14_400_001 } } }),
    ).rejects.toThrow(
      'Invalid config value for "capabilities.agent-device.leaseTtlCapMs": expected at most lease.maxTtlMs',
    );
  });

  it("a loaded config parsed through configSchema keeps the section", async () => {
    const config = await loadWith({
      capabilities: { "agent-device": { command: "ad", enabled: true } },
    });

    const parsed = OPERATIONS["config.get"].output.parse(config) as unknown as Config;
    expect(section(parsed)).toMatchObject({ command: "ad", enabled: true });
    expect(parsed).not.toHaveProperty("agentDevice");
  });

  it("on a gateway, reads enabled and leaseTtlCapMs without a warning, and warns that it ignores command with the generic text", async () => {
    const warn = vi.fn();

    const config = await loadWith(
      {
        capabilities: { "agent-device": { enabled: true, leaseTtlCapMs: 10_000 } },
      },
      warn,
      "gateway",
    );
    expect(section(config)).toMatchObject({ enabled: true, leaseTtlCapMs: 10_000 });
    expect(warn).not.toHaveBeenCalled();

    await loadWith({ capabilities: { "agent-device": { command: "elsewhere" } } }, warn, "gateway");
    expect(warn).toHaveBeenCalledWith(
      'Ignoring "capabilities.agent-device.command": it configures a worker, and this daemon runs in gateway mode.',
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring "capabilities.agent-device"'),
    );
  });

  it("refuses the old top-level agentDevice key as unknown, and leaves agent-device off", async () => {
    const warn = vi.fn();

    const config = await loadWith({ agentDevice: { enabled: true } }, warn);

    expect(warn).toHaveBeenCalledWith('Unknown config key: "agentDevice"');
    expect(section(config)?.["enabled"]).toBe(false);
  });
});
