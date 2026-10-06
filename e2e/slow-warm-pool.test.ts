import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon, waitFor, type TestEnv } from "./helpers/index.js";
import { iosDeviceSet, setDevices, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

/**
 * The warm pool on real devices: a target boots a real simulator and a real emulator ahead of any
 * lease, and with the pool off a released device of each platform ends shut down. The fast lane
 * proves what the pool decides against fake drivers; only a real `simctl` and a real emulator can
 * prove that the create-and-boot path works end to end and that the Android snapshot restore
 * followed by the pool's shutdown leaves an emulator that boots cleanly next time.
 *
 * Run only through `scripts/slow-e2e.sh e2e/slow-warm-pool.test.ts`, never in CI.
 */

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
/** The ABI an emulator runs natively on this host; an image of the other ABI is listed but cannot boot. */
const HOST_ABI = process.arch === "arm64" ? "arm64-v8a" : "x86_64";

type Platform = "ios" | "android";

interface Target {
  readonly count: 1;
  readonly model: string;
  readonly osVersion: string;
  readonly platform: Platform;
}

interface Row {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly state: string;
  readonly spec: { readonly platform: Platform; readonly model: string };
}

interface Grant {
  readonly device: Row;
  readonly lease: { readonly id: string };
}

interface CatalogPlatform {
  readonly platform: string;
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly modelRuntimes: Readonly<Record<string, readonly string[]>>;
  readonly classDefaults: Readonly<Record<string, string>>;
  readonly images?: readonly { runtime: string; tag: string; abi: string }[];
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** Two real boots (one of them an emulator), one lease and release of each, and a second round. */
const TEST_TIMEOUT = 30 * MINUTE;
const LEASE_TIMEOUT = 10 * MINUTE;
const READY_TIMEOUT = 15 * MINUTE;
/** How long a shut-down device is watched: several pool ticks, so a pool still on would have booted it. */
const HOLD = 45 * SECOND;

/** The installed iOS runtimes; empty when `xcrun simctl` is missing or unusable, so the lane skips. */
async function installedIosRuntimes(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"]);
    const parsed = JSON.parse(stdout) as {
      runtimes: { version: string; isAvailable: boolean; platform?: string }[];
    };
    return parsed.runtimes
      .filter((runtime) => runtime.isAvailable && (runtime.platform ?? "iOS") === "iOS")
      .map((runtime) => runtime.version);
  } catch {
    return [];
  }
}

/** Whether an emulator, adb and a system image of the host's ABI (`system-images/<api>/<tag>/<abi>`) exist. */
function installedAndroidImages(): boolean {
  const root = join(ANDROID_HOME, "system-images");
  if (
    !existsSync(join(ANDROID_HOME, "emulator", "emulator")) ||
    !existsSync(join(ANDROID_HOME, "platform-tools", "adb")) ||
    !existsSync(root)
  ) {
    return false;
  }
  try {
    return readdirSync(root).some((api) =>
      readdirSync(join(root, api)).some((tag) => existsSync(join(root, api, tag, HOST_ABI))),
    );
  } catch {
    return false;
  }
}

/** The reason this machine cannot run the lane, naming the missing platform; undefined when it can. */
async function missingPlatform(): Promise<string | undefined> {
  if (process.platform !== "darwin" || (await installedIosRuntimes()).length === 0) {
    return "iOS is missing: no macOS host with an installed iOS runtime";
  }
  if (!installedAndroidImages()) {
    return `Android is missing: no emulator, adb and installed ${HOST_ABI} system image`;
  }
  return undefined;
}

/** Simlock's emulators live on Simlock's own adb server, so that is the one to ask. */
async function onlineEmulators(adbServerPort: number): Promise<string[]> {
  const adb = join(ANDROID_HOME, "platform-tools", "adb");
  const { stdout } = await execFileAsync(adb, ["-P", String(adbServerPort), "devices"]).catch(
    () => ({ stdout: "" }),
  );
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("device"))
    .map((line) => line.split(/\s+/)[0] as string);
}

