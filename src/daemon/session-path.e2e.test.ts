import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createTestKey, keySetBody, type TestKey } from "../auth/testing.js";
import { EXEC_STDIN_MAX_LENGTH, PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { FakeClock, NodeFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
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
  readonly pings: number;
  request(type: string, payload?: unknown): Promise<Frame>;
}

// why: a session is opened by a plain `ws` client, as a remote program would; a refusal comes back as the HTTP answer and no socket.
async function openSession(
  port: number,
  token: string | undefined,
  options: {
    readonly autoPong?: boolean;
    readonly headers?: Record<string, string>;
    readonly path?: string;
  } = {},
): Promise<{ readonly status: number; readonly code?: string; readonly session?: Session }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${options.path ?? "/v1/session"}`, {
    autoPong: options.autoPong ?? true,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  sockets.push(socket);
  const frames: Frame[] = [];
  const state: { closed: { code: number; reason: string } | undefined } = { closed: undefined };
  let pings = 0;
  socket.on("ping", () => {
    pings += 1;
  });
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
    get pings() {
      return pings;
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

// why: the daemon closes a socket whose pong is missing at the next ping tick, and a fake clock fires that tick at once. The client's ping, then a request answered on the same socket, show the pong reached the daemon first, with no sleep that a loaded runner can overrun.
async function tick(clock: FakeClock, ms: number, sessions: readonly Session[]): Promise<void> {
  const before = sessions.map((session) => session.pings);
  clock.advance(ms);
  await vi.waitFor(
    () => expect(sessions.map((session) => session.pings)).toEqual(before.map((n) => n + 1)),
    { timeout: 10_000 },
  );
  for (const session of sessions) await session.request("identity.get");
}

describe("the session path", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  const keyServers: Server[] = [];
  let pumped: FakeClock | undefined;

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
    // why: a stop waits on timers of the daemon's clock, which a fake one never fires by itself.
    const pump = setInterval(() => pumped?.advance(1_000), 10);
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    clearInterval(pump);
    pumped = undefined;
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

  async function farm(
    role: "worker" | "gateway",
    proxyAuth?: Record<string, unknown>,
    clock?: FakeClock,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-session-"));
    directories.push(directory);
    const driver = new FakeDriver({
      availableOsVersions: ["18.0"],
      clock: new SystemClock(),
      knownModels: ["Pixel-A", "Pixel-B", "Pixel-C"],
      // why: a real child process that reads its stdin and exits 0 only when all of it arrived.
      passthrough: () => ({
        args: [
          "-e",
          `let n = 0; process.stdin.on("data", (c) => { n += c.length; }).on("end", () => process.exit(n === ${String(EXEC_STDIN_MAX_LENGTH)} ? 0 : 3));`,
        ],
        command: process.execPath,
        env: {},
      }),
      passthroughTools: ["adb"],
      platform: "android",
    });
    const { port, started } = await startOnFreePort(async (port) =>
      startDaemon({
        ...(clock === undefined ? {} : { clock }),
        configOverrides: {
          // why: the default capacity derives from the host's CPUs, and a 4-CPU runner allows one Android device while this file holds two leases at once.
          capacity: { config: { maxRunning: 4 }, strategy: "fixed" },
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
              drivers: [driver],
            }),
        // why: the exec runs a real child process in the lease's folder, which has to exist.
        filesystem: new NodeFilesystem(),
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
      driver,
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

  it("answers a session's hello as on the socket but for identity: its principal is not used, a credential is refused, an old range keeps it open", async () => {
    for (const role of ["worker", "gateway"] as const) {
      const { agent, operator, port } = await farm(role);

      const named = (await openSession(port, agent.secret)).session as Session;
      const reply = await named.request("hello", { ...hello, principal: "someone-else" });
      expect(reply.payload).toMatchObject({ principal: agent.token.id, role: "agent" });

      const credential = (await openSession(port, agent.secret)).session as Session;
      const refused = await credential.request("hello", { ...hello, credential: "a-secret" });
      expect(refused.error).toEqual({
        code: "BAD_REQUEST",
        message: "A session's identity is its token: send no credential in hello",
      });
      await vi.waitFor(() => expect(credential.closed).toBeDefined());

      const old = (await openSession(port, operator.secret)).session as Session;
      const mismatch = await old.request("hello", {
        clientVersion: "e2e",
        protocolRange: { max: 2, min: 1 },
      });
      expect(mismatch.error?.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
      expect(old.closed).toBeUndefined();
      expect((await old.request("daemon.update", { query: true })).ok).toBe(true);

      const early = (await openSession(port, agent.secret)).session as Session;
      expect((await early.request("identity.get")).error?.code).toBe("HANDSHAKE_REQUIRED");
      await vi.waitFor(() => expect(early.closed).toBeDefined());
    }
  });

  it("closes every open session of a revoked token at once with 4003, and leaves other tokens' sessions and the token's lease", async () => {
    for (const role of ["worker", "gateway"] as const) {
      const { agent, daemon, make, port } = await farm(role);
      const other = await make("other", "agent");
      const sessions = await Promise.all(
        [agent, agent, other].map(async (token) => {
          const { session } = await openSession(port, token.secret);
          await (session as Session).request("hello", hello);
          return session as Session;
        }),
      );
      const [first, second, bystander] = sessions as [Session, Session, Session];
      if (role === "worker") {
        const granted = await first.request("lease.request", {
          model: "Pixel-A",
          platform: "android",
        });
        expect(granted.ok).toBe(true);
      }

      // why: a peer that never reads the close frame keeps its socket CLOSING for ws's 30 s timeout; it must not be served meanwhile.
      const silent = (await openSession(port, agent.secret)).session as Session;
      await silent.request("hello", hello);
      silent.socket.pause();

      await daemon.dispatch("token.revoke", { id: agent.token.id }, admin);
      silent.socket.send(
        JSON.stringify({
          id: 99,
          payload: { model: "Pixel-B", platform: "android", requesterId: "after-revoke" },
          type: "lease.request",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      for (const revoked of [first, second]) {
        await vi.waitFor(() =>
          expect(revoked.closed).toEqual({ code: 4003, reason: "token revoked" }),
        );
      }
      expect(bystander.closed).toBeUndefined();
      expect((await bystander.request("identity.get")).ok).toBe(true);
      expect((await openSession(port, agent.secret)).status).toBe(401);
      if (role === "worker") {
        const { leases } = await daemon.dispatch("lease.list", {}, admin);
        expect(leases.map((lease) => lease.ownerId)).toEqual([agent.token.id]);
      }
    }
  });

  it("holds a session's limits: a message over 32 MiB or a binary one closes it, a silent peer is closed, a proxy identity ends at its expiry", async () => {
    const clock = new FakeClock(Math.floor(Date.now() / 1000) * 1000);
    pumped = clock;
    const key = await createTestKey("ES256", "k1");
    const { agent, port } = await farm(
      "worker",
      {
        audience: "aud",
        header: "cf-access-jwt-assertion",
        issuer: "https://team.example",
        jwksUrl: await keyServer(key),
      },
      clock,
    );
    const live = async (options: Parameters<typeof openSession>[2] = {}, withToken = true) => {
      const { session } = await openSession(port, withToken ? agent.secret : undefined, options);
      await (session as Session).request("hello", hello);
      return session as Session;
    };

    const heavy = await live();
    const granted = await heavy.request("lease.request", { model: "Pixel-A", platform: "android" });
    const leaseId = (granted.payload as { lease: { id: string } }).lease.id;
    const exec = await heavy.request("device.exec", {
      args: [],
      leaseId,
      stdin: "x".repeat(EXEC_STDIN_MAX_LENGTH),
      tool: "adb",
    });
    expect(exec.payload).toMatchObject({ exitCode: 0 });

    const oversized = await live();
    oversized.socket.send(
      JSON.stringify({
        id: 99,
        payload: { pad: "x".repeat(33 * 1024 * 1024) },
        type: "identity.get",
      }),
    );
    await vi.waitFor(() => expect(oversized.closed?.code).toBe(1009), { timeout: 10_000 });
    expect(oversized.frames.some((frame) => frame.id === 99)).toBe(false);

    const binary = await live();
    binary.socket.send(Buffer.from(JSON.stringify({ id: 98, type: "identity.get" })));
    await vi.waitFor(() => expect(binary.closed?.code).toBe(1003), { timeout: 10_000 });
    expect(binary.frames.some((frame) => frame.id === 98)).toBe(false);

    const quiet = await live({ autoPong: false });
    const answering = await live();
    await tick(clock, 15_000, [answering]);
    clock.advance(14_999);
    expect(quiet.closed).toBeUndefined();
    clock.advance(1);
    await vi.waitFor(() => expect(quiet.closed?.code).toBe(1006), { timeout: 10_000 });
    expect(answering.closed).toBeUndefined();

    const jwt = await key.sign({
      aud: "aud",
      email: "alice@team.dev",
      exp: clock.now() / 1000 + 1,
      iss: "https://team.example",
      sub: "7f3a",
    });
    const proxied = await live(
      { headers: { "cf-access-jwt-assertion": jwt, "sec-fetch-site": "same-origin" } },
      false,
    );
    // why: the identity ends 61 s from now (its `exp` plus the proxy strategy's 60 s grace); each ping needs its pong in real time before the next fake tick.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 15_000) await tick(clock, 15_000, [proxied]);
    expect(proxied.closed).toBeUndefined();
    clock.advance(1_000);
    await vi.waitFor(
      () => expect(proxied.closed).toEqual({ code: 4001, reason: "identity expired" }),
      { timeout: 10_000 },
    );
  });

  it("carries calls and pushes over a session for the token's principal: progress, grant, attach, release, expiry, own-lease listing, events, and a close mid-request", async () => {
    const clock = new FakeClock(Math.floor(Date.now() / 1000) * 1000);
    pumped = clock;
    const { agent, driver, make, operator, port } = await farm("worker", undefined, clock);
    const other = await make("other", "agent");
    const live = async (secret: string) => {
      const { session } = await openSession(port, secret);
      await (session as Session).request("hello", hello);
      return session as Session;
    };
    const [first, second, stranger, watcher] = await Promise.all([
      live(agent.secret),
      live(agent.secret),
      live(other.secret),
      live(operator.secret),
    ]);
    const pushes = (session: Session, push: string) =>
      session.frames.filter((frame) => frame.push === push);
    const lease = (frame: Frame) =>
      (frame.payload as { lease: { id: string; ownerId: string } }).lease;
    const ask = { model: "Pixel-A", platform: "android" };
    expect((await watcher.request("events.subscribe")).ok).toBe(true);

    const granted = await first.request("lease.request", ask);
    expect(lease(granted).ownerId).toBe(agent.token.id);
    const grantedAt = first.frames.indexOf(granted);
    expect(pushes(first, "progress").length).toBeGreaterThan(0);
    expect(first.frames.findIndex((frame) => frame.push === "progress")).toBeLessThan(grantedAt);
    await vi.waitFor(() => expect(pushes(watcher, "event").length).toBeGreaterThan(0));

    const named = await stranger.request("lease.request", { ...ask, requesterId: "agent-7" });
    expect(lease(named).ownerId).toBe(other.token.id);
    const all = await watcher.request("lease.list");
    expect(
      (all.payload as { leases: { requesterId: string }[] }).leases
        .map((entry) => entry.requesterId)
        .sort(),
    ).toEqual(["agent-7", agent.token.id].sort());
    const own = await first.request("lease.list");
    expect((own.payload as { leases: { id: string }[] }).leases.map((entry) => entry.id)).toEqual([
      lease(granted).id,
    ]);

    await second.request("lease.release", { leaseId: lease(granted).id });
    await vi.waitFor(() => expect(pushes(first, "lease-lost")).toHaveLength(1));
    expect(pushes(second, "lease-lost")).toHaveLength(0);

    const expiring = await first.request("lease.request", { ...ask, ttlMs: 60_000 });
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 15_000) {
      await tick(clock, 15_000, [first, second, stranger, watcher]);
    }
    await vi.waitFor(() => expect(pushes(first, "lease-lost")).toHaveLength(2));
    expect(pushes(first, "lease-lost")[1]?.payload).toMatchObject({ leaseId: lease(expiring).id });

    driver.hangMakeReady();
    // why: a model no warm device matches, so the request waits on the held `makeReady`.
    const keyed = { ...ask, idempotencyKey: "same-request", model: "Pixel-B" };
    const progressBefore = pushes(first, "progress").length;
    let settled = false;
    const waiting = first.request("lease.request", keyed).finally(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(pushes(first, "progress").length).toBeGreaterThan(progressBefore),
    );
    let attachedSettled = false;
    const attached = second.request("lease.request", keyed).finally(() => {
      attachedSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([settled, attachedSettled]).toEqual([false, false]);
    driver.releaseMakeReady();
    expect(lease(await attached).id).toBe(lease(await waiting).id);
    const held = await watcher.request("lease.list");
    expect(
      (held.payload as { leases: { ownerId: string }[] }).leases.filter(
        (entry) => entry.ownerId === agent.token.id,
      ),
    ).toHaveLength(1);

    driver.hangMakeReady();
    const dropped = await live(other.secret);
    // why: a model no warm device matches, so the request waits on the held `makeReady`. The frame goes out raw: `request` would wait for a reply that never reaches a closed socket and reject unobserved ten seconds later.
    dropped.socket.send(
      JSON.stringify({
        id: 2,
        payload: { ...ask, model: "Pixel-C", requesterId: "agent-8" },
        type: "lease.request",
      }),
    );
    await vi.waitFor(() => expect(pushes(dropped, "progress").length).toBeGreaterThan(0));
    expect(dropped.frames.some((frame) => frame.id === 2)).toBe(false);
    dropped.socket.close();
    await vi.waitFor(() => expect(dropped.closed).toBeDefined());
    driver.releaseMakeReady();
    await vi.waitFor(async () => {
      const after = await watcher.request("lease.list");
      expect(
        (after.payload as { leases: { requesterId: string }[] }).leases.map(
          (entry) => entry.requesterId,
        ),
      ).toContain("agent-8");
    });
  });
});
