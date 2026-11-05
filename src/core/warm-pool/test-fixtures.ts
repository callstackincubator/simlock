import { beforeEach, vi, type Mock } from "vitest";

import { EventBus } from "../../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../../ports/index.js";
import type { CurrentBaseline } from "../baselines.js";
import type { RunningCapacity } from "../capacity/index.js";
import { DeviceOperationClaims } from "../device-operation-claims.js";
import {
  exactRequirement,
  type VirtualDevice,
  type VirtualSpec,
  type LeaseRecord,
  type Platform,
  type TargetResolution,
  type WaitingDemand,
} from "../domain.js";
import type { PlatformCatalog } from "../driver-catalog.js";
import { BootTimeoutError, type DeviceRequest } from "../driver.js";
import { SerializedDecision } from "../serialized-decision.js";
import type { StateDatabase } from "../../state/index.js";
import { openMemoryState } from "../testing.js";
import type { WarmTarget } from "./config.js";
import { WarmPool, type WarmPoolOptions } from "./converger.js";
import { warmPoolOwner } from "./learned.js";

export const minute = 60_000;
export const now = 1_000 * minute;

/** why: a catalog read that lists the iOS models the learned-kind tests lease. */
export const iosListing: PlatformCatalog = {
  classDefaults: {},
  defaultRuntime: undefined,
  modelAliases: {},
  modelClasses: {},
  modelRuntimes: { "iPad Pro": ["26.0"], "iPhone 15": ["26.0"] },
  models: ["iPad Pro", "iPhone 15"],
  platform: "ios",
  runtimes: ["26.0"],
};

export const iphone15: WarmTarget = {
  count: 1,
  model: "iPhone 15",
  osVersion: "26.0",
  platform: "ios",
};

export let learnedState: StateDatabase;

beforeEach(async () => {
  learnedState = await openMemoryState([warmPoolOwner]);
});

export function device(
  id: string,
  state: VirtualDevice["state"],
  endedAgo: number,
  platform: "ios" | "android" = "ios",
): VirtualDevice {
  return {
    physical: false,
    // why: a virtual device that ended a lease is never granted again, so the fixture is a never-leased device whose createdAt orders it by recency.
    createdAt: now - endedAgo,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    mode: "full",
    readyAt: now,
    spec:
      platform === "ios"
        ? { model: "iPhone 15", osVersion: "26.0", physical: false, platform }
        : { model: "Pixel 8", osVersion: "35", physical: false, platform },
    state,
  };
}

export function neverLeased(id: string, platform: "ios" | "android"): VirtualDevice {
  return { ...device(id, "ready", 5_000, platform), readyAt: now - 11 * minute };
}

export function leaseOn(deviceId: string): LeaseRecord {
  return {
    deviceId,
    grantedAt: 1,
    id: `lease-${deviceId}`,
    lastRenewedAt: 1,
    idChosenByRequester: false,
    ownerId: "holder",
    requesterId: "holder",
    ttlDeadline: now + minute,
    ttlMs: minute,
  };
}

export function waiter(spec: VirtualSpec, inFlight = false): WaitingDemand {
  return {
    classOf: () => undefined,
    inFlight,
    mode: "full",
    platform: spec.platform,
    requirement: exactRequirement(spec),
    spec,
  };
}

export type BaselineFixture = Partial<
  Pick<CurrentBaseline, "imageTag" | "mode" | "model" | "osVersion" | "platform" | "staleReason">
> & { readonly version: number };

