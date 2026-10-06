import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { withDaemon, waitFor, type RecordedEvent, type TestEnv } from "./helpers/index.js";
import { iosDeviceSet, setDevices, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

/**
 * The warm pool on real devices: a target boots a real simulator and a real emulator ahead of any
 * lease, and with the pool off a released device of each platform ends shut down. The fast lane
 * proves what the pool decides against fake drivers; only a real `simctl` and a real emulator can
 * prove that the create-and-boot path works end to end, that a released Android emulator comes
 * back ready from its snapshot (its `device.reclaimed` strategy is `snapshot`), and that with the pool off a released device of each platform ends
 * shut down and is the device the next lease boots.
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
/** Two real boots (one of them an emulator) and, before any lease, a hold of one pool tick: well inside it. */
const TEST_TIMEOUT = 30 * MINUTE;
/**
 * Two real boots, a lease and a release of each, and the wait for each to be ready again. The
 * waits alone (a 15 min readiness wait, two 10 min leases, two 3 min releases, two 15 min waits
 * for ready again) add up to 71 min, plus at most 9 one-minute queries and a 5 min nuke: a wait
 * that gives up names itself before this fires.
 */
const WARM_ROUND_TIMEOUT = 90 * MINUTE;
const LEASE_TIMEOUT = 10 * MINUTE;
/** A release returns once the lease is gone; the device's reclaim is awaited separately. */
const RELEASE_TIMEOUT = 3 * MINUTE;
/** Every call that asks the machine or the daemon a question (`simctl`, `adb`, the CLI), so one that never answers names itself. */
const QUERY_TIMEOUT = MINUTE;
/**
 * The pool-off test creates each device from nothing (an Android image's first boot is a cold
 * boot), so it is two cold leases, two boots from shutdown, four releases and two end-state
 * holds. The budgets of its steps (see `step`) sum to 84.5 min. Outside any step it makes at most
 * eight one-minute queries, and on a failure `diagnose` asks for the devices (1 min) and `nuke`
 * runs for up to 5 min: 84.5 + 8 + 1 + 5 = 98.5 min, under this, so each step budget fires,
 * naming its step, before the test's own timeout, which names nothing.
 */
const COLD_TEST_TIMEOUT = 100 * MINUTE;
/** The pool-off test's first step, which brings the daemon up and reads its catalog. */
const DAEMON_START_BUDGET = 5 * MINUTE;
const READY_TIMEOUT = 15 * MINUTE;
/** How long a shut-down device is watched: longer than one pool tick (30s, WARM_POOL_TICK_MS), so a pool still on would have booted it. */
const HOLD = 45 * SECOND;

/** The installed iOS runtimes; empty when `xcrun simctl` is missing or unusable, so the lane skips. */
async function installedIosRuntimes(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "runtimes", "-j"], {
      timeout: QUERY_TIMEOUT,
    });
    const parsed = JSON.parse(stdout) as {
      runtimes: { version: string; isAvailable: boolean; platform?: string }[];
    };
    return parsed.runtimes
      .filter((runtime) => runtime.isAvailable && (runtime.platform ?? "iOS") === "iOS")
      .map((runtime) => runtime.version);
  } catch (error: unknown) {
    // A timed-out simctl is a hang to report, not "no iOS runtime installed".
    if ((error as { killed?: boolean }).killed === true) throw error;
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
  const { stdout } = await execFileAsync(adb, ["-P", String(adbServerPort), "devices"], {
    timeout: QUERY_TIMEOUT,
  }).catch((error: unknown) => {
    // A timed-out adb is a hang to report, not "no emulator online".
    if ((error as { killed?: boolean }).killed === true) throw error;
    return { stdout: "" };
  });
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

/**
 * A real-driver daemon whose pool targets one device of the newest runtime of each platform; with
 * `enabled: false` the config is rewritten and the daemon restarted with the pool off, so no
 * device exists until a lease asks.
 */
async function warmDaemon(options: { readonly enabled?: boolean } = {}): Promise<Lane> {
  await sweepStaleDeviceSets();
  const env = await withDaemon({ driver: "real" });
  const adbServerPort = env.adbServerPort;
  if (adbServerPort === undefined) throw new Error("the real-SDK lane must allocate an adb port");
  const reported = await env.cli(["catalog", "--json"], { timeout: QUERY_TIMEOUT });
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
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
  return { adbServerPort, deviceSet: iosDeviceSet(env.home), env, targets };
}

/** The business-event history, bounded like every other question put to the daemon. */
function recordedEvents(env: TestEnv): Promise<RecordedEvent[]> {
  return env.events(undefined, QUERY_TIMEOUT);
}

/** The two lines the verifier reads in the log: each device.ready event, with its time. */
function logDeviceReady(ready: readonly RecordedEvent[]): void {
  for (const entry of ready) {
    console.info(
      `device.ready ${JSON.stringify(entry.payload)} at ${new Date(entry.timestamp).toISOString()}`,
    );
  }
}

async function devices(env: TestEnv): Promise<Row[]> {
  const listed = await env.cli(["list", "--devices"], { timeout: QUERY_TIMEOUT });
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

/**
 * Runs `check` (which throws on a violation) at every poll for `duration`, and fails on the first
 * poll that throws: waitFor swallows a throwing predicate and keeps polling, so the violation is
 * kept here, the predicate returns true so the loop stops at once, and the violation is rethrown
 * straight after, without waiting out the window.
 */
async function holds(label: string, duration: number, check: () => Promise<void>): Promise<void> {
  const until = Date.now() + duration;
  let violation: unknown;
  await waitFor(
    async () => {
      try {
        await check();
      } catch (error: unknown) {
        violation = error;
        return true;
      }
      return Date.now() >= until;
    },
    { interval: 2000, label, timeout: duration + MINUTE },
  );
  if (violation !== undefined) throw violation;
}

/** Fails if the device is not in `state` at any poll within `duration`: an end state must hold, not be seen once. */
async function holdsState(
  env: TestEnv,
  driverDeviceId: string,
  state: string,
  duration: number,
): Promise<void> {
  await holds(`${driverDeviceId} stays ${state}`, duration, async () => {
    const row = (await devices(env)).find((entry) => entry.driverDeviceId === driverDeviceId);
    expect(row?.state, `${driverDeviceId} stays ${state}`).toBe(state);
  });
}

/** Per platform, exactly one device, and it is ready. */
function expectOneReadyPerPlatform(rows: readonly Row[]): void {
  for (const platform of ["ios", "android"] as const) {
    expect(
      rows.filter((row) => row.spec.platform === platform).map((row) => row.state),
      `${platform} devices`,
    ).toEqual(["ready"]);
  }
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
  const released = await env.cli(["release", grant.lease.id], { timeout: RELEASE_TIMEOUT });
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
  const grantedEvents = (await recordedEvents(env)).filter(
    (entry) => entry.event === "lease.granted",
  );
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

/**
 * Runs one named step of a long test with its own budget. It logs when the step starts and ends,
 * so the slow-lane log shows where a run is, and it fails with the step's name when the budget
 * runs out: a hang names itself long before the test's own timeout, which names nothing.
 */
async function step<T>(name: string, budget: number, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.info(`step start: ${name} (budget ${Math.round(budget / SECOND)}s)`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`step "${name}" did not finish within ${budget}ms`)),
          budget,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    console.info(`step end: ${name} after ${Math.round((Date.now() - started) / SECOND)}s`);
  }
}

/** On a failure, what the daemon last said and what it held: the log is all that is left of a torn-down home. */
async function diagnose(env: TestEnv): Promise<void> {
  try {
    const log = await readFile(env.logPath, "utf8");
    console.info(`daemon.log tail:\n${log.split("\n").slice(-60).join("\n")}`);
  } catch (error: unknown) {
    console.info(`daemon.log unreadable: ${String(error)}`);
  }
  try {
    console.info(`devices at failure: ${JSON.stringify(await devices(env))}`);
  } catch (error: unknown) {
    console.info(`devices at failure unreadable: ${String(error)}`);
  }
}

/** The second lease waited on a boot, was not served warm, and booted the device the first one released. */
async function expectBootedFromShutdown(
  env: TestEnv,
  platform: Platform,
  second: { readonly grant: Grant; readonly stderr: string },
  released: Grant,
): Promise<void> {
  expect(bootingLines(second.stderr), `${platform}: the lease waited on a boot`).not.toEqual([]);
  const granted = (await recordedEvents(env)).find(
    (entry) =>
      entry.event === "lease.granted" &&
      (entry.payload as { leaseId?: string }).leaseId === second.grant.lease.id,
  );
  expect(granted, `${platform}: a lease.granted event names the second lease`).toBeDefined();
  expect(
    granted?.payload,
    `${platform}: the grant did not come from a warm device`,
  ).not.toMatchObject({ source: "warm" });
  expect(
    second.grant.device.id,
    `${platform}: the second lease boots the device the first one released`,
  ).toBe(released.device.id);
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

          expectOneReadyPerPlatform(rows);
          // The end state holds: no extra device starts, and none of the two leaves ready, across a pool tick.
          await holds("one ready device per platform", HOLD, async () => {
            expectOneReadyPerPlatform(await devices(env));
          });
          const recorded = await recordedEvents(env);
          expect(
            recorded.filter((entry) => entry.event.startsWith("lease.")),
            "no lease was asked for before the devices were ready",
          ).toEqual([]);
          const ready = recorded.filter((entry) => entry.event === "device.ready");
          logDeviceReady(ready);
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
      { timeout: WARM_ROUND_TIMEOUT },
      async (context) => {
        const missing = await missingPlatform();
        if (missing !== undefined) context.skip(missing);
        const { env, targets } = await warmDaemon();
        try {
          await untilBothReady(env);
          const before = await recordedEvents(env);
          const readyEvents = before.filter((entry) => entry.event === "device.ready");
          expect(readyEvents.length, "device.ready events before the first lease").toBeGreaterThan(
            1,
          );
          logDeviceReady(readyEvents);

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
          // A failed snapshot load falls back to a wipe and the pool boots the device back to ready,
          // so the state alone cannot tell the two apart: the reclaim's own strategy does.
          const android = granted.find((grant) => grant.device.spec.platform === "android");
          const reclaimed = (await recordedEvents(env)).filter(
            (entry) =>
              entry.event === "device.reclaimed" &&
              (entry.payload as { deviceId?: string }).deviceId === android?.device.id,
          );
          expect(
            reclaimed.map((entry) => (entry.payload as { strategy?: string }).strategy),
            "device.reclaimed strategy of the released emulator",
          ).toEqual(["snapshot"]);
        } finally {
          await nuke(env);
        }
      },
    );

    it(
      "with warmPool.enabled false, a released simulator and a released emulator are both shut down, and each boots on the next lease",
      { timeout: COLD_TEST_TIMEOUT },
      async (context) => {
        const missing = await missingPlatform();
        if (missing !== undefined) context.skip(missing);
        // The daemon is restarted with the targets and enabled false in one config write, so the
        // pool never has a target to boot: the only device of each kind is the one the first lease
        // creates, and once released it is the only shut-down device of its kind, so the planner
        // has no other to boot on the next lease.
        let lane: Lane | undefined;
        try {
          // Inside the try and a step, so a hung setup names itself and `diagnose` and `nuke` run.
          lane = await step("start the daemon with the pool off", DAEMON_START_BUDGET, () =>
            warmDaemon({ enabled: false }),
          );
          const { adbServerPort, deviceSet, env, targets } = lane;
          // Each first lease creates its device and boots it from nothing.
          const first = {
            android: await step(
              "first lease: create and boot the emulator",
              LEASE_TIMEOUT + MINUTE,
              () => lease(env, targets.android, "cold-android"),
            ),
            ios: await step(
              "first lease: create and boot the simulator",
              LEASE_TIMEOUT + MINUTE,
              () => lease(env, targets.ios, "cold-ios"),
            ),
          };
          await step("release the simulator", RELEASE_TIMEOUT + MINUTE, () =>
            release(env, first.ios.grant),
          );
          await step("release the emulator", RELEASE_TIMEOUT + MINUTE, () =>
            release(env, first.android.grant),
          );

          const iosUdid = first.ios.grant.device.driverDeviceId;
          const androidId = first.android.grant.device.driverDeviceId;
          await step("the simulator reaches shutdown", 6 * MINUTE, () =>
            untilState(env, iosUdid, "shutdown", 5 * MINUTE),
          );
          await step("the emulator reaches shutdown", 6 * MINUTE, () =>
            untilState(env, androidId, "shutdown", 5 * MINUTE),
          );
          await step("simctl reports the simulator Shutdown", 2 * MINUTE, () =>
            waitFor(
              async () =>
                (await setDevices(deviceSet, { timeoutMs: QUERY_TIMEOUT })).find(
                  (device) => device.udid === iosUdid,
                )?.state === "Shutdown",
              { interval: 1000, label: "the simulator is Shutdown in simctl", timeout: MINUTE },
            ),
          );
          await step("no emulator is online", 2 * MINUTE, () =>
            waitFor(async () => (await onlineEmulators(adbServerPort)).length === 0, {
              interval: 1000,
              label: "no emulator is online on Simlock's adb server",
              timeout: MINUTE,
            }),
          );

          // Shut down is an end state: the pool, if it were on, would boot both again within this window.
          await step("the simulator stays shutdown", HOLD + 2 * MINUTE, () =>
            holdsState(env, iosUdid, "shutdown", HOLD),
          );
          await step("the emulator stays shutdown", HOLD + 2 * MINUTE, () =>
            holdsState(env, androidId, "shutdown", HOLD),
          );
          expect(
            (await setDevices(deviceSet, { timeoutMs: QUERY_TIMEOUT })).find(
              (device) => device.udid === iosUdid,
            )?.state,
            "the simulator is still Shutdown in simctl",
          ).toBe("Shutdown");
          expect(await onlineEmulators(adbServerPort), "no emulator came back online").toEqual([]);

          // The next boot is clean: each lease waits on a boot, is granted, and its device really is running.
          // Each platform has exactly one device, the released one, so the next lease can only boot it.
          const before = await devices(env);
          for (const platform of ["ios", "android"] as const) {
            expect(
              before
                .filter((row) => row.spec.platform === platform)
                .map((row) => [row.id, row.state]),
              `${platform}: the released device is the only device and it is shut down`,
            ).toEqual([[first[platform].grant.device.id, "shutdown"]]);
          }
          const second = {
            android: await step("second lease: boot the emulator", LEASE_TIMEOUT, () =>
              lease(env, targets.android, "again-android"),
            ),
            ios: await step("second lease: boot the simulator", LEASE_TIMEOUT, () =>
              lease(env, targets.ios, "again-ios"),
            ),
          };
          for (const platform of ["ios", "android"] as const) {
            await expectBootedFromShutdown(env, platform, second[platform], first[platform].grant);
          }
          const rows = await devices(env);
          for (const { grant } of [second.ios, second.android]) {
            expect(
              rows.find((row) => row.id === grant.device.id)?.state,
              `${grant.device.spec.platform} device is leased after its second boot`,
            ).toBe("leased");
          }
          expect(
            (await setDevices(deviceSet, { timeoutMs: QUERY_TIMEOUT })).find(
              (device) => device.udid === second.ios.grant.device.driverDeviceId,
            )?.state,
          ).toBe("Booted");
          expect(
            (await onlineEmulators(adbServerPort)).length,
            "the emulator booted again and is online",
          ).toBeGreaterThan(0);

          await step("release the second simulator lease", RELEASE_TIMEOUT + MINUTE, () =>
            release(env, second.ios.grant),
          );
          await step("release the second emulator lease", RELEASE_TIMEOUT + MINUTE, () =>
            release(env, second.android.grant),
          );
        } catch (error: unknown) {
          if (lane !== undefined) await diagnose(lane.env);
          throw error;
        } finally {
          if (lane !== undefined) await nuke(lane.env);
        }
      },
    );
  },
);
