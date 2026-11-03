import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";
import { iosDeviceSet, setDevices, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";
import { DEVICE_READY_MS } from "./helpers/wait.js";

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

interface ListedBaseline {
  readonly name: string;
  readonly version: number;
  readonly sizeBytes?: number;
}

async function baselines(env: TestEnv): Promise<readonly ListedBaseline[]> {
  const listed = await env.cli(["baseline", "list", "--json"]);
  expect(listed.code, `baseline list failed: ${listed.stderr}`).toBe(0);
  return (listed.json as { baselines: ListedBaseline[] }).baselines;
}

async function expectLeaseEnded(env: TestEnv, leaseId: string): Promise<void> {
  const leases = await env.cli(["list", "--leases"]);
  expect(leases.code, `list failed: ${leases.stderr}`).toBe(0);
  expect((leases.json as { id: string }[]).map((lease) => lease.id)).not.toContain(leaseId);
}

// why: this lane needs the real simctl toolchain, hence darwin-only; it never installs a runtime.
describe.skipIf(process.platform !== "darwin")(
  "baseline save (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "saves a leased iPhone as baseline version 1 with a size above 0, ends the lease, lists the source only in the sources set, and keeps the file written into the device's data folder",
      { timeout: 900_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({ driver: "real" });
        const lease = await env.cli(
          ["lease", "--platform", "ios", "--agent-id", "baseline-ios", "--detach"],
          { timeout: DEVICE_READY_MS },
        );
        expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
        const grant = lease.json as {
          device: { driverDeviceId: string };
          environment: Record<string, string>;
          lease: { id: string };
        };
        const deviceSet = grant.environment.SIMLOCK_IOS_DEVICE_SET as string;
        const udid = grant.device.driverDeviceId;
        const marker = join(deviceSet, udid, "data", "tmp", "simlock-baseline.txt");
        await mkdir(join(deviceSet, udid, "data", "tmp"), { recursive: true });
        await writeFile(marker, "prepared");

        const saved = await env.cli(["baseline", "save", "slow-ios", "--lease", grant.lease.id], {
          timeout: 600_000,
        });
        expect(saved.code, `baseline save failed: ${saved.stderr}`).toBe(0);

        await expectLeaseEnded(env, grant.lease.id);
        const [listed] = await baselines(env);
        expect(listed).toMatchObject({ name: "slow-ios", version: 1 });
        expect(listed?.sizeBytes ?? 0).toBeGreaterThan(0);

        // why: the sources set sits beside the device set under a custom root, or under `ios-sources` for the default set.
        const sourcesSets = [join(deviceSet, "sources"), join(env.home, "devices", "ios-sources")];
        const sourcesSet = sourcesSets.find((candidate) => existsSync(candidate));
        expect(sourcesSet, "no sources set exists after a save").toBeDefined();
        const inSources = await setDevices(sourcesSet as string);
        expect(inSources).toHaveLength(1);
        const source = inSources[0];
        const inDeviceSet = await setDevices(iosDeviceSet(env.home));
        expect(inDeviceSet.map((device) => device.udid)).not.toContain(source?.udid);
        const simctlList = await env.cli(["simctl", "list", "devices"]);
        expect(simctlList.stdout).not.toContain(source?.udid ?? "no source");
        expect(
          await readdir(join(sourcesSet as string, source?.udid ?? "", "data", "tmp")),
        ).toContain("simlock-baseline.txt");

        // why: a lease naming the baseline starts from a copy that holds the saved file, and the copy's own changes are gone for the next one.
        const copyDirectory = async (): Promise<{ leaseId: string; directory: string }> => {
          const copy = await env.cli(
            [
              "lease",
              "--platform",
              "ios",
              "--baseline",
              "slow-ios",
              "--agent-id",
              "baseline-ios",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(copy.code, `lease naming the baseline failed: ${copy.stderr}`).toBe(0);
          const copied = copy.json as {
            device: {
              driverDeviceId: string;
              spec: { baseline?: { name: string; version: number } };
            };
            environment: Record<string, string>;
            lease: { id: string };
          };
          expect(copied.device.spec.baseline).toEqual({ name: "slow-ios", version: 1 });
          return {
            directory: join(
              copied.environment.SIMLOCK_IOS_DEVICE_SET as string,
              copied.device.driverDeviceId,
              "data",
              "tmp",
            ),
            leaseId: copied.lease.id,
          };
        };
        const first = await copyDirectory();
        expect(await readdir(first.directory)).toContain("simlock-baseline.txt");
        await writeFile(join(first.directory, "simlock-session.txt"), "left behind");
        const released = await env.cli(["release", first.leaseId]);
        expect(released.code, `release failed: ${released.stderr}`).toBe(0);
        const second = await copyDirectory();
        const files = await readdir(second.directory);
        expect(files).toContain("simlock-baseline.txt");
        expect(files).not.toContain("simlock-session.txt");
      },
    );
  },
);

describe.skipIf(!hasAndroidSdk)(
  "baseline save (real emulator)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "saves a leased emulator as baseline version 1 after writing a setting, ends the lease, and keeps a simlock_boot snapshot in the source",
      { timeout: 900_000 },
      async () => {
        const env = await withDaemon({ driver: "real" });
        const lease = await env.cli(
          ["lease", "--platform", "android", "--agent-id", "baseline-android", "--detach"],
          { timeout: DEVICE_READY_MS },
        );
        expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
        const grant = lease.json as { lease: { id: string } };
        const written = await env.cli([
          "adb",
          "shell",
          "settings",
          "put",
          "global",
          "simlock_baseline",
          "1",
        ]);
        expect(written.code, `settings put failed: ${written.stderr}`).toBe(0);

        const saved = await env.cli(
          ["baseline", "save", "slow-android", "--lease", grant.lease.id],
          { timeout: 900_000 },
        );
        expect(saved.code, `baseline save failed: ${saved.stderr}`).toBe(0);

        await expectLeaseEnded(env, grant.lease.id);
        const [listed] = await baselines(env);
        expect(listed).toMatchObject({ name: "slow-android", version: 1 });
        const sources = join(env.home, "devices", "android", "sources");
        const folders = await readdir(sources);
        const snapshots = folders.map((folder) =>
          join(sources, folder, "simlock.avd", "snapshots", "simlock_boot"),
        );
        expect(
          snapshots.some((snapshot) => existsSync(snapshot)),
          "the source holds no snapshots/simlock_boot folder",
        ).toBe(true);

        // why: a lease naming the baseline starts from a copy that holds the saved setting, and the copy's own changes are gone for the next one.
        const copyLease = async (): Promise<string> => {
          const copy = await env.cli(
            [
              "lease",
              "--platform",
              "android",
              "--baseline",
              "slow-android",
              "--agent-id",
              "baseline-android",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(copy.code, `lease naming the baseline failed: ${copy.stderr}`).toBe(0);
          return (copy.json as { lease: { id: string } }).lease.id;
        };
        const setting = async (): Promise<string> => {
          const read = await env.cli([
            "adb",
            "shell",
            "settings",
            "get",
            "global",
            "simlock_baseline",
          ]);
          return read.stdout.trim();
        };
        const copyId = await copyLease();
        expect(await setting()).toBe("1");
        const changed = await env.cli([
          "adb",
          "shell",
          "settings",
          "put",
          "global",
          "simlock_baseline",
          "2",
        ]);
        expect(changed.code, `settings put failed: ${changed.stderr}`).toBe(0);
        const released = await env.cli(["release", copyId]);
        expect(released.code, `release failed: ${released.stderr}`).toBe(0);
        await copyLease();
        expect(await setting()).toBe("1");
      },
    );
  },
);
