import type { Filesystem, LogLevel, SystemStats } from "../ports/index.js";
import {
  capacityStrategyNames,
  capacityStrategyValidator,
  DEFAULT_CAPACITY_STRATEGY,
  defaultCapacityOptions,
  isCapacityStrategyName,
  type CapacityConfig,
  type CapacityLimits,
  type CapacityStrategyName,
  type ResourceStrategyOptions,
} from "./capacity/index.js";
import { resourceOptionValidators } from "./capacity/strategies/resource/index.js";
import {
  booleanValue,
  ConfigError,
  integerInRange,
  invalidValue,
  nonNegativeNumber,
  numberAtLeast,
  objectValidator,
  positiveInteger,
  positiveNumber,
  requireObject,
  stringArray,
  stringUnion,
  stringValue,
  type Validator,
  type Warn,
} from "./validation.js";

const DEFAULT_CONFIG_PATH = "~/.simlock/config.json";

/**
 * `lease.defaultTtlMs`'s default (ADR 0004 §4): the width a request that names no `ttlMs` is
 * granted. Exported because `Registry` needs the same number to migrate a lease record written
 * before ADR 0004, which has no stored width of its own -- one definition, read from both
 * places, rather than the same fifteen minutes spelled twice.
 */
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** `lease.maxTtlMs`'s default: the largest TTL any request or renew may ask for. */
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

/** `gateway.disconnectedRetentionMs`'s default (ADR 0005 §6): 24 hours. */
const DEFAULT_DISCONNECTED_RETENTION_MS = 24 * 60 * 60_000;

/**
 * `exec.timeoutMs`'s default (ADR 0005 §19e): how long a single `device.exec` command may run
 * on this worker before it is killed and the operation fails with `EXEC_TIMEOUT`. Ten minutes,
 * because the commands this wraps are installs and boots-worth of `adb wait-for-device`, not
 * sub-second reads -- and because a stuck command holds no lease of its own, so the cost of a
 * generous bound is one process, not a device.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

/**
 * `never` forbids installs even when a request passes `--allow-download` (locked-down
 * machines/CI). `on-request` (default) preserves today's contract: install only when the
 * request itself carries the flag. `always` lets the daemon install missing components for
 * any explicit lease request without the per-request flag.
 */
export type DownloadPolicy = "never" | "on-request" | "always";

/**
 * Which shape a daemon runs as (ADR 0005 §1): a `worker` owns the devices on its machine --
 * every daemon today -- and a `gateway` owns none and fronts the workers that joined it. One
 * daemon runs exactly one mode, and it is a config value rather than a flag because it decides
 * what the process *is*, not what one invocation does.
 */
export type DaemonMode = "worker" | "gateway";

