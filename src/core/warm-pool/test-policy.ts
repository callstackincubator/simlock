import type { CapacityRefusalReason, RunningCapacity } from "../capacity/index.js";
import type {
  DeviceClass,
  VirtualDevice,
  VirtualSpec,
  LeaseRecord,
  WaitingDemand,
} from "../domain.js";
import { sameSpec } from "../domain.js";
import { evaluate as plan, type ResolvedTarget, type WarmPolicyView } from "./policy.js";

export const evaluate = (policyView: WarmPolicyView) => plan(policyView).proposals;

export const minute = 60_000;
export const now = 1_000 * minute;
export const shutdownAfterMs = 10 * minute;

const phones = new Set(["iPhone 15", "iPhone 17"]);
const classOf = (model: string): DeviceClass | undefined =>
  phones.has(model) ? "phone" : "tablet";

export function spec(model: string, overrides: Partial<VirtualSpec> = {}): VirtualSpec {
  return { model, osVersion: "26.0", physical: false, platform: "ios", ...overrides };
}

export interface DeviceOptions {
  spec?: VirtualSpec;
  endedAgo?: number;
  createdAt?: number;
  readyAt?: number;
  leaseIdentity?: "fresh";
  spent?: boolean;
}

function readyStamp(options: DeviceOptions): Pick<VirtualDevice, "readyAt"> | Record<never, never> {
  return options.readyAt === undefined && options.endedAgo === undefined
    ? {}
    : { readyAt: options.readyAt ?? now };
}

// why: a virtual device that ended a lease is spent (ADR 0061 §2) and never grantable; `endedAgo`
// only orders idle devices (least recently used), so it moves createdAt, and only a spent device
// carries the end stamp. Such a device counts as freshly ready, so the never-leased idle rule leaves it be.
function endStamp(
  options: DeviceOptions,
): Pick<VirtualDevice, "lastLeaseEndedAt"> | Record<never, never> {
  return options.spent === true && options.endedAgo !== undefined
    ? { lastLeaseEndedAt: now - options.endedAgo }
    : {};
}

export function device(
  id: string,
  state: VirtualDevice["state"],
  options: DeviceOptions = {},
): VirtualDevice {
  return {
    physical: false,
    createdAt: options.createdAt ?? (options.endedAgo === undefined ? 1 : now - options.endedAgo),
    ...readyStamp(options),
    ...(options.leaseIdentity === undefined ? {} : { leaseIdentity: options.leaseIdentity }),
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    mode: "full",
    spec: options.spec ?? spec("iPhone 15"),
    state,
    ...endStamp(options),
  };
}

export function learnedOf(
  learnedSpec: VirtualSpec,
  count = 1,
  lastLeasedAt = now,
): WarmPolicyView["learned"][number] {
  return { count, lastLeasedAt, spec: learnedSpec };
}

export function leaseOn(target: VirtualDevice): LeaseRecord {
  return {
    deviceId: target.id,
    grantedAt: 1,
    id: `lease-${target.id}`,
    lastRenewedAt: 1,
    idChosenByRequester: false,
    ownerId: "holder",
    requesterId: "holder",
    ttlDeadline: now + minute,
    ttlMs: minute,
  };
}

export function capacityOf(
  devices: readonly VirtualDevice[],
  limits: { global: number; ios?: number; android?: number },
  reserved = 0,
): RunningCapacity {
  const running = (platform?: string): number =>
    devices.filter(
      (item) =>
        ["ready", "leased", "reclaiming", "quarantined"].includes(item.state) &&
        (platform === undefined || item.spec.platform === platform),
    ).length;
  const entry = (maxRunning: number, platform?: string) => ({
    maxRunning,
    overLimit: running(platform) + reserved > maxRunning,
    reserved,
    running: running(platform),
  });
  return {
    android: entry(limits.android ?? limits.global, "android"),
    global: entry(limits.global),
    ios: entry(limits.ios ?? limits.global, "ios"),
  };
}

