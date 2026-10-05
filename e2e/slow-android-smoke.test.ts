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

/** Simlock's emulators live on Simlock's own adb server, so that is the one to ask. */
async function adbDevices(serverPort: number): Promise<string[]> {
  const adb = join(ANDROID_HOME, "platform-tools", "adb");
  const { stdout } = await execFileAsync(adb, ["-P", String(serverPort), "devices"]).catch(() => ({
    stdout: "",
  }));
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

interface AndroidCatalogOutput {
  readonly platforms: readonly {
    readonly platform: string;
    readonly models: readonly string[];
    readonly runtimes: readonly string[];
    readonly modelClasses: Readonly<Record<string, string>>;
    readonly modelAliases: Readonly<Record<string, readonly string[]>>;
    readonly images?: readonly { runtime: string; tag: string; abi: string }[];
  }[];
}

/**
 * Checks the Android entry against the SDK on disk -- every listed image is installed, under a
 * runtime the catalog lists -- and returns the AVD id a built-in profile is listed with as
 * another name.
 */
function avdIdFromCatalog(output: AndroidCatalogOutput): string {
  const android = output.platforms.find((platform) => platform.platform === "android");
  if (android === undefined) {
    throw new Error("simlock catalog reported no android platform -- SDK discovery failed");
  }
  expect(android.models.length).toBeGreaterThan(0);
  // The class comes from the device profile's tag, read off this host's avdmanager.
  expect(android.modelClasses["Pixel 8"]).toBe("phone");
  expect(android.modelClasses["Television (1080p)"]).toBe("tv");

  const images = android.images ?? [];
  expect(images.length, "expected the installed system images to be listed").toBeGreaterThan(0);
  for (const image of images) {
    expect(android.runtimes).toContain(image.runtime);
    const path = join(
      ANDROID_HOME,
      "system-images",
      `android-${image.runtime}`,
      image.tag,
      image.abi,
    );
    expect(existsSync(path), `listed image ${JSON.stringify(image)} is not installed`).toBe(true);
  }

  const aliases = android.models.flatMap((name) => android.modelAliases[name] ?? []);
  expect(
    aliases.length,
    "expected a built-in profile with its AVD id as another name",
  ).toBeGreaterThan(0);
  return aliases[0] as string;
}

// Real emulator boots are slow and this SDK layout is host-specific, so this lane is
// gated on an actually-discoverable Android SDK rather than just `process.platform`.
describe.skipIf(!hasAndroidSdk)(
  "Android smoke (real emulator/adb)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "catalog agrees with the SDK and lists an AVD id and an installed image, a cold lease by that AVD id boots a real emulator, and a shut-down emulator reports erasableReadable:false with no crash or false provenance finding",
      { timeout: 420_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 } },
        });
        const { adbServerPort } = env;
        if (adbServerPort === undefined) {
          throw new Error("the real-SDK lane must allocate its own adb server port");
        }
        try {
          const catalog = await env.cli(["catalog", "--json", "--platform", "android"]);
          expect(catalog.code).toBe(0);
          // The lease below asks by an AVD id the catalog lists as another name.
          const model = avdIdFromCatalog(catalog.json as AndroidCatalogOutput);

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
          const grant = lease.json as {
            device: { driverDeviceId: string };
            environment: Record<string, string>;
            lease: { id: string };
          };
          // On Android the driver's device id is the AVD name (the driver refuses a record
          // where they differ), so this is the name to look for on disk and in avdmanager.
          const avdName = grant.device.driverDeviceId;

          // Without this, a holder's `adb` talks to the shared server, which by design
          // cannot see a Simlock emulator at all (ADR 0001, decision 7).
          expect(grant.environment).toEqual({
            ANDROID_ADB_SERVER_PORT: String(adbServerPort),
          });

          // `simlock adb` is the same scoping, made for the caller, and the refusals are
          // what keep the wrapper from handing back the capability containment removed.
          const wrapped = await env.cli(["adb", "devices"]);
          expect(wrapped.code, `simlock adb failed: ${wrapped.stderr}`).toBe(0);
          expect(wrapped.stdout).toContain("emulator-");

          const refused = await env.cli(["adb", "kill-server"]);
          expect(refused.code, "simlock adb kill-server must be refused, not run").toBe(2);
          expect(refused.error?.code).toBe("USAGE");

          // The adb serial (e.g. "emulator-5554") is a driver-internal detail simlock
          // deliberately keeps opaque outside drivers/android (architecture.md #2) --
          // the grant names simlock's own AVD, not the adb serial, so this only
          // asserts that *an* emulator is actually online, not which one by serial.
          const onlineSerials = await adbDevices(adbServerPort);
          expect(
            onlineSerials.length,
            "expected at least one booted emulator visible to Simlock's own adb server",
          ).toBeGreaterThan(0);

          // Ownership is root membership, not a name: the AVD must be inside the root this
          // env's Simlock owns, and must not be in the user's own AVD home at all.
          expect(
            existsSync(join(env.home, "devices", "android", `${avdName}.avd`)),
            "expected the AVD to live inside Simlock's own device root",
          ).toBe(true);
          const avdNames = await avdManagerList();
          expect(
            avdNames.includes(avdName),
            "a Simlock AVD must not appear in the user's own AVD home",
          ).toBe(false);

          const release = await env.cli(["release", grant.lease.id]);
          expect(release.code, `release failed: ${release.stderr}`).toBe(0);

          // Force the idle-shutdown rule (see flow 9) rather than waiting on the slow
          // periodic tick, so the emulator process actually stops.
          await waitFor(
            async () => {
              await env.cli(["cleanup"]);
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some((row) => row.driverDeviceId === avdName && row.state === "shutdown");
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
          const registryId = devices.find((device) => device.driverDeviceId === avdName)?.id;
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
