import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { waitFor, waitForDeviceState, withDaemon, type TestEnv } from "./helpers/index.js";

interface Grant {
  readonly lease: { readonly id: string; readonly ttlDeadline: number };
  readonly device: { readonly id: string; readonly driverDeviceId: string };
}

interface Leased {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly driverDeviceId: string;
  readonly ttlDeadline: number;
}

type Platform = "ios" | "android";

const MODELS = {
  ios: { model: "iPhone 16", os: "18.4" },
  android: { model: "Pixel 8", os: "34" },
} as const;

async function prepare(env: TestEnv, extra: Record<string, unknown> = {}): Promise<void> {
  await env.driverScript.set({
    ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"], ...extra },
    android: { availableOsVersions: ["34"], knownModels: ["Pixel 8"] },
  });
}

async function lease(env: TestEnv, platform: Platform, ttl?: string): Promise<Leased> {
  const { model, os } = MODELS[platform];
  const result = await env.cli([
    "lease",
    "--platform",
    platform,
    "--device",
    model,
    "--os",
    os,
    "--agent-id",
    `startup-${platform}`,
    "--detach",
    ...(ttl === undefined ? [] : ["--ttl", ttl]),
  ]);
  expect(result.code, result.stderr).toBe(0);
  const grant = result.json as Grant;
  return {
    deviceId: grant.device.id,
    driverDeviceId: grant.device.driverDeviceId,
    leaseId: grant.lease.id,
    ttlDeadline: grant.lease.ttlDeadline,
  };
}

/** What the fake driver reports a platform's devices as, whatever the previous daemon knew. */
async function script(
  env: TestEnv,
  platform: Platform,
  devices: readonly { deviceId: string; runState: "running" | "stopped" | "transitioning" }[],
): Promise<void> {
  await env.driverScript.merge({ [platform]: { managedReality: { devices } } });
}

async function stopDaemon(env: TestEnv): Promise<void> {
  expect((await env.cli(["daemon", "stop"])).code).toBe(0);
  await waitFor(() => !existsSync(env.socketPath), { label: "daemon socket removed" });
}

async function restart(env: TestEnv): Promise<void> {
  await stopDaemon(env);
  const started = await env.startDaemon();
  expect(started.code, started.stderr).toBe(0);
}

async function renewError(env: TestEnv, leaseId: string): Promise<string | undefined> {
  return (await env.cli(["lease", "renew", leaseId])).error?.code;
}

async function leaseEvents(env: TestEnv, leaseId: string) {
  return (await env.events()).filter(
    (entry) =>
      (entry.event === "lease.released" || entry.event === "lease.expired") &&
      (entry.payload as { leaseId?: string }).leaseId === leaseId,
  );
}

async function reclaimCalls(env: TestEnv, driverDeviceId: string) {
  return (await env.driverLog.calls()).filter(
    (call) =>
      call.operation === "reclaim" &&
      (call.arguments[0] as { deviceId?: string }).deviceId === driverDeviceId,
  );
}

async function deviceState(env: TestEnv, deviceId: string): Promise<string | undefined> {
  const rows = (await env.cli(["list", "--devices"])).json as { id: string; state: string }[];
  return rows.find((row) => row.id === deviceId)?.state;
}

