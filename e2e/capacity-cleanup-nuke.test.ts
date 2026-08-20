import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { waitForDeviceState, waitForLeaseCount } from "./helpers/status.js";
import { waitFor } from "./helpers/wait.js";
import type { CliBackgroundHandle } from "./helpers/cli.js";
import type { ScriptedObservedDevice } from "./fake-driver/types.js";

interface CapacitySnapshot {
  readonly used: number;
  readonly limit: number;
  readonly running: number;
  readonly maxRunning: number;
  readonly warm: number;
  readonly overLimit: boolean;
}

interface StatusResponse {
  readonly capacity: {
    readonly ios: CapacitySnapshot;
    readonly global: Omit<CapacitySnapshot, "used" | "limit">;
  };
}

async function status(env: Awaited<ReturnType<typeof withDaemon>>): Promise<StatusResponse> {
  const result = await env.cli(["status", "--json"]);
  if (result.code !== 0) throw new Error(`pitlane status failed: ${result.stderr}`);
  return result.json as StatusResponse;
}

async function deviceRows(
  env: Awaited<ReturnType<typeof withDaemon>>,
): Promise<{ id: string; driverDeviceId: string; state: string }[]> {
  const result = await env.cli(["list", "--devices"]);
  if (result.code !== 0) throw new Error(`pitlane list --devices failed: ${result.stderr}`);
  return result.json as { id: string; driverDeviceId: string; state: string }[];
}

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

async function releaseAndForget(
  env: Awaited<ReturnType<typeof withDaemon>>,
  agentId: string,
): Promise<void> {
  const held = leaseHeld(env, agentId);
  const grant = JSON.parse(await held.firstStdoutLine()) as { lease: string };
  await env.cli(["release", grant.lease]);
  held.kill("SIGKILL");
  await held.waitForExit(15_000).catch(() => undefined);
}

/**
 * Forces an immediate, synchronous reaper evaluation (rather than waiting on the slow
 * 60s periodic tick or hoping an unrelated `lease.released` retriggers it) by polling
 * `pitlane cleanup` itself until the target reaches `state` -- this is what lets an
 * idle-threshold test converge in milliseconds without a fixed sleep: each poll tick
 * both re-checks real elapsed time *and* forces the daemon to act on it.
 */
async function waitForCleanupToReach(
  env: Awaited<ReturnType<typeof withDaemon>>,
  driverDeviceId: string,
  state: string,
  timeout = 10_000,
): Promise<void> {
  await waitFor(
    async () => {
      await env.cli(["cleanup"]);
      const rows = await deviceRows(env);
      return rows.some((row) => row.driverDeviceId === driverDeviceId && row.state === state);
    },
    { timeout, interval: 50, label: `cleanup demotes ${driverDeviceId} to ${state}` },
  );
}