export interface Config {
  /** See `DaemonMode`. Reported on `status.get`'s daemon block, which is how a client tells
   * the two apart. Default `"worker"`. */
  readonly mode: DaemonMode;
  readonly capacity: CapacityConfig;
  /**
   * Per-driver settings, opaque to the core: stored, merged, and handed to the driver
   * that owns the key without a single key being interpreted here. What
   * `drivers.ios.deviceRoot` means is the iOS driver's business, and knowing it here
   * would be exactly the leak architecture rule 2 forbids.
   */
  readonly drivers: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>;
  readonly downloads: {
    readonly policy: DownloadPolicy;
    /** Explicit legal consent for Android SDK licenses, independent of `policy`. */
    readonly acceptAndroidLicenses: boolean;
    /** Per-install timeout; downloads run minutes, not seconds. */
    readonly timeoutMs: number;
  };
  readonly idle: {
    readonly shutdownAfterMs: number;
    readonly deleteAfterMs: number;
  };
  readonly warmPool: {
    readonly quarantine: {
      /** Failed retries allowed after the release-time purge that triggers quarantine. */
      readonly maxRetries: number;
      readonly retryBackoffMs: number;
      /** Growth factor applied to the backoff after each failed retry. */
      readonly retryBackoffMultiplier: number;
      readonly maxRetryBackoffMs: number;
    };
  };
  readonly lease: {
    /**
     * ADR 0004 §4: the TTL applied to a lease whose `lease.request` carried no `ttlMs` -- that
     * request only. It is deliberately *not* the renew fallback: a `lease.renew` given no
     * explicit TTL re-applies the lease's own stored width, so a lease granted for longer
     * keeps it.
     */
    readonly defaultTtlMs: number;
    /** The largest TTL a request or a renew may ask for; more is `BAD_REQUEST`, never a
     * silent clamp, so a caller is never left believing it has more time than it does. */
    readonly maxTtlMs: number;
  };
  /**
   * ADR 0005 §19e. Platform-agnostic on purpose: it bounds the *daemon's* willingness to wait
   * on a child, not anything either driver knows about, so it sits at the top level rather
   * than under `drivers.*`.
   */
  readonly exec: { readonly timeoutMs: number };
  readonly diskPressure: { readonly freeBytesThreshold: number };
  readonly eventBuffer: { readonly capacity: number };
  readonly log: { readonly level: LogLevel; readonly rotateBytes: number };
  readonly http: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
  };
  readonly health: {
    readonly enabled: boolean;
    readonly probeIntervalMs: number;
    readonly stableObservations: number;
    readonly maxRecoveryAttempts: number;
    readonly recoveryBackoffMs: number;
    readonly maxConcurrentRecoveries: number;
  };
  readonly ios: {
    readonly slim: {
      /** Opt-in; default false. */
      readonly enabled: boolean;
      /** Which daemon categories to disable. Undefined means "every category the driver knows". */
      readonly categories?: readonly string[];
      /** Boot deadline used while slim mode is on (slim adds a second boot; CI runners are slow). */
      readonly bootTimeoutMs: number;
    };
  };
  /**
   * ADR 0005 §3/§6. Both sides of the fleet live under one key, and which half is read depends
   * on `mode`:
   *
   * - a **worker** reads `url`, `token`, and `label` -- the two keys that join a fleet, plus a
   *   display name. Absent `url`/`token` simply means "this worker has no gateway", which is
   *   every worker today.
   * - a **gateway** reads `disconnectedRetentionMs` and ignores the other three with a
   *   warning (`loadConfig` reports every worker-only key it finds in a gateway's config).
   *
   * Kept as one block rather than `gateway.*` / `worker.*` blocks because both halves are
   * facts about the same relationship, and a `worker.gateway.url` spelling reads worse than
   * the thing it configures.
   */
  readonly gateway: {
    /** The gateway's uplink endpoint, `ws://host:port/v1/uplink` or `wss://...`. Worker-side. */
    readonly url?: string;
    /** A join token minted on the gateway with `simlock token create --role worker`.
     * Worker-side. It is a secret, and it sits in the daemon's config file like any other
     * value there: `config.get` is admin-role and returns the config as written, so this key
     * is exactly as sensitive as `config.json`'s file permissions make it. See
     * docs/CONFIGURATION.md. */
    readonly token?: string;
    /** Display-only name for this worker in the gateway's views (§3a, §13). Worker-side. */
    readonly label?: string;
    /**
     * How long a gateway keeps a disconnected worker's view before forgetting it (§6).
     * Gateway-side. Default 24 hours: long enough that a machine rebooting overnight is still
     * the same machine in the morning, short enough that a decommissioned one does not haunt
     * `simlock status` forever. A view holding leases is never dropped on this timer.
     */
    readonly disconnectedRetentionMs: number;
  };
  readonly stalledTransition: {
    /**
     * Applied to the driver's own estimate (`provision + boot` for `provisioning`,
     * `reclaim` for `reclaiming`) to get the stall threshold. Deliberately generous:
     * the estimate itself is already tuned for a routine run, so the threshold has to
     * clear real-world variance on top of it, not just match it -- a cold Android
     * provision-plus-boot can legitimately run well past the raw estimate.
     */
    readonly thresholdMultiplier: number;
    /** Floor under the multiplied estimate, for a driver whose estimate is near zero. */
    readonly minimumThresholdMs: number;
  };
}