export function harness(
  initial: readonly VirtualDevice[],
  options: {
    limit?: number;
    enabled?: boolean;
    learn?: boolean;
    baselineLearnAfter?: number;
    refuseBoot?: boolean;
    shutdown?: (target: VirtualDevice) => Promise<VirtualDevice | undefined>;
    boot?: (target: VirtualDevice) => Promise<VirtualDevice | undefined>;
    waiting?: () => readonly WaitingDemand[];
    maintenance?: () => boolean;
    refuseClaim?: boolean;
    targets?: readonly WarmTarget[];
    maxConcurrentBoots?: number;
    /** why: The mode a request naming none plans on iOS: `ios.defaultMode`; full when none is set. */
    defaultMode?: "slim" | "full";
    /** why: What a target resolves to; by default the request's own model and OS (26.0 when none). */
    resolve?: (request: DeviceRequest) => TargetResolution | Promise<TargetResolution>;
    /** why: Holds a creation until the test lets it go; the creation fails when this rejects. */
    provision?: (spec: VirtualSpec, attempt: number) => Promise<void>;
    refuseProvision?: boolean;
    /** why: The budget allows a creation when asked, then refuses the reservation: a lost race. */
    refuseReservation?: boolean;
    /** why: The budget's reservation call throws, which no refusal does. */
    reserveThrows?: boolean;
    refusedPlatforms?: readonly ("ios" | "android")[];
    provisioning?: Promise<void>;
    state?: StateDatabase;
    /** why: called with the id of each device the budget is asked to admit a boot of, while a pass proposes. */
    onAdmit?: (deviceId: string) => void;
    /** why: the current version of each baseline by name; a baseline not listed is removed. */
    baselines?: Readonly<Record<string, BaselineFixture>>;
    /** why: what a platform's catalog read answers; by default a catalog that lists nothing. */
    catalog?: (platform?: Platform) => Promise<readonly PlatformCatalog[]>;
  } = {},
) {
  const clock = new FakeClock(now);
  const eventBus = new EventBus(clock);
  const sink = new MemoryLogSink();
  const claims = new DeviceOperationClaims();
  const state = { devices: [...initial], leases: [] as LeaseRecord[] };
  const setState = (id: string, next: VirtualDevice["state"]): VirtualDevice => {
    const current = state.devices.find((item) => item.id === id);
    if (current === undefined) throw new Error(`no device ${id}`);
    const updated = { ...current, state: next };
    state.devices = state.devices.map((item) => (item.id === id ? updated : item));
    return updated;
  };
  const lease = (id: string): void => {
    setState(id, "leased");
    state.leases.push(leaseOn(id));
  };
  const reservations: { released: number; claimedAtBoot?: boolean; releasedAtBoot?: number }[] = [];
  const kick: Mock<() => void> = vi.fn();
  // why: one read per pass. A pool that spins fails every pass after the 200th here (the pass logs it
  // and ends) instead of exhausting the worker's heap; no test asserts on this guard.
  const passes = { count: 0 };
  const waitingDemand: Mock<() => readonly WaitingDemand[]> = vi.fn(() => {
    passes.count += 1;
    if (passes.count > 200) throw new Error("the warm pool is spinning");
    return options.waiting?.() ?? [];
  });
  const shutdownCalls: string[] = [];
  const shutdownArgs: unknown[][] = [];
  const bootCalls: string[] = [];
  const resolveCalls: DeviceRequest[] = [];
  const provisionCalls: {
    spec: VirtualSpec;
    claim: { kind: string; owner?: string | undefined } | undefined;
    reservationReleasedAtReturn: number;
    deviceId?: string;
  }[] = [];
  const provisionReservations: { released: number }[] = [];
  const reserveAttempts = { count: 0 };
  const finishProvisioning = async (id: string): Promise<void> => {
    if (options.provisioning === undefined) return;
    await options.provisioning;
    state.devices = state.devices.map((item) =>
      item.id === id ? { ...item, state: "ready" } : item,
    );
  };
  const poolOptions: WarmPoolOptions = {
    baselines: {
      current: (name) => {
        const entry = options.baselines?.[name];
        return entry === undefined
          ? undefined
          : { mode: "full", model: "iPhone 15", osVersion: "26.0", platform: "ios", ...entry };
      },
    },
    acquisition: {
      kick,
      get maintenanceActive() {
        return options.maintenance?.() ?? false;
      },
      resolve: async (request) => {
        resolveCalls.push(request);
        if (options.resolve !== undefined) return options.resolve(request);
        return {
          spec: {
            physical: false,
            model: request.model ?? "",
            osVersion: request.osVersion ?? "26.0",
            platform: request.platform,
            ...((request.mode ?? options.defaultMode) === "slim" ? { mode: "slim" as const } : {}),
          },
        };
      },
      defaultMode: () => options.defaultMode ?? "full",
      waitingDemand,
    },
    capacity: {
      runningCapacity: (devices): RunningCapacity => {
        const running = devices.filter((item) =>
          ["ready", "leased", "reclaiming", "quarantined"].includes(item.state),
        ).length;
        const entry = {
          maxRunning: options.limit ?? 10,
          overLimit: running > (options.limit ?? 10),
          reserved: 0,
          running,
        };
        return { android: entry, global: entry, ios: entry };
      },
      canBoot: (candidate) => {
        if (candidate.id !== undefined) options.onAdmit?.(candidate.id);
        return options.refuseBoot === true ? { ok: false, reason: "ram-budget" } : { ok: true };
      },
      canProvision: () =>
        options.refuseProvision === true ? { ok: false, reason: "device-limit" } : { ok: true },
      tryReserveProvisioning: () => {
        reserveAttempts.count += 1;
        if (options.reserveThrows === true) throw new Error("the budget is unreadable");
        if (options.refuseProvision === true || options.refuseReservation === true)
          return { ok: false, reason: "device-limit" };
        const reservation = { released: 0 };
        provisionReservations.push(reservation);
        return {
          ok: true,
          reservation: {
            release: () => {
              reservation.released += 1;
            },
          },
        };
      },
      tryReserveBoot: () => {
        if (options.refuseBoot === true) return { ok: false, reason: "ram-budget" };
        const reservation = { released: 0 };
        reservations.push(reservation);
        return {
          ok: true,
          reservation: {
            release: () => {
              reservation.released += 1;
            },
          },
        };
      },
    },
    catalog: { listCatalog: options.catalog ?? (async () => []) },
    claims: {
      claim: (id) => claims.claim(id),
      isClaimed: (id) => claims.isClaimed(id),
      operationFor: (id) => claims.operationFor(id),
      tryClaim: (id, operation) =>
        options.refuseClaim === true ? undefined : claims.tryClaim(id, operation),
    },
    clock,
    config: {
      enabled: options.enabled ?? true,
      ...(options.learn === undefined ? {} : { learn: options.learn }),
      ...(options.baselineLearnAfter === undefined
        ? {}
        : { baselineLearnAfter: options.baselineLearnAfter }),
      maxConcurrentBoots: options.maxConcurrentBoots ?? 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: options.targets ?? [],
    },
    decisions: new SerializedDecision(),
    eventBus,
    hasDriver: (platform) => options.refusedPlatforms?.includes(platform) !== true,
    idle: { shutdownAfterMs: 10 * minute },
    lifecycle: {
      bootWarm: async (target, claim) => {
        bootCalls.push(target.id);
        const claimed = claims.isClaimed(target.id) && claims.isActive(claim);
        const last = reservations.at(-1);
        if (last !== undefined) {
          last.claimedAtBoot = claimed;
          last.releasedAtBoot = last.released;
        }
        // why: unlike the real lifecycle this leaves the claim to the caller, so what the pool does
        // about it is what the test sees.
        if (options.boot !== undefined) return options.boot(target);
        return setState(target.id, "ready");
      },
      shutdown: async (target, ...rest) => {
        shutdownCalls.push(target.id);
        shutdownArgs.push(rest);
        if (options.shutdown !== undefined) return options.shutdown(target);
        return setState(target.id, "shutdown");
      },
    },
    logger: new JsonLinesLogger({ clock, sink }),
    provisioner: {
      provision: async (spec, provisionOptions) => {
        const record: (typeof provisionCalls)[number] = {
          claim: provisionOptions.claim,
          reservationReleasedAtReturn: 0,
          spec,
        };
        provisionCalls.push(record);
        try {
          await options.provision?.(spec, provisionCalls.length);
        } catch (error: unknown) {
          provisionOptions.reservation.release();
          throw error instanceof Error ? error : new BootTimeoutError("new");
        }
        const id = `new-${provisionCalls.length}`;
        const created: VirtualDevice = {
          physical: false,
          createdAt: now,
          driverData: {},
          driverDeviceId: `driver-${id}`,
          id,
          mode: "full",
          readyAt: clock.now(),
          spec,
          state: options.provisioning === undefined ? "ready" : "provisioning",
        };
        state.devices = [...state.devices, created];
        const claim = claims.tryClaim(
          id,
          provisionOptions.claim?.kind ?? "boot",
          provisionOptions.claim?.owner,
        );
        if (claim === undefined) throw new Error("the new device is already claimed");
        provisionOptions.reservation.release();
        record.deviceId = id;
        await finishProvisioning(id);
        return { claim, device: created };
      },
    },
    registry: {
      get snapshot() {
        return { leases: state.leases, virtualDevices: state.devices };
      },
    },
    state: options.state ?? learnedState,
  };
  const pool = new WarmPool(poolOptions);
  return {
    bootCalls,
    claims,
    clock,
    eventBus,
    kick,
    lease,
    pool,
    provisionCalls,
    provisionReservations,
    reservations,
    reserveAttempts,
    resolveCalls,
    shutdownArgs,
    shutdownCalls,
    sink,
    state,
    waitingDemand,
  };
}
