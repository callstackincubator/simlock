import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";
import { REPO_ROOT } from "./helpers/repo-root.js";
import { sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

/** why: a CLI that dies on the signal leaves its recorder running, so a pid listed after the CLI returned is the orphan. */
async function recordersOf(udid: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", `recordVideo.*${udid}`]);
    return stdout.trim();
  } catch {
    return "";
  }
}

// why: Ctrl-C in a terminal goes to the whole foreground process group, so the only faithful
// case runs the CLI on a pty as its session leader and types ^C; the script prints the exit code it saw.
const PTY_CTRL_C = `
import os, pty, sys, time
video = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
deadline = time.time() + 60
while time.time() < deadline and not (os.path.exists(video) and os.path.getsize(video) > 0):
    time.sleep(0.5)
os.write(fd, b"\\x03")
try:
    while os.read(fd, 4096):
        pass
except OSError:
    pass
_, status = os.waitpid(pid, 0)
print(os.waitstatus_to_exitcode(status))
`;

describe.skipIf(process.platform !== "darwin")(
  "iOS passthrough signals (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "a SIGINT or SIGTERM sent only to `simlock simctl io recordVideo` lets the real recorder finish a playable file and exit, and the simulator records again afterwards",
      { timeout: 900_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({ driver: "real" });
        const lease = await env.cli(
          ["lease", "--platform", "ios", "--agent-id", "ios-signals", "--detach"],
          { timeout: 600_000 },
        );
        expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
        const udid = (lease.json as { device: { driverDeviceId: string } }).device.driverDeviceId;

        // why: SIGINT then SIGTERM on one simulator is the reuse proof: the second recorder can only start if the first one released the device.
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          const video = join(env.home, `recording-${signal}.mp4`);
          const recording = env.cliBackground(["simctl", "io", udid, "recordVideo", video]);
          try {
            await waitFor(
              async () => (await stat(video).catch(() => undefined))?.size !== undefined,
              { interval: 500, label: `${signal} recording file created`, timeout: 60_000 },
            );
            recording.kill(signal);
            const result = await recording.waitForExit(120_000);
            expect.soft(result.code, `${signal}: the CLI returns simctl's own exit code`).toBe(0);
            expect(await recordersOf(udid), `${signal}: no recorder outlives the CLI`).toBe("");
            const bytes = await readFile(video);
            // why: an unfinished MP4 has no moov atom, so its presence is what a flush produces.
            expect(bytes.includes("moov"), `${signal}: the video was finalized`).toBe(true);
          } finally {
            recording.kill("SIGKILL");
          }
        }
      },
    );

    it(
      "Ctrl-C typed in a terminal running `simlock simctl io recordVideo` makes the CLI wait for the recorder and exit with its code",
      { timeout: 900_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({ driver: "real" });
        const lease = await env.cli(
          ["lease", "--platform", "ios", "--agent-id", "ios-pty", "--detach"],
          { timeout: 600_000 },
        );
        expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
        const udid = (lease.json as { device: { driverDeviceId: string } }).device.driverDeviceId;
        const video = join(env.home, "recording-pty.mp4");

        const { stdout } = await execFileAsync(
          "python3",
          [
            "-I",
            "-c",
            PTY_CTRL_C,
            video,
            process.execPath,
            join(REPO_ROOT, "dist/cli/main.js"),
            "simctl",
            "io",
            udid,
            "recordVideo",
            video,
          ],
          { env: env.env, timeout: 300_000 },
        );
        expect(
          Number(stdout.trim()),
          "the CLI exits with simctl's own code after it finished",
        ).toBe(0);
        expect(await recordersOf(udid), "no recorder outlives the CLI").toBe("");
        const bytes = await readFile(video);
        expect(bytes.includes("moov"), "the video was finalized").toBe(true);
      },
    );
  },
);
