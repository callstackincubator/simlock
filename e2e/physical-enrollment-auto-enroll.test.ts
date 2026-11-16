import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { FakeDriverRefusalReason, ScriptedPhysicalDevice } from "./fake-driver/types.js";
import { type TestEnv, waitFor, withDaemon } from "./helpers/index.js";
import { observeFor } from "./helpers/physical-state.js";
import { readEnrolledApps } from "./helpers/state-db.js";
import {
  Added,
  IPHONE,
  PIXEL,
  UDID,
  add,
  daemonOptions,
  inspectCalls,
  named,
  refused,
  rows,
} from "./test-physical-enrollment.js";

const AUTO_ENROLL = { devices: { autoEnroll: true }, health: { probeIntervalMs: 200 } };

const IPHONE_TWO: ScriptedPhysicalDevice = {
  apps: ["com.example.second"],
  class: "phone",
  ids: ["00008110-00FFEEDDCCBB"],
  model: "iPhone 15 Pro",
  osVersion: "18.4",
};

async function autoDaemon(
  options: {
    readonly ios?: Record<string, unknown>;
    readonly android?: Record<string, unknown>;
    readonly config?: Record<string, unknown>;
    readonly platforms?: readonly ("ios" | "android")[];
  } = {},
): Promise<TestEnv> {
  const base = daemonOptions(options);
  return withDaemon({
    ...base,
    configOverrides: { ...AUTO_ENROLL, ...options.config },
  });
}

async function plug(
  env: TestEnv,
  platform: "ios" | "android",
  devices: readonly ScriptedPhysicalDevice[],
): Promise<void> {
  await env.driverScript.merge({ [platform]: { physicalDevices: devices } });
}

async function autoEnrollLog(env: TestEnv): Promise<string[]> {
  const text = await readFile(env.logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => (JSON.parse(line) as { message: string }).message)
    .filter((message) => message.startsWith("auto-enroll:"));
}

