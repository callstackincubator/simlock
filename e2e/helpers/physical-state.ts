import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TestEnv } from "./env.js";
import { waitFor } from "./wait.js";

/** The one iPhone every physical-device flow enrols: an iPhone 15 Pro on iOS 18.4, class phone. */
export const PHYSICAL_MODEL = "iPhone 15 Pro";
export const PHYSICAL_OS = "18.4";

/** The principal the seeded leases belong to; pass it to `withDaemon` as `agentId`. */
export const PHYSICAL_AGENT = "physical-agent";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PhysicalSeed {
  /** The registry id, `dev_<name>`. */
  readonly id: string;
  /** The ID the driver would know it by; a physical UDID in real life. */
  readonly driverDeviceId: string;
  readonly state: "ready" | "leased" | "reclaiming" | "quarantined";
  /** Defaults to a day ago for a `reclaiming` record and to an hour ago otherwise. */
  readonly lastLeaseEndedAt?: number;
  readonly enrolledApps?: readonly string[];
}

export interface SeededLease {
  readonly id: string;
  readonly deviceId: string;
  /** Milliseconds from now; negative is a deadline that passed before the daemon started. */
  readonly deadlineInMs: number;
}

/** A ready, a leased and a reclaiming physical record, and the lease on the leased one. */
export const READY: PhysicalSeed = {
  driverDeviceId: "00008110-00000000READY1",
  id: "dev_pready",
  state: "ready",
};
export const LEASED: PhysicalSeed = {
  driverDeviceId: "00008110-00000000LEASD1",
  id: "dev_pleased",
  state: "leased",
};
export const RECLAIMING: PhysicalSeed = {
  driverDeviceId: "00008110-00000000RECLM1",
  id: "dev_preclaim",
  state: "reclaiming",
};
export const HELD_LEASE = (deadlineInMs: number): SeededLease => ({
  deadlineInMs,
  deviceId: LEASED.id,
  id: "lse_pheld",
});

/**
 * Writes `state.json` into the env's home with these physical records in their own list, the
 * way an enrolment would leave it. Call it before the daemon starts (`withDaemon({ mode:
 * "auto" })`).
 */
export async function seedPhysicalState(
  env: Pick<TestEnv, "home">,
  physical: readonly PhysicalSeed[],
  leases: readonly SeededLease[] = [],
): Promise<void> {
  const now = Date.now();
  const state = {
    components: [],
    devices: [],
    leaseRequests: [],
    leases: leases.map((lease) => ({
      deviceId: lease.deviceId,
      grantedAt: now - 60_000,
      id: lease.id,
      idChosenByRequester: false,
      lastRenewedAt: now - 60_000,
      ownerId: PHYSICAL_AGENT,
      requesterId: PHYSICAL_AGENT,
      ttlDeadline: now + lease.deadlineInMs,
      ttlMs: 600_000,
    })),
    physicalDevices: physical.map((seed) => ({
      address: seed.driverDeviceId,
      createdAt: now - 2 * DAY_MS,
      driverData: {},
      driverDeviceId: seed.driverDeviceId,
      enrolledApps: seed.enrolledApps ?? [],
      id: seed.id,
      lastLeaseEndedAt:
        seed.lastLeaseEndedAt ?? now - (seed.state === "reclaiming" ? DAY_MS : 3_600_000),
      physical: true,
      readyAt: now - 2 * DAY_MS,
      spec: {
        class: "phone",
        model: PHYSICAL_MODEL,
        osVersion: PHYSICAL_OS,
        physical: true,
        platform: "ios",
      },
      state: seed.state,
    })),
  };
  await writeFile(join(env.home, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** The fake driver's operations on calls whose arguments name any of these driver device IDs. */
export async function callsNaming(
  env: Pick<TestEnv, "driverLog">,
  ...driverDeviceIds: readonly string[]
): Promise<string[]> {
  return (await env.driverLog.calls())
    .filter((call) => driverDeviceIds.some((id) => JSON.stringify(call.arguments).includes(id)))
    .map((call) => call.operation);
}

/**
 * Runs `check` every 100 ms for `forMs`, so a test can assert that something did not happen. The
 * first failed check ends the observation and is rethrown.
 */
export async function observeFor(forMs: number, check: () => Promise<void>): Promise<void> {
  const until = Date.now() + forMs;
  let failure: unknown;
  await waitFor(
    async () => {
      try {
        await check();
      } catch (error: unknown) {
        failure = error;
        return true;
      }
      return Date.now() >= until;
    },
    { interval: 100, label: "the observation window ends", timeout: forMs + 30_000 },
  );
  if (failure !== undefined) throw failure;
}
