import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";
import { iosDeviceSet, simctlInSet, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

interface LeaseGrant {
  readonly lease: string;
  readonly udid: string;
  readonly deviceSet: string;
}

interface CatalogPlatform {
  readonly platform: string;
  readonly models: readonly string[];
  readonly modelRuntimes: Readonly<Record<string, readonly string[]>>;
}

/** why: the simulator writes its volume here a few seconds after the command, and keeps it after shutdown (#1118). */
async function simVolume(grant: LeaseGrant): Promise<string | undefined> {
  const plist = join(
    grant.deviceSet,
    grant.udid,
    "data/var/run/simulatoraudio/audiosettings.plist",
  );
  try {
    const { stdout } = await execFileAsync("plutil", ["-extract", "sim_volume", "raw", plist]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function expectSilent(grant: LeaseGrant): Promise<void> {
  let last: string | undefined;
  await waitFor(
    async () => {
      last = await simVolume(grant);
      return last === "0";
    },
    {
      interval: 1_000,
      label: () => `sim_volume was ${last ?? "unreadable"}`,
      timeout: 30_000,
    },
  );
}

async function catalogModelAndOs(env: TestEnv): Promise<{ model: string; os: string }> {
  const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
  expect(catalog.code, `catalog failed: ${catalog.stderr}`).toBe(0);
  const platforms = (catalog.json as { platforms: CatalogPlatform[] }).platforms;
  const iosCatalog = platforms.find((platform) => platform.platform === "ios");
  const model = iosCatalog?.models.find(
    (name) => (iosCatalog.modelRuntimes[name]?.length ?? 0) > 0,
  );
  expect(model, "simlock catalog paired no iOS model with an installed runtime").toBeDefined();
  const os = [...(iosCatalog?.modelRuntimes[model as string] ?? [])].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )[0];
  return { model: model as string, os: os as string };
}

async function leaseDetached(
  env: TestEnv,
  model: string,
  os: string,
  agentId: string,
): Promise<LeaseGrant> {
  const lease = await env.cli(
    [
      "lease",
      "--platform",
      "ios",
      "--device",
      model,
      "--os",
      os,
      "--agent-id",
      agentId,
      "--detach",
    ],
    { timeout: 600_000 },
  );
  expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
  const grant = lease.json as {
    device: { driverDeviceId: string };
    environment: Record<string, string>;
    lease: { id: string };
  };
  return {
    deviceSet: grant.environment.SIMLOCK_IOS_DEVICE_SET as string,
    lease: grant.lease.id,
    udid: grant.device.driverDeviceId,
  };
}

describe.skipIf(process.platform !== "darwin")(
  "iOS simulator audio (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "a leased simulator on a worker with ios.simulator.audio false reads volume 0: first lease, a second lease, and after a recovery reboot",
      { timeout: 1_200_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({
          configOverrides: {
            health: { probeIntervalMs: 2_000, recoveryBackoffMs: 1_000, stableObservations: 1 },
            ios: { simulator: { audio: false } },
          },
          driver: "real",
        });
        expect(iosDeviceSet(env.home)).toBeDefined();
        const { model, os } = await catalogModelAndOs(env);

        const first = await leaseDetached(env, model, os, "audio-first");
        await expectSilent(first);

        await env.cli(["release", first.lease]);
        const second = await leaseDetached(env, model, os, "audio-second");
        expect(second.udid, "a released simulator is never leased again").not.toBe(first.udid);
        await expectSilent(second);

        await simctlInSet(second.deviceSet, ["shutdown", second.udid]);
        await env.expectEvents(["device.crash-detected", "device.recovered"], {
          since: "1h",
          timeout: 180_000,
        });
        await expectSilent(second);

        const log = await readFile(env.logPath, "utf8").catch(() => "");
        expect(
          log.split("\n").filter((line) => line.includes("Could not silence iOS simulator")),
        ).toEqual([]);

        await env.cli(["release", second.lease]).catch(() => undefined);
        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );
  },
);
