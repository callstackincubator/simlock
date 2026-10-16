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
const AGENT = "phone-lane-android";

const missing =
  SERIAL === undefined || SERIAL === ""
    ? "SIMLOCK_PHYSICAL_ANDROID"
    : APK === undefined || APK === ""
      ? "SIMLOCK_PHYSICAL_ANDROID_APK"
      : undefined;

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

async function rig(execTimeoutMs?: number): Promise<Rig> {
  const { env, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      ...(execTimeoutMs === undefined ? {} : { exec: { timeoutMs: execTimeoutMs } }),
      health: { probeIntervalMs: PROBE_INTERVAL_MS, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
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
      "with a short exec.timeoutMs, a device.exec adb shell sleep 60 on the leased phone ends EXEC_TIMEOUT, and the adb server listening on 5037 still runs with the pid it had before the command",
      { timeout: 5 * MINUTE },
      async () => {
        const daemon = await rig(EXEC_TIMEOUT_MS);
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
