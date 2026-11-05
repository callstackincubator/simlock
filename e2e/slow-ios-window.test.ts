import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  SCREEN_TAGS as TAG,
  deviceStreamUrl,
  readScreenFrames as readFrames,
  waitFor,
  withHttpDaemon,
} from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const DEVICEHUB_DEFAULTS = "com.apple.dt.Devices";
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

/** why: DeviceHub keeps the UDID it was last told to select in its defaults, as quoted data; reading it needs no permission. */
async function selectedInDeviceHub(): Promise<string> {
  const { stdout } = await execFileAsync("defaults", [
    "read",
    DEVICEHUB_DEFAULTS,
    "lastSelectedDeviceIdentifier",
  ]);
  const bytes = /0x([0-9a-f ]+)/.exec(stdout)?.[1]?.replaceAll(" ", "") ?? "";
  return Buffer.from(bytes, "hex").toString("utf8").replaceAll('"', "");
}

describe.skipIf(process.platform !== "darwin")(
  "iOS simulator window (real DeviceHub)",
  { tags: ["slow", "ios"] },
  () => {
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
            `tell application id "${DEVICEHUB_DEFAULTS}" to quit`,
          ]).catch(() => undefined);
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
