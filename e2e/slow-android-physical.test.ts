import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { type TestEnv, waitFor, waitForDeviceState, withHttpDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const SERIAL = process.env["SIMLOCK_PHYSICAL_ANDROID"];
const APK = process.env["SIMLOCK_PHYSICAL_ANDROID_APK"];

const PROBE_INTERVAL_MS = 2_000;
const EXEC_TIMEOUT_MS = 5_000;
const MINUTE = 60_000;
const STREAM_OPEN_BOUND = 4 * MINUTE;
const KEY_FRAME_BOUND = 2 * MINUTE;
const AGENT = "phone-lane-android";
const TAG = { alive: 0x06, description: 0x01, keyframe: 0x02, delta: 0x03, meta: 0x05 } as const;

const missing =
  SERIAL === undefined || SERIAL === ""
    ? "SIMLOCK_PHYSICAL_ANDROID"
    : APK === undefined || APK === ""
      ? "SIMLOCK_PHYSICAL_ANDROID_APK"
      : undefined;

interface Frame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

interface Grant {
  readonly device: { readonly driverDeviceId: string };
  readonly environment: Record<string, string>;
  readonly lease: { readonly id: string };
}

interface Rig {
  readonly env: TestEnv;
  readonly base: string;
  readonly auth: Record<string, string>;
}

async function adbOut(serial: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, ...args], { timeout: MINUTE });
  return stdout;
}

async function userAppsOf(serial: string): Promise<string[]> {
  const user = (await adbOut(serial, ["shell", "am", "get-current-user"])).trim();
  const listing = await adbOut(serial, ["shell", "pm", "list", "packages", "-3", "--user", user]);
  return listing
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(/^package:/, ""))
    .filter((line) => line !== "");
}

/** why: the APK's package name is whatever its install adds; no tool outside adb is needed. */
async function installApk(serial: string, apk: string): Promise<string> {
  const before = new Set(await userAppsOf(serial));
  await adbOut(serial, ["install", "-r", "-t", apk]);
  const added = (await userAppsOf(serial)).filter((name) => !before.has(name));
  if (added[0] === undefined) {
    throw new Error(
      `installing ${apk} added no user app: it is already installed on ${serial}; uninstall it first`,
    );
  }
  return added[0];
}

async function uninstall(serial: string, name: string): Promise<void> {
  await adbOut(serial, ["uninstall", name]);
}

async function serverPid(): Promise<string> {
  const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP:5037", "-sTCP:LISTEN", "-t"]);
  return stdout.trim().split("\n")[0] ?? "";
}

async function rig(options: { readonly execTimeoutMs?: number } = {}): Promise<Rig> {
  const { env, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      ...(options.execTimeoutMs === undefined
        ? {}
        : { exec: { timeoutMs: options.execTimeoutMs } }),
      health: { probeIntervalMs: PROBE_INTERVAL_MS, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
      capabilities: {
        stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
      },
    },
    driver: "real",
  }));
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
  const created = await env.cli(["token", "create", "--role", "operator"]);
  expect(created.code, created.stderr).toBe(0);
  const auth = {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
  return { auth, base, env };
}

async function enroll(env: TestEnv, serial: string): Promise<Record<string, unknown>> {
  const added = await env.cli(["device", "add", "--platform", "android", serial, "--json"], {
    timeout: 2 * MINUTE,
  });
  expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
  return added.json as Record<string, unknown>;
}

async function leasePhysical(env: TestEnv): Promise<Grant> {
  const leased = await env.cli(
    ["lease", "--platform", "android", "--physical", "--agent-id", AGENT, "--detach"],
    { timeout: 2 * MINUTE },
  );
  expect(leased.code, `lease failed: ${leased.stderr}`).toBe(0);
  return leased.json as Grant;
}

