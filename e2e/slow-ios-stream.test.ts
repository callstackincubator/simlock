import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  REPO_ROOT,
  SCREEN_TAGS as TAG,
  readScreenFrames as readFrames,
  waitFor,
  withHttpDaemon,
} from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const STREAM_OPEN_BOUND = 240_000;
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
          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const authorization = `Bearer ${(created.json as { secret: string }).secret}`;
          const open = async (signal: AbortSignal) => {
            const response = await within(
              fetch(`${baseUrl}/v1/stream/leases/${encodeURIComponent(leaseId)}`, {
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
          await within(
            readFrames(second.reader, (read) => read.some((frame) => frame.tag === TAG.keyframe)),
            KEY_FRAME_BOUND,
            "the second stream's key frame",
          );
          // why: nothing touches the simulator here, so its screen is still; the stream must stay
          // open well past the 30 s silence bound on the capture's own idle repaints.
          const stillUntil = Date.now() + 35_000;
          const held = await within(
            readFrames(second.reader, () => Date.now() > stillUntil),
            KEY_FRAME_BOUND,
            "the still stream's frames",
          );
          expect(held.length, "a still simulator's stream sent nothing for 35 s").toBeGreaterThan(
            0,
          );
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
