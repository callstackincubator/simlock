import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import { startOnFreePort } from "../test-support/loopback-port.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

const admin: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
};

interface Frame {
  readonly id?: number;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly push?: string;
}

interface Session {
  readonly socket: WebSocket;
  readonly frames: Frame[];
  readonly closed: { code: number; reason: string } | undefined;
  request(type: string, payload?: unknown): Promise<Frame>;
}

// why: a session is opened by a plain `ws` client, as a remote program would; a refusal comes back as the HTTP answer and no socket.
async function openSession(
  port: number,
  token: string | undefined,
  options: { readonly headers?: Record<string, string>; readonly path?: string } = {},
): Promise<{ readonly status: number; readonly code?: string; readonly session?: Session }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${options.path ?? "/v1/session"}`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  sockets.push(socket);
  const frames: Frame[] = [];
  const state: { closed: { code: number; reason: string } | undefined } = { closed: undefined };
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  socket.on("close", (code, reason) => {
    state.closed = { code, reason: reason.toString("utf8") };
  });
  const outcome = await new Promise<{ status: number; code?: string }>((resolve, reject) => {
    socket.once("open", () => resolve({ status: 101 }));
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => {
        let code: string | undefined;
        try {
          code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
        } catch {
          code = undefined;
        }
        resolve({ status: response.statusCode ?? 0, ...(code === undefined ? {} : { code }) });
      });
    });
    socket.once("error", reject);
  });
  if (outcome.status !== 101) return outcome;
  let next = 0;
  const session: Session = {
    frames,
    get closed() {
      return state.closed;
    },
    request: async (type, payload) => {
      next += 1;
      const id = next;
      socket.send(JSON.stringify({ id, payload, type }));
      await vi.waitFor(() => expect(frames.some((frame) => frame.id === id)).toBe(true), {
        timeout: 10_000,
      });
      return frames.find((frame) => frame.id === id) as Frame;
    },
    socket,
  };
  return { ...outcome, session };
}

const sockets: WebSocket[] = [];

describe("the session path", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function worker() {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-session-"));
    directories.push(directory);
    const { port, started } = await startOnFreePort(async (port) =>
      startDaemon({
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["18.0"],
            clock: new SystemClock(),
            knownModels: ["Pixel-A"],
            platform: "android",
          }),
        ],
        filesystem: new MemoryFilesystem(),
        logger: new NoopLogger(),
        version: "1.0.0-e2e",
      }),
    );
    daemons.push(started);
    const agent = await started.dispatch("token.create", { label: "holder", role: "agent" }, admin);
    return { agent, daemon: started, port };
  }

  const hello = { clientVersion: "e2e", protocolRange: PROTOCOL_VERSION_RANGE };

  it("opens a session on a worker and a gateway whose identity is the token's, or refuses the upgrade", async () => {
    const { agent, port } = await worker();

    const opened = await openSession(port, agent.secret);
    expect(opened.status).toBe(101);
    const session = opened.session as Session;
    const reply = await session.request("hello", hello);
    expect(reply.payload).toMatchObject({ principal: agent.token.id, role: "agent" });
    const identity = await session.request("identity.get");
    expect(identity.payload).toMatchObject({
      name: "holder",
      principal: agent.token.id,
      role: "agent",
      via: "token",
    });
  });
});
