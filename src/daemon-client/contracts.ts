export interface RawLeaseGrant {
  readonly device: {
    /**
     * The driver-reported address (adb serial / simctl UDID), current as of the device's last
     * boot. Undefined only for a device leased straight out of a pre-address `state.json`
     * without ever rebooting under this daemon -- see `DeviceRecord.address` in domain.ts.
     */
    readonly address: string | undefined;
    readonly driverDeviceId: string;
    readonly spec: {
      readonly model: string;
      readonly osVersion: string;
      readonly platform: "android" | "ios";
    };
  };
  /**
   * Scoping variables the holder needs to reach this device -- the device-set path on iOS,
   * the adb server port on Android. Always present after parsing, `{}` at the least.
   */
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: {
    readonly id: string;
    readonly mode: "detached" | "held";
    readonly ttlDeadline: number;
  };
  readonly timing: {
    readonly estimatedBootMs: number;
    readonly estimatedProvisionMs: number;
    readonly estimatedReclaimMs: number;
    readonly estimatedReadyMs: number;
  };
}

export interface RawLeaseLost {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly reason: string;
}

export function parseRawLeaseGrant(value: unknown): RawLeaseGrant {
  const grant = requireObject(value, "Daemon returned an invalid lease grant");
  const device = requireObject(grant.device, "Daemon returned an invalid lease grant");
  const spec = requireObject(device.spec, "Daemon returned an invalid lease grant");
  const lease = requireObject(grant.lease, "Daemon returned an invalid lease grant");
  const timing = requireObject(grant.timing, "Daemon returned an invalid lease grant");
  if (
    typeof device.driverDeviceId !== "string" ||
    (device.address !== undefined && typeof device.address !== "string") ||
    typeof spec.model !== "string" ||
    typeof spec.osVersion !== "string" ||
    (spec.platform !== "ios" && spec.platform !== "android") ||
    typeof lease.id !== "string" ||
    (lease.mode !== "held" && lease.mode !== "detached") ||
    typeof lease.ttlDeadline !== "number" ||
    typeof timing.estimatedProvisionMs !== "number" ||
    typeof timing.estimatedBootMs !== "number" ||
    typeof timing.estimatedReclaimMs !== "number" ||
    typeof timing.estimatedReadyMs !== "number"
  ) {
    throw new Error("Daemon returned an invalid lease grant");
  }
  return {
    device: {
      address: device.address,
      driverDeviceId: device.driverDeviceId,
      spec: { model: spec.model, osVersion: spec.osVersion, platform: spec.platform },
    },
    environment: parseStringRecord(grant.environment),
    lease: { id: lease.id, mode: lease.mode, ttlDeadline: lease.ttlDeadline },
    timing: {
      estimatedBootMs: timing.estimatedBootMs,
      estimatedProvisionMs: timing.estimatedProvisionMs,
      estimatedReclaimMs: timing.estimatedReclaimMs,
      estimatedReadyMs: timing.estimatedReadyMs,
    },
  };
}

export interface RawPassthroughCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Parses the `driver.passthrough` response. The command is spawned as-is, so the shape is
 * checked before anything reaches a process: an argument list that is not entirely strings
 * would otherwise stringify into whatever the tool made of it.
 */
export function parseRawPassthroughCommand(value: unknown): RawPassthroughCommand {
  const payload = requireObject(value, "Daemon returned an invalid passthrough command");
  if (
    typeof payload.command !== "string" ||
    payload.command === "" ||
    !isStringArray(payload.args)
  ) {
    throw new Error("Daemon returned an invalid passthrough command");
  }
  return { args: [...payload.args], command: payload.command, env: parseStringRecord(payload.env) };
}

/**
 * Lenient on purpose, and the one place that leniency is the right call: a daemon older
 * than this CLI sends no `environment` with its grants at all, and a grant is still worth
 * having without one. Refusing it would break the mixed pair over a field the client can
 * do without, so a missing, non-object, or partly non-string value degrades to what it
 * can carry rather than failing the whole response.
 */
function parseStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Parses the lease-lost push notification body pushed to the lease's holding connection. */
export function parseRawLeaseLost(value: unknown): RawLeaseLost {
  const payload = requireObject(value, "Daemon sent an invalid lease-lost notification");
  if (
    typeof payload.leaseId !== "string" ||
    typeof payload.deviceId !== "string" ||
    typeof payload.reason !== "string"
  ) {
    throw new Error("Daemon sent an invalid lease-lost notification");
  }
  return { deviceId: payload.deviceId, leaseId: payload.leaseId, reason: payload.reason };
}