describe("capacity, warm pool, cleanup, and nuke", () => {
  it("distinguishes the managed-device limit from the running limit, and counts reclaiming as running, never warm", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 2, ios: { maxDevices: 1, maxRunning: 2 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const first = leaseHeld(env, "cap-a");
    const grantA = JSON.parse(await first.firstStdoutLine()) as { lease: string; udid: string };

    // maxRunning (2) has room, but maxDevices (1) does not: a second requester must
    // still queue, because there is no second device to provision.
    const second = leaseHeld(env, "cap-b");
    await waitFor(() => second.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "second requester queues on the managed-device limit, not the running limit",
    });

    // Release the held device with a deliberately slow reclaim so its transient
    // `reclaiming` state is observable. The release RPC itself waits for reclaim to
    // finish before responding, so the poll for "reclaiming" must run concurrently
    // with the release call, not after it.
    await env.driverScript.merge({ ios: { latencyMs: { reclaim: 1_500 } } });
    const releasePromise = env.cli(["release", grantA.lease]);

    await waitFor(
      async () => {
        const rows = await deviceRows(env);
        return rows.some((row) => row.driverDeviceId === grantA.udid && row.state === "reclaiming");
      },
      { label: "device visibly enters reclaiming" },
    );

    const duringReclaim = await status(env);
    expect(duringReclaim.capacity.ios.running).toBe(1);
    expect(duringReclaim.capacity.ios.warm).toBe(0);

    const release = await releasePromise;
    expect(release.code).toBe(0);

    // The queued second requester is granted the same device once reclaim finishes
    // and it becomes warm (`ready`) again.
    const grantB = JSON.parse(await second.firstStdoutLine(15_000)) as {
      lease: string;
      udid: string;
    };
    expect(grantB.udid).toBe(grantA.udid);

    first.kill("SIGKILL");
    second.kill("SIGKILL");
    await Promise.all([
      first.waitForExit(15_000).catch(() => undefined),
      second.waitForExit(15_000).catch(() => undefined),
    ]);
  });

  it("reports overLimit when a lowered running limit can't yet be met, without evicting existing leases", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 3, ios: { maxDevices: 3, maxRunning: 3 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    // Detached, not held: a graceful `daemon stop` (which `withConfig` triggers to
    // pick up the new limit) releases every held-mode lease as part of closing its
    // owning connection -- exactly like a normal held-mode client disconnecting. A
    // detached lease has no owning connection, so it survives the restart, which is
    // what actually exercises "a lowered limit doesn't evict an existing lease".
    const leaseOne = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "overlimit-one",
      "--detach",
    ]);
    const grantOne = leaseOne.json as { lease: string };
    const leaseTwo = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "overlimit-two",
      "--detach",
    ]);
    const grantTwo = leaseTwo.json as { lease: string };

    await env.withConfig({ limits: { ios: { maxRunning: 1 } } }, async () => {
      const afterLower = await status(env);
      expect(afterLower.capacity.ios.overLimit).toBe(true);

      // Pre-existing leases must never be evicted just because the limit dropped
      // below what is currently held.
      const leases = (await env.cli(["list", "--leases"])).json as { id: string }[];
      expect(leases.map((lease) => lease.id)).toEqual(
        expect.arrayContaining([grantOne.lease, grantTwo.lease]),
      );
    });

    await env.cli(["release", "--all", "--yes"]);
  });

  it("demotes an idle device, previews cleanup without executing on --dry-run, and nuke touches only registry devices", async () => {
    const env = await withDaemon({
      configOverrides: {
        // Tight on purpose: by the nuke phase this forces a real queued waiter
        // (see the comment there) without needing a mid-test daemon restart, which
        // would release the still-needed held lease.
        limits: { maxRunning: 1, ios: { maxDevices: 2, maxRunning: 1 } },
        idle: { shutdownAfterMs: 200 },
      },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const heldX = leaseHeld(env, "idle-x");
    const grantX = JSON.parse(await heldX.firstStdoutLine()) as { lease: string; udid: string };
    await env.cli(["release", grantX.lease]);
    heldX.kill("SIGKILL");
    await heldX.waitForExit(15_000).catch(() => undefined);
    await waitForDeviceState(env, grantX.udid, "ready");

    await waitForCleanupToReach(env, grantX.udid, "shutdown");

    // cleanup --dry-run must report proposals without acting on them.
    await releaseAndForget(env, "dryrun-z");
    const rowsAfterZ = await deviceRows(env);
    const readyDevice = rowsAfterZ.find((row) => row.state === "ready");
    expect(readyDevice, "expected a ready (warm) device for the dry-run preview").toBeDefined();

    await waitFor(
      async () => {
        const preview = await env.cli(["cleanup", "--dry-run"]);
        const proposals = preview.json as { rule: string; target: string }[];
        return proposals.some((proposal) => proposal.target === readyDevice?.id);
      },
      {
        timeout: 10_000,
        interval: 50,
        label: "dry-run eventually proposes shutting the idle device down",
      },
    );

    await env.driverLog.clear();
    const dryRun = await env.cli(["cleanup", "--dry-run"]);
    expect(dryRun.code).toBe(0);
    const dryRunCalls = await env.driverLog.calls();
    expect(
      dryRunCalls.filter((call) => call.operation === "shutdown" || call.operation === "destroy"),
      "--dry-run must never call a destructive/state-changing driver verb",
    ).toEqual([]);

    // nuke: force-releases held leases, clears the queue, destroys registry devices,
    // and must never touch a device the driver reports but the registry doesn't know
    // about (safety.md: registry-only destruction).
    const heldForNuke = leaseHeld(env, "nuke-held");
    await heldForNuke.firstStdoutLine();
    // Managed devices are already at 2/2 and running at 1/1 from the idle/dry-run
    // phase above, so this requester has no device to reuse or provision and queues.
    const queuedForNuke = leaseHeld(env, "nuke-queued");
    await waitFor(() => queuedForNuke.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "a waiter is queued before nuke",
    });

    // Stage an orphan device the fake driver reports but the registry never created,
    // alongside the current real reality (so nuke's other actions are unaffected).
    const rowsBeforeNuke = await deviceRows(env);
    const stagedRealityDevices: ScriptedObservedDevice[] = [
      ...rowsBeforeNuke
        .filter((row) => row.state !== "deleted")
        .map((row) => ({ deviceId: row.driverDeviceId, runState: "running" as const })),
      { deviceId: "fake-ios-orphan-not-in-registry", runState: "running" },
    ];
    await env.driverScript.merge({ ios: { managedReality: { devices: stagedRealityDevices } } });

    await env.driverLog.clear();
    const nuke = await env.cli(["nuke", "--delete-devices", "--yes"]);
    expect(nuke.code).toBe(0);

    await Promise.all([
      heldForNuke.waitForExit(15_000).catch(() => undefined),
      queuedForNuke.waitForExit(15_000).catch(() => undefined),
    ]);

    await waitForLeaseCount(env, 0);
    const nukeCalls = await env.driverLog.calls();
    const touchedOrphan = nukeCalls.some(
      (call) =>
        (call.operation === "destroy" ||
          call.operation === "shutdown" ||
          call.operation === "reclaim") &&
        JSON.stringify(call.arguments).includes("fake-ios-orphan-not-in-registry"),
    );
    expect(touchedOrphan, "nuke must never touch a device the registry does not manage").toBe(
      false,
    );
    expect(
      nukeCalls.some((call) => call.operation === "destroy"),
      "nuke --delete-devices should have destroyed at least one registry device",
    ).toBe(true);

    const cliLeases = await env.cli(["list", "--leases"]);
    expect(cliLeases.json).toEqual([]);
  });
});

function isQueuedAt(event: unknown, position: number): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).event === "queued" &&
    (event as Record<string, unknown>).queue_position === position
  );
}
