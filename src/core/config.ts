import type { Filesystem, SystemStats } from "../ports/index.js";

const GIBIBYTE = 1024 ** 3;

const DEFAULT_CONFIG_PATH = "~/.pitlane/config.json";

export interface Config {
  readonly limits: {
    readonly maxRunning: number;
    readonly ios: { readonly maxDevices: number; readonly maxRunning: number };
    readonly android: { readonly maxDevices: number; readonly maxRunning: number };
  };
  readonly ramBudget: {
    readonly iosBytesPerDevice: number;
    readonly androidBytesPerDevice: number;
  };
  readonly idle: {
    readonly shutdownAfterMs: number;
    readonly deleteAfterMs: number;
  };
  readonly lease: {
    readonly heldTtlBackstopMs: number;
    readonly detachedTtlMs: number;
  };
  readonly diskPressure: { readonly freeBytesThreshold: number };
  readonly eventBuffer: { readonly capacity: number };
}

export type ConfigOverrides = DeepPartial<Config>;

export interface LoadConfigOptions {
  readonly filesystem: Filesystem;
  readonly systemStats: SystemStats;
  readonly configPath?: string;
  readonly overrides?: ConfigOverrides;
  readonly warn?: (message: string) => void;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadConfig({
  configPath = DEFAULT_CONFIG_PATH,
  filesystem,
  overrides,
  systemStats,
  warn = () => {},
}: LoadConfigOptions): Promise<Config> {
  const defaults = defaultConfig(systemStats);
  const fromFile = await readConfigFile(filesystem, configPath);
  const fileConfig = validateConfigLayer(fromFile, "", warn);
  const overrideConfig = validateConfigLayer(overrides ?? {}, "", warn);

  return deepFreeze(mergeConfig(mergeConfig(defaults, fileConfig), overrideConfig));
}

function defaultConfig(systemStats: SystemStats): Config {
  const cpuCount = systemStats.cpuCount();
  const totalRamGb = systemStats.totalRamBytes() / GIBIBYTE;

  const iosMaxDevices = Math.max(1, Math.floor(cpuCount / 2));
  const androidMaxDevices = Math.max(
    1,
    Math.min(Math.floor(cpuCount / 4), Math.floor(totalRamGb / 8)),
  );

  return {
    limits: {
      maxRunning: iosMaxDevices + androidMaxDevices,
      ios: { maxDevices: iosMaxDevices, maxRunning: iosMaxDevices },
      android: { maxDevices: androidMaxDevices, maxRunning: androidMaxDevices },
    },
    ramBudget: {
      iosBytesPerDevice: 1.5 * GIBIBYTE,
      androidBytesPerDevice: 4 * GIBIBYTE,
    },
    idle: {
      shutdownAfterMs: 10 * 60_000,
      deleteAfterMs: 60 * 60_000,
    },
    lease: {
      heldTtlBackstopMs: 60 * 60_000,
      detachedTtlMs: 15 * 60_000,
    },
    diskPressure: { freeBytesThreshold: 10 * GIBIBYTE },
    eventBuffer: { capacity: 1_000 },
  };
}

async function readConfigFile(filesystem: Filesystem, configPath: string): Promise<unknown> {
  if (!(await filesystem.exists(configPath))) {
    return {};
  }

  try {
    return JSON.parse(await filesystem.readFile(configPath)) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in config file: ${configPath}`);
    }

    throw error;
  }
}

function validateConfigLayer(
  value: unknown,
  path: string,
  warn: (message: string) => void,
): ConfigOverrides {
  const object = requireObject(value, path || "config");
  const result: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(object)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const validator = validators[key as keyof typeof validators];

    if (validator === undefined) {
      warn(`Unknown config key: "${childPath}"`);
      continue;
    }

    result[key] = validator(child, childPath, warn);
  }

  return result as ConfigOverrides;
}

type Validator = (value: unknown, path: string, warn: (message: string) => void) => unknown;

const validators = {
  limits: objectValidator({
    maxRunning: positiveInteger,
    ios: objectValidator({ maxDevices: positiveInteger, maxRunning: positiveInteger }),
    android: objectValidator({ maxDevices: positiveInteger, maxRunning: positiveInteger }),
  }),
  ramBudget: objectValidator({
    iosBytesPerDevice: nonNegativeNumber,
    androidBytesPerDevice: nonNegativeNumber,
  }),
  idle: objectValidator({ shutdownAfterMs: nonNegativeNumber, deleteAfterMs: nonNegativeNumber }),
  lease: objectValidator({
    heldTtlBackstopMs: nonNegativeNumber,
    detachedTtlMs: nonNegativeNumber,
  }),
  diskPressure: objectValidator({ freeBytesThreshold: nonNegativeNumber }),
  eventBuffer: objectValidator({ capacity: positiveInteger }),
} satisfies Record<string, Validator>;

function objectValidator(shape: Record<string, Validator>): Validator {
  return (value, path, warn) => {
    const object = requireObject(value, path);
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(object)) {
      const childPath = `${path}.${key}`;
      const validator = shape[key];

      if (validator === undefined) {
        warn(`Unknown config key: "${childPath}"`);
        continue;
      }

      result[key] = validator(child, childPath, warn);
    }

    return result;
  };
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidValue(path, "a positive integer");
  }

  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidValue(path, "a non-negative number");
  }

  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue(path, "an object");
  }

  return value as Record<string, unknown>;
}

function invalidValue(path: string, expected: string): ConfigError {
  return new ConfigError(`Invalid config value for "${path}": expected ${expected}`);
}

function mergeConfig<Base extends object>(base: Base, overrides: DeepPartial<Base>): Base {
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

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

type DeepPartial<Value> = Value extends object
  ? { readonly [Key in keyof Value]?: DeepPartial<Value[Key]> }
  : Value;