describe("devices.autoEnroll", () => {
  it("enrols a phone plugged in, an iPhone, an Android phone and a phone attached before the daemon starts, each with one device.enrolled initiator auto and its installed apps as kept apps", async () => {
    const env = await autoDaemon({ ios: { physicalDevices: [IPHONE] } });

    await plug(env, "ios", [IPHONE, IPHONE_TWO]);
    await plug(env, "android", [PIXEL]);

    await waitFor(async () => (await named(env, "device.enrolled")).length === 3, {
      label: "the three phones are enrolled",
    });
    const enrolled = (await named(env, "device.enrolled")).map(
      (entry) => entry.payload as Added & { readonly initiator: string },
    );
    expect(
      enrolled.map((payload) => [payload.driverDeviceId, payload.initiator, payload.appCount]),
    ).toEqual(
      expect.arrayContaining([
        [UDID, "auto", 12],
        ["00008110-00FFEEDDCCBB", "auto", 1],
        ["R58M123ABC", "auto", 1],
      ]),
    );
    expect(enrolled.every((payload) => !payload.reenrolled)).toBe(true);
    expect(
      readEnrolledApps(env)
        .map((apps) => apps.length)
        .sort(),
    ).toEqual([1, 1, 12]);
    expect((await rows(env)).map((row) => row.state)).toEqual(["ready", "ready", "ready"]);
  });

  it("retries a phone that cannot be enrolled and logs one auto-enroll line each time its reason changes, word for word, then enrols it once unlocked", async () => {
    const env = await autoDaemon();
    const [a, b, c] = [IPHONE, { ...IPHONE, ids: ["PHONE-B"] }, IPHONE_TWO];
    const line = (device: ScriptedPhysicalDevice, reason: FakeDriverRefusalReason) =>
      `auto-enroll: ios ${device.ids[0]} not enrolled: scripted ${reason} for ${device.ids[0]}`;

    await plug(env, "ios", [
      refused(a, "locked"),
      refused(b, "untrusted"),
      refused(c, "untrusted"),
    ]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 3, { label: "three lines" });
    await observeFor(700, async () => {
      expect(await autoEnrollLog(env), "three runs at one reason write one line").toHaveLength(3);
    });
    await plug(env, "ios", [refused(a, "locked"), refused(b, "untrusted"), refused(c, "locked")]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 4, { label: "locked line" });
    await plug(env, "ios", [
      refused(a, "locked"),
      refused(b, "untrusted"),
      refused(c, "untrusted"),
    ]);
    await waitFor(async () => (await autoEnrollLog(env)).length === 5, {
      label: "untrusted again",
    });
    await observeFor(700, async () => {
      expect(await autoEnrollLog(env)).toHaveLength(5);
    });
    await plug(env, "ios", [a, refused(b, "untrusted"), refused(c, "untrusted")]);
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the unlocked phone is enrolled",
    });

    const lines = await autoEnrollLog(env);
    expect(lines).toEqual(
      expect.arrayContaining([line(a, "locked"), line(b, "untrusted"), line(c, "untrusted")]),
    );
    expect(lines.filter((entry) => entry.includes(String(c.ids[0])))).toEqual([
      line(c, "untrusted"),
      line(c, "locked"),
      line(c, "untrusted"),
    ]);
    expect(lines.filter((entry) => entry.includes(UDID))).toEqual([line(a, "locked")]);
    expect((await named(env, "device.enrolled")).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
    ]);
  });

  it("keeps a phone out that was removed while plugged in until it has been missing two runs, while an operator's device add enrols it again", async () => {
    const phone = (id: string): ScriptedPhysicalDevice => ({ ...IPHONE, ids: [id] });
    const removed = phone("PHONE-1");
    const brief = phone("PHONE-2");
    const long = phone("PHONE-3");
    const added = phone("PHONE-4");
    const iphones = [removed, brief, long, added];
    const pixel: ScriptedPhysicalDevice = { ...PIXEL, present: true };
    const env = await autoDaemon({
      android: {
        failures: { reclaim: { message: "scripted reclaim failure", type: "generic" } },
        physicalDevices: [pixel],
      },
      config: {
        health: { probeIntervalMs: 500 },
        warmPool: { quarantine: { maxRetries: 1, retryBackoffMs: 300, retryBackoffMultiplier: 1 } },
      },
      ios: { physicalDevices: iphones },
    });
    const enrolledOf = async (id: string) =>
      (await named(env, "device.enrolled"))
        .map((entry) => entry.payload as Added & { readonly initiator: string })
        .filter((payload) => payload.driverDeviceId === id);
    const runs = async (count: number) => {
      const lists = async () =>
        (await env.driverLog.calls()).filter(
          (call) => call.operation === "listAttachedPhysical" && call.platform === "ios",
        ).length;
      const before = await lists();
      await waitFor(async () => (await lists()) >= before + count, { interval: 20 });
    };
    await waitFor(async () => (await named(env, "device.enrolled")).length === 5, {
      label: "the five phones are enrolled",
    });
    const remove = async (id: string) => {
      const result = await env.cli(["device", "remove", id]);
      expect(result.code, result.stderr).toBe(0);
    };

    await remove("PHONE-1");
    const grant = await env.cli([
      "lease",
      "--platform",
      "android",
      "--physical",
      "--agent-id",
      "a",
      "--detach",
    ]);
    expect(grant.code, grant.stderr).toBe(0);
    const released = await env.cli(["release", (grant.json as { lease: { id: string } }).lease.id]);
    expect(released.code, released.stderr).toBe(0);
    await waitFor(async () => (await named(env, "device.quarantine-abandoned")).length === 1, {
      label: "the quarantine gives up and unenrols the Android phone",
    });
    await remove("PHONE-2");
    await remove("PHONE-3");
    await plug(env, "ios", [
      removed,
      { ...brief, present: false },
      { ...long, present: false },
      added,
    ]);
    await runs(1);
    await plug(env, "ios", [removed, brief, { ...long, present: false }, added]);
    await runs(1);
    await plug(env, "ios", iphones);
    await waitFor(async () => (await enrolledOf("PHONE-3")).length === 2, {
      label: "the phone missing two runs is enrolled again",
    });
    await remove("PHONE-4");
    const again = await env.cli(["device", "add", "--platform", "ios", "PHONE-4"]);
    expect(again.code, again.stderr).toBe(0);
    await runs(3);

    expect(
      (await enrolledOf("PHONE-1")).map((payload) => payload.initiator),
      "removed, plugged in",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf(pixel.ids[0] ?? "")).map((payload) => payload.initiator),
      "unenrolled after quarantine",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf("PHONE-2")).map((payload) => payload.initiator),
      "missing one run",
    ).toEqual(["auto"]);
    expect(
      (await enrolledOf("PHONE-3")).map((payload) => payload.initiator),
      "missing two runs",
    ).toEqual(["auto", "auto"]);
    expect(
      (await enrolledOf("PHONE-4")).map((payload) => payload.initiator),
      "device add while held out",
    ).toEqual(["auto", "operator"]);

    const slow = await autoDaemon({
      config: { health: { probeIntervalMs: 5000 } },
      ios: { physicalDevices: [IPHONE, refused({ ...IPHONE, ids: ["PHONE-Y"] }, "locked")] },
    });
    const slowEnrolled = async (id: string) =>
      (await named(slow, "device.enrolled"))
        .map((entry) => entry.payload as Added & { readonly initiator: string })
        .filter((payload) => payload.driverDeviceId === id);
    await waitFor(async () => (await slowEnrolled(UDID)).length === 1, {
      label: "the first run enrols the unlocked phone",
      timeout: 30_000,
    });
    const gone = await slow.cli(["device", "remove", UDID]);
    expect(gone.code, gone.stderr).toBe(0);
    await plug(slow, "ios", [IPHONE, { ...IPHONE, ids: ["PHONE-Y"] }]);
    await add(slow, "ios", "PHONE-Y");
    const goneToo = await slow.cli(["device", "remove", "PHONE-Y"]);
    expect(goneToo.code, goneToo.stderr).toBe(0);
    const listed = async () =>
      (await slow.driverLog.calls()).filter((call) => call.operation === "listAttachedPhysical")
        .length;
    const seen = await listed();
    await waitFor(async () => (await listed()) >= seen + 4, { interval: 50, timeout: 30_000 });

    expect(
      (await slowEnrolled(UDID)).map((payload) => payload.initiator),
      "removed before the next run",
    ).toEqual(["auto"]);
    expect(
      (await slowEnrolled("PHONE-Y")).map((payload) => payload.initiator),
      "added and removed between two runs",
    ).toEqual(["operator"]);
  });

  it("forgets which phones are held out when the daemon restarts, so a removed phone still plugged in is enrolled on the first run", async () => {
    const env = await autoDaemon({ ios: { physicalDevices: [IPHONE] } });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the phone is enrolled",
    });
    const removed = await env.cli(["device", "remove", UDID]);
    expect(removed.code, removed.stderr).toBe(0);

    await env.restartDaemon();

    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "the restarted daemon enrols the removed phone again",
    });
    expect((await named(env, "device.enrolled")).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
      expect.objectContaining({ driverDeviceId: UDID, initiator: "auto" }),
    ]);
  });

  it("skips a platform that cannot be listed for that run, still enrols the other platform, logs one line per error message, and logs nothing for a platform with no driver", async () => {
    const down = { listAttachedPhysical: { message: "adb is down", type: "generic" } } as const;
    const env = await autoDaemon({
      android: {
        failures: { reclaim: { message: "scripted reclaim failure", type: "generic" } },
        physicalDevices: [PIXEL],
      },
      config: { warmPool: { quarantine: { retryBackoffMs: 600_000 } } },
      ios: { physicalDevices: [IPHONE] },
    });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "both phones are enrolled",
    });
    const removed = await env.cli(["device", "remove", "R58M123ABC"]);
    expect(removed.code, removed.stderr).toBe(0);
    const androidLists = async () =>
      (await env.driverLog.calls()).filter(
        (call) => call.operation === "listAttachedPhysical" && call.platform === "android",
      ).length;
    const runs = async (count: number) => {
      const before = await androidLists();
      await waitFor(async () => (await androidLists()) >= before + count, { interval: 20 });
    };
    const couldNotList = async () =>
      (await autoEnrollLog(env)).filter((line) => line.includes("could not list"));

    await env.driverScript.merge({ android: { failures: down } });
    await runs(4);
    await plug(env, "ios", [IPHONE, IPHONE_TWO]);
    await waitFor(async () => (await named(env, "device.enrolled")).length === 3, {
      label: "the iPhone plugged in while Android cannot be listed is enrolled",
    });

    expect(await couldNotList()).toEqual([
      "auto-enroll: could not list android phones: adb is down",
    ]);

    await env.driverScript.merge({ android: { failures: {} } });
    await runs(4);
    expect(
      (await named(env, "device.enrolled")).filter(
        (e) => (e.payload as Added).platform === "android",
      ),
      "held out across the failing runs",
    ).toHaveLength(1);
    await env.driverScript.merge({ android: { failures: down } });
    await runs(2);
    expect(await couldNotList(), "a list that succeeds resets the message").toHaveLength(2);

    const iosOnly = await autoDaemon({ ios: { physicalDevices: [IPHONE] }, platforms: ["ios"] });
    await waitFor(async () => (await named(iosOnly, "device.enrolled")).length === 1, {
      label: "the iPhone is enrolled on a worker with no Android driver",
    });
    expect(await autoEnrollLog(iosOnly)).toEqual([]);
  });

  it("grants a waiting physical request the auto-enrolled phone within one run, with no second request, and still fails a model with no record at once", async () => {
    const second: ScriptedPhysicalDevice = { ...PIXEL, ids: ["R58M456DEF"] };
    const env = await autoDaemon({ android: { physicalDevices: [PIXEL] } });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 1, {
      label: "the first Pixel is enrolled",
    });
    const ask = (agent: string, model: string) => [
      "lease",
      "--platform",
      "android",
      "--physical",
      "--device",
      model,
      "--agent-id",
      agent,
    ];
    const first = await env.cli([...ask("agent-a", "Pixel 9"), "--detach"], { timeout: 30_000 });
    expect(first.code, first.stderr).toBe(0);
    const waiter = env.cliBackground(ask("agent-b", "Pixel 9"));
    await waitFor(async () => (await named(env, "lease.queued")).length === 1, {
      label: "the second request is queued",
    });

    await plug(env, "android", [PIXEL, second]);

    const grant = JSON.parse(await waiter.firstStdoutLine(30_000)) as {
      device: { driverDeviceId: string };
    };
    expect(grant.device.driverDeviceId).toBe("R58M456DEF");
    const unknown = await env.cli(ask("agent-c", "Galaxy S99"), { timeout: 30_000 });
    expect(unknown.error?.code).toBe("UNKNOWN_MODEL");
  });

  it("does nothing without the setting, unset or false: no device.enrolled and no inspectPhysical call after three runs", async () => {
    for (const devices of [undefined, { autoEnroll: false }]) {
      const env = await withDaemon({
        ...daemonOptions({ ios: { physicalDevices: [IPHONE] } }),
        configOverrides: {
          health: { probeIntervalMs: 200 },
          ...(devices === undefined ? {} : { devices }),
        },
      });
      await observeFor(700, async () => {
        expect(await named(env, "device.enrolled")).toEqual([]);
      });
      expect(await inspectCalls(env)).toEqual([]);
    }
  });

  it("leaves an enrolled phone alone in the states ready, absent, leased and quarantined: no device.enrolled and the kept apps unchanged", async () => {
    const env = await autoDaemon({
      android: {
        failures: { reclaim: { message: "scripted reclaim failure", type: "generic" } },
        physicalDevices: [PIXEL],
      },
      config: { warmPool: { quarantine: { retryBackoffMs: 600_000 } } },
      ios: { physicalDevices: [IPHONE] },
    });
    await waitFor(async () => (await named(env, "device.enrolled")).length === 2, {
      label: "both phones are enrolled",
    });
    const keptApps = readEnrolledApps(env);
    const states = async () => (await rows(env)).map((row) => row.state).sort();
    const stays = async (label: string) => {
      await observeFor(700, async () => {
        expect(await named(env, "device.enrolled"), label).toHaveLength(2);
      });
      expect(readEnrolledApps(env), label).toEqual(keptApps);
    };

    await stays("ready");
    await plug(env, "ios", [{ ...IPHONE, present: false }]);
    await waitFor(async () => (await states()).includes("absent"), {
      label: "the iPhone is absent",
    });
    await stays("absent");
    const leased = await env.cli([
      "lease",
      "--platform",
      "android",
      "--physical",
      "--agent-id",
      "a",
      "--detach",
    ]);
    expect(leased.code, leased.stderr).toBe(0);
    expect(await states()).toContain("leased");
    await stays("leased");
    const released = await env.cli([
      "release",
      (leased.json as { lease: { id: string } }).lease.id,
    ]);
    expect(released.code, released.stderr).toBe(0);
    await waitFor(async () => (await states()).includes("quarantined"), {
      label: "the Android phone is quarantined",
    });
    await stays("quarantined");
  });
});
