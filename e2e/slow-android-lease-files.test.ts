import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, waitFor, withHttpDaemon } from "./helpers/index.js";

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

const FILE_BYTES = 70_000_000;

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

async function readSse(response: Response): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (const raw of (await response.text()).split("\n\n")) {
    if (raw.trim() === "" || raw.startsWith(":")) continue;
    let event: string | undefined;
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event !== undefined) frames.push({ data: JSON.parse(data) as unknown, event });
  }
  return frames;
}

// why: only a real emulator proves that the folder a lease's upload went to is the folder `adb push` reads from, and that `adb pull` leaves a file the GET route serves, at a size no fake pipe is asked to carry.
describe.skipIf(!hasAndroidSdk)(
  "a lease's files on a real emulator",
  { tags: ["slow", "android"] },
  () => {
    it(
      "pushes an uploaded 70 MB file to the emulator with adb push, reads its size back with adb shell wc -c, and pulls it into a file a GET returns byte for byte",
      { timeout: 600_000 },
      async () => {
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            idle: { shutdownAfterMs: 300_000 },
            warmPool: { learn: false },
          },
          driver: "real",
        }));
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        try {
          const created = await env.cli(["token", "create", "--role", "agent"]);
          expect(created.code, created.stderr).toBe(0);
          const auth = {
            authorization: `Bearer ${(created.json as { secret: string }).secret}`,
            "content-type": "application/json",
          };
          const requested = await fetch(`${baseUrl}/v1/lease-requests`, {
            body: JSON.stringify({ device: "Pixel 9", platform: "android" }),
            headers: auth,
            method: "POST",
          });
          expect(requested.status).toBe(201);
          const requestId = ((await requested.json()) as { request: { id: string } }).request.id;
          let leaseId = "";
          await waitFor(
            async () => {
              const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
                headers: auth,
              });
              const view = (await polled.json()) as {
                request: { state: string; lease?: { id: string } };
              };
              leaseId = view.request.lease?.id ?? "";
              return view.request.state === "granted";
            },
            { label: "the lease request is granted", timeout: DEVICE_READY_MS },
          );

          const bytes = Buffer.alloc(FILE_BYTES);
          for (let at = 0; at < FILE_BYTES; at += 1) bytes[at] = at % 251;
          const uploaded = await fetch(`${baseUrl}/v1/leases/${leaseId}/files/fixture.bin`, {
            body: bytes,
            headers: { ...auth, "content-type": "application/octet-stream" },
            method: "PUT",
          });
          expect(uploaded.status).toBe(201);

          const run = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
            const response = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
              body: JSON.stringify({ args, tool: "adb" }),
              headers: auth,
              method: "POST",
            });
            expect(response.status).toBe(200);
            const frames = await readSse(response);
            const exit = frames.find((frame) => frame.event === "exit");
            return {
              exitCode: (exit?.data as { exitCode: number } | undefined)?.exitCode ?? -1,
              stdout: frames
                .filter((frame) => frame.event === "output")
                .map((frame) => frame.data as { stream: string; chunk: string })
                .filter((chunk) => chunk.stream === "stdout")
                .map((chunk) => chunk.chunk)
                .join(""),
            };
          };

          expect((await run(["push", "fixture.bin", "/data/local/tmp/fixture.bin"])).exitCode).toBe(
            0,
          );
          const size = await run(["shell", "wc", "-c", "/data/local/tmp/fixture.bin"]);
          expect(size.exitCode).toBe(0);
          expect(size.stdout).toContain(String(FILE_BYTES));
          expect((await run(["pull", "/data/local/tmp/fixture.bin", "back.bin"])).exitCode).toBe(0);

          const back = await fetch(`${baseUrl}/v1/leases/${leaseId}/files/back.bin`, {
            headers: auth,
          });
          expect(back.status).toBe(200);
          expect(Buffer.from(await back.arrayBuffer()).equals(bytes)).toBe(true);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
