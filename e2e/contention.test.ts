import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

const LEASE_ARGS = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

describe("contention & queueing", () => {
  it("enforces one lease per requester, --no-wait, --timeout, and FIFO queueing", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const first = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    const firstGrant = first.json as { lease: string };

    // Same requester leasing again: REQUESTER_ALREADY_LEASED, naming the existing lease.
    const repeat = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(repeat.code).toBe(13);
    expect(repeat.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(repeat.error?.message).toContain(firstGrant.lease);

    // A different requester at capacity with --no-wait fails immediately.
    const noWait = await env.cli([...LEASE_ARGS, "--agent-id", "agent-b", "--no-wait", "--detach"]);
    expect(noWait.code).toBe(11);
    expect(noWait.error).toMatchObject({ code: "NO_CAPACITY" });

    // A different requester with a short --timeout queues, then times out.
    const timedOut = await env.cli(
      [...LEASE_ARGS, "--agent-id", "agent-c", "--timeout", "300ms", "--detach"],
      { timeout: 15_000 },
    );
    expect(timedOut.code).toBe(10);
    expect(timedOut.error).toMatchObject({ code: "QUEUE_TIMEOUT" });

    // Two held-mode waiters queue behind the holder; releasing grants them in FIFO order.
    const waiterD = env.cliBackground([...LEASE_ARGS, "--agent-id", "agent-d"]);
    await waitFor(() => waiterD.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "agent-d queued at position 1",
    });

    const waiterE = env.cliBackground([...LEASE_ARGS, "--agent-id", "agent-e"]);
    await waitFor(() => waiterE.progressEvents().some((event) => isQueuedAt(event, 2)), {
      label: "agent-e queued at position 2",
    });

    const release = await env.cli(["release", firstGrant.lease]);
    expect(release.code).toBe(0);

    const grantedD = JSON.parse(await waiterD.firstStdoutLine(15_000)) as {
      device: string;
      lease: string;
    };
    expect(grantedD.device).toBe("iPhone 16");

    waiterD.kill("SIGTERM");
    await waiterD.waitForExit(15_000);

    const grantedE = JSON.parse(await waiterE.firstStdoutLine(15_000)) as {
      device: string;
      lease: string;
    };
    expect(grantedE.device).toBe("iPhone 16");
    expect(grantedE.lease).not.toBe(grantedD.lease);

    waiterE.kill("SIGTERM");
    await waiterE.waitForExit(15_000);
  });

  it("tells a waiter queued behind a reclaim how long that reclaim runs", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await env.driverScript.set({
      ios: {
        knownModels: ["iPhone 16"],
        availableOsVersions: ["18.4"],
        estimateMs: { reclaim: 34_000 },
        latencyMs: { reclaim: 4_000 },
      },
    });

    const holder = await env.cli([...LEASE_ARGS, "--agent-id", "agent-holder", "--detach"]);
    expect(holder.code).toBe(0);
    const holderGrant = holder.json as { lease: string };

    // Release hands the caller back before the purge (#58), so the device is `reclaiming` with
    // its full latency still ahead when the next requester arrives -- the case the stage exists
    // for, and the one nothing exercised before this covered the whole path out to the CLI.
    const release = await env.cli(["release", holderGrant.lease]);
    expect(release.code).toBe(0);

    const waiter = env.cliBackground([...LEASE_ARGS, "--agent-id", "agent-waiter"]);
    await waitFor(() => waiter.progressEvents().some(isReclaimingWithEta(34)), {
      label: "agent-waiter told the reclaim's ETA",
    });
    expect(waiter.progressEvents().some((event) => isQueuedAt(event, 1))).toBe(true);

    const granted = JSON.parse(await waiter.firstStdoutLine(15_000)) as { device: string };
    expect(granted.device).toBe("iPhone 16");

    waiter.kill("SIGTERM");
    await waiter.waitForExit(15_000);
  });
});

function isReclaimingWithEta(seconds: number): (event: unknown) => boolean {
  return (event) =>
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).event === "reclaiming" &&
    (event as Record<string, unknown>).eta_seconds === seconds;
}

function isQueuedAt(event: unknown, position: number): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).event === "queued" &&
    (event as Record<string, unknown>).queue_position === position
  );
}
