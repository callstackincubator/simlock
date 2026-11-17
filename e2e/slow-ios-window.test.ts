import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  SCREEN_TAGS as TAG,
  deviceStreamUrl,
  readScreenFrames as readFrames,
  selectedInDeviceHub,
  waitFor,
  withDaemon,
  withHttpDaemon,
} from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const FRAME_BOUND = 120_000;

async function frontmostApp(): Promise<string> {
  const { stdout } = await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js",
  ]);
  return stdout.trim();
}

async function writeClipboard(command: string, args: string[], value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${String(code)}: ${stderr}`)),
    );
    child.stdin.end(value);
  });
}

async function expectClipboardIsolated(udid: string): Promise<void> {
  const token = randomUUID();
  const host = `host-${token}`;
  const device = `device-${token}`;
  await writeClipboard("pbcopy", [], host);
  await writeClipboard("xcrun", ["simctl", "pbcopy", udid], device);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await execFileAsync("pbpaste")).stdout, "device clipboard did not reach host").toBe(host);
  expect(
    (await execFileAsync("xcrun", ["simctl", "pbpaste", udid])).stdout,
    "host clipboard did not reach device",
  ).toBe(device);
  const hostAgain = `host-again-${token}`;
  await writeClipboard("pbcopy", [], hostAgain);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(
    (await execFileAsync("xcrun", ["simctl", "pbpaste", udid])).stdout,
    "host change did not reach device",
  ).toBe(device);
  const deviceAgain = `device-again-${token}`;
  await writeClipboard("xcrun", ["simctl", "pbcopy", udid], deviceAgain);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await execFileAsync("pbpaste")).stdout, "device change did not reach host").toBe(
    hostAgain,
  );
}

describe.skipIf(process.platform !== "darwin")(
  "iOS simulator window (real DeviceHub)",
  { tags: ["slow", "ios"] },
  () => {
    it.each(["cold", "warm"] as const)(
      "isolates clipboard in both directions for a %s lease and after recovery, and deletes only its DeviceHub preference",
      { timeout: 1_200_000 },
      async (path) => {
        const version = await execFileAsync("xcodebuild", ["-version"]);
        expect(version.stdout).toMatch(/^Xcode 27\.2(?:\s|$)/);
        const previousClipboard = (await execFileAsync("pbpaste")).stdout;
        const sentinel = randomUUID().toUpperCase();
        // why: cfprefsd owns DeviceHub's preferences and rewrites the file over a direct edit, so
        // the test reads and edits an export of the domain and imports a change back.
        const staged = join(tmpdir(), `devicehub-${randomUUID()}.plist`);
        const buddy = async (command: string) => {
          await execFileAsync("defaults", ["export", "com.apple.dt.Devices", staged]);
          const result = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", command, staged]);
          if (!command.startsWith("Print")) {
            await execFileAsync("defaults", ["import", "com.apple.dt.Devices", staged]);
          }
          return result;
        };
        const env = await withDaemon({
          configOverrides: {
            drivers: { ios: { deviceSet: "default" } },
            health: { probeIntervalMs: 2_000, recoveryBackoffMs: 1_000, stableObservations: 1 },
            ios: { simulator: { headless: false } },
            warmPool:
              path === "warm"
                ? { targets: [{ count: 1, model: "iPhone 16", platform: "ios" }] }
                : { enabled: false },
          },
          driver: "real",
        });
        let udid = "";
        try {
          let warmId = "";
          if (path === "warm") {
            await waitFor(
              async () => {
                const listed = await env.cli(["list", "--devices"]);
                warmId =
                  ((listed.json ?? []) as { id: string; state: string }[]).find(
                    (device) => device.state === "ready",
                  )?.id ?? "";
                return warmId !== "";
              },
              { interval: 2_000, label: "warm iOS simulator ready", timeout: DEVICE_READY_MS },
            );
          }
          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "ios",
              "--device",
              "iPhone 16",
              "--agent-id",
              `clipboard-${path}`,
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, lease.stderr).toBe(0);
          const grant = lease.json as {
            device: { id: string; driverDeviceId: string };
            lease: { id: string };
          };
          udid = grant.device.driverDeviceId;
          if (path === "warm") expect(grant.device.id).toBe(warmId);
          // why: a warm pool refills after the grant, and the refill's boot selects its own simulator.
          await waitFor(
            async () => {
              const selected = await selectedInDeviceHub();
              return path === "warm" ? selected !== "" : selected === udid;
            },
            { interval: 1_000, label: "DeviceHub selected simulator", timeout: 30_000 },
          );
          expect(
            (await buddy(`Print :DevicePreferences:${udid}:pasteboardSyncEnabled`)).stdout.trim(),
          ).toBe("false");
          await buddy(`Add :DevicePreferences:${sentinel} dict`);
          await buddy(`Add :DevicePreferences:${sentinel}:pasteboardSyncEnabled bool true`);
          await expectClipboardIsolated(udid);
          await execFileAsync("xcrun", ["simctl", "shutdown", udid]);
          await env.expectEvents(["device.crash-detected", "device.recovered"], {
            since: "1h",
            timeout: 180_000,
          });
          await expectClipboardIsolated(udid);
          const released = await env.cli(["release", grant.lease.id]);
          expect(released.code, released.stderr).toBe(0);
          await waitFor(
            async () => {
              try {
                await buddy(`Print :DevicePreferences:${udid}`);
                return false;
              } catch {
                return true;
              }
            },
            { interval: 1_000, label: "deleted simulator preference removed", timeout: 180_000 },
          );
          const devices = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"]);
          expect(devices.stdout).not.toContain(udid);
          expect(
            (
              await buddy(`Print :DevicePreferences:${sentinel}:pasteboardSyncEnabled`)
            ).stdout.trim(),
          ).toBe("true");
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 })
            .catch(() => undefined);
          await buddy(`Delete :DevicePreferences:${sentinel}`).catch(() => undefined);
          await writeClipboard("pbcopy", [], previousClipboard);
          await execFileAsync("osascript", [
            "-e",
            `tell application id "com.apple.dt.Devices" to quit`,
          ]).catch(() => undefined);
        }
      },
    );
    it(
      "a leased simulator on a worker with ios.simulator.headless false shows in DeviceHub's main window within 30 s, the front app stays in front, and its screen streams frames with the window up",
      { timeout: 600_000 },
      async () => {
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            drivers: { ios: { deviceSet: "default" } },
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            ios: { simulator: { headless: false } },
            capabilities: {
              stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
            },
          },
          driver: "real",
        }));
        const front = await frontmostApp();
        try {
          const lease = await env.cli(
            ["lease", "--platform", "ios", "--agent-id", "ios-window", "--detach"],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          const grant = lease.json as {
            device: { id: string; driverDeviceId: string };
            lease: { id: string };
          };

          await waitFor(async () => (await selectedInDeviceHub()) === grant.device.driverDeviceId, {
            interval: 1_000,
            label: "DeviceHub selected the leased simulator",
            timeout: 30_000,
          });
          expect(await frontmostApp(), "the front app changed").toBe(front);

          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const response = await fetch(
            await deviceStreamUrl(`http://127.0.0.1:${String(port)}`, env.home, grant.device.id),
            {
              headers: { authorization: `Bearer ${(created.json as { secret: string }).secret}` },
              signal: AbortSignal.timeout(FRAME_BOUND),
            },
          );
          expect(response.status).toBe(200);
          const frames = await readFrames(response.body!.getReader(), (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
          );
          expect(frames.map((frame) => frame.tag)).toContain(TAG.keyframe);

          await env.cli(["release", grant.lease.id]).catch(() => undefined);
        } finally {
          await execFileAsync("osascript", [
            "-e",
            `tell application id "com.apple.dt.Devices" to quit`,
          ]).catch(() => undefined);
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
