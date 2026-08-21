import { describe, expect, it } from "vitest";

import type { CliBackgroundHandle } from "./helpers/cli.js";
import { waitFor, waitForLeaseCount, withDaemon } from "./helpers/index.js";

interface DeviceRow {
  readonly driverDeviceId: string;
  readonly id: string;
  readonly state: string;
}

interface LeaseGrant {
  readonly lease: string;
  readonly udid: string;
}

interface HealthPushLine {
  readonly attempts?: number;
  readonly device_id: string;
  readonly event: string;
  readonly lease: string;
}

const HEALTH_CONFIG_BASE = {
  probeIntervalMs: 150,
  recoveryBackoffMs: 50,
  stableObservations: 1,
};

function leaseHeld(
  env: Awaited<ReturnType<typeof withDaemon>>,
  agentId: string,
): CliBackgroundHandle {
  return env.cliBackground([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--agent-id",
    agentId,
  ]);
}

async function grantOf(held: CliBackgroundHandle): Promise<LeaseGrant> {
  return JSON.parse(await held.firstStdoutLine()) as LeaseGrant;
}

function healthLines(held: CliBackgroundHandle): HealthPushLine[] {
  return held.progressEvents() as HealthPushLine[];
}

describe("leased device crash recovery", () => {
  it("reboots a crashed leased device under its existing lease and keeps the lease alive", async () => {
    const env = await withDaemon({
      configOverrides: {
        health: HEALTH_CONFIG_BASE,
        limits: { ios: { maxDevices: 2, maxRunning: 2 }, maxRunning: 2 },
      },
    });
    await env.driverScript.set({
      ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] },
    });

    const held = leaseHeld(env, "crash-recovery-a");
    const grant = await grantOf(held);
    await waitForLeaseCount(env, 1);

    // Simulate the Activity-Monitor kill: the simulator process is gone but the
    // device still exists. `managedReality` overrides the *whole* listManaged()
    // result, so every device that should still be visible must be listed here --
    // an omitted device reads as "missing", which is the unrecoverable branch, not
    // this one.
    await env.driverScript.merge({
      ios: { managedReality: { devices: [{ deviceId: grant.udid, runState: "stopped" }] } },
    });

    await waitFor(() => healthLines(held).some((line) => line.event === "device_unhealthy"), {
      label: "held CLI reports device_unhealthy",
      timeout: 15_000,
    });
    await waitFor(() => healthLines(held).some((line) => line.event === "device_recovered"), {
      label: "held CLI reports device_recovered",
      timeout: 15_000,
    });

    // Determinism note: while `managedReality` still says "stopped", every tick
    // re-detects the same crash -- a scripted reality does not change just because
    // the fake driver rebooted the device -- so several device_unhealthy /
    // device_recovered pairs may already have landed. Restore "running" now that
    // we've observed at least one pair, so the recovered state settles; the
    // assertions below deliberately don't depend on an exact recovery count.
    await env.driverScript.merge({
      ios: { managedReality: { devices: [{ deviceId: grant.udid, runState: "running" }] } },
    });

    const lines = healthLines(held);
    const unhealthyIndex = lines.findIndex((line) => line.event === "device_unhealthy");
    const recoveredIndex = lines.findIndex((line) => line.event === "device_recovered");
    expect(unhealthyIndex).toBeGreaterThanOrEqual(0);
    expect(recoveredIndex, "device_recovered must follow device_unhealthy").toBeGreaterThan(
      unhealthyIndex,
    );
    expect(lines[unhealthyIndex]).toMatchObject({
      device_id: expect.any(String),
      lease: grant.lease,
    });
    expect(lines[recoveredIndex]).toMatchObject({ lease: grant.lease });

    await env.expectEvents(["device.crash-detected", "device.recovered"]);

    // The device really was rebooted, not just reported: a second makeReady call
    // for this udid (the first was the original boot at grant time).
    const calls = await env.driverLog.calls();
    const makeReadyCallsForDevice = calls.filter(
      (call) =>
        call.operation === "makeReady" &&
        (call.arguments[0] as { deviceId: string }).deviceId === grant.udid,
    );
    expect(
      makeReadyCallsForDevice.length,
      `expected at least 2 makeReady calls for ${grant.udid}, saw ${String(makeReadyCallsForDevice.length)}`,
    ).toBeGreaterThan(1);

    // The whole point of the feature: the lease survives recovery.
    await waitForLeaseCount(env, 1);
    const leases = (await env.cli(["list", "--leases"])).json;
    expect(leases).toEqual(expect.arrayContaining([expect.objectContaining({ id: grant.lease })]));
    const devices = (await env.cli(["list", "--devices"])).json as DeviceRow[];
    const deviceRow = devices.find((device) => device.driverDeviceId === grant.udid);
    expect(deviceRow?.state).toBe("leased");

    held.kill("SIGKILL");
    await held.waitForExit(15_000).catch(() => undefined);
  });

  it("gives the lease up when a leased device cannot be recovered", async () => {
    const env = await withDaemon({
      configOverrides: {
        health: { ...HEALTH_CONFIG_BASE, maxRecoveryAttempts: 1 },
        limits: { ios: { maxDevices: 2, maxRunning: 2 }, maxRunning: 2 },
      },
    });
    await env.driverScript.set({
      ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] },
    });

    const held = leaseHeld(env, "crash-recovery-b");
    const grant = await grantOf(held);
    await waitForLeaseCount(env, 1);

    // Same crash as the first flow, but every reboot attempt fails and there is
    // only one attempt to give -- recovery cannot work.
    await env.driverScript.merge({
      ios: {
        failures: {
          makeReady: { message: "simulated unrecoverable boot failure", type: "generic" },
        },
        managedReality: { devices: [{ deviceId: grant.udid, runState: "stopped" }] },
      },
    });

    const recorded = await env.expectEvents(["device.recovery-failed", "lease.released"]);
    const recoveryFailed = recorded.find((event) => event.event === "device.recovery-failed");
    expect(recoveryFailed?.payload).toMatchObject({
      leaseId: grant.lease,
      reason: "attempts-exhausted",
    });
    const released = recorded.find(
      (event) =>
        event.event === "lease.released" &&
        (event.payload as { leaseId?: string }).leaseId === grant.lease,
    );
    expect(released?.payload).toMatchObject({ leaseId: grant.lease, reason: "device-lost" });

    // The device is back in the pool, not stuck leased to a dead device.
    await waitForLeaseCount(env, 0);
    const leases = (await env.cli(["list", "--leases"])).json;
    expect(leases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: grant.lease })]),
    );

    held.kill("SIGKILL");
    await held.waitForExit(15_000).catch(() => undefined);
  });

  // Regression guard: writing this suite found that the held CLI never learned its
  // lease had died. The daemon has always pushed `lease-lost` for a `device-lost`
  // release -- the same push MCP's `#handleLeaseLost` reacts to -- but `runLease`'s
  // onPush handler ignored that kind, so the held process neither reported the loss
  // nor exited; it sat forever awaiting an OS signal while holding nothing. Recovery
  // giving up is the first thing that ends a lease with no human involved, which is
  // what made the gap matter enough to fix.
  it("the held CLI observes its lease ending when the device is unrecoverable", async () => {
    const env = await withDaemon({
      configOverrides: {
        health: { ...HEALTH_CONFIG_BASE, maxRecoveryAttempts: 1 },
        limits: { ios: { maxDevices: 2, maxRunning: 2 }, maxRunning: 2 },
      },
    });
    await env.driverScript.set({
      ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] },
    });

    const held = leaseHeld(env, "crash-recovery-c");
    const grant = await grantOf(held);
    await waitForLeaseCount(env, 1);

    await env.driverScript.merge({
      ios: {
        failures: {
          makeReady: { message: "simulated unrecoverable boot failure", type: "generic" },
        },
        managedReality: { devices: [{ deviceId: grant.udid, runState: "stopped" }] },
      },
    });

    // The daemon-side lease is released well before this returns.
    await waitForLeaseCount(env, 0);

    // Expected: the held process reports the lost lease on stderr (mirroring
    // device_unhealthy/device_recovered) and exits on its own. Actual: it does
    // neither -- this waitFor times out and the process is still alive afterwards.
    await waitFor(() => healthLines(held).some((line) => line.event === "lease_lost"), {
      label: "held CLI reports the lease ending",
      timeout: 5_000,
    });
    // `device_id` here is the registry device id (what `pitlane list --devices` calls
    // `id`), not the driver `udid` the grant returns on stdout -- these pushes carry
    // the same identifier the event bus does.
    const lost = healthLines(held).find((line) => line.event === "lease_lost");
    expect(lost).toMatchObject({
      device_id: expect.stringMatching(/^dev_/),
      lease: grant.lease,
      reason: "device-lost",
    });

    // It must also stop holding a lease it no longer has, with an exit code that
    // distinguishes "the daemon took it" from a holder ending its own lease.
    const exit = await held.waitForExit(5_000);
    expect(exit.code).toBe(14);
  });
});