/**
 * The pre-`capacity` spelling of the resource strategy's options. Still accepted
 * everywhere the new shape is, and folded into `capacity.config` before anything
 * downstream sees it, so existing config files keep working untouched.
 */
export interface LegacyCapacityOverrides {
  readonly limits?: DeepPartial<CapacityLimits>;
  readonly ramBudget?: DeepPartial<ResourceStrategyOptions["ramBudget"]>;
}

export type ConfigOverrides = DeepPartial<Config> & LegacyCapacityOverrides;

export interface LoadConfigOptions {
  readonly filesystem: Filesystem;
  readonly systemStats: SystemStats;
  readonly configPath?: string;
  readonly overrides?: ConfigOverrides;
  readonly warn?: Warn;
}

type Layer = Record<string, unknown>;

export async function loadConfig({
  configPath = DEFAULT_CONFIG_PATH,
  filesystem,
  overrides,
  systemStats,
  warn = () => {},
}: LoadConfigOptions): Promise<Config> {
  const fromFile = await readConfigFile(filesystem, configPath);
  const fromOverrides = overrides ?? {};

  // The strategy has to be known before anything else can be validated or
  // defaulted: it decides which options block `capacity.config` is, and which
  // defaults the merge starts from.
  const strategy = resolveStrategyName([fromFile, fromOverrides]);
  // Same reason as the strategy above: `mode` decides which keys are read at all, and what
  // `http.enabled` defaults to, so it has to be known before anything is defaulted or warned
  // about.
  const mode = resolveMode([fromFile, fromOverrides]);
  const validators = configValidators(strategy);

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

  const merged = mergeConfig(
    mergeConfig(defaultConfig(systemStats, strategy, mode), fileConfig),
    overrideConfig,
  ) as unknown as Config;
  validateLeaseTtls(merged);
  if (mode === "gateway") {
    warnWorkerOnlyKeys([fromFile, fromOverrides], warn);
    requireGatewayHttp(merged);
  }
  validateGatewayUrl(merged);
  return deepFreeze(merged);
}

/**
 * Reduces `downloads.policy` and a request's own `--allow-download` / `allow_download` flag
 * to the single permission a driver's `resolveSpec` actually sees. `never` overrides an
 * explicit `true` on the request -- the whole point of the policy is that it cannot be
 * opted back into per request -- and `always` grants permission the request never had to ask
 * for. Only `on-request` defers to what the caller asked for, which is today's behavior.
 */
export function effectiveAllowDownload(policy: DownloadPolicy, requested: boolean): boolean {
  if (policy === "always") return true;
  if (policy === "never") return false;
  return requested;
}

/**
 * Cross-field check (ADR 0004's Consequences): the default TTL a request falls back to cannot
 * exceed the cap every request is measured against, or every defaulted request would be born
 * asking for more than the daemon will grant. A violating config fails the daemon start naming
 * the offending key rather than being clamped to a value the operator never wrote -- the
 * opposite treatment from a retired key, which is a leftover with a safe reading ("ignore it")
 * where a self-contradicting TTL pair has none.
 */
function validateLeaseTtls(config: Config): void {
  if (config.lease.defaultTtlMs > config.lease.maxTtlMs) {
    throw invalidValue("lease.defaultTtlMs", "at most lease.maxTtlMs");
  }
}

/**
 * The config keys a gateway reads (ADR 0005 §2). Everything else in a gateway's config is a
 * worker-only key: it configures drivers, devices, capacity, or cleanup, none of which a
 * gateway has. Listed here rather than derived from `Config`'s shape because the *set* is the
 * decision -- adding a key to `Config` should not silently make it gateway-relevant.
 */
const GATEWAY_CONFIG_KEYS: readonly string[] = [
  "mode",
  "http",
  "log",
  "lease",
  "eventBuffer",
  "gateway",
];

/** The `gateway.*` sub-keys a *worker* reads. A gateway ignores these three (it dials nobody);
 * `disconnectedRetentionMs` is the one the gateway itself reads. */
const WORKER_ONLY_GATEWAY_KEYS: readonly string[] = ["url", "token", "label"];

