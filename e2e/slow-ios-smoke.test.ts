import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import {
  iosDeviceSet,
  setDevices,
  sweepStaleDeviceSets,
  type SimctlDevice,
} from "./helpers/ios-device-set.js";
import type { TestEnv } from "./helpers/env.js";
import { waitFor } from "./helpers/wait.js";

const execFileAsync = promisify(execFile);

/** The machine's own device set -- the one Xcode shows. Simlock's devices must never be in it. */
async function defaultSetDevices(): Promise<SimctlDevice[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices).flat();
}

/** Runtimes are global: a custom set lists the same ones the default set does. */
async function simctlRuntimes(): Promise<string[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const parsed = JSON.parse(stdout) as {
    runtimes: { name: string; version: string; isAvailable: boolean }[];
  };
  return parsed.runtimes.filter((runtime) => runtime.isAvailable).map((runtime) => runtime.version);
}

// This lane needs the real simctl toolchain, hence darwin-only and gated on an
// installed runtime -- it never installs one itself (no --allow-download).
/**
 * `simlock simctl` against a real simctl, which is the only way to know the wrapper
 * resolves a UDID a bare simctl cannot see -- and that the lifecycle verbs it must not
 * proxy come back as a usage error instead of destroying the leased device.
 */
async function expectSimctlPassthrough(env: TestEnv, udid: string): Promise<void> {
  const wrapped = await env.cli(["simctl", "list", "devices", "-j"]);
  expect(wrapped.code, `simlock simctl failed: ${wrapped.stderr}`).toBe(0);
  expect(wrapped.stdout).toContain(udid);

  const refused = await env.cli(["simctl", "delete", udid]);
  expect(refused.code, "simlock simctl delete must be refused, not run").toBe(2);
  expect(refused.error).toMatchObject({ code: "USAGE" });
}

describe.skipIf(process.platform !== "darwin")(
  "iOS smoke (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "catalog agrees with simctl, a cold lease boots a real Booted simulator inside Simlock's own device set with matching provenance, release keeps it warm, and nuke empties the set",
      { timeout: 300_000 },
      async () => {
        await sweepStaleDeviceSets();
        const availableRuntimes = await simctlRuntimes();
        if (availableRuntimes.length === 0) {
          throw new Error("No installed, available iOS runtime -- cannot run the iOS smoke lane");
        }

        const env = await withDaemon({ driver: "real" });
        const deviceSet = iosDeviceSet(env.home);
        const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
        expect(catalog.code).toBe(0);
        const platforms = (
          catalog.json as {
            platforms: {
              platform: string;
              models: string[];
              runtimes: string[];
              modelClasses: Record<string, string>;
            }[];
          }
        ).platforms;
        const iosCatalog = platforms.find((platform) => platform.platform === "ios");
        expect(iosCatalog, "simlock catalog reported no iOS platform").toBeDefined();
        expect(
          iosCatalog?.models.length ?? 0,
          "simlock catalog reported no iOS models",
        ).toBeGreaterThan(0);
        // The class comes from the device type's product family, read off this host's simctl.
        expect(iosCatalog?.modelClasses["iPhone 17"]).toBe("phone");
        expect(iosCatalog?.modelClasses["Apple Watch Series 11 (46mm)"]).toBe("watch");
        for (const runtime of iosCatalog?.runtimes ?? []) {
          expect(
            availableRuntimes,
            "simlock catalog's runtimes must agree with real simctl",
          ).toContain(runtime);
        }
        const model = iosCatalog?.models[0] as string;

        const lease = await env.cli(
          ["lease", "--platform", "ios", "--device", model, "--agent-id", "ios-smoke", "--detach"],
          { timeout: 120_000 },
        );
        expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
        const grant = lease.json as {
          device: { driverDeviceId: string };
          environment: Record<string, string>;
          lease: { id: string };
        };
        // On iOS the driver's device id is the simulator's UDID.
        const udid = grant.device.driverDeviceId;

        // The grant has to say how to reach the device, because nothing else does: the
        // UDID below resolves to nothing without this path (ADR 0001, decision 7).
        expect(grant.environment).toEqual({ SIMLOCK_IOS_DEVICE_SET: deviceSet });

        await expectSimctlPassthrough(env, udid);

        const booted = await setDevices(deviceSet);
        const bootedDevice = booted.find((device) => device.udid === udid);
        expect(
          bootedDevice,
          `simctl --set ${deviceSet} does not know about udid ${udid}`,
        ).toBeDefined();
        expect(bootedDevice?.state).toBe("Booted");
        // The naming is a label with no authority behind it (safety rule 8) -- what
        // proves ownership is the set the device was just found in -- but it is still
        // what a human reads in the simulator window title, so it stays checked.
        expect(
          bootedDevice?.name.startsWith("simlock-"),
          "device name must carry the simlock- prefix",
        ).toBe(true);
        expect(
          (await defaultSetDevices()).some((device) => device.udid === udid),
          "a Simlock simulator must be invisible in the machine's default device set",
        ).toBe(false);

        // Provenance: both marks exist with the same token. `doctor` is the
        // documented way to observe this -- a foreign-provenance-change finding
        // for this device would mean the marks disagree or are missing.
        const doctorReport = await env.cli(["doctor"]);
        expect(doctorReport.code).toBe(0);
        const findings = (doctorReport.json as { findings: { kind: string; deviceId?: string }[] })
          .findings;
        const devices = (await env.cli(["list", "--devices"])).json as {
          id: string;
          driverDeviceId: string;
        }[];
        const registryId = devices.find((device) => device.driverDeviceId === udid)?.id;
        expect(
          findings.some(
            (finding) =>
              finding.kind === "foreign-provenance-change" && finding.deviceId === registryId,
          ),
          "expected no provenance drift for a device simlock just created",
        ).toBe(false);
        expect(
          findings.some((finding) => finding.kind === "driver-unavailable"),
          "the iOS driver must have started, with a root it owns",
        ).toBe(false);

        const release = await env.cli(["release", grant.lease.id]);
        expect(release.code, `release failed: ${release.stderr}`).toBe(0);

        // Still Booted: the warm pool only demotes after idle.shutdownAfterMs,
        // which defaults far longer than this test.
        await waitFor(
          async () => {
            const rows = (await env.cli(["list", "--devices"])).json as {
              driverDeviceId: string;
              state: string;
            }[];
            return rows.some((row) => row.driverDeviceId === udid && row.state === "ready");
          },
          { timeout: 60_000, label: "device returns to ready after release" },
        );
        const stillBooted = await setDevices(deviceSet);
        expect(stillBooted.find((device) => device.udid === udid)?.state).toBe("Booted");

        const nuke = await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 60_000 });
        expect(nuke.code).toBe(0);

        await waitFor(async () => (await setDevices(deviceSet)).length === 0, {
          timeout: 60_000,
          label: "no simulator remains in Simlock's device set after nuke --delete-devices",
        });
      },
    );
  },
);
