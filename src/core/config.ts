import type { Filesystem, LogLevel, SystemStats } from "../ports/index.js";

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
    readonly heartbeatIntervalMs: number;
  };
  readonly diskPressure: { readonly freeBytesThreshold: number };
  readonly eventBuffer: { readonly capacity: number };
  readonly log: { readonly level: LogLevel; readonly rotateBytes: number };
  readonly health: {
    readonly enabled: boolean;
    readonly probeIntervalMs: number;
    readonly stableObservations: number;
    readonly maxRecoveryAttempts: number;
    readonly recoveryBackoffMs: number;
    readonly maxConcurrentRecoveries: number;
  };
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

  const merged = mergeConfig(mergeConfig(defaults, fileConfig), overrideConfig);
  validateHeartbeatInterval(merged);
  return deepFreeze(merged);
}

/**
 * Cross-field check: the heartbeat cadence must be frequent enough, relative to the
 * backstop, that a few missed beats (context compaction, a slow tick) still land well
 * before the backstop deadline rather than racing it.
 */
function validateHeartbeatInterval(config: Config): void {
  if (config.lease.heartbeatIntervalMs > config.lease.heldTtlBackstopMs / 4) {
    throw invalidValue("lease.heartbeatIntervalMs", "at most lease.heldTtlBackstopMs / 4");
  }
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
      heartbeatIntervalMs: 5 * 60_000,
    },
    diskPressure: { freeBytesThreshold: 10 * GIBIBYTE },
    eventBuffer: { capacity: 1_000 },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    health: {
      enabled: true,
      probeIntervalMs: 30_000,
      stableObservations: 2,
      maxRecoveryAttempts: 3,
      recoveryBackoffMs: 5_000,
      maxConcurrentRecoveries: 1,
    },
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
    heartbeatIntervalMs: positiveInteger,
  }),
  diskPressure: objectValidator({ freeBytesThreshold: nonNegativeNumber }),
  eventBuffer: objectValidator({ capacity: positiveInteger }),
  log: objectValidator({ level: logLevel, rotateBytes: positiveInteger }),
  health: objectValidator({
    enabled: booleanValue,
    probeIntervalMs: positiveNumber,
    stableObservations: positiveInteger,
    maxRecoveryAttempts: positiveInteger,
    recoveryBackoffMs: positiveNumber,
    maxConcurrentRecoveries: positiveInteger,
  }),
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

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function logLevel(value: unknown, path: string): LogLevel {
  if (typeof value !== "string" || !LOG_LEVELS.includes(value as LogLevel)) {
    throw invalidValue(path, `one of ${LOG_LEVELS.map((level) => `"${level}"`).join(", ")}`);
  }

  return value as LogLevel;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidValue(path, "a non-negative number");
  }

  return value;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidValue(path, "a positive number");
  }

  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidValue(path, "a boolean");
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