/**
 * ADR 0005 §2: "worker-only keys in a gateway's config are ignored with a warning, as unknown
 * keys are today". Warned per key the operator actually wrote (the file and override layers),
 * never per defaulted key -- a gateway's own defaults contain the whole worker-side `Config`
 * shape, and warning about those would fire on every start with nothing to fix.
 *
 * Ignoring rather than failing is the deliberate choice the ADR makes, and it is what lets one
 * config file be copied between a worker and a gateway while only `mode` differs.
 */
function warnWorkerOnlyKeys(layers: readonly unknown[], warn: Warn): void {
  for (const layer of layers) {
    const object = requireObject(layer, "config");
    for (const key of Object.keys(object)) {
      if (!GATEWAY_CONFIG_KEYS.includes(key)) {
        warn(`Ignoring "${key}": it configures a worker, and this daemon runs in gateway mode.`);
      }
    }
    const gateway = object["gateway"];
    if (gateway === undefined) continue;
    for (const key of Object.keys(requireObject(gateway, "gateway"))) {
      if (WORKER_ONLY_GATEWAY_KEYS.includes(key)) {
        warn(
          `Ignoring "gateway.${key}": it points a worker at its gateway, ` +
            `and this daemon runs in gateway mode.`,
        );
      }
    }
  }
}

/**
 * ADR 0005 §2: "a gateway always listens on HTTP (it is the fleet's contact point) and on its
 * unix socket". HTTP is not optional for a gateway in a way it is for a worker: it is how
 * every agent reaches the fleet *and* the transport the worker uplink upgrades from
 * (`/v1/uplink`), so a gateway with `http.enabled: false` is a process nothing can reach and
 * no worker can join.
 *
 * The default is flipped to `true` for a gateway (see `defaultConfig`), so this only ever
 * fires for a config that says `false` out loud. That is refused rather than silently
 * overridden, on the same reasoning as `lease.defaultTtlMs > lease.maxTtlMs`: a value the
 * operator wrote and the daemon quietly inverted is worse than a start that says why.
 */
function requireGatewayHttp(config: Config): void {
  if (!config.http.enabled) {
    throw invalidValue("http.enabled", "true in gateway mode (a gateway is reached over HTTP)");
  }
}

/**
 * A worker's `gateway.url` is a WebSocket endpoint (ADR 0005 §4). Checked here rather than at
 * dial time so a typo fails the daemon start naming the key, instead of surfacing as an
 * endless reconnect loop hours later. The path is not checked -- the gateway publishes
 * `/v1/uplink`, but an operator behind a reverse proxy may legitimately be given another.
 */
