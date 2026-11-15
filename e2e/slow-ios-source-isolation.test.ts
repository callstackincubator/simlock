import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { IOS } from "./helpers/agent-device-targets.js";
import { withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";
import { iosSourcesFolder, setDevices, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";
import { DEVICE_READY_MS } from "./helpers/wait.js";

// why: a copy writes its first minutes of state (home-screen snapshots, ManagedSettings records) into whatever folder its stored paths name, so each copy is used and left running this long before the sources are read.
const USE_MS = 45_000;
const DIAGNOSTICS = join("data", "var", "db", "diagnostics");
const SWAP_MS_LIMIT = 1000;

interface Lease {
  readonly leaseId: string;
  readonly udid: string;
  readonly deviceSet: string;
}

// why: a requester holds one lease at a time, and the first lease stays held while the others are made.
let leasesMade = 0;

async function lease(env: TestEnv, extra: readonly string[]): Promise<Lease> {
  leasesMade += 1;
  const granted = await env.cli(
    [
      "lease",
      "--platform",
      "ios",
      "--agent-id",
      `isolation-${String(leasesMade)}`,
      "--detach",
      ...extra,
    ],
    { timeout: DEVICE_READY_MS },
  );
  expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
  const grant = granted.json as {
    device: { driverDeviceId: string };
    environment: Record<string, string>;
    lease: { id: string };
  };
  return {
    deviceSet: grant.environment.SIMLOCK_IOS_DEVICE_SET as string,
    leaseId: grant.lease.id,
    udid: grant.device.driverDeviceId,
  };
}

/** why: the copy runs an installed app and idles, as a lease does, so what it writes is what a lease's simulator writes. */
async function use(env: TestEnv, held: Lease): Promise<void> {
  const installed = await env.cli(["simctl", "install", held.udid, IOS.app]);
  expect(installed.code, `install failed: ${installed.stderr}`).toBe(0);
  const started = await env.cli(["simctl", "launch", held.udid, IOS.bundleId]);
  expect(started.code, `launch failed: ${started.stderr}`).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, USE_MS));
}

async function release(env: TestEnv, held: Lease): Promise<void> {
  const released = await env.cli(["release", held.leaseId]);
  expect(released.code, `release failed: ${released.stderr}`).toBe(0);
}

async function modifiedFiles(folder: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const details = await lstat(path);
      if (relative(folder, path) === DIAGNOSTICS) continue;
      if (details.isDirectory()) await walk(path);
      else found.set(relative(folder, path), details.mtimeMs);
    }
  };
  if (existsSync(folder)) await walk(folder);
  return found;
}

async function filesNewerThan(folder: string, since: number): Promise<string[]> {
  return [...(await modifiedFiles(folder))]
    .filter(([, time]) => time > since)
    .map(([path]) => path);
}

/** why: a seed is made when its WALs are flushed and its files indexed, which is after `simctl` wrote its last file; the newest file once the first lease is granted is that moment. */
async function newestModification(folder: string): Promise<number> {
  return Math.max(0, ...(await modifiedFiles(folder)).values());
}

async function expectOwnLogFolder(held: Lease): Promise<void> {
  const target = await readlink(join(held.deviceSet, held.udid, "data", "Library", "Logs"));
  expect(target, `${held.udid}'s Logs link`).toBe(
    join(homedir(), "Library", "Logs", "CoreSimulator", held.udid),
  );
}

/** why: a lease used and released, as an agent's would be; the returned lease is the one released. */
async function useAndRelease(env: TestEnv, extra: readonly string[]): Promise<Lease> {
  const copy = await lease(env, extra);
  await use(env, copy);
  await expectOwnLogFolder(copy);
  await release(env, copy);
  return copy;
}

async function expectNothingNewer(folder: string, since: number, what: string): Promise<void> {
  expect(await filesNewerThan(folder, since), what).toEqual([]);
}

async function swapMilliseconds(env: TestEnv, udid: string): Promise<number> {
  const log = await readFile(join(env.home, "daemon.log"), "utf8");
  const match = log
    .split("\n")
    .map((entry) => /swapped \d+ files and \d+ links in (\d+) ms for (\S+?)["\s]/.exec(entry))
    .find((found) => found?.[2] === udid);
  expect(match, `the swap line of ${udid} in daemon.log`).toBeDefined();
  return Number(match?.[1]);
}

// why: this lane needs the real simctl toolchain, hence darwin-only; it never installs a runtime.
describe.skipIf(process.platform !== "darwin")(
  "iOS source isolation (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "three leases of one kind and two of a baseline saved from a used lease leave no file newer than its making in the seed, the baseline's source or the saved-from lease's folder, each simulator's Logs link names its own log folder, and each baseline copy's swap is logged under 1000 ms",
      { timeout: 1_800_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({
          configOverrides: { log: { level: "debug" } },
          driver: "real",
        });
        const sources = iosSourcesFolder(env.home);

        const first = await lease(env, []);
        const seed = (await setDevices(sources)).find((device) =>
          device.name.startsWith("simlock-seed-"),
        );
        expect(seed, "the seed made for the first lease").toBeDefined();
        const seedMadeAt = await newestModification(join(sources, seed?.udid ?? ""));
        await use(env, first);
        await expectOwnLogFolder(first);
        for (let index = 0; index < 2; index += 1) await useAndRelease(env, []);

        const saved = await env.cli(["baseline", "save", "isolation", "--lease", first.leaseId], {
          timeout: 600_000,
        });
        expect(saved.code, `baseline save failed: ${saved.stderr}`).toBe(0);
        const savedAt = Date.now();
        const source = (await setDevices(sources)).find((device) =>
          device.name.startsWith("simlock-baseline-"),
        );
        expect(source, "the baseline's source").toBeDefined();

        const copies: Lease[] = [];
        for (let index = 0; index < 2; index += 1) {
          copies.push(await useAndRelease(env, ["--baseline", "isolation"]));
        }

        await expectNothingNewer(join(sources, seed?.udid ?? ""), seedMadeAt, "the seed");
        await expectNothingNewer(
          join(sources, source?.udid ?? ""),
          savedAt,
          "the baseline's source",
        );
        await expectNothingNewer(
          join(first.deviceSet, first.udid),
          savedAt,
          "the folder of the lease the baseline was saved from",
        );
        for (const copy of copies) {
          expect(await swapMilliseconds(env, copy.udid), `${copy.udid}'s swap`).toBeLessThan(
            SWAP_MS_LIMIT,
          );
        }
      },
    );
  },
);