function newest(versions: readonly string[]): string | undefined {
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

/** The newest installed runtime the phone-class default model pairs with, and that model. */
function targetFor(catalog: CatalogPlatform, platform: Platform): Target {
  const runnable =
    platform === "android"
      ? (catalog.images ?? []).filter((image) => image.abi === HOST_ABI).map((i) => i.runtime)
      : catalog.runtimes;
  const phone = catalog.classDefaults["phone"];
  const osVersion = newest(
    runnable.filter(
      (runtime) => phone !== undefined && catalog.modelRuntimes[phone]?.includes(runtime),
    ),
  );
  if (phone === undefined || osVersion === undefined) {
    throw new Error(
      `no installed ${platform} runtime pairs with the phone-class model: ${JSON.stringify(catalog)}`,
    );
  }
  return { count: 1, model: phone, osVersion, platform };
}

async function writeWarmPool(env: TestEnv, warmPool: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(env.configPath, "utf8")) as {
    warmPool?: Record<string, unknown>;
  };
  current.warmPool = { ...current.warmPool, ...warmPool };
  await writeFile(env.configPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await env.restartDaemon();
}

interface Lane {
  readonly env: TestEnv;
  readonly adbServerPort: number;
  readonly deviceSet: string;
  readonly targets: Record<Platform, Target>;
}

/** A real-driver daemon whose pool targets one device of the newest runtime of each platform. */
async function warmDaemon(): Promise<Lane> {
  await sweepStaleDeviceSets();
  const env = await withDaemon({ driver: "real" });
  const adbServerPort = env.adbServerPort;
  if (adbServerPort === undefined) throw new Error("the real-SDK lane must allocate an adb port");
  const reported = await env.cli(["catalog", "--json"]);
  expect(reported.code, `catalog failed: ${reported.stderr}`).toBe(0);
  const platforms = (reported.json as { platforms: CatalogPlatform[] }).platforms;
  const catalogOf = (platform: Platform): CatalogPlatform => {
    const found = platforms.find((entry) => entry.platform === platform);
    if (found === undefined) throw new Error(`simlock catalog reported no ${platform} platform`);
    return found;
  };
  const targets = {
    android: targetFor(catalogOf("android"), "android"),
    ios: targetFor(catalogOf("ios"), "ios"),
  };
  await writeWarmPool(env, {
    maxConcurrentBoots: 2,
    targets: [targets.ios, targets.android],
  });
  return { adbServerPort, deviceSet: iosDeviceSet(env.home), env, targets };
}

async function devices(env: TestEnv): Promise<Row[]> {
  const listed = await env.cli(["list", "--devices"]);
  expect(listed.code, listed.stderr).toBe(0);
  return listed.json as Row[];
}

/** Waits until the device with this driver id is in `state`, naming the last rows seen on timeout. */
async function untilState(
  env: TestEnv,
  driverDeviceId: string,
  state: string,
  timeout = READY_TIMEOUT,
): Promise<void> {
  let last: Row[] = [];
  await waitFor(
    async () => {
      last = await devices(env);
      return last.some((row) => row.driverDeviceId === driverDeviceId && row.state === state);
    },
    {
      interval: 1000,
      label: () =>
        `${driverDeviceId} is ${state}; last saw ${JSON.stringify(last.map((r) => [r.driverDeviceId, r.state]))}`,
      timeout,
    },
  );
}

/** Fails if the device leaves `state` at any poll within `duration`: an end state must hold, not be seen once. */
async function holdsState(
  env: TestEnv,
  driverDeviceId: string,
  state: string,
  duration: number,
): Promise<void> {
  const until = Date.now() + duration;
  await waitFor(
    async () => {
      const row = (await devices(env)).find((entry) => entry.driverDeviceId === driverDeviceId);
      expect(row?.state, `${driverDeviceId} stays ${state}`).toBe(state);
      return Date.now() >= until;
    },
    { interval: 2000, label: `${driverDeviceId} stays ${state}`, timeout: duration + MINUTE },
  );
}

/** Waits for one ready device per platform, with no lease asked for yet. */
async function untilBothReady(env: TestEnv): Promise<Row[]> {
  let last: Row[] = [];
  await waitFor(
    async () => {
      last = await devices(env);
      return (["ios", "android"] as const).every((platform) =>
        last.some((row) => row.spec.platform === platform && row.state === "ready"),
      );
    },
    {
      interval: 2000,
      label: () => `a ready simulator and a ready emulator; last saw ${JSON.stringify(last)}`,
      timeout: READY_TIMEOUT,
    },
  );
  return last;
}

async function lease(
  env: TestEnv,
  target: Target,
  agent: string,
): Promise<{ readonly grant: Grant; readonly stderr: string }> {
  const result = await env.cli(
    [
      "lease",
      "--platform",
      target.platform,
      "--device",
      target.model,
      "--os",
      target.osVersion,
      "--agent-id",
      agent,
      "--detach",
    ],
    { timeout: LEASE_TIMEOUT },
  );
  expect(result.code, `${target.platform} lease failed: ${result.stderr}`).toBe(0);
  return { grant: result.json as Grant, stderr: result.stderr };
}

async function release(env: TestEnv, grant: Grant): Promise<void> {
  const released = await env.cli(["release", grant.lease.id], { timeout: LEASE_TIMEOUT });
  expect(released.code, `release failed: ${released.stderr}`).toBe(0);
}

/** The `booting` progress lines a lease wrote to stderr; one per boot the lease waited on. */
function bootingLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => {
    try {
      const parsed = JSON.parse(line) as { push?: string; stage?: string };
      return parsed.push === "progress" && parsed.stage === "booting";
    } catch {
      return false;
    }
  });
}

