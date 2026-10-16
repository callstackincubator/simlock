import { describe, expect, it } from "vitest";

import type { FakeDriverPlatformScript, ScriptedPhysicalDevice } from "./fake-driver/types.js";
import {
  freeLoopbackPort,
  waitFor,
  waitForDeviceState,
  withDaemon,
  type TestEnv,
} from "./helpers/index.js";
import { observeFor } from "./helpers/physical-state.js";

const UDID_A = "00008110-001A2B3C4D5E";
const UDID_B = "00008110-00B0B0B0B0B0";
const UDID_IPAD = "00008112-00C1C1C1C1C1";
const UDID_1841 = "00008110-00D2D2D2D2D2";
const SERIAL = "R58M123ABC";

const IPHONE_A: ScriptedPhysicalDevice = {
  apps: ["com.example.app0", "com.example.app1"],
  class: "phone",
  ids: [UDID_A],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};
const IPHONE_B: ScriptedPhysicalDevice = { ...IPHONE_A, ids: [UDID_B] };
const IPHONE_1841: ScriptedPhysicalDevice = { ...IPHONE_A, ids: [UDID_1841], osVersion: "18.4.1" };
const IPAD: ScriptedPhysicalDevice = {
  apps: ["com.example.notes"],
  class: "tablet",
  ids: [UDID_IPAD],
  model: "iPad Pro 13-inch",
  osVersion: "18.4",
};
const PIXEL: ScriptedPhysicalDevice = {
  apps: ["com.example.mail"],
  class: "phone",
  ids: [SERIAL],
  model: "Pixel 9",
  osVersion: "34",
};

const IOS_BASE = {
  availableOsVersions: ["18.4"],
  defaultModels: { phone: ["iPhone 16"] },
  knownModels: ["iPhone 16", "iPhone 15 Pro"],
  modelClasses: { "iPhone 15 Pro": "phone", "iPhone 16": "phone" },
} as const;

const ANDROID_BASE = {
  availableOsVersions: ["34"],
  defaultModels: { phone: ["Pixel 9"] },
  knownModels: ["Pixel 9"],
  modelClasses: { "Pixel 9": "phone" },
} as const;

const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const FAILING_RECLAIM: FakeDriverPlatformScript = {
  failures: { reclaim: { message: "uninstall failed", type: "generic" } },
};

interface Grant {
  readonly lease: { readonly id: string };
  readonly environment: Record<string, string>;
  readonly device: {
    readonly id: string;
    readonly driverDeviceId: string;
    readonly physical?: boolean;
    readonly class?: string;
    readonly mode?: string;
    readonly spec: { readonly model: string; readonly osVersion: string };
  };
}

interface Waiting {
  readonly id: string;
  readonly requesterId: string;
  readonly queuePosition?: number;
  readonly spec: { readonly physical?: boolean };
}

interface Status {
  readonly queueDepth: number;
  readonly physicalQueueDepth: number;
  readonly waiting: readonly Waiting[];
}

async function startWith(
  devices: {
    readonly ios?: readonly ScriptedPhysicalDevice[];
    readonly android?: readonly ScriptedPhysicalDevice[];
  },
  options: {
    readonly config?: Record<string, unknown>;
    readonly ios?: FakeDriverPlatformScript;
    readonly http?: number;
  } = {},
): Promise<TestEnv> {
  const config = {
    ...options.config,
    ...(options.http === undefined
      ? {}
      : { http: { enabled: true, host: "127.0.0.1", port: options.http } }),
  };
  const env = await withDaemon({
    configOverrides: config,
    driverScript: {
      android: { ...ANDROID_BASE, physicalDevices: devices.android ?? [] },
      ios: { ...IOS_BASE, ...options.ios, physicalDevices: devices.ios ?? [] },
    },
  });
  for (const [platform, list] of [
    ["ios", devices.ios ?? []],
    ["android", devices.android ?? []],
  ] as const) {
    for (const device of list) {
      const added = await env.cli(["device", "add", "--platform", platform, device.ids[0] ?? ""]);
      expect(added.code, added.stderr).toBe(0);
    }
  }
  return env;
}

