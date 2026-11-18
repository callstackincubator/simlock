import {
  DEFAULT_CAPACITY_STRATEGY,
  capacityStrategyNames,
  isCapacityStrategyName,
  type CapacityStrategyName,
} from "./capacity/index.js";
import type {
  Config,
  DownloadPolicy,
  DriverConfigEntry,
  Layer,
  ModuleConfigEntry,
} from "./config-types.js";
import { MIN_EVENT_LOG_MAX_BYTES } from "./config-defaults.js";
import { asObject, mergeConfig, omit, pick } from "./config-helpers.js";
import { invalidValue, requireObject, type Warn } from "./validation.js";

/**
 * why: The one consent function (ADR 0010 §4): reduces `downloads.policy` and what the caller asked
 * for to whether a download may start. A lease request passes its own `--allow-download` /
 * `allowDownload` flag; `component.install` passes `true`, because the command itself is the
 * consent. `never` overrides an explicit `true` -- the whole point of the policy is that no
 * request and no operation can opt back into it -- and `always` grants permission the request
 * never had to ask for. Only `on-request` defers to what the caller asked for.
 */
export function effectiveAllowDownload(policy: DownloadPolicy, requested: boolean): boolean {
  if (policy === "always") return true;
  if (policy === "never") return false;
  return requested;
}

/**
 * why: Cross-field check (ADR 0004's Consequences): the default TTL a request falls back to cannot
 * exceed the cap every request is measured against, or every defaulted request would be born
 * asking for more than the daemon will grant. A violating config fails the daemon start naming
 * the offending key rather than being clamped to a value the operator never wrote -- the
 * opposite treatment from a retired key, which is a leftover with a safe reading ("ignore it")
 * where a self-contradicting TTL pair has none.
 */
export function validateLeaseTtls(config: Config): void {
  if (config.lease.defaultTtlMs > config.lease.maxTtlMs) {
    throw invalidValue("lease.defaultTtlMs", "at most lease.maxTtlMs");
  }
}

export function validateDeletedRetention(config: Config): void {
  if (config.devices.deletedRetentionMs < config.lease.requestRetentionMs) {
    throw invalidValue("devices.deletedRetentionMs", "at least lease.requestRetentionMs");
  }
}

/**
 * why: ADR 0082 §1: a worker must serve the mode it gives a request that names none. A default
 * the operator wrote must be listed; one they did not write follows a one-mode list. "Wrote" is
 * read from the layers, since the merged config holds the built-in `full` either way.
 */
export function applyServedModesDefault(config: Config, layers: readonly unknown[]): Config {
  const written = layers.some(
    (layer) => asObject(asObject(layer)["ios"])["defaultMode"] !== undefined,
  );
  if (written) {
    if (!config.ios.modes.includes(config.ios.defaultMode)) {
      throw invalidValue("ios.defaultMode", "a mode ios.modes lists");
    }
    return config;
  }
  const [only] = config.ios.modes;
  return config.ios.modes.length === 1 && only !== undefined
    ? { ...config, ios: { ...config.ios, defaultMode: only } }
    : config;
}

export function validateEventLogBounds(config: Config): void {
  if (config.eventLog.maxBytes < MIN_EVENT_LOG_MAX_BYTES) {
    throw invalidValue("eventLog.maxBytes", "at least 16 MiB");
  }
}

export function validateMetricsRetention(config: Config): void {
  if (config.metrics.retention < config.eventLog.retention) {
    throw invalidValue("metrics.retention", "at least eventLog.retention");
  }
}

/**
 * why: The config keys a gateway reads (ADR 0005 §2). Everything else in a gateway's config is a
 * worker-only key: it configures drivers, devices, capacity, or cleanup, none of which a
 * gateway has. Listed here rather than derived from `Config`'s shape because the *set* is the
 * decision -- adding a key to `Config` should not silently make it gateway-relevant.
 */
const GATEWAY_CONFIG_KEYS: readonly string[] = [
  "http",
  "log",
  "lease",
  "eventBuffer",
  "eventLog",
  "metrics",
  "gateway",
  "capabilities",
  "update",
];

const WORKER_ONLY_GATEWAY_KEYS: readonly string[] = ["url", "token", "label", "headers"];

/**
 * why: ADR 0005 §2: "worker-only keys in a gateway's config are ignored with a warning, as unknown
 * keys are today". Warned per key the operator actually wrote (the file and override layers),
 * never per defaulted key -- a gateway's own defaults contain the whole worker-side `Config`
 * shape, and warning about those would fire on every start with nothing to fix.
 *
 * Ignoring rather than failing is the deliberate choice the ADR makes, and it is what lets one
 * config file be copied between a worker and a gateway while only `mode` differs.
 */