async function exec(daemon: Rig, leaseId: string, args: readonly string[]): Promise<string> {
  const response = await fetch(`${daemon.base}/v1/leases/${leaseId}/exec`, {
    body: JSON.stringify({ args, requesterId: AGENT, tool: "adb" }),
    headers: daemon.auth,
    method: "POST",
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function within<T>(work: Promise<T>, bound: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${bound} ms waiting for ${what}`)),
      bound,
    );
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

// why: the body is an endless stream, so this reads frames until it has what it came for and then
// lets go, rather than reading to an end that never comes.
async function readFrames(
  body: ReadableStream<Uint8Array>,
  enough: (frames: readonly Frame[]) => boolean,
  whileOpen?: () => Promise<void>,
): Promise<Frame[]> {
  const reader = body.getReader();
  const frames: Frame[] = [];
  let buffer = new Uint8Array(0);
  try {
    while (!enough(frames)) {
      const step = await within(reader.read(), KEY_FRAME_BOUND, "the stream's frames");
      if (step.done) break;
      const joined = new Uint8Array(buffer.length + step.value.length);
      joined.set(buffer);
      joined.set(step.value, buffer.length);
      buffer = joined;
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (buffer.length < 4 + length) break;
        frames.push({ payload: buffer.slice(5, 4 + length), tag: buffer[4]! });
        buffer = buffer.slice(4 + length);
      }
    }
    // why: runs once the frames are in and before the stream is let go, so it sees the stream open.
    await whileOpen?.();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

async function streamOf(daemon: Rig, leaseId: string): Promise<Response> {
  const response = await fetch(`${daemon.base}/v1/stream/leases/${encodeURIComponent(leaseId)}`, {
    headers: daemon.auth,
    // why: covers the ~185 s worst case of opening the stream, so a stall fails here naming its step.
    signal: AbortSignal.timeout(STREAM_OPEN_BOUND),
  });
  // why: a 200 body is an endless stream, so its text is read only for a failure, never as an argument evaluated up front.
  const detail = response.status === 200 ? "" : await response.text().catch(() => "");
  expect(response.status, detail).toBe(200);
  return response;
}

describe.skipIf(missing !== undefined)(
  missing === undefined
    ? "Android physical phone (real adb)"
    : `Android physical phone (skipped: ${missing} is not set)`,
  { tags: ["slow", "android", "physical"] },
  () => {
    const serial = SERIAL as string;
    const apk = APK as string;

    it(
      "simlock device add --platform android $SIMLOCK_PHYSICAL_ANDROID enrolls it with the model and API level adb shell getprop reports and as many apps as pm list packages -3 lists for the current user",
      { timeout: 5 * MINUTE },
      async () => {
        const { env } = await rig();

        const added = await enroll(env, serial);

        expect(added["driverDeviceId"]).toBe(serial);
        expect(added["model"]).toBe(
          (await adbOut(serial, ["shell", "getprop", "ro.product.model"])).trim(),
        );
        expect(added["osVersion"]).toBe(
          (await adbOut(serial, ["shell", "getprop", "ro.build.version.sdk"])).trim(),
        );
        expect(added["appCount"]).toBe((await userAppsOf(serial)).length);
      },
    );

    it(
      "simlock lease --platform android --physical grants that serial with ANDROID_SERIAL set to it and ANDROID_ADB_SERVER_PORT=5037, and device.exec adb shell getprop ro.serialno over HTTP prints the serial",
      { timeout: 5 * MINUTE },
      async () => {
        const daemon = await rig();
        await enroll(daemon.env, serial);

        const grant = await leasePhysical(daemon.env);
        const output = await exec(daemon, grant.lease.id, ["shell", "getprop", "ro.serialno"]);

        expect(grant.device.driverDeviceId).toBe(serial);
        expect(grant.environment["ANDROID_SERIAL"]).toBe(serial);
        expect(grant.environment["ANDROID_ADB_SERVER_PORT"]).toBe("5037");
        expect(output).toContain(serial);
        await daemon.env.cli(["release", grant.lease.id]);
      },
    );

    it(
      "after installing $SIMLOCK_PHYSICAL_ANDROID_APK with plain adb -s and releasing, the device is ready, the APK's package is gone, and every enrolled package is still installed",
      { timeout: 10 * MINUTE },
      async () => {
        const name = await installApk(serial, apk);
        await uninstall(serial, name);
        const enrolledApps = await userAppsOf(serial);
        try {
          const { env } = await rig();
          await enroll(env, serial);
          const grant = await leasePhysical(env);
          expect(await installApk(serial, apk)).toBe(name);

          const released = await env.cli(["release", grant.lease.id]);
          expect(released.code, released.stderr).toBe(0);
          await waitForDeviceState(env, serial, "ready", { timeout: 3 * MINUTE });

          const after = await userAppsOf(serial);
          expect(after).not.toContain(name);
          for (const kept of enrolledApps) expect(after).toContain(kept);
        } finally {
          await uninstall(serial, name).catch(() => undefined);
        }
      },
    );

    it(
      "the plugged-in phone stays ready across three probe intervals",
      { timeout: 5 * MINUTE },
      async () => {
        const { env } = await rig();
        await enroll(env, serial);
        await waitForDeviceState(env, serial, "ready");

        const seen: string[] = [];
        const until = Date.now() + 3 * PROBE_INTERVAL_MS + 1_000;
        await waitFor(
          async () => {
            const rows = (await env.cli(["list", "--devices"])).json as {
              driverDeviceId: string;
              state: string;
            }[];
            seen.push(rows.find((row) => row.driverDeviceId === serial)?.state ?? "missing");
            return Date.now() >= until;
          },
          { interval: 500, label: "three probe intervals observed", timeout: MINUTE },
        );

        expect(new Set(seen)).toEqual(new Set(["ready"]));
      },
    );

    it(
      "a lease on the phone streams a meta frame and a key frame over GET /v1/stream/leases/{leaseId}, and after the lease ends the phone holds no simlock-scrcpy jar and no scrcpy server process and the host keeps no capture shell, with the phone's screen off when the stream asks and its stay-awake setting put back within 10 s of the lease's end",
      { timeout: 10 * MINUTE },
      async () => {
        const stayOn = (
          await adbOut(serial, ["shell", "settings", "get", "global", "stay_on_while_plugged_in"])
        ).trim();
        const screenIsOff = async (): Promise<boolean> => {
          const power = await adbOut(serial, ["shell", "dumpsys", "power"]);
          const word = /^\s*mWakefulness=(\S+)\s*$/m.exec(power)?.[1];
          return word === "Asleep" || word === "Dozing";
        };
        // why: the setting is put back whatever the case does, so a failure leaves the phone as it was found.
        try {
          // why: 2 is not scrcpy's 7, so a restore of the recorded value shows in the setting.
          await adbOut(serial, [
            "shell",
            "settings",
            "put",
            "global",
            "stay_on_while_plugged_in",
            "2",
          ]);
          await adbOut(serial, ["shell", "input", "keyevent", "KEYCODE_SLEEP"]);
          await waitFor(screenIsOff, {
            interval: 500,
            label: "the phone's screen off before the stream asks",
            timeout: 15_000,
          });

          const daemon = await rig();
          await enroll(daemon.env, serial);
          const grant = await leasePhysical(daemon.env);

          const response = await streamOf(daemon, grant.lease.id);
          if (response.body === null) throw new Error("the stream answered without a body");
          const frames = await readFrames(
            response.body,
            (read) => read.some((frame) => frame.tag === TAG.keyframe),
            async () => {
              // why: 7 is scrcpy's stay_awake value; read while the stream body is still open, so the viewer's cancel cannot have put it back.
              expect(
                (
                  await adbOut(serial, [
                    "shell",
                    "settings",
                    "get",
                    "global",
                    "stay_on_while_plugged_in",
                  ])
                ).trim(),
                "stay_on_while_plugged_in while the stream is open",
              ).toBe("7");
              // why: the lease ends with the stream still open, so the wait below cannot be met by the viewer's own cancel.
              expect(await daemon.env.cli(["release", grant.lease.id])).toMatchObject({ code: 0 });
            },
          );

          const tags = frames.map((frame) => frame.tag);
          expect(tags).toContain(TAG.meta);
          expect(tags).toContain(TAG.keyframe);
          const meta = JSON.parse(new TextDecoder().decode(frames[0]!.payload)) as {
            codec: string;
            width: number;
            height: number;
          };
          expect(meta.codec).toBe("h264");
          expect(Math.max(meta.width, meta.height)).toBeGreaterThan(0);

          await waitFor(
            async () =>
              (
                await adbOut(serial, [
                  "shell",
                  "settings",
                  "get",
                  "global",
                  "stay_on_while_plugged_in",
                ])
              ).trim() === "2",
            {
              interval: 500,
              label: "stay_on_while_plugged_in back at 2 after the lease ended",
              timeout: 10_000,
            },
          );

          await waitFor(
            async () => {
              const processes = await adbOut(serial, ["shell", "ps", "-A", "-o", "ARGS"]);
              const files = await adbOut(serial, ["shell", "ls", "/data/local/tmp"]);
              return (
                !processes.includes("com.genymobile.scrcpy.Server") &&
                !files.includes("simlock-scrcpy-")
              );
            },
            {
              interval: 500,
              label: "no scrcpy server process and no pushed jar left on the phone",
              timeout: 30_000,
            },
          );

          const hostShells = await new Promise<string>((resolve) => {
            execFile("pgrep", ["-fl", "[s]imlock-scrcpy-"], (_error, stdout) => resolve(stdout));
          });
          expect(hostShells, "a host adb shell for the capture outlived the lease").toBe("");
        } finally {
          await adbOut(serial, [
            "shell",
            "settings",
            "put",
            "global",
            "stay_on_while_plugged_in",
            stayOn,
          ]);
        }
      },
    );

    it(
      "with a short exec.timeoutMs, a device.exec adb shell sleep 60 on the leased phone ends EXEC_TIMEOUT, and the adb server listening on 5037 still runs with the pid it had before the command",
      { timeout: 5 * MINUTE },
      async () => {
        const daemon = await rig({ execTimeoutMs: EXEC_TIMEOUT_MS });
        await enroll(daemon.env, serial);
        const grant = await leasePhysical(daemon.env);
        const pidBefore = await serverPid();
        expect(pidBefore).not.toBe("");

        const body = await exec(daemon, grant.lease.id, ["shell", "sleep", "60"]);

        expect(body).toContain("EXEC_TIMEOUT");
        expect(await serverPid()).toBe(pidBefore);
        await daemon.env.cli(["release", grant.lease.id]);
      },
    );
  },
);
