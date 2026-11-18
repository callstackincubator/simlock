import type { Filesystem } from "../ports/index.js";
import { authStrategies as registeredAuthStrategies } from "../auth/index.js";
import type { Platform } from "./domain.js";
import { ConfigError, requireObject, type Validator, type Warn } from "./validation.js";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_METRICS_RETENTION_MS,
  defaultConfig,
} from "./config-defaults.js";
import { asObject, mergeConfig } from "./config-helpers.js";
import {
  normalizeLayer,
  requireGatewayHttp,
  resolveStrategyName,
  runDriverChecks,
  runModuleChecks,
  applyServedModesDefault,
  validateDeletedRetention,
  validateEventLogBounds,
  validateGatewayMembership,
  validateLeaseTtls,
  validateMetricsRetention,
  warnWorkerOnlyKeys,
} from "./config-role-checks.js";
import { configValidators } from "./config-validators.js";
import type {
  Config,
  ConfigLayerOptions,
  DriverConfigEntry,
  Layer,
  LoadConfigOptions,
  LoadedConfig,
} from "./config-types.js";

export {
  DEFAULT_DEVICES_DELETED_RETENTION_MS,
  DEFAULT_LEASE_ENDED_ID_RETENTION_MS,
  DEFAULT_LEASE_MAX_REQUEST_RECORDS,
  DEFAULT_LEASE_REQUEST_RETENTION_MS,
} from "./config-defaults.js";
export { configValidators } from "./config-validators.js";
export { effectiveAllowDownload } from "./config-role-checks.js";
export type {
  Config,
  ConfigOverrides,
  DaemonMode,
  DriverConfigEntry,
  LoadConfigOptions,
  MaxPerRequester,
  ModuleConfigEntry,
} from "./config-types.js";

export {
  ALERT_EVENTS,
  ALERT_FORMATS,
  type AlertDestination,
  type AlertEventName,
  type AlertFormatName,
} from "./config-alerts.js";

export const REDACTED_VALUE = "[redacted]";

// why: masked rather than deleted, so the copy keeps `Config`'s keys and a reader can tell "set" from "unset"; a copy, because the live config is what `config.get` answers and the uplink presents.
export function redactConfig<
  Shape extends {
    readonly gateway: {
      readonly token?: string | undefined;
      readonly headers?: Readonly<Record<string, string>> | undefined;
      readonly alerts: {
        readonly destinations: readonly {
          readonly url: string;
          readonly secret?: string | undefined;
        }[];
      };
    };
  },
>(config: Shape): Shape {
  const { token, headers, alerts } = config.gateway;
  if (token === undefined && headers === undefined && alerts.destinations.length === 0) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      ...(token === undefined ? {} : { token: REDACTED_VALUE }),
      ...(headers === undefined
        ? {}
        : {
            headers: Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED_VALUE])),
          }),
      alerts: {
        ...alerts,
        destinations: alerts.destinations.map((destination) => ({
          ...destination,
          url: REDACTED_VALUE,
          ...(destination.secret === undefined ? {} : { secret: REDACTED_VALUE }),
        })),
      },
    },
  } as Shape;
}

// why: typed by the entry the loader validated the section with; a config loaded without that entry holds none of its keys.
export function driverConfig<Section>(
  config: Pick<Config, Platform>,
  entry: DriverConfigEntry<Section>,
): Section {
  return config[entry.platform] as Section;
}

const MODE_KEY_REMOVED =
  '"mode" is no longer a config key. A daemon started with --gateway is a gateway; any other is a worker. Remove "mode" from config.json.';

export async function loadConfig(options: LoadConfigOptions): Promise<Config> {
  return (await loadConfigWithDefaults(options)).config;
}

export async function loadConfigWithDefaults({
  configPath = DEFAULT_CONFIG_PATH,
  filesystem,
  ...layerOptions
}: LoadConfigOptions): Promise<LoadedConfig> {
  return configFromLayers(await readConfigFile(filesystem, configPath), layerOptions);
}

export function configFromLayers(
  fromFile: unknown,
  {
    authStrategies = registeredAuthStrategies,
    driverSections = [],
    modules = [],
    overrides,
    role = "worker",
    systemStats,
    warn = () => {},
  }: ConfigLayerOptions,
): LoadedConfig {
  const fromOverrides = overrides ?? {};

  // why: The strategy has to be known before anything else can be validated or
  // defaulted: it decides which options block `capacity.config` is, and which
  // defaults the merge starts from.
  const strategy = resolveStrategyName([fromFile, fromOverrides]);
  // why: refused before any other validation, so a config that still sets `mode` fails on that alone.
  for (const layer of [fromFile, fromOverrides]) {
    if (Object.hasOwn(requireObject(layer, "config"), "mode")) {
      throw new ConfigError(MODE_KEY_REMOVED);
    }
  }
  const validators = configValidators(strategy, modules, authStrategies, driverSections);

  const fileConfig = normalizeLayer(
    validateConfigLayer(fromFile, "", warn, validators),
    strategy,
    warn,
  );
  const overrideConfig = normalizeLayer(
    validateConfigLayer(fromOverrides, "", warn, validators),
    strategy,
    warn,
  );

  const layers = [fileConfig, overrideConfig];
  const standalone =
    role === "worker" && !layers.some((layer) => asObject(layer["gateway"])["url"] !== undefined);
  const defaulted = new Set(
    modules
      .filter(
        (entry) =>
          entry.enabledByDefault === "standalone-worker" &&
          standalone &&
          !layers.some(
            (layer) =>
              asObject(asObject(layer["capabilities"])[entry.name])["enabled"] !== undefined,
          ),
      )
      .map((entry) => entry.name),
  );
  const mergedWithoutMetrics = mergeConfig(
    mergeConfig(
      defaultConfig(
        systemStats,
        strategy,
        role,
        modules,
        authStrategies,
        standalone,
        defaulted,
        driverSections,
      ),
      fileConfig,
    ),
    overrideConfig,
  ) as unknown as Omit<Config, "metrics"> & { readonly metrics?: Config["metrics"] };
  const merged: Config = {
    ...mergedWithoutMetrics,
    metrics: {
      retention:
        mergedWithoutMetrics.metrics?.retention ??
        Math.max(DEFAULT_METRICS_RETENTION_MS, mergedWithoutMetrics.eventLog.retention),
    },
  };
  validateLeaseTtls(merged);
  validateEventLogBounds(merged);
  validateMetricsRetention(merged);
  // why: a gateway reads a module's gateway keys, so a bad value stops it too.
  runModuleChecks(merged, modules);
  runDriverChecks(merged, driverSections);
  let loaded = merged;
  if (role === "gateway") {
    warnWorkerOnlyKeys([fromFile, fromOverrides], warn, modules);
    requireGatewayHttp(merged);
  } else {
    // why: Worker-side only: a gateway ignores these keys entirely (it dials nobody), so pairing
    // them there would fail a start over a value nothing reads.
    validateGatewayMembership(merged);
    // why: only a worker keeps device records, so only it reads `devices.deletedRetentionMs`.
    validateDeletedRetention(merged);
    loaded = applyServedModesDefault(merged, layers);
  }
  return { config: deepFreeze(loaded), defaulted };
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
  warn: Warn,
  validators: Record<string, Validator>,
): Layer {
  const object = requireObject(value, path || "config");
  const result: Layer = {};

  for (const [key, child] of Object.entries(object)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const validator = validators[key];

    if (validator === undefined) {
      warn(`Unknown config key: "${childPath}"`);
      continue;
    }

    result[key] = validator(child, childPath, warn);
  }

  return result;
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
