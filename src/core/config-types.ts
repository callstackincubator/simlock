import type { AuthStrategyDefinition } from "../auth/index.js";
import type { Filesystem, LogLevel, SystemStats } from "../ports/index.js";
import type { CapacityConfig, CapacityLimits, ResourceStrategyOptions } from "./capacity/index.js";
import type { DeviceClass, DeviceMode, LeaseIdentity, Platform } from "./domain.js";
import type { AlertDestination } from "./config-alerts.js";
import type { Validator, Warn } from "./validation.js";
import type { WarmPoolConfig } from "./warm-pool/index.js";

/**
 * why: `gateway.routing`'s valid names (ADR 0005 §13/Decision 7) and its default. Declared here
 * rather than imported from `src/gateway/routing.ts`'s own registry: `core` stays
 * platform-agnostic and gateway-unaware (`AGENTS.md`/`architecture.md`), so this list is
 * re-declared the same way `src/contract/schemas.ts` re-declares it independently rather than
 * importing across its own boundary -- three places name `"warm-then-free"`, the same
 * redundancy `capacity.strategy`'s "fixed"/"resource" already carries between `core` and the
 * contract. Adding a second policy means adding it here, in the gateway's own registry, and in
 * the contract schema -- one line each, never a shared import.
 */
export const ROUTING_POLICIES = ["warm-then-free"] as const;

/** why: The literal union `ROUTING_POLICIES` names -- `Config["gateway"]["routing"]`'s type, so it
 * agrees with the contract's own `z.enum(["warm-then-free"])` (also re-declared, never
 * imported) instead of widening to a bare `string` the boundary between the two would otherwise
 * force. */
type RoutingPolicyName = (typeof ROUTING_POLICIES)[number];

export type DownloadPolicy = "never" | "on-request" | "always";

/**
 * why: one number counts a requester's leases across all platforms; the object counts per
 * platform, and a platform it leaves out is 1.
 */
export type MaxPerRequester = number | { readonly ios?: number; readonly android?: number };

/**
 * why: which shape a daemon runs as (ADR 0005 §1): a `worker` owns the devices on its machine and a
 * `gateway` owns none and fronts the workers that joined it. One daemon runs exactly one mode,
 * and the folder it lives in decides it (ADR 0034): the daemon is told its role at start, and
 * `loadConfig` takes it as an argument -- no config key names it.
 */
export type DaemonMode = "worker" | "gateway";

interface MemoryPressureRule {
  readonly level: "normal" | "warn" | "critical" | "off";
  readonly minAvailablePercent: number;
}

