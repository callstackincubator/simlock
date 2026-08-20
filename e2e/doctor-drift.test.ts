import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import type { CliBackgroundHandle } from "./helpers/cli.js";
import type { ScriptedObservedDevice } from "./fake-driver/types.js";

interface DeviceRow {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly state: string;
  readonly foreignProvenanceDetectedAt?: number;
}

interface Finding {
  readonly kind: string;
  readonly deviceId?: string;
  readonly device?: { readonly deviceId: string };
  readonly detail?: string;
}

async function deviceRows(env: Awaited<ReturnType<typeof withDaemon>>): Promise<DeviceRow[]> {
  const result = await env.cli(["list", "--devices"]);
  if (result.code !== 0) throw new Error(`pitlane list --devices failed: ${result.stderr}`);
  return result.json as DeviceRow[];
}

/** Launches a held-mode lease for `agentId`; caller launches every agent it needs
 *  before awaiting any of their grants, so none is warm-pool reused for the next
 *  (a sequential lease/release/lease would just reuse the same warm device). */
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

async function grantOf(held: CliBackgroundHandle): Promise<{ lease: string; udid: string }> {
  return JSON.parse(await held.firstStdoutLine()) as { lease: string; udid: string };
}

describe("doctor and drift", () => {
  it("reports registry vs. reality drift, applies only registry-safe fixes, and skips leased devices", async () => {
    const env = await withDaemon({
      configOverrides: {
        limits: { maxRunning: 5, ios: { maxDevices: 5, maxRunning: 5 } },
      },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    // A, C, D, E get released back to `ready` right after grant; B stays leased
    // throughout as the "must skip a leased device" case. All five are launched
    // before any grant is awaited, so capacity (5) covers them concurrently and
    // none is warm-pool reused for the next.
    const heldA = leaseHeld(env, "doctor-a");
    const deviceA = await grantOf(heldA);
    const heldB = leaseHeld(env, "doctor-b");
    const deviceB = await grantOf(heldB);
    const heldC = leaseHeld(env, "doctor-c");
    const deviceC = await grantOf(heldC);
    const heldD = leaseHeld(env, "doctor-d");
    const deviceD = await grantOf(heldD);
    const heldE = leaseHeld(env, "doctor-e");
    const deviceE = await grantOf(heldE);
    const distinctUdids = new Set([deviceA, deviceB, deviceC, deviceD, deviceE].map((d) => d.udid));
    expect(distinctUdids.size, "expected 5 distinct devices, one per concurrent lease").toBe(5);

    for (const device of [deviceA, deviceC, deviceD, deviceE]) {
      const release = await env.cli(["release", device.lease]);
      expect(release.code).toBe(0);
    }
    for (const held of [heldA, heldC, heldD, heldE]) {
      held.kill("SIGKILL");
      await held.waitForExit(15_000).catch(() => undefined);
    }

    const rows = await deviceRows(env);
    const registryIdOf = (udid: string): string => {
      const row = rows.find((candidate) => candidate.driverDeviceId === udid);
      if (row === undefined) throw new Error(`No registry row for driverDeviceId ${udid}`);
      return row.id;
    };

    const stagedDevices: ScriptedObservedDevice[] = [
      { deviceId: deviceA.udid, runState: "stopped" },
      { deviceId: deviceB.udid, runState: "stopped" },
      // deviceC.udid deliberately omitted.
      {
        deviceId: deviceD.udid,
        runState: "running",
        mark: { durable: "tok-d", erasableReadable: true },
      },
      {
        deviceId: deviceE.udid,
        runState: "running",
        mark: { durable: "tok-e", erasable: "stale", erasableReadable: false },
      },
      { deviceId: "fake-ios-99-unregistered", runState: "running" },
    ];
    await env.driverScript.merge({
      ios: {
        managedReality: {
          devices: stagedDevices,
          processes: [{ deviceId: "fake-ios-100-orphan" }],
        },
      },
    });

    const dryRun = await env.cli(["doctor"]);
    expect(dryRun.code).toBe(0);
    const findings = (dryRun.json as { findings: Finding[] }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "foreign-state-change",
        deviceId: registryIdOf(deviceA.udid),
        expected: "running",
        observed: "stopped",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "foreign-state-change",
        deviceId: registryIdOf(deviceB.udid),
        expected: "running",
        observed: "stopped",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "registry-device-missing",
        deviceId: registryIdOf(deviceC.udid),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "foreign-provenance-change",
        deviceId: registryIdOf(deviceD.udid),
        detail: "erased",
      }),
    );
    expect(
      findings.some((finding) => finding.deviceId === registryIdOf(deviceE.udid)),
      "deviceE has an unreadable erasable mark and must produce no finding at all",
    ).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "orphan-device",
        device: expect.objectContaining({ deviceId: "fake-ios-99-unregistered" }),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "orphan-process",
        device: expect.objectContaining({ deviceId: "fake-ios-100-orphan" }),
      }),
    );

    await env.driverLog.clear();
    const fixed = await env.cli(["doctor", "--fix"]);
    expect(fixed.code).toBe(0);

    // Registry-only destruction (safety.md #1/#3): --fix must never call a destructive
    // or state-changing driver verb. Every correction above is pure registry bookkeeping.
    const calls = await env.driverLog.calls();
    const destructiveOps = new Set(["destroy", "shutdown", "reclaim", "makeReady", "provision"]);
    expect(
      calls.filter((call) => destructiveOps.has(call.operation)),
      `--fix must be registry-only; saw: ${JSON.stringify(calls.map((call) => call.operation))}`,
    ).toEqual([]);

    const rowsAfterFix = await deviceRows(env);
    const rowA = rowsAfterFix.find((row) => row.id === registryIdOf(deviceA.udid));
    expect(rowA?.state, "deviceA's foreign-state-change should have been corrected").toBe(
      "shutdown",
    );
    const rowB = rowsAfterFix.find((row) => row.id === registryIdOf(deviceB.udid));
    expect(rowB?.state, "leased deviceB must be left alone by --fix").toBe("leased");
    const rowC = rowsAfterFix.find((row) => row.id === registryIdOf(deviceC.udid));
    expect(rowC?.state, "vanished deviceC should be marked deleted, not recreated").toBe("deleted");
    const rowD = rowsAfterFix.find((row) => row.id === registryIdOf(deviceD.udid));
    expect(
      rowD?.foreignProvenanceDetectedAt,
      "provenance drift is report-only -- re-marking would destroy the evidence",
    ).toBeGreaterThan(0);

    heldB.kill("SIGKILL");
    await heldB.waitForExit(15_000).catch(() => undefined);
  });
});
