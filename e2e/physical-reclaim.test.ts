import { describe, expect, it } from "vitest";

import type {
  FakeDriverErrorSpec,
  FakeDriverPlatformScript,
  ScriptedPhysicalDevice,
} from "./fake-driver/types.js";
import { waitFor, withDaemon, type TestEnv } from "./helpers/index.js";
import {
  HELD_LEASE,
  LEASED,
  PHYSICAL_AGENT,
  PHYSICAL_MODEL,
  PHYSICAL_OS,
  READY,
  RECLAIMING,
  callsNaming,
  observeFor,
  seedPhysicalState,
  type PhysicalSeed,
  type SeededLease,
} from "./helpers/physical-state.js";
import { patchPhysicalRecords } from "./helpers/physical-presence.js";

const ENROLLED = ["com.example.mail", "com.example.maps"] as const;
const AGENT_APPS = ["com.agent.one", "com.agent.two"] as const;
const RECLAIM_FAILURE: FakeDriverErrorSpec = { message: "device busy", type: "generic" };

interface Row {
  readonly id: string;
  readonly state: string;
  readonly physical?: boolean;
}

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: Row;
}

interface ScriptOptions {
  readonly installed?: readonly string[];
  readonly present?: boolean;
  readonly failReclaim?: boolean;
}

function iosScript(device: PhysicalSeed, options: ScriptOptions = {}): FakeDriverPlatformScript {
  const scripted: ScriptedPhysicalDevice = {
    apps: ENROLLED,
    class: "phone",
    ids: [device.driverDeviceId],
    model: PHYSICAL_MODEL,
    osVersion: PHYSICAL_OS,
    ...(options.installed === undefined ? {} : { installedApps: options.installed }),
    ...(options.present === undefined ? {} : { present: options.present }),
  };
  return {
    availableOsVersions: [PHYSICAL_OS],
    defaultModels: { phone: ["iPhone 16"] },
    ...(options.failReclaim === true ? { failures: { reclaim: RECLAIM_FAILURE } } : {}),
    knownModels: [PHYSICAL_MODEL, "iPhone 16"],
    modelClasses: { "iPhone 16": "phone", [PHYSICAL_MODEL]: "phone" },
    physicalDevices: [scripted],
  };
}

