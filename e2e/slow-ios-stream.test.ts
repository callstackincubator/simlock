import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, waitFor, withHttpDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const TAG = { description: 0x01, keyframe: 0x02, meta: 0x05 } as const;

interface Frame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

// why: the body is an endless stream, so this reads frames until it has what it came for and then
// lets go, rather than reading to an end that never comes.
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  enough: (frames: readonly Frame[]) => boolean,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  let buffer = new Uint8Array(0);
  while (!enough(frames)) {
    const step = await reader.read();
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
  return frames;
}

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
            const response = await fetch(
              `${baseUrl}/v1/stream/leases/${encodeURIComponent(leaseId)}`,
              { headers: { authorization }, signal },
            );
            expect(
              response.status,
              await response
                .clone()
                .text()
                .catch(() => ""),
            ).toBe(200);
            if (response.body === null) throw new Error("the stream answered without a body");
            return { reader: response.body.getReader(), response };
          };

          const viewer = new AbortController();
          const first = await open(viewer.signal);
          expect(first.response.headers.get("simlock-stream-codec")).toBe("h264");
          const frames = await readFrames(first.reader, (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
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
          await readFrames(second.reader, (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
          );
          // why: nothing touches the simulator here, so its screen is still; the stream must stay
          // open well past the 30 s silence bound on the capture's own idle repaints.
          const stillUntil = Date.now() + 35_000;
          const held = await readFrames(second.reader, () => Date.now() > stillUntil);
          expect(held.length, "a still simulator's stream sent nothing for 35 s").toBeGreaterThan(
            0,
          );
          const after = await second.reader.read();
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
  },
);