export function classDemand(
  mode: "slim" | "full" = "full",
  platform: "ios" | "android" = "ios",
  inFlight = false,
  model = "iPhone 15",
) {
  return {
    classOf,
    inFlight,
    mode,
    platform,
    spec: spec(model, { platform, ...(mode === "slim" ? { mode } : {}) }),
    requirement: {
      imageTag: undefined,
      osVersion: { kind: "installed", versions: ["26.0"] },
      platform,
      target: { class: "phone", kind: "class" },
    },
  } satisfies WaitingDemand;
}

export function modelDemand(model: string): WaitingDemand {
  return {
    classOf,
    inFlight: false,
    mode: "full",
    platform: "ios",
    spec: spec(model),
    requirement: {
      imageTag: undefined,
      osVersion: { kind: "exact", version: "26.0" },
      platform: "ios",
      target: { kind: "model", model },
    },
  };
}

// fallow-ignore-next-line complexity -- one test fixture builder; each option is a plain pass-through to a view field.
export function view(
  devices: readonly VirtualDevice[],
  options: {
    limit?: number;
    limits?: { ios?: number; android?: number };
    reserve?: { ios?: number; android?: number };
    reserved?: number;
    waiting?: readonly WaitingDemand[];
    enabled?: boolean;
    claimed?: readonly string[];
    leased?: readonly VirtualDevice[];
    handoffInFlight?: boolean;
    reset?: readonly string[];
    targets?: readonly ResolvedTarget[];
    spared?: readonly ResolvedTarget[];
    learned?: WarmPolicyView["learned"];
    inFlight?: readonly VirtualSpec[];
    onItsWay?: WarmPolicyView["onItsWay"];
    maxConcurrentBoots?: number;
    blocked?: readonly VirtualSpec[];
    refuseProvision?: CapacityRefusalReason;
    refuseBoot?: CapacityRefusalReason;
    /** why: a creation the capacity strategy refuses until the plan has shut a device down. */
    refuseProvisionUntilDown?: CapacityRefusalReason;
    unplanned?: readonly VirtualSpec[];
    pressure?: {
      step?: WarmPolicyView["pressure"]["step"];
      mayShed?: boolean;
      shedFailed?: readonly string[];
    };
  } = {},
): WarmPolicyView {
  return {
    admit: {
      boot: () => options.refuseBoot,
      create: (_spec, down) =>
        options.refuseProvision ??
        ((down?.size ?? 0) === 0 ? options.refuseProvisionUntilDown : undefined),
    },
    unplanned: options.unplanned ?? [],
    inFlight: options.inFlight ?? [],
    onItsWay: options.onItsWay ?? [],
    retry: {
      mayAttempt: (target) => !(options.blocked ?? []).some((held) => sameSpec(held, target)),
    },
    spared: options.spared ?? [],
    learned: options.learned ?? [],
    targets: options.targets ?? [],
    capacity: capacityOf(
      devices,
      { global: options.limit ?? 10, ...options.limits },
      options.reserved,
    ),
    config: {
      enabled: options.enabled ?? true,
      maxConcurrentBoots: options.maxConcurrentBoots ?? 1,
      reserveRunning: { android: 0, ios: 0, ...options.reserve },
      shutdownAfterMs,
    },
    devices,
    handoffInFlight: options.handoffInFlight ?? false,
    resetDevices: new Set(options.reset ?? []),
    pressure: {
      mayShed: options.pressure?.mayShed ?? true,
      shedFailed: new Set(options.pressure?.shedFailed ?? []),
      step: options.pressure?.step ?? "none",
    },
    isClaimed: (id) => options.claimed?.includes(id) ?? false,
    leases: (options.leased ?? devices.filter((item) => item.state === "leased")).map(leaseOn),
    now,
    waiting: options.waiting ?? [],
  };
}