export interface RawDeviceUnhealthy {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly reason: string;
}

/** Parses the `device-unhealthy` push notified to a lease's holding connection. */
export function parseRawDeviceUnhealthy(value: unknown): RawDeviceUnhealthy {
  const payload = requireObject(value, "Daemon sent an invalid device-unhealthy notification");
  if (
    typeof payload.deviceId !== "string" ||
    typeof payload.leaseId !== "string" ||
    typeof payload.reason !== "string"
  ) {
    throw new Error("Daemon sent an invalid device-unhealthy notification");
  }
  return { deviceId: payload.deviceId, leaseId: payload.leaseId, reason: payload.reason };
}

export interface RawDeviceRecovered {
  readonly attempts: number;
  readonly deviceId: string;
  readonly leaseId: string;
}

/** Parses the `device-recovered` push notified to a lease's holding connection. */
export function parseRawDeviceRecovered(value: unknown): RawDeviceRecovered {
  const payload = requireObject(value, "Daemon sent an invalid device-recovered notification");
  if (
    typeof payload.attempts !== "number" ||
    typeof payload.deviceId !== "string" ||
    typeof payload.leaseId !== "string"
  ) {
    throw new Error("Daemon sent an invalid device-recovered notification");
  }
  return { attempts: payload.attempts, deviceId: payload.deviceId, leaseId: payload.leaseId };
}

export interface RawLeaseHeartbeatAck {
  readonly leases: readonly { readonly leaseId: string; readonly ttlDeadline: number }[];
}

/** Parses the `lease.heartbeat` ack re-surfaced by `IpcDaemonConnection` as a push. */
export function parseRawLeaseHeartbeatAck(value: unknown): RawLeaseHeartbeatAck {
  const payload = requireObject(value, "Daemon sent an invalid heartbeat ack");
  if (!Array.isArray(payload.leases)) {
    throw new Error("Daemon sent an invalid heartbeat ack");
  }
  return {
    leases: payload.leases.map((entry: unknown) => {
      const lease = requireObject(entry, "Daemon sent an invalid heartbeat ack");
      if (typeof lease.leaseId !== "string" || typeof lease.ttlDeadline !== "number") {
        throw new Error("Daemon sent an invalid heartbeat ack");
      }
      return { leaseId: lease.leaseId, ttlDeadline: lease.ttlDeadline };
    }),
  };
}

export type RawLeaseProgress =
  | { readonly stage: "queued"; readonly queuePosition: number }
  | { readonly stage: "provisioning" | "booting" | "reclaiming"; readonly etaMs: number };

/** Parses a "progress" push frame delivered to the requesting connection while a lease is in flight. */
export function parseRawLeaseProgress(value: unknown): RawLeaseProgress {
  const payload = requireObject(value, "Daemon sent an invalid progress notification");
  if (payload.stage === "queued") {
    if (typeof payload.queuePosition !== "number") {
      throw new Error("Daemon sent an invalid progress notification");
    }
    return { queuePosition: payload.queuePosition, stage: "queued" };
  }
  if (
    (payload.stage === "provisioning" ||
      payload.stage === "booting" ||
      payload.stage === "reclaiming") &&
    typeof payload.etaMs === "number"
  ) {
    return { etaMs: payload.etaMs, stage: payload.stage };
  }
  throw new Error("Daemon sent an invalid progress notification");
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

export interface RawCatalogEntry {
  readonly platform: "android" | "ios";
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly defaultRuntime: string | undefined;
}

export interface RawCatalog {
  readonly platforms: readonly RawCatalogEntry[];
}

export function parseRawCatalog(value: unknown): RawCatalog {
  const root = requireCatalogObject(value);
  if (!Array.isArray(root.platforms)) {
    throw new Error("Daemon returned an invalid device catalog");
  }
  return { platforms: root.platforms.map(parseRawCatalogEntry) };
}

function parseRawCatalogEntry(value: unknown): RawCatalogEntry {
  const entry = requireCatalogObject(value);
  if (
    (entry.platform !== "ios" && entry.platform !== "android") ||
    !isStringArray(entry.models) ||
    !isStringArray(entry.runtimes) ||
    (entry.defaultRuntime !== undefined && typeof entry.defaultRuntime !== "string")
  ) {
    throw new Error("Daemon returned an invalid device catalog");
  }
  return {
    defaultRuntime: entry.defaultRuntime,
    models: entry.models,
    platform: entry.platform,
    runtimes: entry.runtimes,
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function requireCatalogObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Daemon returned an invalid device catalog");
  }
  return value as Record<string, unknown>;
}
