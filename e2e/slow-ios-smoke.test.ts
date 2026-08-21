import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { waitFor } from "./helpers/wait.js";

const execFileAsync = promisify(execFile);

interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

async function simctlDevices(): Promise<SimctlDevice[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices).flat();
}

async function simctlRuntimes(): Promise<string[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const parsed = JSON.parse(stdout) as {
    runtimes: { name: string; version: string; isAvailable: boolean }[];
  };
  return parsed.runtimes.filter((runtime) => runtime.isAvailable).map((runtime) => runtime.version);
}

async function deleteStraySimlockSimulators(): Promise<void> {
  const devices = await simctlDevices();
  for (const device of devices) {
    if (device.name.startsWith("simlock-")) {
      await execFileAsync("xcrun", ["simctl", "delete", device.udid]).catch(() => undefined);
    }
  }
}

// This lane needs the real simctl toolchain, hence darwin-only and gated on an
// installed runtime -- it never installs one itself (no --allow-download).
describe.skipIf(process.platform !== "darwin")(
  "iOS smoke (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "catalog agrees with simctl, a cold lease boots a real Booted simulator with matching provenance, release keeps it warm, and nuke leaves no simlock- simulator",
      { timeout: 300_000 },
      async () => {
        const availableRuntimes = await simctlRuntimes();
        if (availableRuntimes.length === 0) {
          throw new Error("No installed, available iOS runtime -- cannot run the iOS smoke lane");
        }

        const env = await withDaemon({ driver: "real" });
        try {
          const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
          expect(catalog.code).toBe(0);
          const platforms = (
            catalog.json as {
              platforms: { platform: string; models: string[]; runtimes: string[] }[];
            }
          ).platforms;
          const iosCatalog = platforms.find((platform) => platform.platform === "ios");
          expect(iosCatalog, "simlock catalog reported no iOS platform").toBeDefined();
          expect(
            iosCatalog?.models.length ?? 0,
            "simlock catalog reported no iOS models",
          ).toBeGreaterThan(0);
          for (const runtime of iosCatalog?.runtimes ?? []) {
            expect(
              availableRuntimes,
              "simlock catalog's runtimes must agree with real simctl",
            ).toContain(runtime);
          }
          const model = iosCatalog?.models[0] as string;

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "ios",
              "--device",
              model,
              "--agent-id",
              "ios-smoke",
              "--detach",
            ],
            { timeout: 120_000 },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const grant = lease.json as { lease: string; udid: string; device: string };

          const booted = await simctlDevices();
          const bootedDevice = booted.find((device) => device.udid === grant.udid);
          expect(bootedDevice, `simctl does not know about udid ${grant.udid}`).toBeDefined();
          expect(bootedDevice?.state).toBe("Booted");
          expect(
            bootedDevice?.name.startsWith("simlock-"),
            "device name must carry the simlock- prefix",
          ).toBe(true);

          // Provenance: both marks exist with the same token. `doctor` is the
          // documented way to observe this -- a foreign-provenance-change finding
          // for this device would mean the marks disagree or are missing.
          const doctorReport = await env.cli(["doctor"]);
          expect(doctorReport.code).toBe(0);
          const findings = (
            doctorReport.json as { findings: { kind: string; deviceId?: string }[] }
          ).findings;
          const devices = (await env.cli(["list", "--devices"])).json as {
            id: string;
            driverDeviceId: string;
          }[];
          const registryId = devices.find((device) => device.driverDeviceId === grant.udid)?.id;
          expect(
            findings.some(
              (finding) =>
                finding.kind === "foreign-provenance-change" && finding.deviceId === registryId,
            ),
            "expected no provenance drift for a device simlock just created",
          ).toBe(false);

          const release = await env.cli(["release", grant.lease]);
          expect(release.code).toBe(0);

          // Still Booted: the warm pool only demotes after idle.shutdownAfterMs,
          // which defaults far longer than this test.
          await waitFor(
            async () => {
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some((row) => row.driverDeviceId === grant.udid && row.state === "ready");
            },
            { timeout: 60_000, label: "device returns to ready after release" },
          );
          const stillBooted = await simctlDevices();
          expect(stillBooted.find((device) => device.udid === grant.udid)?.state).toBe("Booted");

          const nuke = await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 60_000 });
          expect(nuke.code).toBe(0);

          await waitFor(
            async () =>
              !(await simctlDevices()).some((device) => device.name.startsWith("simlock-")),
            { timeout: 60_000, label: "no simlock- simulator remains after nuke --delete-devices" },
          );
        } finally {
          await deleteStraySimlockSimulators();
        }
      },
    );
  },
);
