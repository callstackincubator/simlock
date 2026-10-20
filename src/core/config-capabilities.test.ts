import { describe, expect, it, vi } from "vitest";

import { configSchema } from "../contract/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { loadConfig, type Config, type ModuleConfigEntry } from "./index.js";
import { objectValidator, stringValue } from "./validation.js";

const configPath = "/home/agent/.simlock/config.json";

function entry(overrides: Partial<ModuleConfigEntry> = {}): ModuleConfigEntry {
  return {
    defaults: { greeting: "hello" },
    gatewayKeys: [],
    name: "alpha",
    validator: objectValidator({ greeting: stringValue }),
    ...overrides,
  };
}

async function load(
  contents: unknown,
  modules: readonly ModuleConfigEntry[] = [entry()],
  warnings: string[] = [],
  role: "worker" | "gateway" = "worker",
) {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/home/agent/.simlock");
  await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
  const config = await loadConfig({
    configPath,
    filesystem,
    modules,
    role,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
    warn: (message) => warnings.push(message),
  });
  return config as Config & {
    readonly capabilities: Readonly<Record<string, Record<string, unknown>>>;
  };
}

describe("loadConfig with optional modules", () => {
  it("fills a module's section from its defaults, with enabled false, when the file has none", async () => {
    const config = await load({});

    expect(config.capabilities).toEqual({ alpha: { enabled: false, greeting: "hello" } });
  });

  it('warns Unknown config key: "capabilities.nope" for a name no module has, and drops it', async () => {
    const warnings: string[] = [];

    const config = await load(
      { capabilities: { alpha: { enabled: true }, nope: {} } },
      [entry()],
      warnings,
    );

    expect(warnings).toEqual(['Unknown config key: "capabilities.nope"']);
    expect(Object.keys(config.capabilities)).toEqual(["alpha"]);
  });

  it("validates a module's section with its validator, and warns about an unknown key inside it but not about enabled", async () => {
    const warnings: string[] = [];

    const config = await load(
      { capabilities: { alpha: { enabled: true, extra: 1, greeting: "hi" } } },
      [entry()],
      warnings,
    );

    expect(warnings).toEqual(['Unknown config key: "capabilities.alpha.extra"']);
    expect(config.capabilities["alpha"]).toEqual({ enabled: true, greeting: "hi" });
    await expect(load({ capabilities: { alpha: { greeting: 3 } } })).rejects.toThrow(
      "capabilities.alpha.greeting",
    );
  });

  it("refuses a non-boolean capabilities.<name>.enabled", async () => {
    await expect(load({ capabilities: { alpha: { enabled: true } } })).resolves.toBeDefined();

    await expect(load({ capabilities: { alpha: { enabled: "yes" } } })).rejects.toThrow(
      "capabilities.alpha.enabled",
    );
  });

  it("runs a module's check against the merged config, and fails the load when it throws", async () => {
    const seen = vi.fn();
    const check = (section: { greeting: string }, config: Config) => {
      seen(config.mode);
      if (section.greeting === "bad") throw new Error("greeting is bad");
    };
    const checked = entry({ check: check as NonNullable<ModuleConfigEntry["check"]> });
    await load({ capabilities: { alpha: { greeting: "good" } } }, [checked]);

    await expect(load({ capabilities: { alpha: { greeting: "bad" } } }, [checked])).rejects.toThrow(
      "greeting is bad",
    );

    expect(seen).toHaveBeenCalledWith("worker");
  });

  it("on a gateway, reads enabled without a warning, and warns about a key outside gatewayKeys, naming capabilities.<name>.<key>", async () => {
    const contents = {
      capabilities: { alpha: { enabled: true, greeting: "hi" } },
    };
    const closed: string[] = [];
    const open: string[] = [];

    const config = await load(contents, [entry()], closed, "gateway");
    await load(contents, [entry({ gatewayKeys: ["greeting"] })], open, "gateway");

    expect(config.capabilities["alpha"]?.["enabled"]).toBe(true);
    expect(closed).toEqual([
      'Ignoring "capabilities.alpha.greeting": it configures a worker, and this daemon runs in gateway mode.',
    ]);
    expect(open).toEqual([]);
  });

  it("config.get's schema keeps capabilities with each module's section", async () => {
    const config = await load({ capabilities: { alpha: { enabled: true } } });

    const parsed = configSchema.parse(config) as unknown as { capabilities?: unknown };

    expect(parsed.capabilities).toEqual({ alpha: { enabled: true, greeting: "hello" } });
  });
});
