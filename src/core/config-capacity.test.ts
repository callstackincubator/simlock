import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { loadConfig } from "./index.js";
import { resourceOptions, configPath, gibibyte, createStats } from "./test-config.js";

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
