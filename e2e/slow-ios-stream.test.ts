import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  deviceStreamUrl,
  REPO_ROOT,
  SCREEN_TAGS as TAG,
  readScreenFrames as readFrames,
  waitFor,
  withHttpDaemon,
} from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const STREAM_OPEN_BOUND = 240_000;
// why: an exact model name, as a warm target needs; the same model the other iOS lanes lease.
const WARM_MODEL = "iPhone 16";
const KEY_FRAME_BOUND = 120_000;

async function within<T>(work: Promise<T>, bound: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${String(bound)} ms waiting for ${what}`)),
      bound,
    );
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

const SIMULATOR_PROGRAM = join(REPO_ROOT, "dist", "bin", "simlock-screen-capture");

// why: `pgrep -x` matches the program's own name only; a pattern match would also find the shell
// running this check, which is a capture that looks alive and is not.
async function capturesRunning(): Promise<number> {
  const found = await execFileAsync("pgrep", ["-x", "simlock-screen-capture"]).catch(() => ({
    stdout: "",
  }));
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

// why: a one-panel device starts no panel follower, so nothing runs `log` inside its simulator; the
// pattern names the follower's children (`simctl spawn <udid> log stream|show`), not this shell.
async function panelLogChildren(): Promise<number> {
  const found = await execFileAsync("pgrep", ["-f", "simctl .*spawn .* log (stream|show)"]).catch(
    () => ({ stdout: "" }),
  );
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

describe.skipIf(process.platform !== "darwin")(
  "iOS screen stream (real simulator)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "streams a leased simulator's screen as meta, an avcC description and an H.264 key frame; a still screen stays open past the silence bound; a viewer leaving and a lease ending under a viewer each stop the capture",
      { timeout: 480_000 },
      async () => {
        expect(await capturesRunning(), "a capture was already running before the test").toBe(0);
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            capabilities: {
              stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
            },
          },
          driver: "real",
        }));
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        try {
          const lease = await env.cli(
            ["lease", "--platform", "ios", "--agent-id", "ios-stream", "--detach"],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          const leaseId = (lease.json as { lease: { id: string } }).lease.id;
          const deviceId = (lease.json as { device: { id: string } }).device.id;
          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const authorization = `Bearer ${(created.json as { secret: string }).secret}`;
          const open = async (signal: AbortSignal) => {
            const response = await within(
              fetch(await deviceStreamUrl(baseUrl, env.home, deviceId), {
                headers: { authorization },
                signal,
              }),
              STREAM_OPEN_BOUND,
              "the stream to open",
            );
            // why: a 200 body is an endless stream, so its text is read only for a failure, never
            // as an argument evaluated up front.
            const detail = response.status === 200 ? "" : await response.text().catch(() => "");
            expect(response.status, detail).toBe(200);
            if (response.body === null) throw new Error("the stream answered without a body");
            return { reader: response.body.getReader(), response };
          };

          const viewer = new AbortController();
          const first = await open(viewer.signal);
          expect(first.response.headers.get("simlock-stream-codec")).toBe("h264");
          const frames = await within(
            readFrames(first.reader, (read) => read.some((frame) => frame.tag === TAG.keyframe)),
            KEY_FRAME_BOUND,
            "the first stream's key frame",
          );
          expect(await capturesRunning()).toBe(1);
          viewer.abort();

          expect(frames.map((frame) => frame.tag).slice(0, 3)).toEqual([
            TAG.meta,
            TAG.description,
            TAG.keyframe,
          ]);
          const meta = JSON.parse(new TextDecoder().decode(frames[0]!.payload)) as {
            codec: string;
            width: number;
            height: number;
          };
          expect(meta.codec).toBe("h264");
          expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(720);
          expect(Math.min(meta.width, meta.height)).toBeGreaterThan(0);
          expect(frames[1]!.payload[0]).toBe(1);
          await waitFor(async () => (await capturesRunning()) === 0, {
            interval: 250,
            label: "the capture stopped once its viewer went away",
            timeout: 10_000,
          });

          const second = await open(new AbortController().signal);
          const opening = await within(
            readFrames(second.reader, (read) => read.some((frame) => frame.tag === TAG.keyframe)),
            KEY_FRAME_BOUND,
            "the second stream's key frame",
          );
          // why: nothing touches the simulator here, so its screen is still; the stream must stay
          // open well past the 30 s silence bound on the capture's own idle repaints.
          const stillFrom = Date.now();
          const stillUntil = stillFrom + 35_000;
          // why: the stream is endless, so a key frame's arrival is stamped as the read that
          // brought it ends; `enough` runs after every read.
          const keyArrivals = [stillFrom];
          let keysSeen = 0;
          const held = await within(
            readFrames(second.reader, (read) => {
              const keys = read.filter((frame) => frame.tag === TAG.keyframe).length;
              if (keys > keysSeen) keyArrivals.push(Date.now());
              keysSeen = keys;
              return Date.now() > stillUntil;
            }),
            KEY_FRAME_BOUND,
            "the still stream's frames",
          );
          expect(held.length, "a still simulator's stream sent nothing for 35 s").toBeGreaterThan(
            0,
          );
          expect(
            keysSeen,
            "a still simulator's stream sent too few key frames",
          ).toBeGreaterThanOrEqual(3);
          const gaps = [...keyArrivals, Date.now()].slice(1).map((at, i) => at - keyArrivals[i]!);
          expect(
            Math.max(...gaps.slice(0, -1)),
            "a still simulator's stream went over 5.5 s without a key frame",
          ).toBeLessThanOrEqual(5_500);
          expect(
            [...opening, ...held].filter((frame) => frame.tag === TAG.meta).length,
            "a one-panel device's stream sent more than one meta frame",
          ).toBe(1);
          expect(await panelLogChildren(), "a one-panel device started a panel follower").toBe(0);
          const after = await within(
            second.reader.read(),
            KEY_FRAME_BOUND,
            "the still stream's next read",
          );
          expect(after.done, "a still simulator's stream ended inside 35 s").toBe(false);
          const release = await env.cli(["release", leaseId]);
          expect(release.code, release.stderr).toBe(0);
          const ended = await Promise.race([
            readFrames(second.reader, () => false).then(
              () => "ended",
              () => "ended",
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("still streaming"), 15_000)),
          ]);
          expect(ended).toBe("ended");
          await waitFor(async () => (await capturesRunning()) === 0, {
            interval: 250,
            label: "the capture stopped once its lease ended under a connected viewer",
            timeout: 10_000,
          });
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );

    it(
      "streams a simulator nobody has leased, and keeps streaming for 10 s when a lease is granted on that simulator",
      { timeout: 480_000 },
      async () => {
        expect(await capturesRunning(), "a capture was already running before the test").toBe(0);
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            capabilities: {
              stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
            },
            warmPool: { targets: [{ count: 1, model: WARM_MODEL, platform: "ios" }] },
          },
          driver: "real",
        }));
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        try {
          let warmId = "";
          await waitFor(
            async () => {
              const listed = await env.cli(["list", "--devices"]);
              const devices = (listed.json ?? []) as { id: string; state: string }[];
              warmId = devices.find((device) => device.state === "ready")?.id ?? "";
              return warmId !== "";
            },
            {
              interval: 2_000,
              label: "the warm pool keeps one simulator ready",
              timeout: DEVICE_READY_MS,
            },
          );
          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const viewer = new AbortController();
          const response = await within(
            fetch(await deviceStreamUrl(baseUrl, env.home, warmId), {
              headers: { authorization: `Bearer ${(created.json as { secret: string }).secret}` },
              signal: viewer.signal,
            }),
            STREAM_OPEN_BOUND,
            "the unleased simulator's stream to open",
          );
          const detail = response.status === 200 ? "" : await response.text().catch(() => "");
          expect(response.status, detail).toBe(200);
          if (response.body === null) throw new Error("the stream answered without a body");
          const reader = response.body.getReader();
          const first = await within(
            readFrames(reader, (read) => read.some((frame) => frame.tag === TAG.keyframe)),
            KEY_FRAME_BOUND,
            "the unleased simulator's key frame",
          );
          expect(first.some((frame) => frame.tag === TAG.keyframe)).toBe(true);

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "ios",
              "--device",
              WARM_MODEL,
              "--agent-id",
              "ios-stream-watched",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          expect(
            (lease.json as { device: { id: string } }).device.id,
            "the lease took another simulator",
          ).toBe(warmId);
          const keepUntil = Date.now() + 10_000;
          const kept = await within(
            readFrames(reader, () => Date.now() > keepUntil),
            KEY_FRAME_BOUND,
            "frames after the lease was granted",
          );
          expect(kept.length, "the stream sent nothing for 10 s after the lease").toBeGreaterThan(
            0,
          );
          // why: a stream that closed at the grant ends the read loop early with frames already
          // buffered, so frames alone do not prove it kept going; the next read must still be open.
          const stillOpen = await within(
            reader.read(),
            KEY_FRAME_BOUND,
            "the stream's next read after the lease",
          );
          expect(stillOpen.done, "the stream ended when the lease was granted").toBe(false);
          viewer.abort();
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );

    it(
      "a capture program that was killed leaves no frame-callback faults once the next one starts, and one whose daemon died stops itself without leaving any",
      { timeout: 480_000 },
      async () => {
        expect(existsSync(SIMULATOR_PROGRAM), "run pnpm build first").toBe(true);
        const { env } = await withHttpDaemon((httpPort) => ({
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port: httpPort } },
          driver: "real",
        }));
        try {
          const lease = await env.cli(
            ["lease", "--platform", "ios", "--agent-id", "ios-capture-faults", "--detach"],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          const grant = lease.json as {
            device: { driverDeviceId: string };
            environment: Record<string, string | undefined>;
          };
          const udid = grant.device.driverDeviceId;
          const deviceSet = grant.environment.SIMLOCK_IOS_DEVICE_SET;
          const programEnv = { ...process.env };
          delete programEnv.SIMLOCK_IOS_DEVICE_SET;
          if (deviceSet !== undefined) programEnv.SIMLOCK_IOS_DEVICE_SET = deviceSet;
          const start = () => startCapture(udid, programEnv);

          // why: the renderer only composites, and so only faults, when the screen changes; a
          // still simulator renders once a minute, so every wait on a fault flips the appearance.
          let dark = false;
          const repaint = async () => {
            dark = !dark;
            const args = ["simctl", ...(deviceSet === undefined ? [] : ["--set", deviceSet])];
            await execFileAsync("xcrun", [
              ...args,
              "ui",
              udid,
              "appearance",
              dark ? "dark" : "light",
            ]);
          };
          const renderer = await rendererPid(udid);
          const faultsSince = async (since: Date) => (await rendererFaults(renderer, since)).length;

          const killed = start();
          await killed.firstFrame;
          killed.child.kill("SIGKILL");
          await killed.exited;
          const killedAt = new Date();
          await waitFor(
            async () => {
              await repaint();
              return (await faultsSince(killedAt)) > 0;
            },
            {
              interval: 1_000,
              label: "the renderer to log faults for the killed program's frame callbacks",
              timeout: 90_000,
            },
          );

          const next = start();
          await next.firstFrame;
          // why: the faults a registration left before the next program unregistered it are not the
          // claim; the window opens a few seconds after that program's first frame.
          const settled = new Date(Date.now() + 3_000);
          const windowEnd = Date.now() + 13_000;
          while (Date.now() < windowEnd) {
            await repaint();
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          expect(
            await rendererFaults(renderer, settled),
            "the renderer kept faulting for a killed program's frame callbacks after the next program started",
          ).toEqual([]);
          next.child.stdin.end();
          expect(await next.exited, "a program told to stop by its stdin closing exits 0").toEqual({
            code: 0,
            signal: null,
          });

          const orphan = start();
          await orphan.firstFrame;
          // why: a daemon that dies closes all its ends of the program's pipes at once.
          orphan.child.stdin.destroy();
          orphan.child.stdout.destroy();
          orphan.child.stderr.destroy();
          const ended = await within(
            orphan.exited,
            30_000,
            "the program whose daemon died to exit",
          );
          expect(
            ended,
            "a program whose daemon died was killed by a signal instead of stopping",
          ).toEqual({
            code: 0,
            signal: null,
          });
          const orphanEnd = new Date(Date.now() + 2_000);
          const orphanWindow = Date.now() + 12_000;
          while (Date.now() < orphanWindow) {
            await repaint();
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          expect(
            await rendererFaults(renderer, orphanEnd),
            "the renderer faulted for the frame callbacks of a program whose daemon died",
          ).toEqual([]);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );

    it(
      "the simulator capture program exits 64 on missing usage and 1 when its device is not there",
      { timeout: 120_000 },
      async () => {
        expect(existsSync(SIMULATOR_PROGRAM), "run pnpm build first").toBe(true);
        const noArgs = await run(SIMULATOR_PROGRAM, []);
        expect(noArgs.code, "no arguments is a usage error").toBe(64);
        const unknownUdid = await run(SIMULATOR_PROGRAM, [
          "00000000-0000-0000-0000-000000000000",
          "--codec",
          "avcc",
          "--fps",
          "30",
          "--bitrate",
          "1500000",
          "--max-dimension",
          "720",
        ]);
        expect(unknownUdid.code, "a device that is not there fails to start").toBe(1);
      },
    );
  },
);

// why: `execFile` rejects on a non-zero exit, which is the whole claim here; the exit code is what
// the test reads, so the rejection is unwrapped rather than caught per call site. `stdio[0]` is
// `pipe` and not `ignore` because stdin is the capture's liveness handle: the driver hands it a live
// pipe it closes only to stop, so a pipe hung up at birth is a stop asked for before the program
// began -- which the iPhone program answers by going at once with exit 0, reporting no reason.
async function run(
  program: string,
  args: readonly string[],
): Promise<{ code: number; stderr: string }> {
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? -1));
  });
  return { code, stderr };
}

interface Capture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly firstFrame: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// why: the program the driver starts for a simulator stream, with the driver's arguments, run
// without a daemon so a test can end it the ways a daemon does not.
function startCapture(udid: string, env: NodeJS.ProcessEnv): Capture {
  const child = spawn(
    SIMULATOR_PROGRAM,
    [udid, "--codec", "avcc", "--fps", "30", "--bitrate", "1500000", "--max-dimension", "720"],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const firstFrame = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("the capture program ended before its first frame")));
  });
  // why: the rejection is read where a test awaits it; a program that ends after its frame is no
  // unhandled rejection.
  firstFrame.catch(() => undefined);
  child.stdout.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, firstFrame };
}

function logTime(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

// why: every booted simulator has its own SimRenderServer on the host, with no UDID in its
// arguments or log lines; it starts in the same second as the simulator's launchd_sim (which names
// the UDID) and just before it, so it is the highest SimRenderServer pid below that launchd_sim's.
async function rendererPid(udid: string): Promise<number> {
  const listed = await execFileAsync("ps", ["-axww", "-o", "pid=,command="]);
  const rows = listed.stdout.split("\n").map((line) => {
    const [pid, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), command: command.join(" ") };
  });
  const launchd = rows.find((r) => r.command.includes("launchd_sim") && r.command.includes(udid));
  expect(launchd, `no launchd_sim running for simulator ${udid}`).toBeDefined();
  const renderers = rows
    .filter((r) => r.command.includes("SimRenderServer.xpc") && r.pid < (launchd?.pid ?? 0))
    .map((r) => r.pid);
  expect(
    renderers.length,
    `no SimRenderServer started before simulator ${udid}'s launchd_sim`,
  ).toBeGreaterThan(0);
  return Math.max(...renderers);
}

// why: the simulator's renderer logs one `Invalid connection UUID specified` fault per rendered
// frame for each frame callback nobody unregistered; only the leased simulator's renderer counts,
// because another booted simulator on the host faults on its own.
async function rendererFaults(renderer: number, since: Date): Promise<string[]> {
  const shown = await execFileAsync("log", [
    "show",
    "--style",
    "compact",
    "--start",
    logTime(since),
    "--predicate",
    `process == "SimRenderServer" AND processID == ${String(renderer)} AND eventMessage CONTAINS "Invalid connection UUID specified"`,
  ]);
  return shown.stdout
    .split("\n")
    .filter((line) => line.includes("Invalid connection UUID specified"));
}
