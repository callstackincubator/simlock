import type { ZodType } from "zod";

import type { Filesystem, LogLevel, SystemStats } from "../ports/index.js";
import {
  authStrategies as registeredAuthStrategies,
  type AuthStrategyDefinition,
} from "../auth/index.js";
import {
  capacityStrategyNames,
  capacityStrategyValidator,
  DEFAULT_CAPACITY_STRATEGY,
  defaultCapacityOptions,
  isCapacityStrategyName,
  resourceOptionValidators,
  type CapacityConfig,
  type CapacityLimits,
  type CapacityStrategyName,
  type ResourceStrategyOptions,
} from "./capacity/index.js";
import { DEVICE_CLASSES, type DeviceClass, type DeviceMode, type LeaseIdentity } from "./domain.js";
import {
  booleanValue,
  ConfigError,
  integerInRange,
  invalidValue,
  nonEmptyString,
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
import {
  defaultWarmPoolConfig,
  warmPoolConfigValidator,
  type WarmPoolConfig,
} from "./warm-pool/index.js";

const DEFAULT_CONFIG_PATH = "~/.simlock/config.json";

const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** `lease.maxTtlMs`'s default: the largest TTL any request or renew may ask for. */
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

/** `lease.requestRetentionMs`'s default: how long a settled lease request still answers a replay. */
export const DEFAULT_LEASE_REQUEST_RETENTION_MS = 10 * 60_000;

const DEFAULT_LEASE_MAX_PER_REQUESTER = 1;

/** `lease.maxRequestRecords`'s default: the most lease-request records the daemon keeps. */
export const DEFAULT_LEASE_MAX_REQUEST_RECORDS = 10_000;

/** `gateway.disconnectedRetentionMs`'s default (ADR 0005 §6): 24 hours. */
const DEFAULT_DISCONNECTED_RETENTION_MS = 24 * 60 * 60_000;

/** `gateway.execTimeoutMs`'s default (ADR 0005 §19e): eleven minutes, one more than the
 * worker's authoritative ten, so the worker's timeout is the one that fires. */
const DEFAULT_GATEWAY_EXEC_TIMEOUT_MS = 11 * 60_000;

/** `gateway.leaseRequestTimeoutMs`'s default (P2, round 2 review): five minutes -- generous
 * against a cold device provision-plus-boot, and well short of `execTimeoutMs`, since granting a
 * lease should never take as long as a command a caller runs against the device afterward. */
const DEFAULT_LEASE_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * `gateway.routing`'s valid names (ADR 0005 §13/Decision 7) and its default. Declared here
 * rather than imported from `src/gateway/routing.ts`'s own registry: `core` stays
 * platform-agnostic and gateway-unaware (`AGENTS.md`/`architecture.md`), so this list is
 * re-declared the same way `src/contract/schemas.ts` re-declares it independently rather than
 * importing across its own boundary -- three places name `"warm-then-free"`, the same
 * redundancy `capacity.strategy`'s "fixed"/"resource" already carries between `core` and the
 * contract. Adding a second policy means adding it here, in the gateway's own registry, and in
 * the contract schema -- one line each, never a shared import.
 */
const ROUTING_POLICIES = ["warm-then-free"] as const;
const DEFAULT_ROUTING_POLICY = "warm-then-free";

/** The literal union `ROUTING_POLICIES` names -- `Config["gateway"]["routing"]`'s type, so it
 * agrees with the contract's own `z.enum(["warm-then-free"])` (also re-declared, never
 * imported) instead of widening to a bare `string` the boundary between the two would otherwise
 * force. */
type RoutingPolicyName = (typeof ROUTING_POLICIES)[number];

export const ALERT_EVENTS = [
  "worker.connected",
  "worker.disconnected",
  "worker.rejected",
  "worker.drain-started",
  "worker.drain-ended",
  "device.quarantine-abandoned",
  "device.quarantine-stranded",
  "device.recovery-failed",
  "device.stalled-transition-detected",
  "disk.pressure-detected",
  "component.install-failed",
] as const;
export type AlertEventName = (typeof ALERT_EVENTS)[number];

/**
 * why: re-declared in the contract's `configSchema`, which imports nothing from core; a test checks the two agree.
 */
export const ALERT_FORMATS = ["generic", "slack"] as const;
export type AlertFormatName = (typeof ALERT_FORMATS)[number];

/** why: checked at config load, which cannot import the alerts module. */
const ALERT_FORMAT_SECRET: Record<AlertFormatName, "required" | "refused"> = {
  generic: "required",
  slack: "refused",
};

export interface AlertDestination {
  readonly name: string;
  readonly format: AlertFormatName;
  readonly url: string;
  readonly events: readonly AlertEventName[];
  readonly secret?: string;
}

const MAX_ALERT_DESTINATIONS = 16;
const ALERT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ALERT_LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const ALERT_URL_EXPECTED =
  "an https:// URL, or an http:// URL to localhost, 127.0.0.1 or [::1], with no user name or password";

function isAlertUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ALERT_LOCAL_HOSTS.includes(url.hostname);
}