async function startWith(
  physical: PhysicalSeed,
  options: {
    readonly leases?: readonly SeededLease[];
    readonly config?: Record<string, unknown>;
    readonly script?: ScriptOptions;
    readonly patchState?: (device: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): Promise<TestEnv> {
  const seed = { ...physical, enrolledApps: ENROLLED };
  const env = await withDaemon({
    agentId: PHYSICAL_AGENT,
    configOverrides: options.config ?? {},
    driverScript: { ios: iosScript(seed, options.script) },
    mode: "auto",
  });
  await seedPhysicalState(env, [seed], options.leases ?? []);
  if (options.patchState !== undefined) await patchPhysicalRecords(env, options.patchState);
  const started = await env.startDaemon();
  expect(started.code, started.stderr).toBe(0);
  return env;
}

async function setScript(
  env: TestEnv,
  physical: PhysicalSeed,
  options: ScriptOptions,
): Promise<void> {
  await env.driverScript.set({ ios: iosScript(physical, options) });
}

async function stateOf(env: TestEnv, id: string): Promise<string | undefined> {
  const result = await env.cli(["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return ((result.json as { devices?: Row[] }).devices ?? []).find((row) => row.id === id)?.state;
}

async function waitForState(env: TestEnv, id: string, state: string): Promise<void> {
  await waitFor(async () => (await stateOf(env, id)) === state, {
    label: () => `${id} is ${state}`,
    timeout: 30_000,
  });
}

async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

async function waitForEvent(env: TestEnv, name: string) {
  await waitFor(async () => (await named(env, name)).length > 0, {
    label: () => `${name} is emitted`,
    timeout: 30_000,
  });
  const [entry] = await named(env, name);
  return entry?.payload as Record<string, unknown>;
}

async function uninstalls(env: TestEnv): Promise<(readonly unknown[])[]> {
  return (await env.driverLog.calls())
    .filter((call) => call.operation === "uninstall")
    .map((call) => call.arguments)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function leasePhysical(env: TestEnv): Promise<Grant> {
  const result = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--physical",
    "--agent-id",
    "reclaim-agent",
    "--detach",
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

describe("a released physical device is reclaimed by uninstalling the apps enrolment did not list", () => {
  it("a release uninstalls exactly the apps not on the enrollment app list, the device is ready again, and device.reclaimed has strategy uninstall and empty missingApps", async () => {
    const env = await startWith(READY);
    const grant = await leasePhysical(env);
    expect(grant.device.id).toBe(READY.id);
    await setScript(env, READY, { installed: [...ENROLLED, ...AGENT_APPS] });

    const released = await env.cli(["release", grant.lease.id]);
    expect(released.code, released.stderr).toBe(0);

    const reclaimed = await waitForEvent(env, "device.reclaimed");
    expect(reclaimed).toMatchObject({ deviceId: READY.id, missingApps: [], strategy: "uninstall" });
    await waitForState(env, READY.id, "ready");
    expect(await uninstalls(env)).toEqual([
      [READY.driverDeviceId, "com.agent.one"],
      [READY.driverDeviceId, "com.agent.two"],
    ]);
  });

  it("an enrollment app the agent removed is reported in missingApps and not reinstalled", async () => {
    const env = await startWith(READY);
    const grant = await leasePhysical(env);
    await setScript(env, READY, { installed: ["com.example.maps"] });

    const released = await env.cli(["release", grant.lease.id]);
    expect(released.code, released.stderr).toBe(0);

    const reclaimed = await waitForEvent(env, "device.reclaimed");
    expect(reclaimed).toMatchObject({ missingApps: ["com.example.mail"], strategy: "uninstall" });
    await waitForState(env, READY.id, "ready");
    expect(await uninstalls(env)).toEqual([]);
    const script = await env.driverScript.get();
    expect(script.ios?.physicalDevices?.[0]?.installedApps).toEqual(["com.example.maps"]);
  });

  it("an expired physical lease is reclaimed the same way", async () => {
    const env = await startWith(LEASED, {
      leases: [HELD_LEASE(2_000)],
      script: { installed: [...ENROLLED, ...AGENT_APPS] },
    });

    await waitForEvent(env, "lease.expired");

    const reclaimed = await waitForEvent(env, "device.reclaimed");
    expect(reclaimed).toMatchObject({
      deviceId: LEASED.id,
      missingApps: [],
      strategy: "uninstall",
    });
    await waitForState(env, LEASED.id, "ready");
    expect(await uninstalls(env)).toEqual([
      [LEASED.driverDeviceId, "com.agent.one"],
      [LEASED.driverDeviceId, "com.agent.two"],
    ]);
  });

  it("simlock nuke --delete-devices --yes with a physical lease ends it, uninstalls its apps, and leaves the device enrolled and ready; the fake driver log has no shutdown or destroy naming it", async () => {
    const env = await startWith(LEASED, {
      leases: [HELD_LEASE(600_000)],
      script: { installed: [...ENROLLED, ...AGENT_APPS] },
    });

    const nuke = await env.cli(["nuke", "--delete-devices", "--yes"]);
    expect(nuke.code, nuke.stderr).toBe(0);

    expect((await env.cli(["list", "--leases"])).json).toEqual([]);
    await waitForState(env, LEASED.id, "ready");
    expect(await uninstalls(env)).toEqual([
      [LEASED.driverDeviceId, "com.agent.one"],
      [LEASED.driverDeviceId, "com.agent.two"],
    ]);
    const naming = await callsNaming(env, LEASED.driverDeviceId);
    expect(naming).not.toContain("shutdown");
    expect(naming).not.toContain("destroy");
  });
});

describe("a physical reclaim that fails quarantines the device", () => {
  it("a quarantine retry that succeeds makes the device ready with device.quarantine-recovered strategy uninstall and missingApps", async () => {
    const env = await startWith(LEASED, {
      config: { warmPool: { quarantine: { retryBackoffMs: 1_500 } } },
      leases: [HELD_LEASE(600_000)],
      script: { failReclaim: true, installed: ["com.example.maps", ...AGENT_APPS] },
    });
    const released = await env.cli(["release", "lse_pheld"]);
    expect(released.code, released.stderr).toBe(0);
    await waitForState(env, LEASED.id, "quarantined");

    await setScript(env, LEASED, { installed: ["com.example.maps", ...AGENT_APPS] });

    const recovered = await waitForEvent(env, "device.quarantine-recovered");
    expect(recovered).toMatchObject({
      deviceId: LEASED.id,
      missingApps: ["com.example.mail"],
      strategy: "uninstall",
    });
    await waitForState(env, LEASED.id, "ready");
    expect(await uninstalls(env)).toEqual([
      [LEASED.driverDeviceId, "com.agent.one"],
      [LEASED.driverDeviceId, "com.agent.two"],
    ]);
  });

  it("when retries run out the device is deleted in simlock status, with device.deleted initiator quarantine and physical true, then device.quarantine-abandoned, and the fake driver log has no destroy", async () => {
    const env = await startWith(LEASED, {
      config: {
        warmPool: {
          quarantine: { maxRetries: 1, retryBackoffMs: 300, retryBackoffMultiplier: 1 },
        },
      },
      leases: [HELD_LEASE(600_000)],
      script: { failReclaim: true, installed: [...ENROLLED, ...AGENT_APPS] },
    });

    const released = await env.cli(["release", "lse_pheld"]);
    expect(released.code, released.stderr).toBe(0);

    await waitForEvent(env, "device.quarantine-abandoned");
    expect(await stateOf(env, LEASED.id)).toBe("deleted");
    const events = await named(env, "device.deleted", "device.quarantine-abandoned");
    expect(events.map((entry) => entry.event)).toEqual([
      "device.deleted",
      "device.quarantine-abandoned",
    ]);
    expect(events[0]?.payload).toMatchObject({
      deviceId: LEASED.id,
      initiator: "quarantine",
      physical: true,
    });
    const operations = (await env.driverLog.calls()).map((call) => call.operation);
    expect(operations).not.toContain("destroy");
  });
});

describe("a physical device that was mid-reclaim or quarantined when the daemon stopped", () => {
  it("a physical device left reclaiming in state.db that is not present stays reclaiming after a daemon start; doctor --fix past its estimate quarantines it, and it is retried after retryBackoffMs once present", async () => {
    const env = await startWith(RECLAIMING, {
      config: { warmPool: { quarantine: { retryBackoffMs: 1_500 } } },
      script: { installed: [...ENROLLED, ...AGENT_APPS], present: false },
    });
    await observeFor(1_500, async () => {
      expect(await stateOf(env, RECLAIMING.id), "the start leaves it reclaiming").toBe(
        "reclaiming",
      );
    });

    const fixed = await env.cli(["doctor", "--fix"]);
    expect(fixed.code, fixed.stderr).toBe(0);
    expect(await stateOf(env, RECLAIMING.id)).toBe("quarantined");
    await setScript(env, RECLAIMING, { installed: [...ENROLLED, ...AGENT_APPS] });

    await waitForState(env, RECLAIMING.id, "ready");
    expect(await uninstalls(env)).toEqual([
      [RECLAIMING.driverDeviceId, "com.agent.one"],
      [RECLAIMING.driverDeviceId, "com.agent.two"],
    ]);
  });

  it("a daemon restarted with a quarantined physical device in state.db retries it after its quarantineNextRetryAt", async () => {
    const nextRetryAt = Date.now() + 2_500;
    const env = await startWith(
      { ...READY, state: "quarantined" },
      {
        patchState: (device) => ({
          ...device,
          quarantineAttempts: 1,
          quarantineNextRetryAt: nextRetryAt,
        }),
        script: { installed: [...ENROLLED, ...AGENT_APPS] },
      },
    );
    expect(await stateOf(env, READY.id)).toBe("quarantined");

    await waitForState(env, READY.id, "ready");

    const calls = (await env.driverLog.calls()).filter((call) => call.operation === "uninstall");
    expect(calls.map((call) => call.arguments)).toEqual([
      [READY.driverDeviceId, "com.agent.one"],
      [READY.driverDeviceId, "com.agent.two"],
    ]);
    for (const call of calls) expect(call.timestampMs).toBeGreaterThanOrEqual(nextRetryAt);
  });
});
