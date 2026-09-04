import { describe, expect, it } from "vitest";

import { waitForDeviceState, waitForLeaseCount, withDaemon } from "./helpers/index.js";

describe("held-lease liveness & restart", () => {
  it("killing the held CLI process releases its lease", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const held = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow5-killed",
    ]);
    const grant = JSON.parse(await held.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await waitForLeaseCount(env, 1);

    held.kill("SIGKILL");
    await held.waitForExit(15_000);

    await waitForLeaseCount(env, 0);
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");
    await env.expectEvents(["lease.granted", "lease.released"]);
  });

  it("orphan-sweeps a held lease still persisted across a daemon restart", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const held = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow5-orphaned",
    ]);
    const grant = JSON.parse(await held.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await waitForLeaseCount(env, 1);

    // Kill the daemon out from under the holder (not a graceful `daemon stop`) so the
    // lease is left `held` in the persisted registry with no live connection --
    // exactly the case StartupConverger's orphan sweep exists for.
    await env.killDaemon("SIGKILL");
    await env.startDaemon();

    await waitForLeaseCount(env, 0);
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");

    const recorded = await env.events();
    expect(recorded).toContainEqual(
      expect.objectContaining({
        event: "lease.released",
        payload: expect.objectContaining({ leaseId: grant.lease.id, reason: "orphaned" }),
      }),
    );

    held.kill("SIGKILL");
    await held.waitForExit(15_000).catch(() => undefined);
  });

  it("a detached lease survives a restart with its TTL timer restored", async () => {
    const env = await withDaemon({
      // Generous relative to the default (900_000ms) but still short enough to keep the
      // test fast; needs enough headroom that a restart (which now waits, best-effort,
      // for the previous daemon process to fully exit -- see helpers/env.ts) can't
      // itself eat into the TTL window before the "still there right after restart"
      // check below runs.
      configOverrides: { lease: { detachedTtlMs: 15_000, heartbeatIntervalMs: 500 } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow5-detached",
      "--detach",
    ]);
    expect(lease.code).toBe(0);
    const grant = lease.json as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };

    // The event ring buffer resets on restart (documented behaviour, ARCHITECTURE.md),
    // so check "granted" happened before the restart wipes it, and only look for
    // "expired" afterwards.
    await env.expectEvents(["lease.requested", "lease.granted"]);

    await env.restartDaemon();

    // Still there immediately after restart -- the lease was not dropped.
    const leasesAfterRestart = await env.cli(["list", "--leases"]);
    expect(leasesAfterRestart.json).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: grant.lease.id })]),
    );

    // If the TTL timer were not restored (rather than merely the lease record
    // persisting), it would never expire and this would time out.
    await waitForLeaseCount(env, 0, { timeout: 30_000 });
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");

    await env.expectEvents(["lease.expired"]);
  });
});