export interface Config {
  readonly capabilities: Readonly<
    Record<string, { readonly enabled: boolean } & Readonly<Record<string, unknown>>>
  >;
  readonly mode: DaemonMode;
  readonly capacity: CapacityConfig;
  /**
   * why: Per-driver settings, opaque to the core: stored, merged, and handed to the driver
   * that owns the key without a single key being interpreted here. What
   * `drivers.ios.deviceRoot` means is the iOS driver's business, and knowing it here
   * would be exactly the leak architecture rule 2 forbids.
   */
  readonly drivers: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>;
  readonly downloads: {
    readonly policy: DownloadPolicy;
    /** why: Explicit legal consent for Android SDK licenses, independent of `policy`. */
    readonly acceptAndroidLicenses: boolean;
    /**
     * why: One budget per install request, from its arrival, covering the wait behind another
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
      readonly maxRetries: number;
      readonly retryBackoffMs: number;
      readonly retryBackoffMultiplier: number;
      readonly maxRetryBackoffMs: number;
    };
  };
  readonly devices: {
    /**
     * why: how long a `deleted` device record stays in `state.db` and in `status.get`, counted
     * from its deletion. At least `lease.requestRetentionMs`: a granted request names its device.
     */
    readonly deletedRetentionMs: number;
    /**
     * why: a worker enrols the phones plugged into it by USB, as `device add` would; off by default
     * because a personal phone on the worker would be wiped of apps at every lease's end.
     */
    readonly autoEnroll: boolean;
  };
  readonly lease: {
    /**
     * why: ADR 0004 §4: the TTL applied to a lease whose `lease.request` carried no `ttlMs` -- that
     * request only. It is deliberately *not* the renew fallback: a `lease.renew` given no
     * explicit TTL re-applies the lease's own stored width, so a lease granted for longer
     * keeps it.
     */
    readonly defaultTtlMs: number;
    /** why: The largest TTL a request or a renew may ask for; more is `BAD_REQUEST`, never a
     * silent clamp, so a caller is never left believing it has more time than it does. */
    readonly maxTtlMs: number;
    /**
     * why: The lease-identity policy per platform (see `LeaseIdentity`) no longer changes anything:
     * every virtual device serves one lease and is deleted when it ends (ADR 0061 §2). It stays
     * accepted and stored on each device record.
     */
    readonly identity: {
      readonly ios: LeaseIdentity;
      readonly android: LeaseIdentity;
    };
    readonly requestRetentionMs: number;
    /** why: ADR 0074 §4: how long a chosen lease id is refused after its lease ended, counted from the end; read by a worker and a gateway. */
    readonly endedIdRetentionMs: number;
    readonly maxRequestRecords: number;
    readonly maxPerRequester: MaxPerRequester;
    readonly endWaitMs: number;
  };
  /**
   * why: ADR 0005 §19e. Platform-agnostic on purpose: it bounds the *daemon's* willingness to wait
   * on a child, not anything either driver knows about, so it sits at the top level rather
   * than under `drivers.*`.
   */
  readonly exec: { readonly timeoutMs: number };
  readonly diskPressure: { readonly freeBytesThreshold: number };
  /** why: ADR 0068 §1: when host memory pauses a worker's warming and its new devices; worker only. */
  readonly memoryPressure: {
    readonly enabled: boolean;
    readonly pauseWarming: MemoryPressureRule;
    readonly pauseNewDevices: MemoryPressureRule;
    readonly clearAfterMs: number;
  };
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
    readonly defaultMode: DeviceMode;
    readonly defaultModels: DefaultModels;
    /** why: the iOS device modes this worker serves (ADR 0082 §1); a request or target of another mode is refused. */
    readonly modes: readonly DeviceMode[];
    /** why: false makes this worker serve only enrolled physical iOS devices (ADR 0084 §1). */
    readonly virtualDevices: boolean;
  } & DriverConfigSection;
  readonly android: {
    /** why: the image tag an Android lease that names none gets where an image of it fits (ADR 0078 §1). */
    readonly defaultImageTag?: string;
    readonly defaultModels: DefaultModels;
    /** why: false makes this worker serve only enrolled physical Android devices (ADR 0084 §1). */
    readonly virtualDevices: boolean;
  } & DriverConfigSection;
  /**
   * why: ADR 0005 §3/§6. Both sides of the fleet live under one key, and which half is read depends
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
    readonly url?: string;
    /** why: A join token minted on the gateway with `simlock token create --role worker`.
     * Worker-side. It is a secret, and it sits in the daemon's config file, which `simlock
     * config set` writes owner-only (0600) every time; a file written by hand, or before
     * that, keeps whatever mode it has until the next `config set`. Everywhere else the
     * config is written out -- the startup log line, `daemon.started`, and `config.get`
     * unless it is asked with `showSecrets: true` -- it goes through `redactConfig`. */
    readonly token?: string;
    readonly label?: string;
    readonly headers?: Readonly<Record<string, string>>;
    /**
     * why: How long a gateway keeps a disconnected worker's view before forgetting it (§6).
     * Gateway-side. Default 24 hours: long enough that a machine rebooting overnight is still
     * the same machine in the morning, short enough that a decommissioned one does not haunt
     * `simlock status` forever. A view whose leases have not all expired is never dropped on
     * this timer, however long it has been gone.
     */
    readonly disconnectedRetentionMs: number;
    /**
     * why: Gateway-side backstop on a proxied `device.exec` (ADR 0005 §19e). Deliberately longer
     * than the worker's own `exec.timeoutMs` (ten minutes): the worker's is authoritative and
     * should be what kills a runaway command, so a gateway that timed out first would report
     * a failure for a command still running on the machine that owns the device. Read by #118,
     * which is what proxies `device.exec`; declared now so the key does not appear mid-series.
     */
    readonly execTimeoutMs: number;
    /**
     * why: P2 (round 2 review): bounds a forwarded `lease.request` -- the one uplink call that used
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
    readonly routing: RoutingPolicyName;
    readonly alerts: { readonly destinations: readonly AlertDestination[] };
    /**
     * why: ADR 0074 §1: the program a gateway runs for each new lease request, and how long it may
     * take; a worker ignores both, as it does `execTimeoutMs`.
     */
    readonly admission: { readonly command?: readonly string[]; readonly timeoutMs: number };
  };
  readonly stalledTransition: {
    /**
     * why: Applied to the driver's own estimate (`provision + boot` for `provisioning`,
     * `reclaim` for `reclaiming`) to get the stall threshold. Deliberately generous:
     * the estimate itself is already tuned for a routine run, so the threshold has to
     * clear real-world variance on top of it, not just match it -- a cold Android
     * provision-plus-boot can legitimately run well past the raw estimate.
     */
    readonly thresholdMultiplier: number;
    /** why: Floor under the multiplied estimate, for a driver whose estimate is near zero. */
    readonly minimumThresholdMs: number;
  };
}

