import type { Config } from "./index.js";
import type { ResourceStrategyOptions } from "./capacity/index.js";
import { FakeSystemStats } from "../ports/index.js";

export function resourceOptions(config: Config): ResourceStrategyOptions {
  if (config.capacity.strategy !== "resource") throw new Error("expected the resource strategy");
  return config.capacity.config;
}

/**
 * why: The walk `simlock config get <key>` performs over the daemon's config, reproduced here
 * so a driver block is proven reachable by dotted key and not just present in the object.
 */
export function dottedValue(config: Config, key: string): unknown {
  let current: unknown = config;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export const configPath = "/home/agent/.simlock/config.json";
export const gibibyte = 1024 ** 3;

export function createStats(): FakeSystemStats {
  return new FakeSystemStats({
    cpuCount: 8,
    totalRamBytes: 32 * gibibyte,
  });
}
