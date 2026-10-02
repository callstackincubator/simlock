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
  if (result.code !== 0) throw new Error(`simlock list --devices failed: ${result.stderr}`);
  return result.json as DeviceRow[];
}

/** Launches a `simlock lease` holder for `agentId`; caller launches every agent it needs
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

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: { readonly driverDeviceId: string };
}

async function grantOf(held: CliBackgroundHandle): Promise<Grant> {
  return JSON.parse(await held.firstStdoutLine()) as Grant;
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
    const distinctUdids = new Set(
      [deviceA, deviceB, deviceC, deviceD, deviceE].map((d) => d.device.driverDeviceId),
    );
    expect(distinctUdids.size, "expected 5 distinct devices, one per concurrent lease").toBe(5);

    for (const device of [deviceA, deviceC, deviceD, deviceE]) {
      const release = await env.cli(["release", device.lease.id]);
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
      { deviceId: deviceA.device.driverDeviceId, runState: "stopped" },
      { deviceId: deviceB.device.driverDeviceId, runState: "stopped" },
      // deviceC.device.driverDeviceId deliberately omitted.
      {
        deviceId: deviceD.device.driverDeviceId,
        runState: "running",
        mark: { durable: "tok-d", erasableReadable: true },
      },
      {
        deviceId: deviceE.device.driverDeviceId,
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
        deviceId: registryIdOf(deviceA.device.driverDeviceId),
        expected: "running",
        observed: "stopped",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "foreign-state-change",
        deviceId: registryIdOf(deviceB.device.driverDeviceId),
        expected: "running",
        observed: "stopped",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "registry-device-missing",
        deviceId: registryIdOf(deviceC.device.driverDeviceId),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "foreign-provenance-change",
        deviceId: registryIdOf(deviceD.device.driverDeviceId),
        detail: "erased",
      }),
    );
    expect(
      findings.some((finding) => finding.deviceId === registryIdOf(deviceE.device.driverDeviceId)),
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
    const rowA = rowsAfterFix.find((row) => row.id === registryIdOf(deviceA.device.driverDeviceId));
    expect(rowA?.state, "deviceA's foreign-state-change should have been corrected").toBe(
      "shutdown",
    );
    const rowB = rowsAfterFix.find((row) => row.id === registryIdOf(deviceB.device.driverDeviceId));
    expect(rowB?.state, "leased deviceB must be left alone by --fix").toBe("leased");
    const rowC = rowsAfterFix.find((row) => row.id === registryIdOf(deviceC.device.driverDeviceId));
    expect(rowC?.state, "vanished deviceC should be marked deleted, not recreated").toBe("deleted");
    const rowD = rowsAfterFix.find((row) => row.id === registryIdOf(deviceD.device.driverDeviceId));
    expect(
      rowD?.foreignProvenanceDetectedAt,
      "provenance drift is report-only -- re-marking would destroy the evidence",
    ).toBeGreaterThan(0);

    heldB.kill("SIGKILL");
    await heldB.waitForExit(15_000).catch(() => undefined);
  });

  it("reports a scripted missing prerequisite in the JSON report and on stderr, and stops once it is installed", async () => {
    const env = await withDaemon();
    const emulator = {
      prerequisite: "android-emulator",
      message: "The Android emulator package is not installed.",
      remedy: "Run `sdkmanager --install emulator`.",
    };
    await env.driverScript.set({ android: { missingPrerequisites: [emulator] } });

    const missing = await env.cli(["doctor"]);
    expect(missing.code).toBe(0);
    expect((missing.json as { findings: unknown[] }).findings).toEqual([
      { kind: "prerequisite-missing", platform: "android", ...emulator },
    ]);
    expect(missing.stderr).toContain(
      "Missing [android] android-emulator: The Android emulator package is not installed. " +
        "Run `sdkmanager --install emulator`.",
    );

    // Same daemon, no restart: the next run looks again.
    await env.driverScript.set({ android: {} });
    const installed = await env.cli(["doctor"]);
    expect((installed.json as { findings: unknown[] }).findings).toEqual([]);
    expect(installed.stderr).not.toContain("Missing [");
  });

  it("purges orphans only when asked and confirmed and the root re-proves first, while --fix only reports them", async () => {
    const env = await withDaemon();
    const orphanScript = {
      knownModels: ["iPhone 16"],
      availableOsVersions: ["18.4"],
      managedReality: {
        devices: [{ deviceId: "fake-ios-orphan", runState: "running" as const }],
        processes: [{ deviceId: "fake-ios-orphan" }],
      },
    };
    await env.driverScript.set({ ios: orphanScript });
    const operations = async () => (await env.driverLog.calls()).map((call) => call.operation);
    const kinds = (result: { json?: unknown }) =>
      (result.json as { findings: Finding[] }).findings.map((f) => f.kind);

    const reported = await env.cli(["doctor"]);
    expect(reported.code).toBe(0);
    expect(kinds(reported)).toEqual(["orphan-device", "orphan-process"]);

    // ADR 0001 decision 6: `purgeOrphans` is not part of `fix`, so an operator already running
    // `doctor --fix` unattended does not gain a device-destroying behaviour by upgrading. Its
    // own step, asserted on its own: folding the purge into `fix` would still pass the purge
    // steps below. `--yes` too, since the confirmation is not what keeps `--fix` safe.
    await env.driverLog.clear();
    const fixed = await env.cli(["doctor", "--fix", "--yes"]);
    expect(fixed.code).toBe(0);
    expect(kinds(fixed)).toEqual(["orphan-device", "orphan-process"]);
    expect(await operations(), "--fix must never destroy a device").not.toContain("destroy");
    // The purge is the only path that re-proves the root, because it is the only one that
    // was ever going to destroy anything.
    expect(await operations()).not.toContain("revalidateRoot");

    // No TTY behind the e2e CLI, so `confirm` answers no: the refusal is the documented
    // `USAGE`/exit 2 contract `release --all` already has (safety rule 5).
    await env.driverLog.clear();
    const declined = await env.cli(["doctor", "--purge-orphans"]);
    expect(declined.code).toBe(2);
    expect(declined.error?.code).toBe("USAGE");
    expect(await operations()).not.toContain("destroy");

    // A root that stopped proving ownership is exactly the case where `listManaged` may be
    // describing the user's own devices: the orphans stay reported, and stay on disk.
    await env.driverScript.set({
      ios: {
        ...orphanScript,
        failures: { revalidateRoot: { type: "generic", message: "root is a symlink now" } },
      },
    });
    await env.driverLog.clear();
    const refused = await env.cli(["doctor", "--purge-orphans", "--yes"]);
    expect(refused.code).toBe(0);
    expect(kinds(refused)).toEqual(["orphan-device", "orphan-process"]);
    expect(await operations()).not.toContain("destroy");

    await env.driverScript.set({ ios: orphanScript });
    await env.driverLog.clear();
    const purged = await env.cli(["doctor", "--purge-orphans", "--yes"]);
    expect(purged.code).toBe(0);
    // Both findings go: destroying the device covers the process it was running.
    expect((purged.json as { findings: Finding[] }).findings).toEqual([]);
    expect(
      (await operations()).filter((operation) => operation !== "listManaged"),
      "the root is re-proven before anything is destroyed",
    ).toEqual(["revalidateRoot", "destroy"]);
    await env.expectEvents(["device.orphan-purged"]);
  });
});
