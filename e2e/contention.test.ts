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
    const firstGrant = first.json as { lease: { id: string } };

    // Same requester leasing again: REQUESTER_ALREADY_LEASED, naming the existing lease.
    const repeat = await env.cli([...LEASE_ARGS, "--agent-id", "agent-a", "--detach"]);
    expect(repeat.code).toBe(13);
    expect(repeat.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(repeat.error?.message).toContain(firstGrant.lease.id);

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

    const release = await env.cli(["release", firstGrant.lease.id]);
    expect(release.code).toBe(0);

    const grantedD = JSON.parse(await waiterD.firstStdoutLine(15_000)) as {
      device: { spec: { model: string } };
      lease: { id: string };
    };
    expect(grantedD.device.spec.model).toBe("iPhone 16");

    waiterD.kill("SIGTERM");
    await waiterD.waitForExit(15_000);

    const grantedE = JSON.parse(await waiterE.firstStdoutLine(15_000)) as {
      device: { spec: { model: string } };
      lease: { id: string };
    };
    expect(grantedE.device.spec.model).toBe("iPhone 16");
    expect(grantedE.lease.id).not.toBe(grantedD.lease.id);

    waiterE.kill("SIGTERM");
    await waiterE.waitForExit(15_000);
  });

  it("the CLI --lease-id flag names the lease, and exits 13 with LEASE_ID_TAKEN for an ID an active lease or a waiting request holds", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 1, ios: { maxDevices: 1, maxRunning: 1 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const held = await env.cli([
      ...LEASE_ARGS,
      "--agent-id",
      "agent-a",
      "--lease-id",
      "ad-7f3a",
      "--detach",
    ]);
    expect(held.code).toBe(0);
    expect((held.json as { lease: { id: string } }).lease.id).toBe("ad-7f3a");

    // The ID of an active lease is taken.
    const clash = await env.cli([
      ...LEASE_ARGS,
      "--agent-id",
      "agent-b",
      "--lease-id",
      "ad-7f3a",
      "--detach",
    ]);
    expect(clash.code).toBe(13);
    expect(clash.error).toMatchObject({ code: "LEASE_ID_TAKEN" });
    expect(clash.error?.message).toContain("ad-7f3a");

    // A request waiting for the one device holds its ID too.
    const waiter = env.cliBackground([
      ...LEASE_ARGS,
      "--agent-id",
      "agent-c",
      "--lease-id",
      "waits-1",
    ]);
    await waitFor(() => waiter.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "agent-c queued at position 1",
    });
    const waitingClash = await env.cli([
      ...LEASE_ARGS,
      "--agent-id",
      "agent-d",
      "--lease-id",
      "waits-1",
      "--detach",
    ]);
    expect(waitingClash.code).toBe(13);
    expect(waitingClash.error).toMatchObject({ code: "LEASE_ID_TAKEN" });

    expect((await env.cli(["release", "ad-7f3a"])).code).toBe(0);
    const granted = JSON.parse(await waiter.firstStdoutLine(15_000)) as { lease: { id: string } };
    expect(granted.lease.id).toBe("waits-1");
    waiter.kill("SIGTERM");
    await waiter.waitForExit(15_000);
  });
});

function isQueuedAt(event: unknown, position: number): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).push === "progress" &&
    (event as Record<string, unknown>).stage === "queued" &&
    (event as Record<string, unknown>).queuePosition === position
  );
}
