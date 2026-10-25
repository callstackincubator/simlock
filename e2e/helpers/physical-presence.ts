import { expect } from "vitest";

import type { FakeDriverErrorSpec, FakeDriverPlatformScript } from "../fake-driver/types.js";
import type { CliBackgroundHandle } from "./cli.js";
import { withDaemon, type TestEnv } from "./env.js";
import {
  PHYSICAL_AGENT,
  PHYSICAL_MODEL,
  PHYSICAL_OS,
  seedPhysicalState,
  type PhysicalSeed,
  type SeededLease,
} from "./physical-state.js";
import { patchPhysicalRows, readPhysicalRecords } from "./state-db.js";
import { waitFor } from "./wait.js";

export const ENROLLED = ["com.example.mail", "com.example.maps"] as const;
export const AGENT_APPS = ["com.agent.one", "com.agent.two"] as const;
const RECLAIM_FAILURE: FakeDriverErrorSpec = { message: "device busy", type: "generic" };

const GRACE_HEALTH = { probeIntervalMs: 200, stableObservations: 2 };

export type AbsentReason = "locked" | "untrusted" | "not-present";

export interface PresenceSeed extends Omit<PhysicalSeed, "state"> {
  readonly state: PhysicalSeed["state"] | "absent";
  readonly absentReason?: AbsentReason;
  readonly quarantineAttempts?: number;
  readonly quarantineNextRetryAt?: number;
}

export const READY_TWO: PresenceSeed = {
  driverDeviceId: "00008110-00000000READY2",
  id: "dev_pready2",
  state: "ready",
};
export const ABSENT: PresenceSeed = {
  absentReason: "not-present",
  driverDeviceId: "00008110-00000000ABSNT1",
  id: "dev_pabsent",
  state: "absent",
};
export const QUARANTINED: PresenceSeed = {
  driverDeviceId: "00008110-00000000QUART1",
  id: "dev_pquarant",
  quarantineAttempts: 1,
  state: "quarantined",
};

export interface DeviceScript {
  readonly present?: boolean;
  readonly absentReason?: AbsentReason;
  readonly osVersion?: string;
  readonly installed?: readonly string[];
  readonly apps?: readonly string[];
  readonly connected?: boolean;
}

export interface ScriptedSeed {
  readonly seed: PresenceSeed;
  readonly script?: DeviceScript;
}

function scriptedExtras(script: DeviceScript | undefined) {
  return {
    ...(script?.installed === undefined ? {} : { installedApps: script.installed }),
    ...(script?.present === undefined ? {} : { present: script.present }),
    ...(script?.absentReason === undefined ? {} : { absentReason: script.absentReason }),
  };
}

function iosScript(
  devices: readonly ScriptedSeed[],
  options: { readonly failReclaim?: boolean } = {},
): FakeDriverPlatformScript {
  const physicalDevices = devices
    .filter(({ script }) => script?.connected !== false)
    .map(({ seed, script }) => ({
      apps: script?.apps ?? ENROLLED,
      class: "phone" as const,
      ids: [seed.driverDeviceId],
      model: PHYSICAL_MODEL,
      osVersion: script?.osVersion ?? PHYSICAL_OS,
      ...scriptedExtras(script),
    }));
  return {
    availableOsVersions: [PHYSICAL_OS],
    defaultModels: { phone: ["iPhone 16"] },
    ...(options.failReclaim === true ? { failures: { reclaim: RECLAIM_FAILURE } } : {}),
    knownModels: [PHYSICAL_MODEL, "iPhone 16"],
    modelClasses: { "iPhone 16": "phone", [PHYSICAL_MODEL]: "phone" },
    physicalDevices,
  };
}

export async function setIosScript(
  env: TestEnv,
  devices: readonly ScriptedSeed[],
  options: { readonly failReclaim?: boolean } = {},
): Promise<void> {
  await env.driverScript.set({ ios: iosScript(devices, options) });
}

export async function setPresence(
  env: TestEnv,
  seed: PresenceSeed,
  script: DeviceScript,
  options: { readonly failReclaim?: boolean } = {},
): Promise<void> {
  await setIosScript(env, [{ script, seed }], options);
}

export interface StartOptions {
  readonly health?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly leases?: readonly SeededLease[];
  readonly failReclaim?: boolean;
}

export async function startPresence(
  devices: readonly ScriptedSeed[],
  options: StartOptions = {},
): Promise<TestEnv> {
  const seeds = devices.map(({ seed }) => ({
    ...seed,
    enrolledApps: seed.enrolledApps ?? ENROLLED,
  }));
  const env = await withDaemon({
    agentId: PHYSICAL_AGENT,
    configOverrides: {
      health: { ...GRACE_HEALTH, ...options.health },
      ...options.config,
    },
    driverScript: {
      ios: iosScript(devices, options.failReclaim === true ? { failReclaim: true } : {}),
    },
    mode: "auto",
  });
  await seedPhysicalState(
    env,
    seeds.map((seed) => ({ ...seed, state: seed.state === "absent" ? "ready" : seed.state })),
    options.leases ?? [],
  );
  await patchPhysicalRecords(env, (record) => {
    const seed = seeds.find((candidate) => candidate.id === record["id"]);
    if (seed === undefined) return record;
    return {
      ...record,
      ...(seed.state === "absent" ? { absentReason: seed.absentReason, state: "absent" } : {}),
      ...(seed.state === "quarantined"
        ? {
            quarantineAttempts: seed.quarantineAttempts ?? 1,
            quarantineNextRetryAt: seed.quarantineNextRetryAt ?? Date.now() - 1_000,
            quarantinedAt: Date.now() - 60_000,
          }
        : {}),
    };
  });
  const started = await env.startDaemon();
  expect(started.code, started.stderr).toBe(0);
  return env;
}