function physical(agent: string, ...extra: readonly string[]): string[] {
  return ["lease", "--platform", "ios", "--physical", "--agent-id", agent, ...extra];
}

async function granted(env: TestEnv, args: readonly string[]): Promise<Grant> {
  const result = await env.cli([...args, "--detach"], { timeout: 30_000 });
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

async function release(env: TestEnv, grant: Grant): Promise<void> {
  const result = await env.cli(["release", grant.lease.id]);
  expect(result.code, result.stderr).toBe(0);
}

async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

function isQueuedAt(event: unknown, position: number): boolean {
  const record = event as Record<string, unknown>;
  return (
    record.push === "progress" && record.stage === "queued" && record.queuePosition === position
  );
}

async function queuedAt(
  handle: ReturnType<TestEnv["cliBackground"]>,
  position: number,
): Promise<void> {
  await waitFor(() => handle.progressEvents().some((event) => isQueuedAt(event, position)), {
    label: `a request queued at position ${String(position)}`,
  });
}

async function statusJson(env: TestEnv): Promise<Status> {
  const result = await env.cli(["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Status;
}

async function setPhysical(
  env: TestEnv,
  platform: "ios" | "android",
  devices: readonly ScriptedPhysicalDevice[],
): Promise<void> {
  await env.driverScript.merge({ [platform]: { physicalDevices: devices } });
}

async function rejectedWith(env: TestEnv, reason: string): Promise<void> {
  await waitFor(
    async () =>
      (await named(env, "lease.rejected")).some(
        (entry) => (entry.payload as { reason: string }).reason === reason,
      ),
    { label: `a lease.rejected with reason ${reason}`, timeout: 30_000 },
  );
}

async function stateOf(env: TestEnv, driverDeviceId: string): Promise<string | undefined> {
  const listed = await env.cli(["list", "--devices"]);
  return (listed.json as { driverDeviceId: string; state: string }[]).find(
    (row) => row.driverDeviceId === driverDeviceId,
  )?.state;
}

describe("a physical lease request: validation", () => {
  it.each([
    [["--mode", "slim"], "mode"],
    [["--image-tag", "x"], "imageTag"],
    [["--allow-download"], "allowDownload"],
  ] as const)(
    "simlock lease --physical with %j exits 2 with BAD_REQUEST naming %s",
    async (flag, field) => {
      const env = await startWith({ ios: [IPHONE_A] });
      const accepted = await granted(env, physical("agent-ok"));
      await release(env, accepted);

      const refused = await env.cli(physical("agent-bad", ...flag, "--detach"));

      expect(refused.code, refused.stderr).toBe(2);
      expect(refused.error?.code).toBe("BAD_REQUEST");
      expect(refused.error?.message).toContain(field);
    },
  );
});

describe("a physical lease request: grant", () => {
  it("lease --platform ios --physical is granted a free, present, enrolled iPhone; the grant shows it physical; lease.granted has source warm; the fake driver log has no provision or boot", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    await env.driverLog.clear();

    const grant = await granted(env, physical("agent-a"));

    expect(grant.device.driverDeviceId).toBe(UDID_A);
    expect(grant.device.physical).toBe(true);
    const events = await named(env, "lease.granted");
    expect(events.map((entry) => (entry.payload as { source: string }).source)).toEqual(["warm"]);
    const calls = (await env.driverLog.calls()).map((call) => call.operation);
    expect(calls).not.toContain("provision");
    expect(calls).not.toContain("makeReady");
  });

  it("lease --platform ios without --physical, with only a free enrolled iPhone, gets a simulator", async () => {
    const env = await startWith({ ios: [IPHONE_A] });

    const grant = await granted(env, ["lease", "--platform", "ios", "--agent-id", "agent-sim"]);

    expect(grant.device.physical).toBe(false);
    expect(grant.device.driverDeviceId).toMatch(/^fake-ios-/);
    expect(grant.device.driverDeviceId).not.toBe(UDID_A);
  });

  it("--class tablet is granted an enrolled iPad, and the grant's device shows physical: true, class: tablet and no mode", async () => {
    const env = await startWith({ ios: [IPHONE_A, IPAD] });

    const grant = await granted(env, physical("agent-tablet", "--class", "tablet"));

    expect(grant.device.driverDeviceId).toBe(UDID_IPAD);
    expect(grant.device.physical).toBe(true);
    expect(grant.device.class).toBe("tablet");
    expect(grant.device.mode).toBeUndefined();
  });

  it('--device "iphone 15 pro" --os ">=18 <19" is granted the enrolled iPhone 15 Pro on 18.4', async () => {
    const env = await startWith({ ios: [IPAD, IPHONE_A] });

    const grant = await granted(
      env,
      physical("agent-model", "--device", "iphone 15 pro", "--os", ">=18 <19"),
    );

    expect(grant.device.driverDeviceId).toBe(UDID_A);
    expect(grant.device.spec).toMatchObject({ model: "iPhone 15 Pro", osVersion: "18.4" });
  });

  it('--os 18 with only an iPhone on 18.4.1 enrolled exits with UNKNOWN_MODEL at once, and its message names --os ">=18 <19"', async () => {
    const env = await startWith({ ios: [IPHONE_1841] });
    const accepted = await granted(env, physical("agent-range", "--os", ">=18 <19"));
    expect(accepted.device.driverDeviceId).toBe(UDID_1841);
    await release(env, accepted);

    const refused = await env.cli(physical("agent-exact", "--os", "18", "--detach"), {
      timeout: 15_000,
    });

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    expect(refused.error?.message).toContain('--os ">=18 <19"');
  });

  it('--os 18.4 with only an iPhone on 18.4.1 enrolled exits with UNKNOWN_MODEL at once, and its message names --os ">=18.4 <18.5"', async () => {
    const env = await startWith({ ios: [IPHONE_1841] });
    const accepted = await granted(env, physical("agent-range", "--os", ">=18.4 <18.5"));
    expect(accepted.device.driverDeviceId).toBe(UDID_1841);
    await release(env, accepted);

    const refused = await env.cli(physical("agent-exact", "--os", "18.4", "--detach"), {
      timeout: 15_000,
    });

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    expect(refused.error?.message).toContain('--os ">=18.4 <18.5"');
  });

  it("--os 18.4.1 with only an iPhone on 18.4 enrolled exits with UNKNOWN_MODEL at once, and its message names no range", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const accepted = await granted(env, physical("agent-exact", "--os", "18.4"));
    expect(accepted.device.driverDeviceId).toBe(UDID_A);
    await release(env, accepted);

    const refused = await env.cli(physical("agent-newer", "--os", "18.4.1", "--detach"), {
      timeout: 15_000,
    });

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    expect(refused.error?.message).not.toMatch(/>=|<\d/);
  });

  it("--platform android --physical --os 34 is granted the phone on API 34", async () => {
    const env = await startWith({ android: [PIXEL] });

    const grant = await granted(env, [
      "lease",
      "--platform",
      "android",
      "--physical",
      "--os",
      "34",
      "--agent-id",
      "agent-android",
    ]);

    expect(grant.device.driverDeviceId).toBe(SERIAL);
    expect(grant.device.physical).toBe(true);
    expect(grant.device.spec.osVersion).toBe("34");
  });

  it("--platform android --physical --os 33 with only a phone on API 34 enrolled exits with UNKNOWN_MODEL at once, and its message names no range", async () => {
    const env = await startWith({ android: [PIXEL] });
    const accepted = await granted(env, [
      "lease",
      "--platform",
      "android",
      "--physical",
      "--os",
      "34",
      "--agent-id",
      "agent-exact",
    ]);
    expect(accepted.device.driverDeviceId).toBe(SERIAL);
    await release(env, accepted);

    const refused = await env.cli(
      [
        "lease",
        "--platform",
        "android",
        "--physical",
        "--os",
        "33",
        "--agent-id",
        "agent-older",
        "--detach",
      ],
      { timeout: 15_000 },
    );

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    expect(refused.error?.message).not.toMatch(/>=|<\d/);
  });

  it("the grant's environment is the fake driver's answer for that device: SIMLOCK_DEVICE_UDID on iOS, ANDROID_SERIAL and ANDROID_ADB_SERVER_PORT=5037 on Android", async () => {
    const env = await startWith({ android: [PIXEL], ios: [IPHONE_A] });

    const ios = await granted(env, physical("agent-ios"));
    const android = await granted(env, [
      "lease",
      "--platform",
      "android",
      "--physical",
      "--agent-id",
      "agent-android",
    ]);

    expect(ios.environment).toEqual({ SIMLOCK_DEVICE_UDID: UDID_A });
    expect(android.environment).toEqual({
      ANDROID_ADB_SERVER_PORT: "5037",
      ANDROID_SERIAL: SERIAL,
    });
  });
});

describe("a physical lease request nothing could match", () => {
  it("exits with UNKNOWN_MODEL at once, records lease.rejected unresolvable-spec, and never queues: with no iPhone enrolled", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const accepted = await granted(env, physical("agent-first"));
    await release(env, accepted);
    expect((await env.cli(["device", "remove", UDID_A])).code).toBe(0);

    const refused = await env.cli(physical("agent-none", "--detach"), { timeout: 15_000 });

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    const rejected = await named(env, "lease.rejected");
    expect(rejected.map((entry) => (entry.payload as { reason: string }).reason)).toEqual([
      "unresolvable-spec",
    ]);
    expect(await named(env, "lease.queued")).toEqual([]);
  });

  it("exits with UNKNOWN_MODEL at once, records lease.rejected unresolvable-spec, and never queues: with --class tablet and only iPhones enrolled", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const accepted = await granted(env, physical("agent-phone"));
    await release(env, accepted);

    const refused = await env.cli(physical("agent-tablet", "--class", "tablet", "--detach"), {
      timeout: 15_000,
    });

    expect(refused.code, refused.stderr).toBe(12);
    expect(refused.error?.code).toBe("UNKNOWN_MODEL");
    const rejected = await named(env, "lease.rejected");
    expect(rejected.map((entry) => (entry.payload as { reason: string }).reason)).toEqual([
      "unresolvable-spec",
    ]);
    expect(await named(env, "lease.queued")).toEqual([]);
  });
});