const ALERT_KEYS = ["name", "format", "url", "events", "secret"];

function checkAlertName(name: unknown, path: string, names: Set<string>): string {
  if (typeof name !== "string" || !ALERT_NAME_PATTERN.test(name)) {
    throw invalidValue(
      `${path}.name`,
      "a name of lowercase letters, digits and dashes that starts with a letter, at most 32 characters",
    );
  }
  if (names.has(name)) throw invalidValue(`${path}.name`, "a name no other destination uses");
  return name;
}

function checkAlertEvents(events: unknown, path: string): AlertEventName[] {
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    new Set(events).size !== events.length ||
    !events.every((event) => (ALERT_EVENTS as readonly unknown[]).includes(event))
  ) {
    throw invalidValue(
      `${path}.events`,
      `a non-empty list of alert events, each once: ${ALERT_EVENTS.join(", ")}`,
    );
  }
  return events as AlertEventName[];
}

function checkAlertSecret(
  format: AlertFormatName,
  entry: Record<string, unknown>,
  path: string,
): string | undefined {
  const { secret } = entry;
  if (ALERT_FORMAT_SECRET[format] === "refused") {
    if ("secret" in entry) {
      throw invalidValue(`${path}.secret`, `no secret: a ${format} destination is not signed`);
    }
    return undefined;
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw invalidValue(`${path}.secret`, `a non-empty secret for a ${format} destination`);
  }
  return secret;
}

function alertDestinationValidator(
  names: Set<string>,
): (value: unknown, path: string, warn: Warn) => AlertDestination {
  return (value, path, warn) => {
    const entry = requireObject(value, path);
    for (const key of Object.keys(entry)) {
      if (!ALERT_KEYS.includes(key)) warn(`Unknown config key: "${path}.${key}"`);
    }
    // why: the fields are checked in this order, so a destination with several bad ones reports the first.
    const name = checkAlertName(entry.name, path, names);
    const format = stringUnion(ALERT_FORMATS)(entry.format, `${path}.format`);
    if (!isAlertUrl(entry.url)) throw invalidValue(`${path}.url`, ALERT_URL_EXPECTED);
    const events = checkAlertEvents(entry.events, path);
    const secret = checkAlertSecret(format, entry, path);
    names.add(name);
    return {
      name,
      format,
      url: entry.url,
      events,
      ...(secret === undefined ? {} : { secret }),
    };
  };
}

function alertDestinationsValidator(value: unknown, path: string, warn: Warn): AlertDestination[] {
  if (!Array.isArray(value) || value.length > MAX_ALERT_DESTINATIONS) {
    throw invalidValue(path, `a list of at most ${MAX_ALERT_DESTINATIONS} destinations`);
  }
  const validate = alertDestinationValidator(new Set());
  return value.map((entry, index) => validate(entry, `${path}[${index}]`, warn));
}

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
 * why: which shape a daemon runs as (ADR 0005 §1): a `worker` owns the devices on its machine and a
 * `gateway` owns none and fronts the workers that joined it. One daemon runs exactly one mode,
 * and the folder it lives in decides it (ADR 0034): the daemon is told its role at start, and
 * `loadConfig` takes it as an argument -- no config key names it.
 */