async function expectGrantedWarm(
  env: TestEnv,
  granted: readonly Grant[],
  readyEvents: readonly { timestamp: number }[],
): Promise<void> {
  const grantedEvents = (await env.events()).filter((entry) => entry.event === "lease.granted");
  for (const grant of granted) {
    const entry = grantedEvents.find(
      (candidate) => (candidate.payload as { leaseId?: string }).leaseId === grant.lease.id,
    );
    expect(
      entry?.payload,
      `${grant.device.spec.platform}: lease.granted names the warm pool as its source`,
    ).toMatchObject({ source: "warm" });
    expect(entry?.timestamp ?? 0).toBeGreaterThan(
      Math.max(...readyEvents.map((ready) => ready.timestamp)),
    );
  }
}

async function nuke(env: TestEnv): Promise<void> {
  await env
    .cli(["nuke", "--delete-devices", "--yes"], { timeout: 5 * MINUTE })
    .catch(() => undefined);
}

describe(
  "warm pool targets (real simctl and emulator)",
  { tags: ["slow", "ios", "android"] },
  () => {
    it(
      "with a target of one iPhone and one Android phone, ends with one ready simulator and one ready emulator before any lease",
      { timeout: TEST_TIMEOUT },
      async (context) => {
        const missing = await missingPlatform();
        if (missing !== undefined) context.skip(missing);
        const { env } = await warmDaemon();
        try {
          const rows = await untilBothReady(env);

          for (const platform of ["ios", "android"] as const) {
            const ofPlatform = rows.filter((row) => row.spec.platform === platform);
            expect(
              ofPlatform.map((row) => row.state),
              `${platform} devices`,
            ).toEqual(["ready"]);
          }
          const recorded = await env.events();
          expect(
            recorded.filter((entry) => entry.event.startsWith("lease.")),
            "no lease was asked for before the devices were ready",
          ).toEqual([]);
          const ready = recorded.filter((entry) => entry.event === "device.ready");
          // The two lines the verifier reads in the log: both device.ready events, before any lease.
          for (const entry of ready) {
            console.info(
              `device.ready ${JSON.stringify(entry.payload)} at ${new Date(entry.timestamp).toISOString()}`,
            );
          }
          expect(
            ready.map((entry) => (entry.payload as { deviceId: string }).deviceId).sort(),
          ).toEqual(rows.map((row) => row.id).sort());
        } finally {
          await nuke(env);
        }
      },
    );

    it(
      "grants the first lease of each targeted model warm with no booting progress, and after release each device is ready again",
      { timeout: TEST_TIMEOUT },
      async (context) => {
        const missing = await missingPlatform();
        if (missing !== undefined) context.skip(missing);
        const { env, targets } = await warmDaemon();
        try {
          await untilBothReady(env);
          const before = await env.events();
          const readyEvents = before.filter((entry) => entry.event === "device.ready");
          expect(readyEvents.length, "device.ready events before the first lease").toBeGreaterThan(
            1,
          );
          for (const entry of readyEvents) {
            console.info(
              `device.ready ${JSON.stringify(entry.payload)} at ${new Date(entry.timestamp).toISOString()}`,
            );
          }

          const granted: Grant[] = [];
          for (const platform of ["ios", "android"] as const) {
            const { grant, stderr } = await lease(env, targets[platform], `warm-${platform}`);
            expect(
              bootingLines(stderr),
              `${platform}: the first lease must not wait on a boot`,
            ).toEqual([]);
            granted.push(grant);
          }

          await expectGrantedWarm(env, granted, readyEvents);

          for (const grant of granted) await release(env, grant);
          // iOS is shut down, erased and booted again by the pool; Android restores its snapshot.
          for (const grant of granted) {
            await untilState(env, grant.device.driverDeviceId, "ready");
          }
        } finally {
          await nuke(env);
        }
      },
    );

    it(
      "with warmPool.enabled false, a released simulator and a released emulator are both shut down, and each boots on the next lease",
      { timeout: TEST_TIMEOUT },
      async (context) => {
        const missing = await missingPlatform();
        if (missing !== undefined) context.skip(missing);
        const { adbServerPort, deviceSet, env, targets } = await warmDaemon();
        try {
          await untilBothReady(env);
          await writeWarmPool(env, { enabled: false });

          const first = {
            android: await lease(env, targets.android, "cold-android"),
            ios: await lease(env, targets.ios, "cold-ios"),
          };
          await release(env, first.ios.grant);
          await release(env, first.android.grant);

          const iosUdid = first.ios.grant.device.driverDeviceId;
          await untilState(env, iosUdid, "shutdown", 5 * MINUTE);
          await untilState(env, first.android.grant.device.driverDeviceId, "shutdown", 5 * MINUTE);
          await waitFor(
            async () =>
              (await setDevices(deviceSet)).find((device) => device.udid === iosUdid)?.state ===
              "Shutdown",
            { interval: 1000, label: "the simulator is Shutdown in simctl", timeout: MINUTE },
          );
          await waitFor(async () => (await onlineEmulators(adbServerPort)).length === 0, {
            interval: 1000,
            label: "no emulator is online on Simlock's adb server",
            timeout: MINUTE,
          });

          // Shut down is an end state: the pool, were it still on, would boot both again within this window.
          const androidId = first.android.grant.device.driverDeviceId;
          await holdsState(env, iosUdid, "shutdown", HOLD);
          await holdsState(env, androidId, "shutdown", HOLD);
          expect(
            (await setDevices(deviceSet)).find((device) => device.udid === iosUdid)?.state,
            "the simulator is still Shutdown in simctl",
          ).toBe("Shutdown");
          expect(await onlineEmulators(adbServerPort), "no emulator came back online").toEqual([]);

          // The next boot is clean: each lease waits on a boot, is granted, and its device really is running.
          const second = {
            android: await lease(env, targets.android, "again-android"),
            ios: await lease(env, targets.ios, "again-ios"),
          };
          for (const platform of ["ios", "android"] as const) {
            expect(
              bootingLines(second[platform].stderr),
              `${platform}: the lease waited on a boot`,
            ).not.toEqual([]);
            const granted = (await env.events()).find(
              (entry) =>
                entry.event === "lease.granted" &&
                (entry.payload as { leaseId?: string }).leaseId === second[platform].grant.lease.id,
            );
            expect(
              granted?.payload,
              `${platform}: the grant did not come from a warm device`,
            ).not.toMatchObject({ source: "warm" });
          }
          const rows = await devices(env);
          for (const { grant } of [second.ios, second.android]) {
            expect(
              rows.find((row) => row.id === grant.device.id)?.state,
              `${grant.device.spec.platform} device is leased after its second boot`,
            ).toBe("leased");
          }
          expect(
            (await setDevices(deviceSet)).find(
              (device) => device.udid === second.ios.grant.device.driverDeviceId,
            )?.state,
          ).toBe("Booted");
          expect(
            (await onlineEmulators(adbServerPort)).length,
            "the emulator booted again and is online",
          ).toBeGreaterThan(0);

          await release(env, second.ios.grant);
          await release(env, second.android.grant);
        } finally {
          await nuke(env);
        }
      },
    );
  },
);