describe("a physical lease request that waits", () => {
  it("two agents asking for the same single device: one is granted, the other is queued and granted after the first releases and the reclaim ends", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const first = await granted(env, physical("agent-a"));
    expect(first.device.driverDeviceId).toBe(UDID_A);

    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);
    await release(env, first);

    const second = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(second.device.driverDeviceId).toBe(UDID_A);
    expect(second.device.physical).toBe(true);
    await env.expectEvents([
      "lease.granted",
      "lease.released",
      "device.reclaimed",
      "lease.granted",
    ]);
  });

  it("a request whose only match is reclaiming is queued, not refused", async () => {
    const env = await startWith({ ios: [IPHONE_A] }, { ios: { latencyMs: { reclaim: 1_500 } } });
    const first = await granted(env, physical("agent-a"));
    await release(env, first);
    await waitForDeviceState(env, UDID_A, "reclaiming");

    const waiter = env.cliBackground(physical("agent-b"));

    await queuedAt(waiter, 1);
    const second = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(second.device.driverDeviceId).toBe(UDID_A);
  });

  it("a request whose only match is quarantined is queued, not refused", async () => {
    const env = await startWith(
      { ios: [IPHONE_A] },
      { config: { warmPool: { quarantine: { retryBackoffMs: 1_500 } } }, ios: FAILING_RECLAIM },
    );
    const first = await granted(env, physical("agent-a"));
    await release(env, first);
    await waitForDeviceState(env, UDID_A, "quarantined");

    const waiter = env.cliBackground(physical("agent-b"));

    await queuedAt(waiter, 1);
    await env.driverScript.merge({ ios: { failures: {} } });
    const second = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(second.device.driverDeviceId).toBe(UDID_A);
  });

  it("--no-wait with every match leased is NO_CAPACITY", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const first = await granted(env, physical("agent-a", "--no-wait"));
    expect(first.device.driverDeviceId).toBe(UDID_A);

    const refused = await env.cli(physical("agent-b", "--no-wait", "--detach"), {
      timeout: 15_000,
    });

    expect(refused.code, refused.stderr).toBe(11);
    expect(refused.error?.code).toBe("NO_CAPACITY");
  });

  it("a queued physical request fails UNKNOWN_MODEL when its last match is unenrolled by device remove", async () => {
    const env = await startWith(
      { ios: [IPHONE_A] },
      { config: { warmPool: { quarantine: { retryBackoffMs: 600_000 } } }, ios: FAILING_RECLAIM },
    );
    const first = await granted(env, physical("agent-a"));
    await release(env, first);
    await waitForDeviceState(env, UDID_A, "quarantined");
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    const removed = await env.cli(["device", "remove", UDID_A]);

    expect(removed.code, removed.stderr).toBe(0);
    const ended = await waiter.waitForExit(15_000);
    expect(ended.code, ended.stderr).toBe(12);
    expect(ended.error?.code).toBe("UNKNOWN_MODEL");
  });

  it("a queued physical request fails UNKNOWN_MODEL when quarantine gives up on its last match", async () => {
    const env = await startWith(
      { ios: [IPHONE_A] },
      {
        config: {
          warmPool: {
            quarantine: { maxRetries: 1, maxRetryBackoffMs: 300, retryBackoffMs: 300 },
          },
        },
        ios: FAILING_RECLAIM,
      },
    );
    const first = await granted(env, physical("agent-a"));
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);
    await release(env, first);

    const ended = await waiter.waitForExit(30_000);

    expect(ended.code, ended.stderr).toBe(12);
    expect(ended.error?.code).toBe("UNKNOWN_MODEL");
    expect(await named(env, "device.quarantine-abandoned")).toHaveLength(1);
  });

  it("a queued physical request is granted a matching device enrolled while it waits", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    await granted(env, physical("agent-a"));
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);
    await setPhysical(env, "ios", [IPHONE_A, IPHONE_B]);

    const added = await env.cli(["device", "add", "--platform", "ios", UDID_B]);

    expect(added.code, added.stderr).toBe(0);
    const second = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(second.device.driverDeviceId).toBe(UDID_B);
  });

  it("a ready device read not present is not granted: a second matching present device is granted instead", async () => {
    const env = await startWith({ ios: [IPHONE_A, IPHONE_B] });
    await setPhysical(env, "ios", [{ ...IPHONE_A, present: false }, IPHONE_B]);

    const grant = await granted(env, physical("agent-a"));

    expect(grant.device.driverDeviceId).toBe(UDID_B);
    expect(await stateOf(env, UDID_A)).toBe("ready");
  });

  it("a ready device read not present is not granted: with none, --no-wait is NO_CAPACITY, a waiting request stays queued, and the device stays ready", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    const accepted = await granted(env, physical("agent-first", "--no-wait"));
    await release(env, accepted);
    await waitForDeviceState(env, UDID_A, "ready");
    await setPhysical(env, "ios", [{ ...IPHONE_A, present: false }]);

    const refused = await env.cli(physical("agent-a", "--no-wait", "--detach"), {
      timeout: 15_000,
    });
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    expect(refused.code, refused.stderr).toBe(11);
    expect(refused.error?.code).toBe("NO_CAPACITY");
    await observeFor(1_500, async () => {
      expect(waiter.stdoutSoFar(), "the waiting request is not granted").toBe("");
      expect(await stateOf(env, UDID_A)).toBe("ready");
    });
  });

  it("a request with no --timeout that waits only for a device read not present stays queued after the device reads present again, and is granted it once a release of another device wakes the queue", async () => {
    const env = await startWith({ ios: [IPHONE_A, IPAD] });
    await setPhysical(env, "ios", [{ ...IPHONE_A, present: false }, IPAD]);
    const tablet = await granted(env, physical("agent-tablet", "--class", "tablet"));
    expect(tablet.device.driverDeviceId).toBe(UDID_IPAD);
    const waiter = env.cliBackground(physical("agent-phone"));
    await queuedAt(waiter, 1);

    await setPhysical(env, "ios", [IPHONE_A, IPAD]);

    await observeFor(1_500, async () => {
      expect(waiter.stdoutSoFar(), "the device reads present but nothing woke the queue").toBe("");
    });
    await release(env, tablet);
    const phone = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(phone.device.driverDeviceId).toBe(UDID_A);
  });
});

