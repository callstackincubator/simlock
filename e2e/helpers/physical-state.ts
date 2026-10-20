import type { TestEnv } from "./env.js";
import { openSeedDatabase } from "./state-db.js";
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

/** A shut-down simulator in the registry's own `devices` list, beside the physical records. */
export interface ShutdownSimulatorSeed {
  readonly id: string;
  readonly driverDeviceId: string;
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

export async function seedPhysicalState(
  env: Pick<TestEnv, "home">,
  physical: readonly PhysicalSeed[],
  leases: readonly SeededLease[] = [],
  simulators: readonly ShutdownSimulatorSeed[] = [],
): Promise<void> {
  const now = Date.now();
  const state = await openSeedDatabase(env);
  try {
    state.transaction(() => {
      const { database } = state;
      for (const simulator of simulators) {
        database
          .prepare(
            `INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version,
               mode, created_at, shutdown_at) VALUES (?, 'ios', 0, ?, 'shutdown', ?, ?, 'full', ?, ?)`,
          )
          .run(
            simulator.id,
            simulator.driverDeviceId,
            PHYSICAL_MODEL,
            PHYSICAL_OS,
            now - 2 * DAY_MS,
            now - DAY_MS,
          );
        database
          .prepare("INSERT INTO e2e_fake_device_data (device_id, fake_device_id) VALUES (?, ?)")
          .run(simulator.id, simulator.driverDeviceId);
      }
      for (const seed of physical) {
        database
          .prepare(
            `INSERT INTO devices (id, platform, physical, driver_device_id, state, model, os_version,
               class, created_at, last_lease_ended_at, ready_at, address)
             VALUES (?, 'ios', 1, ?, ?, ?, ?, 'phone', ?, ?, ?, ?)`,
          )
          .run(
            seed.id,
            seed.driverDeviceId,
            seed.state,
            PHYSICAL_MODEL,
            PHYSICAL_OS,
            now - 2 * DAY_MS,
            seed.lastLeaseEndedAt ?? now - (seed.state === "reclaiming" ? DAY_MS : 3_600_000),
            now - 2 * DAY_MS,
            seed.driverDeviceId,
          );
        (seed.enrolledApps ?? []).forEach((app, position) => {
          database
            .prepare("INSERT INTO device_enrolled_apps (device_id, position, app) VALUES (?, ?, ?)")
            .run(seed.id, position, app);
        });
      }
      for (const lease of leases) {
        database
          .prepare(
            `INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms,
               ttl_deadline, last_renewed_at, id_chosen_by_requester) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            lease.id,
            lease.deviceId,
            PHYSICAL_AGENT,
            PHYSICAL_AGENT,
            now - 60_000,
            600_000,
            now + lease.deadlineInMs,
            now - 60_000,
          );
      }
    });
  } finally {
    state.close();
  }
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