describe("startup ends every lease whose device is not running", () => {
  it("a daemon restarted after its leased device was scripted stopped answers a renew of that lease with UNKNOWN_LEASE, records lease.released with reason device-lost, and the device becomes ready after reclaim", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "stopped" }]);
    await restart(env);

    expect(await renewError(env, held.leaseId)).toBe("UNKNOWN_LEASE");
    const ended = await leaseEvents(env, held.leaseId);
    expect(ended.map((entry) => entry.event)).toEqual(["lease.released"]);
    expect(ended[0]?.payload).toMatchObject({ leaseId: held.leaseId, reason: "device-lost" });
    await waitForDeviceState(env, held.driverDeviceId, "ready");
    expect(await reclaimCalls(env, held.driverDeviceId)).toHaveLength(1);
  });

  it("a daemon restarted after its leased device was scripted transitioning answers a renew with UNKNOWN_LEASE, records lease.released with reason device-lost, and the device becomes ready after reclaim", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "transitioning" }]);
    await restart(env);

    expect(await renewError(env, held.leaseId)).toBe("UNKNOWN_LEASE");
    const ended = await leaseEvents(env, held.leaseId);
    expect(ended[0]?.payload).toMatchObject({ leaseId: held.leaseId, reason: "device-lost" });
    await waitForDeviceState(env, held.driverDeviceId, "ready");
  });

  it("a daemon restarted after its leased device was removed from the scripted reality ends the lease, emits device.deleted with initiator doctor, and the fake driver log shows no reclaim call for it", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await script(env, "ios", []);
    await restart(env);

    expect(await renewError(env, held.leaseId)).toBe("UNKNOWN_LEASE");
    const ended = await leaseEvents(env, held.leaseId);
    expect(ended[0]?.payload).toMatchObject({ leaseId: held.leaseId, reason: "device-lost" });
    const deleted = (await env.events()).filter((entry) => entry.event === "device.deleted");
    expect(deleted.map((entry) => entry.payload)).toEqual([
      { deviceId: held.deviceId, initiator: "doctor" },
    ]);
    expect(await reclaimCalls(env, held.driverDeviceId)).toEqual([]);
  });

  it("a daemon restarted with SIMLOCK_FAKE_DRIVER_PLATFORMS naming only the other platform ends the lease and leaves the device reclaiming, unclaimed", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await stopDaemon(env);
    env.env.SIMLOCK_FAKE_DRIVER_PLATFORMS = "android";
    expect((await env.startDaemon()).code).toBe(0);

    expect(await renewError(env, held.leaseId)).toBe("UNKNOWN_LEASE");
    expect((await leaseEvents(env, held.leaseId))[0]?.payload).toMatchObject({
      reason: "device-lost",
    });
    expect(await deviceState(env, held.deviceId)).toBe("reclaiming");
    expect(await reclaimCalls(env, held.driverDeviceId)).toEqual([]);
  });

  it("a daemon restarted with listManaged scripted to fail on a platform leaves that platform's leased device reclaiming, and the fake driver log shows no reclaim call for it", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await prepare(env, {
      failures: { listManaged: { type: "generic", message: "listing broke" } },
    });
    await restart(env);

    expect(await renewError(env, held.leaseId)).toBe("UNKNOWN_LEASE");
    expect(await deviceState(env, held.deviceId)).toBe("reclaiming");
    expect(await reclaimCalls(env, held.driverDeviceId)).toEqual([]);
  });

  it("a daemon restarted after that with the listing working recovers the device as an interrupted reclaim", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");
    await prepare(env, {
      failures: { listManaged: { type: "generic", message: "listing broke" } },
    });
    await restart(env);
    expect(await deviceState(env, held.deviceId)).toBe("reclaiming");

    await prepare(env);
    await restart(env);

    await waitForDeviceState(env, held.driverDeviceId, "ready");
    expect(await reclaimCalls(env, held.driverDeviceId)).toHaveLength(1);
  });

  it("a daemon restarted with listManaged scripted to fail on one platform reaches running, ends that platform's leases, and keeps a running lease on the other platform", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const ios = await lease(env, "ios");
    const android = await lease(env, "android");

    await prepare(env, {
      failures: { listManaged: { type: "generic", message: "listing broke" } },
    });
    await script(env, "android", [{ deviceId: android.driverDeviceId, runState: "running" }]);
    await restart(env);

    expect(
      ((await env.cli(["daemon", "status"])).json as { daemon: { health: string } }).daemon.health,
    ).toBe("running");
    expect(await renewError(env, ios.leaseId)).toBe("UNKNOWN_LEASE");
    expect(await renewError(env, android.leaseId)).toBeUndefined();
  });

  it("a daemon restarted with a leased device scripted running keeps the lease, and a renew of it succeeds", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");

    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "running" }]);
    await restart(env);

    const renewed = await env.cli(["lease", "renew", held.leaseId]);
    expect(renewed.code, renewed.stderr).toBe(0);
    expect((renewed.json as { ttlDeadline: number }).ttlDeadline).toBeGreaterThan(held.ttlDeadline);
    expect(await leaseEvents(env, held.leaseId)).toEqual([]);
    expect(await reclaimCalls(env, held.driverDeviceId)).toEqual([]);
  });

  it("a lease whose deadline passed while the daemon was down emits lease.expired at the restart and no lease.released, and with its device scripted running it is reclaimed", async () => {
    const env = await withDaemon();
    await prepare(env);
    const held = await lease(env, "ios", "2s");

    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "running" }]);
    await stopDaemon(env);
    await waitFor(() => Date.now() > held.ttlDeadline, { label: "lease deadline passed" });
    expect((await env.startDaemon()).code).toBe(0);

    const ended = await leaseEvents(env, held.leaseId);
    expect(ended.map((entry) => entry.event)).toEqual(["lease.expired"]);
    await waitForDeviceState(env, held.driverDeviceId, "ready");
    expect(await reclaimCalls(env, held.driverDeviceId)).toHaveLength(1);
  });

  it("a lease whose deadline passed while the daemon was down, with its device removed from the scripted reality, is marked missing with no reclaim call", async () => {
    const env = await withDaemon();
    await prepare(env);
    const held = await lease(env, "ios", "2s");

    await script(env, "ios", []);
    await stopDaemon(env);
    await waitFor(() => Date.now() > held.ttlDeadline, { label: "lease deadline passed" });
    expect((await env.startDaemon()).code).toBe(0);

    const ended = await leaseEvents(env, held.leaseId);
    expect(ended.map((entry) => entry.event)).toEqual(["lease.expired"]);
    const deleted = (await env.events()).filter((entry) => entry.event === "device.deleted");
    expect(deleted.map((entry) => entry.payload)).toEqual([
      { deviceId: held.deviceId, initiator: "doctor" },
    ]);
    expect(await reclaimCalls(env, held.driverDeviceId)).toEqual([]);
  });

  it("startup calls listManaged once per platform, per the fake driver's log", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");
    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "stopped" }]);
    await stopDaemon(env);
    await env.driverLog.clear();

    expect((await env.startDaemon()).code).toBe(0);

    const listings = (await env.driverLog.calls()).filter(
      (call) => call.operation === "listManaged",
    );
    expect(listings.map((call) => call.platform).sort()).toEqual(["android", "ios"]);
  });

  it("a lease.request sent while the daemon is starting is answered only after every voided lease's lease.released is in the event history", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
    await prepare(env);
    const held = await lease(env, "ios");
    await script(env, "ios", [{ deviceId: held.driverDeviceId, runState: "stopped" }]);
    await stopDaemon(env);
    await prepare(env, {
      latencyMs: { listManaged: 3_000 },
      managedReality: { devices: [{ deviceId: held.driverDeviceId, runState: "stopped" }] },
    });

    const start = env.cliBackground(["daemon", "start"]);
    await waitFor(() => existsSync(env.socketPath), { label: "daemon claimed its socket" });
    const request = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "startup-parked",
    ]);
    await request.firstStdoutLine(30_000);

    const released = await leaseEvents(env, held.leaseId);
    expect(released.map((entry) => entry.event)).toEqual(["lease.released"]);
    expect((await start.waitForExit(30_000)).code).toBe(0);
  });
});