export async function patchPhysicalRecords(
  env: Pick<TestEnv, "home">,
  patch: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  patchPhysicalRows(env, patch);
}

export async function physicalRecords(
  env: Pick<TestEnv, "home">,
): Promise<Record<string, unknown>[]> {
  return readPhysicalRecords(env);
}

export interface DeviceRow {
  readonly id: string;
  readonly state: string;
  readonly driverDeviceId?: string;
  readonly absentReason?: string;
  readonly quarantineAttempts?: number;
  readonly quarantineNextRetryAt?: number;
  readonly spec: { readonly osVersion?: string };
}

export async function statusJson(env: TestEnv): Promise<{
  readonly devices: readonly DeviceRow[];
  readonly leases: readonly unknown[];
}> {
  const result = await env.cli(["status", "--json"]);
  if (result.code !== 0) throw new Error(`status --json failed: ${result.stderr}`);
  return result.json as { devices: readonly DeviceRow[]; leases: readonly unknown[] };
}

export async function rowOf(env: TestEnv, id: string): Promise<DeviceRow | undefined> {
  return (await statusJson(env)).devices.find((row) => row.id === id);
}

export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  let last = await read();
  await waitFor(
    async () => {
      last = await read();
      return done(last);
    },
    { interval: 100, timeout: timeoutMs },
  ).catch(() => undefined);
  return last;
}

export async function rowWhere(
  env: TestEnv,
  id: string,
  done: (row: DeviceRow | undefined) => boolean,
  timeoutMs?: number,
): Promise<DeviceRow | undefined> {
  return until(() => rowOf(env, id), done, timeoutMs);
}

export async function rowInState(
  env: TestEnv,
  id: string,
  state: string,
  timeoutMs?: number,
): Promise<DeviceRow | undefined> {
  return rowWhere(env, id, (row) => row?.state === state, timeoutMs);
}

export async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

export async function payloadsOf(
  env: TestEnv,
  name: string,
): Promise<readonly Record<string, unknown>[]> {
  return (await named(env, name)).map((entry) => entry.payload as Record<string, unknown>);
}

export async function firstPayload(
  env: TestEnv,
  name: string,
  timeoutMs?: number,
): Promise<Record<string, unknown> | undefined> {
  const seen = await until(
    () => payloadsOf(env, name),
    (list) => list.length > 0,
    timeoutMs,
  );
  return seen[0];
}

export interface Grant {
  readonly lease: { readonly id: string };
  readonly device: { readonly id: string; readonly driverDeviceId: string };
}

export function physicalLeaseArgs(agent: string, ...extra: readonly string[]): string[] {
  return ["lease", "--platform", "ios", "--physical", "--agent-id", agent, ...extra];
}

export async function leaseDetached(env: TestEnv, agent = "presence-agent"): Promise<Grant> {
  const result = await env.cli(physicalLeaseArgs(agent, "--detach"), { timeout: 30_000 });
  if (result.code !== 0) throw new Error(`lease failed (${String(result.code)}): ${result.stderr}`);
  return result.json as Grant;
}

export async function queuedAtFirst(handle: CliBackgroundHandle): Promise<boolean> {
  return until(
    async () =>
      handle.progressEvents().some((event) => {
        const record = event as Record<string, unknown>;
        return (
          record["push"] === "progress" &&
          record["stage"] === "queued" &&
          record["queuePosition"] === 1
        );
      }),
    Boolean,
  );
}

export async function callsOn(env: TestEnv, driverDeviceId: string) {
  return (await env.driverLog.calls()).filter((call) =>
    JSON.stringify(call.arguments).includes(driverDeviceId),
  );
}

export async function presenceReadTimes(env: TestEnv, driverDeviceId: string): Promise<number[]> {
  return (await callsOn(env, driverDeviceId))
    .filter((call) => call.operation === "listPresentPhysical")
    .map((call) => call.timestampMs);
}

export async function changingCallsOn(env: TestEnv, driverDeviceId: string): Promise<string[]> {
  return (await callsOn(env, driverDeviceId))
    .map((call) => String(call.operation))
    .filter((operation) => ["reclaim", "uninstall", "shutdown", "destroy"].includes(operation));
}

export async function uninstallsOf(env: TestEnv): Promise<(readonly unknown[])[]> {
  return (await env.driverLog.calls())
    .filter((call) => call.operation === "uninstall")
    .map((call) => call.arguments)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
