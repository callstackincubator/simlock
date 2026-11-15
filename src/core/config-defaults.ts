import type { AuthStrategyDefinition } from "../auth/index.js";
import type { SystemStats } from "../ports/index.js";
import {
  defaultCapacityOptions,
  type CapacityConfig,
  type CapacityStrategyName,
} from "./capacity/index.js";
import type { Platform } from "./domain.js";
import type { Config, DaemonMode, DriverConfigEntry, ModuleConfigEntry } from "./config-types.js";
import { defaultWarmPoolConfig } from "./warm-pool/index.js";

export const DEFAULT_CONFIG_PATH = "~/.simlock/config.json";

const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

/** why: `devices.deletedRetentionMs`'s default: how long a `deleted` device record is kept, counted from its deletion. */
export const DEFAULT_DEVICES_DELETED_RETENTION_MS = 60 * 60_000;

export const DEFAULT_LEASE_REQUEST_RETENTION_MS = 10 * 60_000;

/** why: `lease.endedIdRetentionMs`'s default: how long a chosen lease id is refused after its lease ended (ADR 0074 §4). */
export const DEFAULT_LEASE_ENDED_ID_RETENTION_MS = 24 * 60 * 60_000;

/** why: `gateway.admission.timeoutMs`'s default (ADR 0074 §1): a policy script answers in well under this, and a stuck one refuses requests for no longer. */
const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000;

/** why: the bounds on `gateway.admission`, checked when the config is read. */
export const ADMISSION_TIMEOUT_MAX_MS = 60_000;
export const ADMISSION_COMMAND_MAX_ENTRIES = 64;
export const ADMISSION_ARGUMENT_MAX_LENGTH = 4096;

const DEFAULT_LEASE_MAX_PER_REQUESTER = 1;

export const DEFAULT_LEASE_MAX_REQUEST_RECORDS = 10_000;

const DEFAULT_DISCONNECTED_RETENTION_MS = 24 * 60 * 60_000;

/** why: `gateway.execTimeoutMs`'s default (ADR 0005 §19e): eleven minutes, one more than the
 * worker's authoritative ten, so the worker's timeout is the one that fires. */
const DEFAULT_GATEWAY_EXEC_TIMEOUT_MS = 11 * 60_000;

/** why: `gateway.leaseRequestTimeoutMs`'s default (P2, round 2 review): five minutes -- generous
 * against a cold device provision-plus-boot, and well short of `execTimeoutMs`, since granting a
 * lease should never take as long as a command a caller runs against the device afterward. */
const DEFAULT_LEASE_REQUEST_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_ROUTING_POLICY = "warm-then-free";

/**
 * why: `exec.timeoutMs`'s default (ADR 0005 §19e): how long a single `device.exec` command may run
 * on this worker before it is killed and the operation fails with `EXEC_TIMEOUT`. Ten minutes,
 * because the commands this wraps are installs and boots-worth of `adb wait-for-device`, not
 * sub-second reads -- and because a stuck command holds no lease of its own, so the cost of a
 * generous bound is one process, not a device.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_METRICS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const MIN_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;

export function defaultConfig(
  systemStats: SystemStats,
  strategy: CapacityStrategyName,
  role: DaemonMode,
  modules: readonly ModuleConfigEntry[],
  authStrategies: readonly AuthStrategyDefinition[],
  standalone: boolean,
  defaulted: ReadonlySet<string>,
  driverSections: readonly DriverConfigEntry[],
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
    devices: { autoEnroll: false, deletedRetentionMs: DEFAULT_DEVICES_DELETED_RETENTION_MS },
    lease: {
      defaultTtlMs: DEFAULT_LEASE_TTL_MS,
      maxTtlMs: DEFAULT_LEASE_MAX_TTL_MS,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: DEFAULT_LEASE_REQUEST_RETENTION_MS,
      endedIdRetentionMs: DEFAULT_LEASE_ENDED_ID_RETENTION_MS,
      maxRequestRecords: DEFAULT_LEASE_MAX_REQUEST_RECORDS,
      maxPerRequester: DEFAULT_LEASE_MAX_PER_REQUESTER,
      endWaitMs: DEFAULT_EXEC_TIMEOUT_MS,
    },
    exec: { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
    diskPressure: { freeBytesThreshold: 10 * 1024 ** 3 },
    memoryPressure: {
      enabled: true,
      pauseWarming: { level: "warn", minAvailablePercent: 20 },
      pauseNewDevices: { level: "critical", minAvailablePercent: 10 },
      clearAfterMs: 60_000,
    },
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
    ios: { ...driverDefaults(driverSections, "ios"), defaultMode: "full", defaultModels: {} },
    android: { ...driverDefaults(driverSections, "android"), defaultModels: {} },
    gateway: {
      disconnectedRetentionMs: DEFAULT_DISCONNECTED_RETENTION_MS,
      execTimeoutMs: DEFAULT_GATEWAY_EXEC_TIMEOUT_MS,
      leaseRequestTimeoutMs: DEFAULT_LEASE_REQUEST_TIMEOUT_MS,
      routing: DEFAULT_ROUTING_POLICY,
      alerts: { destinations: [] },
      admission: { timeoutMs: DEFAULT_ADMISSION_TIMEOUT_MS },
    },
    stalledTransition: {
      thresholdMultiplier: 3,
      minimumThresholdMs: 60_000,
    },
  };
}

function driverDefaults(
  driverSections: readonly DriverConfigEntry[],
  platform: Platform,
): Record<string, unknown> {
  return Object.assign(
    {},
    ...driverSections.filter((entry) => entry.platform === platform).map((entry) => entry.defaults),
  ) as Record<string, unknown>;
}
