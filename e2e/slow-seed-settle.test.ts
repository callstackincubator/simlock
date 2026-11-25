import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { requireAndroidSdk } from "./helpers/test-android-sdk.js";
import { DEVICE_READY_MS, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";
import { sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

/**
 * why: the fast lane proves that `simlock seed` makes and settles a seed against fakes; only real
 * hardware can show what ADR 0090 promises, that a copy of a settled seed does less work than a
 * copy of a quick one. Each platform leases one copy of a quick seed and measures the CPU its
 * processes use in the 5 minutes after it is ready, then settles the seed with `simlock seed`,
 * leases a copy of the settled seed, and measures the same. Android must use under half of
 * the quick copy's CPU time; iOS has no ratio (measured 0.95 of the quick copy's total, which is
 * dominated by the boot both copies share) and must use under 0.3 cores from its minute 3.
 *
 * Run only through `scripts/slow-e2e.sh e2e/slow-seed-settle.test.ts`, never in CI.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** why: `simlock seed` waits at most 60 minutes before it fails; a settle itself takes about 6. */
const SEED_TIMEOUT = 61 * MINUTE;
const QUERY_TIMEOUT = MINUTE;
/** why: two leases, two 5-minute windows, a settle of up to 60 minutes and the releases, with room for the setup. */
const TEST_TIMEOUT = 100 * MINUTE;

type Platform = "ios" | "android";

interface Grant {
  readonly device: { readonly driverDeviceId: string; readonly address?: string };
  readonly lease: { readonly id: string };
}

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly seconds: number;
  readonly command: string;
}

function cpuSeconds(text: string): number {
  return text.split(":").reduce((total, part) => total * 60 + Number.parseFloat(part), 0);
}

async function processTable(): Promise<Row[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,time=,command="], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: QUERY_TIMEOUT,
  });
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      command: match[4] as string,
      pid: Number(match[1]),
      ppid: Number(match[2]),
      seconds: cpuSeconds(match[3] as string),
    }));
}

/**
 * why: an emulator's command line never names its device (every copy's AVD is called `simlock`, and its folder is
 * only in the environment), but it always carries `-port <console port>`, which is the number in the lease's
 * `emulator-<port>` address; a simulator's command line carries its own folder or id.
 */
function namesDevice(command: string, grant: Grant): boolean {
  const port = /^emulator-(\d+)$/.exec(grant.device.address ?? "")?.[1];
  if (port !== undefined) return new RegExp(`(^|\\s)-port ${port}(\\s|$)`).test(command);
  return command.includes(grant.device.driverDeviceId);
}

/**
 * why: a simulator's work is spread over its `launchd_sim` and its children, and an emulator's over one process and its helpers; the device is
 * the roots that name it and everything below them.
 */
async function deviceCpuSeconds(grant: Grant): Promise<number> {
  const table = await processTable();
  const members = new Set(
    table.filter((row) => namesDevice(row.command, grant)).map((row) => row.pid),
  );
  expect(
    members.size,
    `no process names the device ${grant.device.driverDeviceId} (${grant.device.address ?? "no address"})`,
  ).toBeGreaterThan(0);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      if (!members.has(row.pid) && members.has(row.ppid)) {
        members.add(row.pid);
        grew = true;
      }
    }
  }
  return table.filter((row) => members.has(row.pid)).reduce((total, row) => total + row.seconds, 0);
}

async function lease(
  env: TestEnv,
  platform: Platform,
  osFlags: readonly string[],
  agent: string,
): Promise<Grant> {
  const granted = await env.cli(
    ["lease", "--platform", platform, ...osFlags, "--agent-id", agent, "--detach"],
    { timeout: DEVICE_READY_MS },
  );
  expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
  return granted.json as Grant;
}

async function measure(grant: Grant): Promise<number[]> {
  const samples = [await deviceCpuSeconds(grant)];
  for (let minute = 1; minute <= 5; minute += 1) {
    const mark = Date.now();
    await waitFor(async () => Date.now() - mark >= MINUTE, {
      interval: SECOND,
      timeout: 2 * MINUTE,
    });
    samples.push(await deviceCpuSeconds(grant));
  }
  return samples.slice(1).map((value, index) => value - (samples[index] as number));
}

const total = (perMinute: readonly number[]): number =>
  perMinute.reduce((sum, value) => sum + value, 0);

async function release(env: TestEnv, grant: Grant): Promise<void> {
  const released = await env.cli(["release", grant.lease.id], { timeout: 2 * MINUTE });
  expect(released.code, `release failed: ${released.stderr}`).toBe(0);
}

describe.skipIf(process.platform !== "darwin")(
  "simlock seed on real devices",
  { tags: ["slow", "ios", "android"] },
  () => {
    it.each([
      // why: ADR 0090 measured Android 36; the newest image on a host (37, 16 KiB pages) idles at about one core whether settled or not, so the case pins the measured one.
      {
        platform: "android" as const,
        ratio: 0.5,
        osFlags: ["--os", "36.1"],
        claim: "uses under half of the CPU time of a copy of its quick seed in its first 5 minutes",
      },
      {
        platform: "ios" as const,
        ratio: undefined,
        osFlags: [],
        claim: "uses under 0.3 cores from its third minute",
      },
    ])(
      "a copy of a $platform seed settled with simlock seed $claim",
      { timeout: TEST_TIMEOUT },
      async ({ platform, ratio, osFlags }) => {
        if (platform === "ios") await sweepStaleDeviceSets();
        else requireAndroidSdk();
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 }, warmPool: { learn: false } },
        });
        try {
          const quick = await lease(env, platform, osFlags, "seed-quick");
          const model = await modelOf(env, quick);
          const quickMinutes = await measure(quick);
          await release(env, quick);

          const seeded = await env.cli(["seed", platform, model, ...osFlags, "--json"], {
            timeout: SEED_TIMEOUT,
          });
          expect(seeded.code, `seed failed: ${seeded.stderr}`).toBe(0);
          expect((seeded.json as { outcome: string }).outcome).toMatch(/settled/);

          const settled = await lease(env, platform, osFlags, "seed-settled");
          const settledMinutes = await measure(settled);
          await release(env, settled);

          if (ratio !== undefined) {
            expect(
              total(settledMinutes),
              `quick copy ${JSON.stringify(quickMinutes)} s per minute, settled copy ${JSON.stringify(settledMinutes)}, seed answered ${seeded.stdout.trim()}`,
            ).toBeLessThan(total(quickMinutes) * ratio);
          }
          if (platform === "ios") {
            for (const seconds of settledMinutes.slice(2)) {
              expect(seconds / 60, "cores used by the settled iOS copy from minute 3").toBeLessThan(
                0.3,
              );
            }
          }
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 5 * MINUTE })
            .catch(() => undefined);
        }
      },
    );
  },
);

async function modelOf(env: TestEnv, grant: Grant): Promise<string> {
  const listed = await env.cli(["list", "--devices"], { timeout: QUERY_TIMEOUT });
  const devices = listed.json as readonly {
    driverDeviceId: string;
    spec: { model: string };
  }[];
  const device = devices.find((entry) => entry.driverDeviceId === grant.device.driverDeviceId);
  expect(device, "the leased device is listed").toBeDefined();
  return (device as (typeof devices)[number]).spec.model;
}