function validateGatewayUrl(config: Config): void {
  const url = config.gateway.url;
  if (url === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidValue("gateway.url", "a ws:// or wss:// URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw invalidValue("gateway.url", "a ws:// or wss:// URL");
  }
}

/** Last layer that names a mode wins; absent everywhere means `worker` (ADR 0005 §1). */
function resolveMode(layers: readonly unknown[]): DaemonMode {
  let resolved: DaemonMode = "worker";
  for (const layer of layers) {
    const candidate = requireObject(layer, "config")["mode"];
    if (candidate === undefined) continue;
    if (candidate !== "worker" && candidate !== "gateway") {
      throw invalidValue("mode", 'one of "worker", "gateway"');
    }
    resolved = candidate;
  }
  return resolved;
}

/** Last layer that names a strategy wins; absent everywhere means the default. */
function resolveStrategyName(layers: readonly unknown[]): CapacityStrategyName {
  let resolved: CapacityStrategyName = DEFAULT_CAPACITY_STRATEGY;

  for (const layer of layers) {
    const capacity = requireObject(layer, "config")["capacity"];
    if (capacity === undefined) continue;

    const candidate = requireObject(capacity, "capacity")["strategy"];
    if (candidate === undefined) continue;

    if (!isCapacityStrategyName(candidate)) {
      throw invalidValue(
        "capacity.strategy",
        `one of ${capacityStrategyNames.map((name) => `"${name}"`).join(", ")}`,
      );
    }

    resolved = candidate;
  }

  return resolved;
}

/** The pre-`capacity` spelling of the resource strategy's options. */
const LEGACY_RESOURCE_KEYS = ["limits", "ramBudget"] as const;

/**
 * Folds the legacy top-level keys into `capacity.config`. Runs per layer, before
 * merging, so precedence between layers is unaffected by which spelling each one
 * happens to use. Within a layer `capacity.config` wins.
 */
function normalizeLayer(layer: Layer, strategy: CapacityStrategyName, warn: Warn): Layer {
  const legacy = pick(layer, LEGACY_RESOURCE_KEYS);
  const present = Object.keys(legacy);
  if (present.length === 0) return layer;

  const rest = omit(layer, LEGACY_RESOURCE_KEYS);
  if (strategy !== "resource") {
    warn(legacyIgnoredMessage(present, strategy));
    return rest;
  }

  const capacity = asObject(rest["capacity"]);
  return {
    ...rest,
    capacity: { ...capacity, config: mergeConfig(legacy, asObject(capacity["config"])) },
  };
}

function legacyIgnoredMessage(keys: readonly string[], strategy: CapacityStrategyName): string {
  const subject = keys.length > 1 ? "these keys configure" : "this key configures";
  return (
    `Ignoring ${keys.join(" and ")}: ${subject} the "resource" capacity strategy, ` +
    `but "${strategy}" is selected. Move the settings under "capacity.config".`
  );
}

function pick(layer: Layer, keys: readonly string[]): Layer {
  return Object.fromEntries(
    keys.filter((key) => layer[key] !== undefined).map((key) => [key, layer[key]]),
  );
}

function omit(layer: Layer, keys: readonly string[]): Layer {
  return Object.fromEntries(Object.entries(layer).filter(([key]) => !keys.includes(key)));
}

function asObject(value: unknown): Layer {
  return isObject(value) ? value : {};
}

function defaultConfig(
  systemStats: SystemStats,
  strategy: CapacityStrategyName,
  mode: DaemonMode,
): Config {
  return {
    mode,
    capacity: {
      strategy,
      config: defaultCapacityOptions(strategy, systemStats),
    } as CapacityConfig,
    drivers: {},
    downloads: {
      policy: "on-request",
      acceptAndroidLicenses: false,
      timeoutMs: 1_200_000,
    },
    idle: {
      shutdownAfterMs: 10 * 60_000,
      deleteAfterMs: 60 * 60_000,
    },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
        maxRetryBackoffMs: 5 * 60_000,
      },
    },
    lease: {
      defaultTtlMs: DEFAULT_LEASE_TTL_MS,
      maxTtlMs: DEFAULT_LEASE_MAX_TTL_MS,
    },
    exec: { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
    diskPressure: { freeBytesThreshold: 10 * 1024 ** 3 },
    eventBuffer: { capacity: 1_000 },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    // ADR 0005 §2: a gateway always listens on HTTP, so that is its default rather than
    // something every operator has to remember to switch on; a worker's HTTP gateway stays
    // opt-in exactly as before.
    http: { enabled: mode === "gateway", host: "127.0.0.1", port: 4700 },
    health: {
      enabled: true,
      probeIntervalMs: 30_000,
      stableObservations: 2,
      maxRecoveryAttempts: 3,
      recoveryBackoffMs: 5_000,
      maxConcurrentRecoveries: 1,
    },
    ios: {
      slim: {
        enabled: false,
        bootTimeoutMs: 600_000,
      },
    },
    gateway: { disconnectedRetentionMs: DEFAULT_DISCONNECTED_RETENTION_MS },
    stalledTransition: {
      thresholdMultiplier: 3,
      minimumThresholdMs: 60_000,
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

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const DAEMON_MODES: readonly DaemonMode[] = ["worker", "gateway"];
const DOWNLOAD_POLICIES: readonly DownloadPolicy[] = ["never", "on-request", "always"];

/**
 * The `capacity.config` validator is the selected strategy's own, so a strategy
 * owns its options end to end and nothing here has to know their shape.
 */
function configValidators(strategy: CapacityStrategyName): Record<string, Validator> {
  return {
    mode: stringUnion(DAEMON_MODES),
    gateway: objectValidator({
      url: stringValue,
      token: stringValue,
      label: stringValue,
      disconnectedRetentionMs: positiveNumber,
    }),
    capacity: objectValidator({
      strategy: stringUnion(capacityStrategyNames),
      config: capacityStrategyValidator(strategy),
    }),
    // Legacy spelling of the resource options; still type-checked here so a typo
    // inside them is still reported rather than silently dropped.
    ...resourceOptionValidators,
    drivers: driversValidator,
    downloads: objectValidator({
      policy: stringUnion(DOWNLOAD_POLICIES),
      acceptAndroidLicenses: booleanValue,
      timeoutMs: positiveNumber,
    }),
    idle: objectValidator({ shutdownAfterMs: nonNegativeNumber, deleteAfterMs: nonNegativeNumber }),
    warmPool: objectValidator({
      quarantine: objectValidator({
        maxRetries: positiveInteger,
        retryBackoffMs: nonNegativeNumber,
        retryBackoffMultiplier: numberAtLeast(1),
        maxRetryBackoffMs: nonNegativeNumber,
      }),
    }),
    // The three pre-ADR-0004 keys (`lease.detachedTtlMs`, `lease.heldTtlBackstopMs`,
    // `lease.heartbeatIntervalMs`) are deliberately absent rather than aliased: `objectValidator`
    // warns about each as an unrecognized key and ignores it, so an old config still boots and
    // gets the new key's default rather than the value it wrote. See docs/CONFIGURATION.md.
    lease: objectValidator({
      defaultTtlMs: positiveNumber,
      maxTtlMs: positiveNumber,
    }),
    exec: objectValidator({ timeoutMs: positiveNumber }),
    diskPressure: objectValidator({ freeBytesThreshold: nonNegativeNumber }),
    eventBuffer: objectValidator({ capacity: positiveInteger }),
    log: objectValidator({ level: stringUnion(LOG_LEVELS), rotateBytes: positiveInteger }),
    http: objectValidator({
      enabled: booleanValue,
      host: stringValue,
      port: integerInRange(1, 65535),
    }),
    health: objectValidator({
      enabled: booleanValue,
      probeIntervalMs: positiveNumber,
      stableObservations: positiveInteger,
      maxRecoveryAttempts: positiveInteger,
      recoveryBackoffMs: positiveNumber,
      maxConcurrentRecoveries: positiveInteger,
    }),
    ios: objectValidator({
      slim: objectValidator({
        enabled: booleanValue,
        categories: stringArray,
        bootTimeoutMs: positiveNumber,
      }),
    }),
    stalledTransition: objectValidator({
      thresholdMultiplier: numberAtLeast(1),
      minimumThresholdMs: nonNegativeNumber,
    }),
  };
}

/**
 * Checks the shape of `drivers` and nothing else. Every leaf is type-checked, because a
 * config file is hand-edited and a nested object or array there is a mistake worth
 * naming -- but an unrecognised key inside a driver block is deliberately *not* a
 * warning. The core does not know which keys a driver has, and warning about the ones it
 * has not heard of would be the same leak as interpreting them.
 */
const driversValidator: Validator = (value, path) => {
  const drivers = requireObject(value, path);

  return Object.fromEntries(
    Object.entries(drivers).map(([name, block]) => [
      name,
      driverSettings(block, `${path}.${name}`),
    ]),
  );
};

function driverSettings(value: unknown, path: string): Record<string, string | number | boolean> {
  const settings = requireObject(value, path);
  const result: Record<string, string | number | boolean> = {};

  for (const [key, leaf] of Object.entries(settings)) {
    if (typeof leaf !== "string" && typeof leaf !== "number" && typeof leaf !== "boolean") {
      throw invalidValue(`${path}.${key}`, "a string, number, or boolean");
    }

    result[key] = leaf;
  }

  return result;
}

function mergeConfig<Base extends object>(base: Base, overrides: object): Base {
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
