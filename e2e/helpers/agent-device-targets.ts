import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import type { AgentDeviceResult } from "./agent-device.js";
import type { SharedTestEnv } from "./env.js";
import { REPO_ROOT } from "./repo-root.js";
import { DEVICE_READY_MS, waitFor } from "./wait.js";

export function succeeds(file: string, args: readonly string[]): boolean {
  try {
    execFileSync(file, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function hasIosRuntime(): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false;
  try {
    return execFileSync("xcrun", ["simctl", "list", "runtimes"], { encoding: "utf8" }).includes(
      "iOS",
    );
  } catch {
    return false;
  }
}

export interface Target {
  readonly platform: "ios" | "android";
  readonly bundleId: string;
  readonly app: string;
  readonly deviceFlag: "--udid" | "--serial";
  readonly forbiddenFlags: (deviceId: string, dir: string) => string[][];
}

export const IOS: Target = {
  platform: "ios",
  bundleId: "com.callstack.appduct.playgroundnative",
  app: join(REPO_ROOT, "e2e/fixtures/appduct/ios/AppductPlayground.app"),
  deviceFlag: "--udid",
  forbiddenFlags: (_id, dir) => [["--ios-simulator-device-set", dir]],
};

export const ANDROID: Target = {
  platform: "android",
  bundleId: "com.callstack.appduct.playground",
  app: join(REPO_ROOT, "e2e/fixtures/appduct/android/AppductPlayground.apk"),
  deviceFlag: "--serial",
  forbiddenFlags: (id, dir) => [
    ["--ios-simulator-device-set", dir],
    ["--android-device-allowlist", id],
  ],
};

export interface DeviceRow {
  readonly id: string;
  readonly driverDeviceId: string;
  // why: the address agent-device names the device by (an iOS UDID, an Android adb serial); on Android it is not the driver's device id.
  readonly address: string;
  readonly state: string;
}
export interface LeaseRow {
  readonly id: string;
  readonly deviceId: string;
  readonly ownerId: string;
  readonly requesterId: string;
}
export interface RequestRow {
  readonly requesterId: string;
}

// why: the first snapshot on a fresh simulator starts the XCTest runner, which agent-device gives 45 s to start (RUNNER_STARTUP_TIMEOUT_MS in packages/platform-apple/src/runner/runner-startup-transport.ts), so with the command's own 45 s it can pass the CLI's 60 s default and cut off agent-device's answer.
export const FIRST_SNAPSHOT = { timeout: 180_000 } as const;

async function listRows<T>(env: SharedTestEnv, flag: string): Promise<T[]> {
  const result = await env.cli(["list", flag], { timeout: 60_000 });
  expect(result.code, `simlock list ${flag}: ${result.stderr}`).toBe(0);
  return result.json as T[];
}

export const listDevices = (env: SharedTestEnv) => listRows<DeviceRow>(env, "--devices");
export const listLeases = (env: SharedTestEnv) => listRows<LeaseRow>(env, "--leases");

// why: `simlock list --requests` prints one text line per request (`Request <id>: <requester>[ on <worker>], ...`) or "No requests are waiting.", never JSON.
export async function listRequests(env: SharedTestEnv): Promise<RequestRow[]> {
  const result = await env.cli(["list", "--requests"], { timeout: 60_000 });
  expect(result.code, `simlock list --requests: ${result.stderr}`).toBe(0);
  return result.stdout
    .split("\n")
    .map((line) => /^Request \S+: ([^\s,]+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ requesterId: match[1] as string }));
}

export async function waitForFree(env: SharedTestEnv): Promise<void> {
  let observed = "nothing read yet";
  await waitFor(
    async () => {
      const [devices, leases, requests] = await Promise.all([
        listDevices(env),
        listLeases(env),
        listRequests(env),
      ]);
      observed = `devices ${devices.map((device) => device.state).join(",") || "none"}; leases ${String(leases.length)}; requests ${String(requests.length)}`;
      return (
        devices.length > 0 &&
        devices.every((device) => device.state === "ready") &&
        leases.length === 0 &&
        requests.length === 0
      );
    },
    {
      timeout: DEVICE_READY_MS,
      interval: 1_000,
      label: () => `every device ready, no lease, no request; last observed: ${observed}`,
    },
  );
}

export function ok(result: AgentDeviceResult): void {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
}

export function failureText(result: AgentDeviceResult): string {
  return result.error?.message ?? `${result.stdout}\n${result.stderr}`;
}

// why: the device limit lives in the config of the daemon that owns devices (a worker, or a single host), so the caller passes that daemon; the caller waits for whatever it needs after the restart.
export async function setLimits(
  daemon: SharedTestEnv,
  target: Target,
  devices: number,
): Promise<void> {
  const config = JSON.parse(await readFile(daemon.configPath, "utf8")) as {
    capacity: { config: { limits: Record<string, unknown> } };
  };
  config.capacity.config.limits[target.platform] = { maxDevices: devices, maxRunning: devices };
  await writeFile(daemon.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await daemon.restart();
}

export async function warmUp(daemon: SharedTestEnv, target: Target, count: number): Promise<void> {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const lease = await daemon.cli(
      ["lease", "--detach", "--platform", target.platform, "--agent-id", `warmup-${index}`],
      { timeout: 330_000 },
    );
    expect(lease.code, lease.stderr).toBe(0);
    ids.push((lease.json as { lease: { id: string } }).lease.id);
  }
  for (const id of ids) {
    const released = await daemon.cli(["release", id], { timeout: 60_000 });
    expect(released.code, released.stderr).toBe(0);
  }
  let observed = "nothing read yet";
  await waitFor(
    async () => {
      const devices = await listDevices(daemon);
      observed = devices.map((device) => device.state).join(",") || "none";
      return devices.length >= count && devices.every((device) => device.state === "ready");
    },
    {
      timeout: DEVICE_READY_MS,
      interval: 1_000,
      label: () => `${String(count)} warm-up devices ready; last observed: ${observed}`,
    },
  );
}

// why: vitest holds a test's console output until the test ends; a write to fd 2 reaches the log at once, so a stuck test shows while it runs.
export function progress(line: string): void {
  writeSync(2, `${new Date().toISOString()} ${line}\n`);
}