describe("a physical lease request beside simulator requests", () => {
  it("a simulator request is granted while a physical request waits for a busy iPhone", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    await granted(env, physical("agent-a"));
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    const simulator = await granted(env, ["lease", "--platform", "ios", "--agent-id", "agent-sim"]);

    expect(simulator.device.physical).toBe(false);
    expect(simulator.device.driverDeviceId).toMatch(/^fake-ios-/);
  });

  it("a physical request for a free iPhone is granted while a simulator request waits for capacity", async () => {
    const env = await startWith({ ios: [IPHONE_A] }, { config: ONE_DEVICE });
    await granted(env, ["lease", "--platform", "ios", "--agent-id", "sim-holder"]);
    const waiter = env.cliBackground(["lease", "--platform", "ios", "--agent-id", "sim-waiter"]);
    await queuedAt(waiter, 1);

    const grant = await granted(env, physical("agent-phone"));

    expect(grant.device.driverDeviceId).toBe(UDID_A);
    expect(grant.device.physical).toBe(true);
  });

  it("a released iPhone goes to the oldest waiting request it matches, and a newer request for another free device is granted at once", async () => {
    const env = await startWith({ ios: [IPHONE_A, IPAD] });
    const holder = await granted(env, physical("agent-holder"));
    const older = env.cliBackground(physical("agent-older"));
    await queuedAt(older, 1);
    const newer = env.cliBackground(physical("agent-newer"));
    await queuedAt(newer, 2);

    const tablet = await granted(env, physical("agent-tablet", "--class", "tablet"));
    await release(env, holder);

    expect(tablet.device.driverDeviceId).toBe(UDID_IPAD);
    const olderGrant = JSON.parse(await older.firstStdoutLine(30_000)) as Grant;
    expect(olderGrant.device.driverDeviceId).toBe(UDID_A);
    await observeFor(1_500, async () => {
      expect(newer.stdoutSoFar(), "the newer request is still waiting").toBe("");
    });
  });

  it("a waiting physical request makes the warm pool create or boot nothing", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    await granted(env, physical("agent-a"));
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);
    await env.driverLog.clear();

    await observeFor(2_500, async () => {
      const operations = (await env.driverLog.calls()).map((call) => call.operation);
      expect(operations).not.toContain("provision");
      expect(operations).not.toContain("makeReady");
    });
  });
});

