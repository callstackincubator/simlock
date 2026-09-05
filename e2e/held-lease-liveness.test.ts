import { describe, expect, it } from "vitest";

import { waitForDeviceState, waitForLeaseCount, withDaemon } from "./helpers/index.js";

/**
 * Lease liveness end to end under ADR 0004: a lease is TTL-bound, a client-initiated
 * `lease.renew` is the only thing that keeps it alive, and nothing about a connection --
 * its close, its daemon's death, or a restart -- ends one.
 */
describe("lease liveness & restart", () => {
  it("keeps a SIGKILLed holder's lease until it expires, then frees the device", async () => {
    // The one behaviour change a local user notices (ADR 0004's Consequences): a holder that
    // cannot run its own release path holds its device until `ttlDeadline`. A short TTL is
    // the bound, which is why this env sets one.
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 5_000 } } });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const holder = env.cliBackground([
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
    const grant = JSON.parse(await holder.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await waitForLeaseCount(env, 1);

    holder.kill("SIGKILL");
    await holder.waitForExit(15_000);

    // Killed outright, so nothing released: the lease is still there right after the holder
    // is gone, with its device still leased.
    const leases = (await env.cli(["list", "--leases"])).json as { id: string }[];
    expect(leases.map((lease) => lease.id)).toContain(grant.lease.id);

    // Its own deadline is what ends it -- nothing renews it any more.
    await waitForLeaseCount(env, 0, { timeout: 30_000 });
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");
    await env.expectEvents(["lease.granted", "lease.expired"]);
  });

  it("releases at once when a holder exits gracefully, without waiting for the TTL", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 600_000 } } });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const holder = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow5-sigterm",
    ]);
    const grant = JSON.parse(await holder.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await waitForLeaseCount(env, 1);

    // Release-on-exit is the holder's own policy (ADR 0004 §2), and it is what makes a
    // normal exit still free the device immediately -- the ten-minute TTL above never
    // comes into it.
    holder.kill("SIGTERM");
    const exit = await holder.waitForExit(15_000);
    expect(exit.code).toBe(0);

    await waitForLeaseCount(env, 0);
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");
    const recorded = await env.expectEvents(["lease.granted", "lease.released"]);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        event: "lease.released",
        payload: expect.objectContaining({ leaseId: grant.lease.id, reason: "explicit" }),
      }),
    );
  });

  it("keeps a lease across an ungraceful daemon restart, with its TTL timer restored", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 15_000 } } });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const holder = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow5-restart",
    ]);
    const grant = JSON.parse(await holder.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await waitForLeaseCount(env, 1);

    // Kill the daemon out from under the holder (not a graceful `daemon stop`), leaving the
    // lease persisted with no live connection. Pre-ADR-0004 this is exactly what
    // `StartupConverger`'s orphan sweep released; it no longer exists, because a restart
    // proves nothing about whether a holder is alive.
    await env.killDaemon("SIGKILL");
    await env.startDaemon();

    const afterRestart = (await env.cli(["list", "--leases"])).json as { id: string }[];
    expect(afterRestart.map((lease) => lease.id)).toContain(grant.lease.id);

    // The holder itself does not survive the restart -- the CLI never reconnects (ADR 0003
    // §10) -- so it writes one DAEMON_CONNECTION_LOST line naming the still-standing lease
    // and exits 1, releasing nothing.
    const exit = await holder.waitForExit(15_000);
    expect(exit.code).toBe(1);
    expect(exit.error?.code).toBe("DAEMON_CONNECTION_LOST");
    // The message names the lease and the deadline a later invocation has to beat.
    expect(exit.error?.message).toContain(grant.lease.id);
    expect(exit.error?.message).toContain("ttlDeadline");

    // With nothing left renewing it, the restored timer expires the lease on its own
    // deadline: the record persisted, and so did the deadline it carried.
    await waitForLeaseCount(env, 0, { timeout: 30_000 });
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");
    await env.expectEvents(["lease.expired"]);
  });

  it("survives a graceful daemon stop and can be renewed from a later invocation", async () => {
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 120_000 } } });
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
    const grant = lease.json as { lease: { id: string; ttlDeadline: number } };

    // The event ring buffer resets on restart (documented behaviour, ARCHITECTURE.md), so
    // check "granted" happened before the restart wipes it.
    await env.expectEvents(["lease.requested", "lease.granted"]);

    // ADR 0004 §3: `daemon stop` does not touch leases -- they persist, and the next daemon
    // restores each one's timer from its own deadline.
    await env.restartDaemon();

    const leasesAfterRestart = (await env.cli(["list", "--leases"])).json as { id: string }[];
    expect(leasesAfterRestart.map((row) => row.id)).toContain(grant.lease.id);

    // And it is still renewable across that restart, which is the whole point of the lease
    // outliving the connection that asked for it.
    const renewed = await env.cli(["lease", "renew", grant.lease.id]);
    expect(renewed.code).toBe(0);
    expect((renewed.json as { ttlDeadline: number }).ttlDeadline).toBeGreaterThan(
      grant.lease.ttlDeadline,
    );

    await env.cli(["release", grant.lease.id]);
    await waitForLeaseCount(env, 0);
  });
});
