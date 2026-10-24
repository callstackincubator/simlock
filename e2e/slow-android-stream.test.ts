import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, deviceStreamUrl, waitFor, withHttpDaemon } from "./helpers/index.js";

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

const TAG = { alive: 0x06, description: 0x01, keyframe: 0x02, delta: 0x03, meta: 0x05 } as const;

interface Frame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

// why: the body is an endless stream, so this reads frames until it has what it came for and then
// lets go, rather than reading to an end that never comes.
async function readFrames(
  body: ReadableStream<Uint8Array>,
  enough: (frames: readonly Frame[]) => boolean,
): Promise<Frame[]> {
  const reader = body.getReader();
  const frames: Frame[] = [];
  let buffer = new Uint8Array(0);
  try {
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
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

describe.skipIf(!hasAndroidSdk)(
  "Android screen stream (real emulator)",
  { tags: ["slow", "android"] },
  () => {
    it(
      "streams a leased emulator's screen as meta, an avcC description and an H.264 key frame, leaves no server or jar once the viewer goes, keeps a still screen open 15 s past the silence bound with alive frames, and ends when its lease is released under a viewer",
      { timeout: 480_000 },
      async () => {
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
            [
              "lease",
              "--platform",
              "android",
              "--device",
              "Pixel 9",
              "--agent-id",
              "android-stream",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          const leaseId = (lease.json as { lease: { id: string } }).lease.id;
          const deviceId = (lease.json as { device: { id: string } }).device.id;
          const streamUrl = await deviceStreamUrl(baseUrl, env.home, deviceId);
          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const authorization = `Bearer ${(created.json as { secret: string }).secret}`;

          const viewer = new AbortController();
          const response = await fetch(streamUrl, {
            headers: { authorization },
            signal: viewer.signal,
          });
          // why: a 200 body is an endless stream, so its text is read only for a failure, never as
          // an argument evaluated up front.
          const detail = response.status === 200 ? "" : await response.text().catch(() => "");
          expect(response.status, detail).toBe(200);
          expect(response.headers.get("simlock-stream-codec")).toBe("h264");
          if (response.body === null) throw new Error("the stream answered without a body");

          const frames = await readFrames(response.body, (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
          );
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
          const description = frames[1]!.payload;
          expect(description[0]).toBe(1);
          expect(description[4]).toBe(0xff);
          const key = frames[2]!.payload;
          const firstNal = new DataView(key.buffer, key.byteOffset).getUint32(0);
          expect(firstNal).toBeGreaterThan(0);
          expect(firstNal).toBeLessThanOrEqual(key.length - 4);

          await waitFor(
            async () => {
              const processes = await env.cli(["adb", "shell", "ps", "-A", "-o", "ARGS"]);
              const files = await env.cli(["adb", "shell", "ls", "/data/local/tmp"]);
              return (
                processes.code === 0 &&
                !processes.stdout.includes("com.genymobile.scrcpy.Server") &&
                files.code === 0 &&
                !files.stdout.includes("simlock-scrcpy-")
              );
            },
            {
              interval: 500,
              label: "no scrcpy server process and no pushed jar left on the emulator",
              timeout: 30_000,
            },
          );

          // why: an untouched emulator's encoder sends nothing once its picture is still, so a stream
          // held well past the 30 s silence bound proves the still screen is kept alive on a real
          // device, and the lease released under that viewer proves the stop on a device too.
          const watching = await fetch(streamUrl, { headers: { authorization } });
          expect(watching.status).toBe(200);
          if (watching.body === null) throw new Error("the stream answered without a body");
          const watched = watching.body.getReader();
          const tags: number[] = [];
          let buffered = new Uint8Array(0);
          let ended = false;
          const reading = (async () => {
            for (;;) {
              const step = await watched.read().catch(() => ({ done: true, value: undefined }));
              if (step.done || step.value === undefined) break;
              const joined = new Uint8Array(buffered.length + step.value.length);
              joined.set(buffered);
              joined.set(step.value, buffered.length);
              buffered = joined;
              while (buffered.length >= 5) {
                const length = new DataView(buffered.buffer, buffered.byteOffset).getUint32(0);
                if (buffered.length < 4 + length) break;
                tags.push(buffered[4]!);
                buffered = buffered.slice(4 + length);
              }
            }
            ended = true;
          })();
          await new Promise((resolve) => setTimeout(resolve, 45_000));
          expect(ended, "a still screen's stream ended inside the silence bound").toBe(false);
          expect(tags).toContain(TAG.keyframe);
          // why: an `alive` frame is the evidence the screen went still and the stream was kept open
          // for it; a screen that kept painting would pass the line above without proving anything.
          expect(tags, "no alive frame: the screen never went still").toContain(TAG.alive);

          // why: the viewer leaves while the screen is still, the case where the server writes
          // nothing and only the close can end it; the device must be left with no server and no jar.
          await watched.cancel();
          await reading;
          await waitFor(
            async () => {
              const processes = await env.cli(["adb", "shell", "ps", "-A", "-o", "ARGS"]);
              const files = await env.cli(["adb", "shell", "ls", "/data/local/tmp"]);
              return (
                processes.code === 0 &&
                !processes.stdout.includes("com.genymobile.scrcpy.Server") &&
                files.code === 0 &&
                !files.stdout.includes("simlock-scrcpy-")
              );
            },
            {
              interval: 500,
              label: "no scrcpy server and no jar left after a viewer left a still screen",
              timeout: 30_000,
            },
          );

          const last = await fetch(streamUrl, {
            headers: { authorization },
          });
          expect(last.status).toBe(200);
          const lastReader = last.body?.getReader();
          if (lastReader === undefined) throw new Error("the stream answered without a body");
          await lastReader.read();
          let lastEnded = false;
          const draining = (async () => {
            for (;;) {
              const step = await lastReader.read().catch(() => ({ done: true }));
              if (step.done) break;
            }
            lastEnded = true;
          })();
          const release = await env.cli(["release", leaseId]);
          expect(release.code, release.stderr).toBe(0);
          await Promise.race([draining, new Promise((resolve) => setTimeout(resolve, 15_000))]);
          expect(lastEnded, "the stream outlived its lease").toBe(true);
          const hostShells = await new Promise<string>((resolve) => {
            execFile("pgrep", ["-fl", "[s]imlock-scrcpy-"], (_error, stdout) => resolve(stdout));
          });
          expect(hostShells, "a host adb shell for the capture outlived the lease").toBe("");
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