describe("a waiting physical request in the queue views", () => {
  it("simlock list --requests shows a waiting physical request with physical, and status --json shows it in waiting with physical: true", async () => {
    const env = await startWith({ ios: [IPHONE_A] });
    await granted(env, physical("agent-a"));
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    const listed = await env.cli(["list", "--requests"]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^Request \S+: agent-b, ios .*\bphysical\b.*, queued at 1,/);
    const status = await statusJson(env);
    expect(status.waiting).toHaveLength(1);
    expect(status.waiting[0]?.requesterId).toBe("agent-b");
    expect(status.waiting[0]?.spec.physical).toBe(true);
  });

  it("a physical request queued behind two simulator requests has queuePosition 1 in status --json and in lease.queued; status --json shows queueDepth 2 and physicalQueueDepth 1; its queue.changed carries physical: true and depth 1", async () => {
    const env = await startWith({ ios: [IPHONE_A] }, { config: ONE_DEVICE });
    await granted(env, ["lease", "--platform", "ios", "--agent-id", "sim-holder"]);
    await granted(env, physical("agent-holder"));
    const first = env.cliBackground(["lease", "--platform", "ios", "--agent-id", "sim-1"]);
    await queuedAt(first, 1);
    const second = env.cliBackground(["lease", "--platform", "ios", "--agent-id", "sim-2"]);
    await queuedAt(second, 2);

    const waiter = env.cliBackground(physical("agent-phone"));
    await queuedAt(waiter, 1);

    const status = await statusJson(env);
    expect(status.queueDepth).toBe(2);
    expect(status.physicalQueueDepth).toBe(1);
    const entry = status.waiting.find((request) => request.requesterId === "agent-phone");
    expect(entry?.queuePosition).toBe(1);
    expect(entry?.spec.physical).toBe(true);
    const queued = await named(env, "lease.queued");
    expect(queued.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ requestId: entry?.id, queuePosition: 1 }),
    );
    const changed = await named(env, "queue.changed");
    expect(changed.map((event) => event.payload)).toContainEqual({ depth: 1, physical: true });
  });
});

