import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeScreenFrame, encodeScreenMeta, SCREEN_FRAME_TAG } from "../core/index.js";
import type { ScreenCapture } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

const admin: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
};

const agent: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "agent-1",
  role: "agent",
};

// why: a screen that paints a meta frame and a key frame, then keeps the stream open until it is
// closed, which is what a real capture does; `closes` is the test's witness that a stop reached it.
function paintingScreen(): { readonly capture: ScreenCapture; readonly closes: () => number } {
  let closes = 0;
  return {
    capture: {
      open: async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start: (given) => {
            controller = given;
            given.enqueue(encodeScreenMeta({ codec: "h264", fps: 30, height: 64, width: 32 }));
            given.enqueue(
              encodeScreenFrame(SCREEN_FRAME_TAG.keyframe, new Uint8Array([0, 0, 0, 1, 7])),
            );
          },
        });
        return {
          body,
          close: async () => {
            closes += 1;
            try {
              controller.close();
            } catch {
              // why: a body its reader already cancelled is closed; the stop still counts.
            }
          },
        };
      },
      unavailable: async () => undefined,
    },
    closes: () => closes,
  };
}

describe("a screen stream through a gateway", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function fleet(workerStreams: boolean) {
    const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-stream-gateway-"));
    directories.push(gatewayDirectory);
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port },
        mode: "gateway",
        capabilities: { stream: { enabled: true } },
      },
      dataDirectory: gatewayDirectory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(gatewayDirectory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const token = (await gateway.dispatch("token.create", { label: "w", role: "worker" }, admin))
      .secret;
    const operator = (
      await gateway.dispatch("token.create", { label: "op", role: "operator" }, admin)
    ).secret;
    const workerDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-stream-worker-"));
    directories.push(workerDirectory);
    const screen = paintingScreen();
    const worker = await startDaemon({
      configOverrides: {
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
        capabilities: { stream: { enabled: workerStreams } },
      },
      dataDirectory: workerDirectory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          knownModels: ["Pixel-A"],
          platform: "android",
          screenCapture: screen.capture,
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      statePath: join(workerDirectory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(worker);
    await vi.waitFor(
      async () => {
        const { workers } = await gateway.dispatch("worker.list", {}, admin);
        expect(workers[0]?.catalog?.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    const granted = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      agent,
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    const stream = (signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${String(port)}/v1/stream/leases/${encodeURIComponent(leaseId)}`, {
        headers: { authorization: `Bearer ${operator}` },
        ...(signal === undefined ? {} : { signal }),
      });
    return { gateway, leaseId, screen, stream };
  }

  it(
    "relays the worker's picture, and the lease ending on the gateway stops the capture on the worker",
    { timeout: 30_000 },
    async () => {
      const { gateway, leaseId, screen, stream } = await fleet(true);
      const response = await stream();
      expect(response.status).toBe(200);
      expect(response.headers.get("simlock-stream-codec")).toBe("h264");
      expect(response.headers.get("simlock-stream-width")).toBe("32");
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("no body");
      const first = await reader.read();
      expect(first.value?.[4]).toBe(SCREEN_FRAME_TAG.meta);

      await gateway.dispatch("lease.release", { leaseId }, agent);
      await vi.waitFor(() => expect(screen.closes()).toBe(1), { timeout: 10_000 });
      await vi.waitFor(
        async () => {
          const step = await reader.read().catch(() => ({ done: true }));
          expect(step.done).toBe(true);
        },
        { timeout: 10_000 },
      );
    },
  );

  it(
    "a viewer leaving the gateway stops the capture on the worker",
    { timeout: 30_000 },
    async () => {
      const { screen, stream } = await fleet(true);
      const viewer = new AbortController();
      const response = await stream(viewer.signal);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("no body");
      await reader.read();
      viewer.abort();
      await vi.waitFor(() => expect(screen.closes()).toBe(1), { timeout: 10_000 });
    },
  );

  it(
    "answers 503 STREAM_UNAVAILABLE naming the worker when that worker does not stream",
    { timeout: 30_000 },
    async () => {
      const { stream } = await fleet(false);
      const response = await stream();
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("STREAM_UNAVAILABLE");
      expect(body.error.message).toMatch(/^Worker /u);
    },
  );
});
