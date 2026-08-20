export interface RawLeaseGrant {
  readonly device: {
    readonly driverDeviceId: string;
    readonly spec: {
      readonly model: string;
      readonly osVersion: string;
      readonly platform: "android" | "ios";
    };
  };
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
      driverDeviceId: device.driverDeviceId,
      spec: { model: spec.model, osVersion: spec.osVersion, platform: spec.platform },
    },
    lease: { id: lease.id, mode: lease.mode, ttlDeadline: lease.ttlDeadline },
    timing: {
      estimatedBootMs: timing.estimatedBootMs,
      estimatedProvisionMs: timing.estimatedProvisionMs,
      estimatedReclaimMs: timing.estimatedReclaimMs,
      estimatedReadyMs: timing.estimatedReadyMs,
    },
  };
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