describe("a waiting physical request ends", () => {
  async function waitingBehindHolder(config: Record<string, unknown> = {}, http?: number) {
    const env = await startWith(
      { ios: [IPHONE_A] },
      { config, ...(http === undefined ? {} : { http }) },
    );
    await granted(env, physical("agent-holder"));
    return env;
  }

  it("timeout at its timeout", async () => {
    const env = await waitingBehindHolder();

    const timedOut = await env.cli(physical("agent-b", "--timeout", "500ms", "--detach"), {
      timeout: 15_000,
    });

    expect(timedOut.code, timedOut.stderr).toBe(10);
    expect(timedOut.error?.code).toBe("QUEUE_TIMEOUT");
    await rejectedWith(env, "timeout");
  });

  it("cancelled when its requester cancels", async () => {
    const port = await freeLoopbackPort();
    const env = await waitingBehindHolder({}, port);
    const base = `http://127.0.0.1:${String(port)}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${base}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP API accepting connections" },
    );
    const minted = await env.cli(["token", "create", "--role", "agent"]);
    const headers = {
      authorization: `Bearer ${(minted.json as { secret: string }).secret}`,
      "content-type": "application/json",
    };

    const created = await fetch(`${base}/v1/lease-requests`, {
      body: JSON.stringify({ physical: true, platform: "ios" }),
      headers,
      method: "POST",
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { request: { id: string } }).request.id;
    await waitFor(
      async () => {
        const listed = await env.cli(["list", "--requests"]);
        return listed.stdout.includes(id);
      },
      { label: "the request waits" },
    );
    const cancelled = await fetch(`${base}/v1/lease-requests/${id}`, {
      headers,
      method: "DELETE",
    });

    expect(cancelled.status).toBe(204);
    await rejectedWith(env, "cancelled");
  });

  it("killed on simlock nuke", async () => {
    const env = await waitingBehindHolder();
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    const nuke = await env.cli(["nuke", "--yes"]);

    expect(nuke.code, nuke.stderr).toBe(0);
    await rejectedWith(env, "killed");
  });

  it("daemon-restarted across a daemon restart", async () => {
    const env = await waitingBehindHolder();
    const waiter = env.cliBackground(physical("agent-b"));
    await queuedAt(waiter, 1);

    await env.restartDaemon();

    await rejectedWith(env, "daemon-restarted");
  });
});
