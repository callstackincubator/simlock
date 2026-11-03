import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { DEVICE_READY_MS, waitFor } from "./helpers/wait.js";

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

/**
 * why: the emulator keeps crash dumps in `/tmp/android-<user>/emu-crash-<version>.db`, shared with
 * Android Studio, and `-crash-report-mode never` deletes the ones in the database it reads.
 * Returns the shared `completed/` folder of the installed emulator.
 */
async function sharedCrashCompletedDir(): Promise<string> {
  const emulator = join(ANDROID_HOME, "emulator", "emulator");
  const { stdout } = await execFileAsync(emulator, ["-version"]);
  const version = /emulator version (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  if (version === undefined) {
    throw new Error(`could not read the emulator version from: ${stdout}`);
  }
  return join("/tmp", `android-${userInfo().username}`, `emu-crash-${version}.db`, "completed");
}

/** why: the test removes only the folders it created, so it needs the topmost one that was missing. */
function firstMissingAncestor(path: string): string | undefined {
  let missing: string | undefined;
  for (let dir = path; !existsSync(dir); dir = dirname(dir)) {
    missing = dir;
  }
  return missing;
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

function checkCatalog(output: AndroidCatalogOutput): void {
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

  expect(android.models[0]).toBe("Pixel 9");
  expect(android.modelClasses["Pixel 9"]).toBe("phone");
  expect(android.modelAliases["Pixel 9"]).toEqual(["pixel_9"]);
}

// Real emulator boots are slow and this SDK layout is host-specific, so this lane is
// gated on an actually-discoverable Android SDK rather than just `process.platform`.
describe.skipIf(!hasAndroidSdk)(
  "Android smoke (real emulator/adb)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "catalog lists Simlock's Pixel 9 first, a cold lease of Pixel 9 boots a real emulator with the library screen size and leaves a dump in the user's shared crash database alone, and a released emulator is deleted from the root and from avdmanager with no crash or false provenance finding",
      { timeout: 420_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          // why: a learned warm kind would re-boot the emulator the idle shutdown just stopped.
          configOverrides: { idle: { shutdownAfterMs: 300 }, warmPool: { learn: false } },
        });
        const { adbServerPort } = env;
        if (adbServerPort === undefined) {
          throw new Error("the real-SDK lane must allocate its own adb server port");
        }
        const completedDir = await sharedCrashCompletedDir();
        // why: crashpad skips a report file without its database xattrs, so a plain file would never be read, let alone deleted.
        const dumpId = randomUUID();
        const planted = join(completedDir, `${dumpId}.dmp`);
        const createdRoot = firstMissingAncestor(completedDir);
        try {
          await mkdir(completedDir, { recursive: true });
          await writeFile(planted, "simlock slow-lane crash dump marker");
          await execFileAsync("xattr", [
            "-w",
            "org.chromium.crashpad.database.uuid",
            dumpId,
            planted,
          ]);
          await execFileAsync("xattr", [
            "-w",
            "org.chromium.crashpad.database.creation_time",
            String(Math.floor(Date.now() / 1000)),
            planted,
          ]);
          const catalog = await env.cli(["catalog", "--json", "--platform", "android"]);
          expect(catalog.code).toBe(0);
          checkCatalog(catalog.json as AndroidCatalogOutput);

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "android",
              "--device",
              "Pixel 9",
              "--agent-id",
              "android-smoke",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const grant = lease.json as {
            device: { driverDeviceId: string };
            environment: Record<string, string>;
            lease: { id: string };
          };
          // why: the driver device id names the device's own folder, `<root>/<id>/simlock.avd`; every copy's AVD is called `simlock`.
          const avdName = grant.device.driverDeviceId;
          const avdFolder = join(env.home, "devices", "android", avdName);

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

          const size = await env.cli(["adb", "shell", "wm", "size"]);
          expect(size.stdout).toContain("Physical size: 1080x2424");
          const density = await env.cli(["adb", "shell", "wm", "density"]);
          expect(density.stdout).toContain("Physical density: 420");

          // why: the lease is up, so no dialog blocked the boot, and the launch must have left the user's shared crash database alone.
          expect(
            existsSync(planted),
            "the lease deleted a dump in the user's shared crash db",
          ).toBe(true);

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
            existsSync(join(avdFolder, "simlock.avd")),
            "expected the AVD to live inside Simlock's own device root",
          ).toBe(true);
          const avdNames = await avdManagerList();
          expect(
            avdNames.includes("simlock") || avdNames.includes(avdName),
            "a Simlock AVD must not appear in the user's own AVD home",
          ).toBe(false);

          const release = await env.cli(["release", grant.lease.id]);
          expect(release.code, `release failed: ${release.stderr}`).toBe(0);

          // why: a released emulator is deleted, never wiped and kept: its state, its AVD folder and its avdmanager entry all go.
          await waitFor(
            async () => {
              const rows = (await env.cli(["list", "--devices"])).json as {
                driverDeviceId: string;
                state: string;
              }[];
              return rows.some((row) => row.driverDeviceId === avdName && row.state === "deleted");
            },
            { timeout: 120_000, interval: 500, label: "device deleted after release" },
          );
          expect(existsSync(avdFolder), "the released emulator's folder is gone").toBe(false);
          expect((await avdManagerList()).includes(avdName)).toBe(false);

          // why: `doctor` must not crash on a deleted device nor report it as drift.
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
            findings.filter((finding) => finding.deviceId === registryId),
            "a deleted emulator must produce no finding",
          ).toEqual([]);

          const seeds = (
            doctorReport.json as { sources: { kind: string; platform: string }[] }
          ).sources.filter((source) => source.platform === "android" && source.kind === "seed");
          expect(seeds, "doctor lists the Android seed the lease was copied from").toHaveLength(1);

          const list = await env.cli(["list", "--devices"]);
          expect(list.code).toBe(0);

          // why: ADR 0059: the worker with real drivers holds the machine's worker lock while it runs and frees it at its stop.
          const lockFolder = join(`/tmp/simlock-${process.getuid?.() ?? 0}`, "worker.lock");
          const owner = JSON.parse(await readFile(join(lockFolder, "owner.json"), "utf8")) as {
            folder: string;
            pid: number;
          };
          expect(owner.folder).toBe(env.dataDirectory);
          expect(() => process.kill(owner.pid, 0)).not.toThrow();
          const stopped = await env.cli(["daemon", "stop"]);
          expect(stopped.code).toBe(0);
          // why: `daemon stop` returns once the stop is asked for; the release runs at the end of the daemon's dispose.
          await waitFor(() => !existsSync(lockFolder), {
            timeout: 60_000,
            label: "daemon stop left the worker lock behind",
          });
        } finally {
          await rm(planted, { force: true });
          if (createdRoot !== undefined) {
            await rm(createdRoot, { recursive: true, force: true });
          }
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
    it(
      "two plain leases of Pixel 9 at once are copies of one seed, a file written on one is absent from the next lease, and a released copy's folder is gone",
      { timeout: 900_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 }, warmPool: { learn: false } },
        });
        try {
          const root = join(env.home, "devices", "android");
          const lease = async (agent: string) => {
            const granted = await env.cli(
              [
                "lease",
                "--platform",
                "android",
                "--device",
                "Pixel 9",
                "--agent-id",
                agent,
                "--detach",
              ],
              { timeout: DEVICE_READY_MS },
            );
            expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
            return granted.json as {
              device: { address?: string; driverDeviceId: string };
              lease: { id: string };
            };
          };
          // why: a worker's `simlock adb` has no lease to aim at (`--lease` is a gateway's), and its adb server lists every emulator, so each call names the lease's own serial.
          const adbOn = (grant: { device: { address?: string } }, ...args: string[]) =>
            env.cli(["adb", "-s", grant.device.address ?? "", ...args]);

          const [first, second] = await Promise.all([lease("seed-one"), lease("seed-two")]);

          expect(
            (await readdir(join(root, "sources"))).filter((entry) => entry.startsWith("seed_")),
            "one seed serves both leases",
          ).toHaveLength(1);
          for (const grant of [first, second]) {
            expect(existsSync(join(root, grant.device.driverDeviceId, "simlock.avd"))).toBe(true);
          }
          const touched = await adbOn(first, "shell", "touch", "/data/local/tmp/t2");
          expect(touched.code, touched.stderr).toBe(0);

          for (const grant of [first, second]) {
            const release = await env.cli(["release", grant.lease.id]);
            expect(release.code, `release failed: ${release.stderr}`).toBe(0);
          }
          await waitFor(
            async () =>
              ![first, second].some((grant) => existsSync(join(root, grant.device.driverDeviceId))),
            { timeout: 120_000, interval: 500, label: "released copies' folders deleted" },
          );

          const third = await lease("seed-three");
          expect([first, second].map((grant) => grant.device.driverDeviceId)).not.toContain(
            third.device.driverDeviceId,
          );
          const listed = await adbOn(third, "shell", "ls", "/data/local/tmp/t2");
          expect(listed.code, "the file written on the first lease is not on a later one").not.toBe(
            0,
          );

          expect(await readFile(env.logPath, "utf8")).not.toContain(
            "Android snapshot boot fell back to a cold boot",
          );
          await env.cli(["release", third.lease.id]);
          await waitFor(async () => !existsSync(join(root, third.device.driverDeviceId)), {
            timeout: 120_000,
            interval: 500,
            label: "third copy's folder deleted",
          });
          const doctorReport = await env.cli(["doctor"]);
          expect(doctorReport.code, doctorReport.stderr).toBe(0);
          const seeds = (
            doctorReport.json as {
              sources: { kind: string; platform: string; sizeBytes?: number }[];
            }
          ).sources.filter((source) => source.platform === "android" && source.kind === "seed");
          expect(seeds, "doctor lists one Android seed").toHaveLength(1);
          expect(seeds[0]?.sizeBytes ?? 0).toBeGreaterThan(0);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
