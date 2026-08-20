import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { waitFor } from "./helpers/wait.js";

const execFileAsync = promisify(execFile);
const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

async function adbDevices(): Promise<string[]> {
  const adb = join(ANDROID_HOME, "platform-tools", "adb");
  const { stdout } = await execFileAsync(adb, ["devices"]).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("device"))
    .map((line) => line.split(/\s+/)[0] as string);
}

async function avdManagerList(): Promise<string[]> {
  const avdmanager = join(ANDROID_HOME, "cmdline-tools", "latest", "bin", "avdmanager");
  const binary = existsSync(avdmanager)
    ? avdmanager
    : join(ANDROID_HOME, "tools", "bin", "avdmanager");
  const { stdout } = await execFileAsync(binary, ["list", "avd"]).catch(() => ({ stdout: "" }));
  return [...stdout.matchAll(/Name:\s*(\S+)/g)].map((match) => match[1] as string);
}

// Real emulator boots are slow and this SDK layout is host-specific, so this lane is
// gated on an actually-discoverable Android SDK rather than just `process.platform`.
describe.skipIf(!hasAndroidSdk)(
  "Android smoke (real emulator/adb)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "catalog agrees with the SDK, a cold lease boots a real emulator, and a shut-down emulator reports erasableReadable:false with no crash or false provenance finding",
      { timeout: 420_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 } },
        });
        try {
          const catalog = await env.cli(["catalog", "--json", "--platform", "android"]);
          expect(catalog.code).toBe(0);
          const platforms = (
            catalog.json as { platforms: { platform: string; models: string[] }[] }
          ).platforms;
          const androidCatalog = platforms.find((platform) => platform.platform === "android");
          expect(
            androidCatalog,
            "pitlane catalog reported no android platform -- SDK discovery failed",
          ).toBeDefined();
          expect(androidCatalog?.models.length ?? 0).toBeGreaterThan(0);
          const model = androidCatalog?.models[0] as string;

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "android",
              "--device",
              model,
              "--agent-id",
              "android-smoke",
              "--detach",
            ],
            { timeout: 240_000 },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const grant = lease.json as { lease: string; udid: string };

          // The adb serial (e.g. "emulator-5554") is a driver-internal detail pitlane
          // deliberately keeps opaque outside drivers/android (architecture.md #2) --
          // `grant.udid` is pitlane's own AVD name, not the adb serial, so this only
          // asserts that *an* emulator is actually online, not which one by serial.
          const onlineSerials = await adbDevices();
          expect(
            onlineSerials.length,
            "expected at least one booted emulator visible to adb",
          ).toBeGreaterThan(0);

          const avdNames = await avdManagerList();
          expect(
            avdNames.some((name) => name.startsWith("pitlane_")),
            "expected a pitlane_-prefixed AVD",
          ).toBe(true);

          await env.cli(["release", grant.lease]);

          // Force the idle-shutdown rule (see flow 9) rather than waiting on the slow
          // periodic tick, so the emulator process actually stops.
          await waitFor(
            async () => {
              await env.cli(["cleanup"]);
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some(
                (row) => row.driverDeviceId === grant.udid && row.state === "shutdown",
              );
            },
            { timeout: 60_000, interval: 500, label: "device demoted to shutdown" },
          );

          // With the emulator process stopped, the on-device erasable mark is
          // unreachable -- `doctor` must not crash on that, must not report it as an
          // erase (unreadable is not the same as absent), and `list` must render fine.
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
            "a stopped emulator's unreadable mark must not be reported as a foreign-provenance-change",
          ).toBe(false);

          const list = await env.cli(["list", "--devices"]);
          expect(list.code).toBe(0);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