/**
 * why: The pre-`capacity` spelling of the resource strategy's options. Still accepted
 * everywhere the new shape is, and folded into `capacity.config` before anything
 * downstream sees it, so existing config files keep working untouched.
 */
export interface LegacyCapacityOverrides {
  readonly limits?: DeepPartial<CapacityLimits>;
  readonly ramBudget?: DeepPartial<ResourceStrategyOptions["ramBudget"]>;
}

export type ConfigOverrides = DeepPartial<Config> & LegacyCapacityOverrides;

// why: a platform's section also holds its driver's own keys, which the loader carries without reading one.
type DriverConfigSection = Readonly<Record<string, unknown>>;

// why: a driver declares the keys it reads under its platform's section, so a new driver setting changes no file of the core; `defaults` holds every key that has one, typed as the driver reads the section.
export interface DriverConfigEntry<Section = unknown> {
  readonly platform: Platform;
  readonly validators: Readonly<Record<string, Validator>>;
  readonly defaults: Section;
  // why: the values the driver uses for the `drivers.<platform>.*` keys config.json leaves unset, which depend on the data directory and on the keys that are set; `config.get` shows them, so `config get` reads a key at its default.
  readonly settingDefaults?: (
    simlockHome: string,
    settings: Readonly<Record<string, string | number | boolean>>,
  ) => Readonly<Record<string, string | number | boolean>>;
  // why: ADR 0083 I4: runs on the merged config, after both layers, where a rule that spans keys of one section can be judged; it throws a `ConfigError`.
  readonly check?: (section: never, config: Config) => void;
}

export interface ModuleConfigEntry {
  readonly name: string;
  readonly validator: Validator;
  readonly defaults: unknown;
  readonly gatewayKeys: readonly string[];
  readonly enabledByDefault?: "standalone-worker";
  readonly check?: (section: never, config: Config) => void;
}

export interface ConfigLayerOptions {
  readonly authStrategies?: readonly AuthStrategyDefinition[];
  readonly driverSections?: readonly DriverConfigEntry[];
  readonly modules?: readonly ModuleConfigEntry[];
  readonly systemStats: SystemStats;
  readonly overrides?: ConfigOverrides;
  readonly role?: DaemonMode;
  readonly warn?: Warn;
}

export interface LoadConfigOptions extends ConfigLayerOptions {
  readonly filesystem: Filesystem;
  readonly configPath?: string;
}

export type Layer = Record<string, unknown>;

export interface LoadedConfig {
  readonly config: Config;
  readonly defaulted: ReadonlySet<string>;
}

export type DefaultModels = Partial<Record<DeviceClass, readonly string[]>>;

export type DeepPartial<Value> = Value extends object
  ? { readonly [Key in keyof Value]?: DeepPartial<Value[Key]> }
  : Value;
