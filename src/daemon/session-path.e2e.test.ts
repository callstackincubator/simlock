import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createTestKey, keySetBody, type TestKey } from "../auth/testing.js";
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
  const keyServers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      keyServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function keyServer(key: TestKey): Promise<string> {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(keySetBody(key));
    });
    keyServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/keys`;
  }

  async function farm(role: "worker" | "gateway", proxyAuth?: Record<string, unknown>) {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-session-"));
    directories.push(directory);
    const { port, started } = await startOnFreePort(async (port) =>
      startDaemon({
        configOverrides: {
          http: {
            enabled: true,
            host: "127.0.0.1",
            port,
            ...(proxyAuth === undefined ? {} : { proxyAuth }),
          },
        },
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        ...(role === "gateway"
          ? { role: "gateway" as const }
          : {
              drivers: [
                new FakeDriver({
                  availableOsVersions: ["18.0"],
                  clock: new SystemClock(),
                  knownModels: ["Pixel-A"],
                  platform: "android",
                }),
              ],
            }),
        filesystem: new MemoryFilesystem(),
        logger: new NoopLogger(),
        version: "1.0.0-e2e",
      }),
    );
    daemons.push(started);
    const make = (label: string, kind: "agent" | "operator" | "worker") =>
      started.dispatch("token.create", { label, role: kind }, admin);
    return {
      agent: await make("holder", "agent"),
      daemon: started,
      join: await make("joiner", "worker"),
      make,
      operator: await make("op", "operator"),
      port,
    };
  }

  const hello = { clientVersion: "e2e", protocolRange: PROTOCOL_VERSION_RANGE };

  it("opens a session on a worker and a gateway whose identity is the token's, or refuses the upgrade", async () => {
    const key = await createTestKey("ES256", "k1");
    const jwt = await key.sign({
      aud: "aud",
      email: "alice@team.dev",
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: "https://team.example",
      sub: "7f3a",
    });
    const signedIn = { "cf-access-jwt-assertion": jwt };
    const proxyAuth = {
      audience: "aud",
      header: "cf-access-jwt-assertion",
      issuer: "https://team.example",
      jwksUrl: await keyServer(key),
    };
    for (const role of ["worker", "gateway"] as const) {
      const { agent, daemon, join, make, operator, port } = await farm(role, proxyAuth);

      const opened = await openSession(port, agent.secret);
      expect(opened.status).toBe(101);
      const reply = await (opened.session as Session).request("hello", hello);
      expect(reply.payload).toMatchObject({ principal: agent.token.id, role: "agent" });
      const identity = await (opened.session as Session).request("identity.get");
      expect(identity.payload).toMatchObject({
        name: "holder",
        principal: agent.token.id,
        role: "agent",
        via: "token",
      });

      const asOperator = (await openSession(port, operator.secret)).session as Session;
      expect((await asOperator.request("hello", hello)).payload).toMatchObject({ role: "admin" });

      const revoked = await make("gone", "agent");
      await daemon.dispatch("token.revoke", { id: revoked.token.id }, admin);
      const refusals: [string, Awaited<ReturnType<typeof openSession>>][] = [
        ["no token", await openSession(port, undefined)],
        ["unknown token", await openSession(port, "slk_unknown")],
        ["revoked token", await openSession(port, revoked.secret)],
        ["join token", await openSession(port, join.secret)],
        [
          "cross-site proxy",
          await openSession(port, undefined, {
            headers: { ...signedIn, "sec-fetch-site": "cross-site" },
          }),
        ],
        ["other path", await openSession(port, agent.secret, { path: "/v1/session/x" })],
      ];
      expect(refusals.map(([name, result]) => [name, result.status, result.code])).toEqual([
        ["no token", 401, "UNAUTHENTICATED"],
        ["unknown token", 401, "UNAUTHENTICATED"],
        ["revoked token", 401, "UNAUTHENTICATED"],
        ["join token", 403, "FORBIDDEN"],
        ["cross-site proxy", 403, "FORBIDDEN"],
        ["other path", 404, undefined],
      ]);

      const proxied = await openSession(port, undefined, {
        headers: { ...signedIn, "sec-fetch-site": "same-origin" },
      });
      expect(proxied.status).toBe(101);
      const proxiedSession = proxied.session as Session;
      expect((await proxiedSession.request("hello", hello)).payload).toMatchObject({
        role: "admin",
      });
      expect((await proxiedSession.request("identity.get")).payload).toMatchObject({
        name: "alice@team.dev",
        via: "proxy",
      });
    }
  });
});
