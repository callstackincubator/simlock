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
  if (result.code !== 0) throw new Error(`simlock status failed: ${result.stderr}`);
  return result.json as StatusResponse;
}

async function deviceRows(
  env: Awaited<ReturnType<typeof withDaemon>>,
): Promise<{ id: string; driverDeviceId: string; state: string }[]> {
  const result = await env.cli(["list", "--devices"]);
  if (result.code !== 0) throw new Error(`simlock list --devices failed: ${result.stderr}`);
  return result.json as { id: string; driverDeviceId: string; state: string }[];
}

/** Starts a `simlock lease` that stays alive, renewing its own lease (ADR 0004 §2). */
function leaseHolder(
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

describe("capacity, warm pool, cleanup, and nuke", () => {
  it("distinguishes the managed-device limit from the running limit, and counts a released device on its way out as running, never warm", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 2, ios: { maxDevices: 1, maxRunning: 2 } } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const first = leaseHolder(env, "cap-a");
    const grantA = JSON.parse(await first.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };

    // maxRunning (2) has room, but maxDevices (1) does not: a second requester must
    // still queue, because there is no second device to provision.
    const second = leaseHolder(env, "cap-b");
    await waitFor(() => second.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "second requester queues on the managed-device limit, not the running limit",
    });

    await env.driverScript.merge({ ios: { latencyMs: { shutdown: 1_500 } } });
    const releasePromise = env.cli(["release", grantA.lease.id]);

    await waitFor(
      async () => {
        const rows = await deviceRows(env);
        return rows.some(
          (row) =>
            row.driverDeviceId === grantA.device.driverDeviceId && row.state === "reclaiming",
        );
      },
      { label: "released device visibly enters reclaiming" },
    );

    const duringReclaim = await status(env);
    expect(duringReclaim.capacity.ios.running).toBe(1);
    expect(duringReclaim.capacity.ios.warm).toBe(0);

    const release = await releasePromise;
    expect(release.code).toBe(0);

    // why: the queued second requester is granted a new device once the released one is deleted; a released device is never granted again.
    const grantB = JSON.parse(await second.firstStdoutLine(15_000)) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    expect(grantB.device.driverDeviceId).not.toBe(grantA.device.driverDeviceId);

    // `second` still holds `grantB`, and a SIGKILL would leave it standing for the whole
    // TTL (ADR 0004 §3), so it is released explicitly before the processes are torn down.
    await env.cli(["release", grantB.lease.id]);
    first.kill("SIGKILL");
    second.kill("SIGKILL");
    await Promise.all([
      first.waitForExit(15_000).catch(() => undefined),
      second.waitForExit(15_000).catch(() => undefined),
    ]);
    await waitForLeaseCount(env, 0);
  });

  it("keeps an idle device of a leased kind out of cleanup and its --dry-run preview, and nuke touches only registry devices", async () => {
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

    const holderX = leaseHolder(env, "idle-x");
    const grantX = JSON.parse(await holderX.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    await env.cli(["release", grantX.lease.id]);
    holderX.kill("SIGKILL");
    await holderX.waitForExit(15_000).catch(() => undefined);
    await waitForDeviceState(env, grantX.device.driverDeviceId, "deleted");
    // why: the released device is deleted; the pool learned the kind from the lease and makes a new device that stays ready past idle.shutdownAfterMs.
    let readyDevice: { id: string; driverDeviceId: string; state: string } | undefined;
    await waitFor(
      async () => {
        readyDevice = (await deviceRows(env)).find((row) => row.state === "ready");
        return readyDevice !== undefined;
      },
      { label: "the pool makes a ready device of the leased kind" },
    );
    expect((await env.cli(["cleanup"])).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await env.cli(["cleanup"])).code).toBe(0);
    expect((await deviceRows(env)).find((row) => row.id === readyDevice?.id)?.state).toBe("ready");

    // why: a dry run lists what a real run would do, and the device the pool keeps is not in it. That it executes nothing is the reaper unit test's: no device here is one a rule acts on.
    const preview = await env.cli(["cleanup", "--dry-run"]);
    expect(
      (preview.json as { target: string }[]).filter(
        (proposal) => proposal.target === readyDevice?.id,
      ),
      "the kept device of a leased kind is not proposed",
    ).toEqual([]);

    // nuke: force-releases every lease, clears the queue, destroys registry devices,
    // and must never touch a device the driver reports but the registry doesn't know
    // about (safety.md: registry-only destruction).
    const heldForNuke = leaseHolder(env, "nuke-held");
    await heldForNuke.firstStdoutLine();
    // why: the held lease took the one ready device, so running is at 1/1 and this requester has no device to reuse or provision and queues.
    const queuedForNuke = leaseHolder(env, "nuke-queued");
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
    (event as Record<string, unknown>).push === "progress" &&
    (event as Record<string, unknown>).stage === "queued" &&
    (event as Record<string, unknown>).queuePosition === position
  );
}
