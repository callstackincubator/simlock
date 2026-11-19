import type { Layer } from "./config-types.js";

export function pick(layer: Layer, keys: readonly string[]): Layer {
  return Object.fromEntries(
    keys.filter((key) => layer[key] !== undefined).map((key) => [key, layer[key]]),
  );
}

export function omit(layer: Layer, keys: readonly string[]): Layer {
  return Object.fromEntries(Object.entries(layer).filter(([key]) => !keys.includes(key)));
}

export function asObject(value: unknown): Layer {
  return isObject(value) ? value : {};
}

export function mergeConfig<Base extends object>(base: Base, overrides: object): Base {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [key, override] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      isObject(current) && isObject(override) ? mergeConfig(current, override) : override;
  }

  return merged as Base;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