export function warnWorkerOnlyKeys(
  layers: readonly unknown[],
  warn: Warn,
  modules: readonly ModuleConfigEntry[],
): void {
  for (const layer of layers) {
    const object = requireObject(layer, "config");
    for (const key of Object.keys(object)) {
      if (!GATEWAY_CONFIG_KEYS.includes(key)) {
        warn(`Ignoring "${key}": it configures a worker, and this daemon runs in gateway mode.`);
      }
    }
    warnWorkerOnlySubKeys(
      object,
      "gateway",
      WORKER_ONLY_GATEWAY_KEYS,
      warn,
      (key) =>
        `Ignoring "gateway.${key}": it points a worker at its gateway, ` +
        `and this daemon runs in gateway mode.`,
    );
    warnWorkerOnlyModuleKeys(object, modules, warn);
  }
}

function warnWorkerOnlyModuleKeys(
  layer: Record<string, unknown>,
  modules: readonly ModuleConfigEntry[],
  warn: Warn,
): void {
  const sections = layer["capabilities"];
  if (sections === undefined) return;
  for (const [name, section] of Object.entries(requireObject(sections, "capabilities"))) {
    const entry = modules.find((candidate) => candidate.name === name);
    if (entry === undefined) continue;
    for (const key of Object.keys(requireObject(section, `capabilities.${name}`))) {
      if (key !== "enabled" && !entry.gatewayKeys.includes(key)) {
        warn(
          `Ignoring "capabilities.${name}.${key}": it configures a worker, ` +
            `and this daemon runs in gateway mode.`,
        );
      }
    }
  }
}

export function runModuleChecks(config: Config, modules: readonly ModuleConfigEntry[]): void {
  for (const entry of modules) {
    entry.check?.(config.capabilities[entry.name] as never, config);
  }
}

export function runDriverChecks(
  config: Config,
  driverSections: readonly DriverConfigEntry[],
): void {
  for (const entry of driverSections) {
    entry.check?.(config[entry.platform] as never, config);
  }
}

function warnWorkerOnlySubKeys(
  layer: Record<string, unknown>,
  section: string,
  workerOnly: readonly string[],
  warn: Warn,
  message: (key: string) => string,
): void {
  const value = layer[section];
  if (value === undefined) return;
  for (const key of Object.keys(requireObject(value, section))) {
    if (workerOnly.includes(key)) warn(message(key));
  }
}

/**
 * why: ADR 0005 §2: "a gateway always listens on HTTP (it is the fleet's contact point) and on its
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
export function requireGatewayHttp(config: Config): void {
  if (!config.http.enabled) {
    throw invalidValue("http.enabled", "true in gateway mode (a gateway is reached over HTTP)");
  }
}

/**
 * why: A worker's fleet membership, checked at load rather than at dial time so a typo fails the
 * daemon start naming the key instead of surfacing as an endless reconnect loop hours later.
 *
 * `gateway.url` is the gateway's **base** URL (`ws://host:port`); the worker derives the
 * uplink endpoint (`/v1/uplink`) from it, so nothing here inspects the path -- a URL that
 * already carries one is accepted and the endpoint is resolved against it, which is what makes
 * a reverse proxy on a sub-path work.
 *
 * The two keys are required together: a URL with no token cannot authenticate and a token with
 * no URL has nowhere to go, and either alone is an operator half-finishing a join. Failing the
 * start is right where ignoring would be wrong -- a worker that silently never joined would
 * look identical to one whose gateway is down.
 */
export function validateGatewayMembership(config: Config): void {
  const { token, url } = config.gateway;
  if (url !== undefined) requireWebSocketUrl(url);
  if (url !== undefined && token === undefined) {
    throw invalidValue("gateway.token", "a join token, since gateway.url is set");
  }
  if (token !== undefined && url === undefined) {
    throw invalidValue("gateway.url", "a gateway URL, since gateway.token is set");
  }
  const { headers } = config.gateway;
  if (url === undefined && headers !== undefined && Object.keys(headers).length > 0) {
    throw invalidValue(
      "gateway.headers",
      "gateway.url to be set too, since gateway.headers is set",
    );
  }
  requireJoinedWorkerHttpOff(config);
}

function requireWebSocketUrl(url: string): void {
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

// why: a joined worker is reached through the gateway; its own listener would be a second entrance.
function requireJoinedWorkerHttpOff(config: Config): void {
  if (config.gateway.url !== undefined && config.http.enabled) {
    throw invalidValue(
      "http.enabled",
      "false when gateway.url is set (joined workers are reached through the gateway)",
    );
  }
}

export function resolveStrategyName(layers: readonly unknown[]): CapacityStrategyName {
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

const LEGACY_RESOURCE_KEYS = ["limits", "ramBudget"] as const;

/**
 * why: Folds the legacy top-level keys into `capacity.config`. Runs per layer, before
 * merging, so precedence between layers is unaffected by which spelling each one
 * happens to use. Within a layer `capacity.config` wins.
 */
export function normalizeLayer(layer: Layer, strategy: CapacityStrategyName, warn: Warn): Layer {
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