export type DaemonMode = "worker" | "gateway";

export interface Config {
  readonly capabilities: Readonly<
    Record<string, { readonly enabled: boolean } & Readonly<Record<string, unknown>>>
  >;
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
    /**
     * One budget per install request, from its arrival, covering the wait behind another
     * download and the download itself (ADR 0010 §3); downloads run minutes, not seconds.
     */
    readonly timeoutMs: number;
  };
  readonly idle: {
    readonly shutdownAfterMs: number;
    readonly deleteAfterMs: number;
  };
  readonly update: {
    readonly check: boolean;
  };
  readonly warmPool: WarmPoolConfig & {
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
    /**
     * The lease-identity policy per platform (see `LeaseIdentity`), read by key for a new
     * device's own platform when it is registered. Daemon configuration only: no lease request
     * can change it, and a device keeps the value it was created under after this changes.
     */
    readonly identity: {
      readonly ios: LeaseIdentity;
      readonly android: LeaseIdentity;
    };
    /**
     * How long a settled lease request stays stored, counted from when it settled. Within this
     * window a repeat of the request returns the stored result; after it, the record is pruned
     * and the same key starts a new request.
     */
    readonly requestRetentionMs: number;
    /**
     * The most lease-request records kept at once. Reaching it evicts the oldest settled record;
     * an open record is never evicted.
     */
    readonly maxRequestRecords: number;
    readonly maxPerRequester: number;
    readonly endWaitMs: number;
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
  readonly eventLog: {
    readonly retention: number;
    readonly maxBytes: number;
  };
  readonly metrics: { readonly retention: number };
  readonly http: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly proxyAuth?: {
      readonly header: string;
      readonly jwksUrl: string;
      readonly issuer: string;
      readonly audience: string;
      readonly signOutUrl?: string;
    };
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
    /**
     * The device mode a lease request that names none gets on this worker (ADR 0007 §1).
     * Default `"full"`. Every worker makes both kinds of device whatever this says.
     */
    readonly defaultMode: DeviceMode;
    /** The operator's own preference list per class, ahead of the driver's built-in one. */
    readonly defaultModels: DefaultModels;
    /** How a slim device is made, whatever the default mode is. */
    readonly slim: {
      /** Which daemon categories to disable. Undefined means "every category the driver knows". */
      readonly categories?: readonly string[];
      /** Boot deadline for a slim device (slim adds a second boot; CI runners are slow). */
      readonly bootTimeoutMs: number;
    };
  };
  /**
   * How this machine's Android emulators are launched. Operator configuration of the Android
   * driver, the same way `ios.slim` configures the iOS one: the core validates each value's
   * type and hands the block to the driver without interpreting it, and no lease request can
   * set it. Which emulator flag a key becomes is the driver's business. Applies at a device's
   * next boot.
   */
  readonly android: {
    /** The operator's own preference list per class, ahead of the driver's built-in one. */
    readonly defaultModels: DefaultModels;
    readonly emulator: {
      readonly headless: boolean;
      /** An emulator GPU mode; `"auto"` leaves the emulator's own default. */
      readonly gpu: string;
      readonly audio: boolean;
      readonly bootAnimation: boolean;
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
    /** why: A join token minted on the gateway with `simlock token create --role worker`.
     * Worker-side. It is a secret, and it sits in the daemon's config file like any other
     * value there: `config.get` is admin-role and returns the config as written, so this key
     * is exactly as sensitive as `config.json`'s file permissions make it. `simlock config
     * set` writes that file owner-only (0600) every time; a file written by hand, or before
     * that, keeps whatever mode it has until the next `config set`. Everywhere else the
     * config is written out -- the startup log line, `daemon.started` -- goes through
     * `redactConfig`. */
    readonly token?: string;
    /** Display-only name for this worker in the gateway's views (§3a, §13). Worker-side. */
    readonly label?: string;
    /**
     * How long a gateway keeps a disconnected worker's view before forgetting it (§6).
     * Gateway-side. Default 24 hours: long enough that a machine rebooting overnight is still
     * the same machine in the morning, short enough that a decommissioned one does not haunt
     * `simlock status` forever. A view whose leases have not all expired is never dropped on
     * this timer, however long it has been gone.
     */
    readonly disconnectedRetentionMs: number;
    /**
     * Gateway-side backstop on a proxied `device.exec` (ADR 0005 §19e). Deliberately longer
     * than the worker's own `exec.timeoutMs` (ten minutes): the worker's is authoritative and
     * should be what kills a runaway command, so a gateway that timed out first would report
     * a failure for a command still running on the machine that owns the device. Read by #118,
     * which is what proxies `device.exec`; declared now so the key does not appear mid-series.
     */
    readonly execTimeoutMs: number;
    /**
     * P2 (round 2 review): bounds a forwarded `lease.request` -- the one uplink call that used
     * to have no timeout of its own, parking a waiter `processing` where neither `timeoutMs`'s
     * deadline check nor `lease.cancel` could reach it (`WaitQueue#armTimeout` declines to
     * reject a `processing` waiter, and `cancelPending` answers `not-cancellable`) if the
     * worker's own `lease.request` handler ever wedged. Generous relative to how long granting a
     * lease can plausibly take -- provisioning plus a cold device boot -- and bounded well below
     * `execTimeoutMs`, since granting a lease should never take as long as an arbitrary command
     * a caller runs afterward might. Expiry maps to `WORKER_UNREACHABLE`, returning the waiter
     * to a state `enqueue`'s deadline check and `cancelPending` can both act on again.
     */
    readonly leaseRequestTimeoutMs: number;
    /**
     * ADR 0005 §13/Decision 7: which routing policy dispatch uses. Gateway-side, read once at
     * daemon start -- routing is "a pure function over worker views, a module with one entry
     * point selected by `gateway.routing`, the same shape as `CapacityStrategy`", never a
     * per-request choice. `"warm-then-free"` is the only value in v1 (`ROUTING_POLICIES` above).
     */
    readonly routing: RoutingPolicyName;
    readonly alerts: { readonly destinations: readonly AlertDestination[] };
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

/** What `redactConfig` puts in place of a secret's value. */
export const REDACTED_VALUE = "[redacted]";

// why: masked rather than deleted, so the copy keeps `Config`'s keys and a reader can tell "set" from "unset"; a copy, because the live config is what `config.get` answers and the uplink presents.
export function redactConfig(config: Config): Config {
  const { token, alerts } = config.gateway;
  if (token === undefined && alerts.destinations.length === 0) return config;
  return {
    ...config,
    gateway: {
      ...config.gateway,
      ...(token === undefined ? {} : { token: REDACTED_VALUE }),
      alerts: {
        ...alerts,
        destinations: alerts.destinations.map((destination) => ({
          ...destination,
          url: REDACTED_VALUE,
          ...(destination.secret === undefined ? {} : { secret: REDACTED_VALUE }),
        })),
      },
    },
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

export interface ModuleConfigEntry {
  readonly name: string;
  readonly validator: Validator;
  readonly defaults: unknown;
  readonly gatewayKeys: readonly string[];
  readonly enabledByDefault?: "standalone-worker";
  readonly check?: (section: never, config: Config) => void;
}

const MODE_KEY_REMOVED =
  '"mode" is no longer a config key. A daemon started with --gateway is a gateway; any other is a worker. Remove "mode" from config.json.';

export interface LoadConfigOptions {
  readonly authStrategies?: readonly AuthStrategyDefinition[];
  readonly modules?: readonly ModuleConfigEntry[];
  readonly filesystem: Filesystem;
  readonly systemStats: SystemStats;
  readonly configPath?: string;
  readonly overrides?: ConfigOverrides;
  readonly role?: DaemonMode;
  readonly warn?: Warn;
}

type Layer = Record<string, unknown>;

export async function loadConfig(options: LoadConfigOptions): Promise<Config> {
  return (await loadConfigWithDefaults(options)).config;
}

export async function loadConfigWithDefaults({
  authStrategies = registeredAuthStrategies,
  configPath = DEFAULT_CONFIG_PATH,
  filesystem,
  modules = [],
  overrides,
  role = "worker",
  systemStats,
  warn = () => {},
}: LoadConfigOptions): Promise<{
  readonly config: Config;
  readonly defaulted: ReadonlySet<string>;
}> {
  const fromFile = await readConfigFile(filesystem, configPath);
  const fromOverrides = overrides ?? {};

  // The strategy has to be known before anything else can be validated or
  // defaulted: it decides which options block `capacity.config` is, and which
  // defaults the merge starts from.
  const strategy = resolveStrategyName([fromFile, fromOverrides]);
  // why: refused before any other validation, so a config that still sets `mode` fails on that alone.
  for (const layer of [fromFile, fromOverrides]) {
    if (Object.hasOwn(requireObject(layer, "config"), "mode")) {
      throw new ConfigError(MODE_KEY_REMOVED);
    }
  }
  const validators = configValidators(strategy, modules, authStrategies);

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
      defaultConfig(systemStats, strategy, role, modules, authStrategies, standalone, defaulted),
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
  if (role === "gateway") {
    warnWorkerOnlyKeys([fromFile, fromOverrides], warn, modules);
    requireGatewayHttp(merged);
  } else {
    // Worker-side only: a gateway ignores these keys entirely (it dials nobody), so pairing
    // them there would fail a start over a value nothing reads.
    validateGatewayMembership(merged);
  }
  return { config: deepFreeze(merged), defaulted };
}

/**
 * The one consent function (ADR 0010 §4): reduces `downloads.policy` and what the caller asked
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

const DEFAULT_METRICS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const MIN_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;

function validateEventLogBounds(config: Config): void {
  if (config.eventLog.maxBytes < MIN_EVENT_LOG_MAX_BYTES) {
    throw invalidValue("eventLog.maxBytes", "at least 16 MiB");
  }
}

function validateMetricsRetention(config: Config): void {
  if (config.metrics.retention < config.eventLog.retention) {
    throw invalidValue("metrics.retention", "at least eventLog.retention");
  }
}

/**
 * The config keys a gateway reads (ADR 0005 §2). Everything else in a gateway's config is a
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

/** The `gateway.*` sub-keys a *worker* reads. A gateway ignores these three (it dials nobody);
 * `disconnectedRetentionMs`, `execTimeoutMs`, and `leaseRequestTimeoutMs` are the ones the
 * gateway itself reads. */
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
function warnWorkerOnlyKeys(
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

function runModuleChecks(config: Config, modules: readonly ModuleConfigEntry[]): void {
  for (const entry of modules) {
    entry.check?.(config.capabilities[entry.name] as never, config);
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
 * A worker's fleet membership, checked at load rather than at dial time so a typo fails the
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
function validateGatewayMembership(config: Config): void {
  const { token, url } = config.gateway;
  if (url !== undefined) requireWebSocketUrl(url);
  if (url !== undefined && token === undefined) {
    throw invalidValue("gateway.token", "a join token, since gateway.url is set");
  }
  if (token !== undefined && url === undefined) {
    throw invalidValue("gateway.url", "a gateway URL, since gateway.token is set");
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
  role: DaemonMode,
  modules: readonly ModuleConfigEntry[],
  authStrategies: readonly AuthStrategyDefinition[],
  standalone: boolean,
  defaulted: ReadonlySet<string>,
): Omit<Config, "metrics"> {
  return {
    mode: role,
    capabilities: Object.fromEntries(
      modules.map((entry) => [
        entry.name,
        { ...(entry.defaults as Record<string, unknown>), enabled: defaulted.has(entry.name) },
      ]),
    ) as Config["capabilities"],
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
    update: { check: true },
    warmPool: {
      ...defaultWarmPoolConfig(systemStats),
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
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: DEFAULT_LEASE_REQUEST_RETENTION_MS,
      maxRequestRecords: DEFAULT_LEASE_MAX_REQUEST_RECORDS,
      maxPerRequester: DEFAULT_LEASE_MAX_PER_REQUESTER,
      endWaitMs: DEFAULT_EXEC_TIMEOUT_MS,
    },
    exec: { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
    diskPressure: { freeBytesThreshold: 10 * 1024 ** 3 },
    eventBuffer: { capacity: 1_000 },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    // why: ADR 0005 §2 and ADR 0046 §1: a gateway and a standalone worker listen on HTTP by default; a joined worker is reached through its gateway, so its default is off.
    http: {
      enabled: role === "gateway" || standalone,
      host: "127.0.0.1",
      port: role === "gateway" ? 4700 : 4701,
      ...Object.fromEntries(
        authStrategies.flatMap((definition) =>
          definition.config === undefined
            ? []
            : [[definition.config.key, definition.config.defaults]],
        ),
      ),
    },
    health: {
      enabled: true,
      probeIntervalMs: 30_000,
      stableObservations: 2,
      maxRecoveryAttempts: 3,
      recoveryBackoffMs: 5_000,
      maxConcurrentRecoveries: 1,
    },
    ios: {
      defaultMode: "full",
      defaultModels: {},
      slim: {
        bootTimeoutMs: 600_000,
      },
    },
    android: {
      defaultModels: {},
      emulator: {
        headless: false,
        gpu: "auto",
        audio: true,
        bootAnimation: true,
      },
    },
    gateway: {
      disconnectedRetentionMs: DEFAULT_DISCONNECTED_RETENTION_MS,
      execTimeoutMs: DEFAULT_GATEWAY_EXEC_TIMEOUT_MS,
      leaseRequestTimeoutMs: DEFAULT_LEASE_REQUEST_TIMEOUT_MS,
      routing: DEFAULT_ROUTING_POLICY,
      alerts: { destinations: [] },
    },
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
const DOWNLOAD_POLICIES: readonly DownloadPolicy[] = ["never", "on-request", "always"];
const LEASE_IDENTITIES: readonly LeaseIdentity[] = ["reusable", "fresh"];

/**
 * The `capacity.config` validator is the selected strategy's own, so a strategy
 * owns its options end to end and nothing here has to know their shape.
 */
function configValidators(
  strategy: CapacityStrategyName,
  modules: readonly ModuleConfigEntry[],
  authStrategies: readonly AuthStrategyDefinition[],
): Record<string, Validator> {
  return {
    capabilities: capabilitiesValidator(modules),
    gateway: objectValidator({
      url: stringValue,
      token: stringValue,
      label: stringValue,
      disconnectedRetentionMs: positiveNumber,
      execTimeoutMs: positiveNumber,
      leaseRequestTimeoutMs: positiveNumber,
      routing: stringUnion(ROUTING_POLICIES),
      alerts: objectValidator({ destinations: alertDestinationsValidator }),
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
    update: objectValidator({ check: booleanValue }),
    warmPool: objectValidator({
      ...warmPoolConfigValidator,
      quarantine: objectValidator({
        maxRetries: positiveInteger,
        retryBackoffMs: nonNegativeNumber,
        retryBackoffMultiplier: numberAtLeast(1),
        maxRetryBackoffMs: nonNegativeNumber,
      }),
    }),
    // why: The three pre-ADR-0004 keys (`lease.detachedTtlMs`, `lease.heldTtlBackstopMs`,
    // `lease.heartbeatIntervalMs`) are deliberately absent rather than aliased: `objectValidator`
    // warns about each as an unrecognized key and ignores it, so an old config still boots and
    // gets the new key's default rather than the value it wrote.
    lease: objectValidator({
      defaultTtlMs: positiveNumber,
      maxTtlMs: positiveNumber,
      identity: objectValidator({
        ios: stringUnion(LEASE_IDENTITIES),
        android: stringUnion(LEASE_IDENTITIES),
      }),
      requestRetentionMs: positiveNumber,
      maxRequestRecords: positiveInteger,
      maxPerRequester: positiveInteger,
      endWaitMs: endWaitValidator,
    }),
    exec: objectValidator({ timeoutMs: positiveNumber }),
    diskPressure: objectValidator({ freeBytesThreshold: nonNegativeNumber }),
    eventBuffer: objectValidator({ capacity: positiveInteger }),
    log: objectValidator({ level: stringUnion(LOG_LEVELS), rotateBytes: positiveInteger }),
    eventLog: objectValidator({
      retention: positiveInteger,
      maxBytes: positiveInteger,
    }),
    metrics: objectValidator({ retention: positiveInteger }),
    http: objectValidator({
      enabled: booleanValue,
      host: stringValue,
      port: integerInRange(1, 65535),
      ...Object.fromEntries(
        authStrategies.flatMap((definition) =>
          definition.config === undefined
            ? []
            : [[definition.config.key, schemaValidator(definition.config.schema)]],
        ),
      ),
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
      defaultMode: stringUnion(["slim", "full"]),
      defaultModels: defaultModelsValidator,
      slim: objectValidator({
        categories: stringArray,
        bootTimeoutMs: positiveNumber,
      }),
    }),
    android: objectValidator({
      defaultModels: defaultModelsValidator,
      emulator: objectValidator({
        headless: booleanValue,
        gpu: nonEmptyString,
        audio: booleanValue,
        bootAnimation: booleanValue,
      }),
    }),
    stalledTransition: objectValidator({
      thresholdMultiplier: numberAtLeast(1),
      minimumThresholdMs: nonNegativeNumber,
    }),
  };
}

function schemaValidator(schema: ZodType): Validator {
  return (value, path) => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    if (issue === undefined) throw invalidValue(path, "a valid value");
    const issuePath = [path, ...issue.path.map(String)].join(".");
    // why: a strategy's own messages are lower-case phrases that finish "expected ..."; zod's built-in ones start with a capital.
    const expected = /^[A-Z]/.test(issue.message)
      ? `a valid value (${issue.message})`
      : issue.message;
    throw invalidValue(issuePath, expected);
  };
}

function capabilitiesValidator(modules: readonly ModuleConfigEntry[]): Validator {
  return (value, path, warn) => {
    const result: Record<string, unknown> = {};
    for (const [name, section] of Object.entries(requireObject(value, path))) {
      const sectionPath = `${path}.${name}`;
      const entry = modules.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        warn(`Unknown config key: "${sectionPath}"`);
        continue;
      }
      const { enabled, ...rest } = requireObject(section, sectionPath);
      result[name] = {
        ...(entry.validator(rest, sectionPath, warn) as Record<string, unknown>),
        ...(enabled === undefined
          ? {}
          : { enabled: booleanValue(enabled, `${sectionPath}.enabled`) }),
      };
    }
    return result;
  };
}

/**
 * An operator's model preference per device class (ADR 0015 §4): for each class, the model
 * names to try first, most preferred first. A class with no key has none.
 */
export type DefaultModels = Partial<Record<DeviceClass, readonly string[]>>;

/** why: `setTimeout` fires after about 1 ms above this delay, which would end the wait at once. */
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

const endWaitValidator: Validator = (value, path) => {
  const wait = positiveNumber(value, path);
  if (wait > MAXIMUM_TIMER_DELAY_MS) {
    throw invalidValue(path, `a positive number no larger than ${MAXIMUM_TIMER_DELAY_MS}`);
  }
  return wait;
};

/**
 * Each key is a device class and each value one non-empty model name or a non-empty list of
 * them, stored as a list. Any other key is refused rather than warned about: a misspelled class
 * would otherwise leave the operator's preference silently unused.
 */
const defaultModelsValidator: Validator = (value, path) => {
  const object = requireObject(value, path);
  const result: Record<string, readonly string[]> = {};

  for (const [key, names] of Object.entries(object)) {
    const keyPath = `${path}.${key}`;
    if (!(DEVICE_CLASSES as readonly string[]).includes(key)) {
      throw invalidValue(keyPath, `a device class (${DEVICE_CLASSES.join(", ")})`);
    }
    const list = typeof names === "string" ? [names] : names;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isNonEmptyString)) {
      throw invalidValue(keyPath, "a model name or a non-empty list of model names");
    }
    result[key] = list;
  }

  return result;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
