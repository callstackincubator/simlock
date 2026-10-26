import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createTestKey, keySetBody, type TestKey } from "../auth/testing.js";
import { FakeDriver, FakeInputFactory, fakeDeviceDataTables } from "../core/testing.js";
import { FakeClock, MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
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

const UNAVAILABLE_CONFIG = {
  height: 1,
  inputUnavailable: true,
  orientation: "portrait",
  width: 1,
};

function message(tag: number, body: unknown): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);
}

function tags(opened: OpenedSocket): number[] {
  return opened.messages.map((entry) => entry[0] ?? -1);
}

function config(opened: OpenedSocket, index: number): unknown {
  return JSON.parse(opened.messages[index]?.subarray(1).toString("utf8") ?? "");
}

interface OpenedSocket {
  // why: 101 for an upgrade that was accepted, else the status the refusal answered.
  readonly status: number;
  // why: the error code of a refusal's JSON body, when it has one.
  readonly code: string | undefined;
  readonly messages: Buffer[];
  readonly socket: WebSocket;
  // why: how the socket closed, once it has; read it again after waiting, it changes.
  readonly closed: { code: number; reason: string } | undefined;
}

async function openInput(
  url: string,
  token: string | undefined,
  options: { readonly autoPong?: boolean; readonly headers?: Record<string, string> } = {},
): Promise<OpenedSocket> {
  const socket = new WebSocket(url, {
    autoPong: options.autoPong ?? true,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  sockets.push(socket);
  const messages: Buffer[] = [];
  const opened: { closed: { code: number; reason: string } | undefined } = { closed: undefined };
  socket.on("message", (data) => messages.push(data as Buffer));
  socket.on("close", (code, reason) => {
    opened.closed = { code, reason: reason.toString("utf8") };
  });
  const outcome = await new Promise<{ status: number; code: string | undefined }>(
    (resolve, reject) => {
      socket.once("open", () => resolve({ code: undefined, status: 101 }));
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
          resolve({ code, status: response.statusCode ?? 0 });
        });
      });
      socket.once("error", reject);
    },
  );
  return {
    ...outcome,
    get closed() {
      return opened.closed;
    },
    messages,
    socket,
  };
}

const sockets: WebSocket[] = [];

describe("a lease's input socket", () => {
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

  async function directory(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `simlock-e2e-input-${name}-`));
    directories.push(path);
    return path;
  }

  function driver(input?: FakeInputFactory): FakeDriver {
    return new FakeDriver({
      ...(input === undefined ? {} : { input }),
      availableOsVersions: ["18.0"],
      clock: new SystemClock(),
      knownModels: ["Pixel-A"],
      platform: "android",
    });
  }

  async function tokens(daemon: DaemonServer) {
    const make = (label: string, role: "agent" | "operator") =>
      daemon.dispatch("token.create", { label, role }, admin);
    return {
      holder: await make("holder", "agent"),
      operator: await make("op", "operator"),
      other: await make("other", "agent"),
    };
  }

  async function lease(daemon: DaemonServer, principal: string): Promise<string> {
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal },
    );
    return (granted as { lease: { id: string } }).lease.id;
  }

  async function fleet(options: {
    readonly gatewayInput: boolean;
    readonly workerInput: boolean;
    readonly input?: FakeInputFactory;
  }) {
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: options.gatewayInput } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: await directory("gateway"),
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      role: "gateway",
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const token = (await gateway.dispatch("token.create", { label: "w", role: "worker" }, admin))
      .secret;
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { input: { enabled: options.workerInput } },
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: await directory("worker"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver(options.input)],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
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
    const { holder, operator, other } = await tokens(gateway);
    const leaseId = await lease(gateway, holder.token.id);
    await vi.waitFor(
      () => gateway.dispatch("lease.get", { leaseId }, { ...agent, principal: holder.token.id }),
      { timeout: 10_000 },
    );
    return {
      gateway,
      holder: holder.secret,
      worker,
      inputUrl: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      owner: { ...agent, principal: holder.token.id },
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
    };
  }

  async function keyServer(key: TestKey): Promise<string> {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(keySetBody(key));
    });
    keyServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/keys`;
  }

  async function standalone(
    options: { readonly clock?: FakeClock; readonly proxyAuth?: Record<string, unknown> } = {},
  ) {
    const { clock, proxyAuth } = options;
    const port = await freeLoopbackPort();
    const worker = await startDaemon({
      ...(clock === undefined ? {} : { clock }),
      configOverrides: {
        capabilities: { input: { enabled: true }, stream: { enabled: true } },
        http: {
          enabled: true,
          host: "127.0.0.1",
          port,
          ...(proxyAuth === undefined ? {} : { proxyAuth }),
        },
      },
      dataDirectory: await directory("standalone"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver()],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(worker);
    const { holder, operator, other } = await tokens(worker);
    const leaseId = await lease(worker, holder.token.id);
    return {
      daemon: worker,
      holder: holder.secret,
      inputUrl: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/input`,
    };
  }

  async function expectAdmitted(url: string, token: string): Promise<void> {
    const opened = await openInput(url, token);
    expect(opened.status).toBe(101);
    await vi.waitFor(() => expect(opened.messages).toHaveLength(2), { timeout: 10_000 });
    expect([...(opened.messages[0] ?? [])]).toEqual([0x83]);
    expect(opened.messages[1]?.[0]).toBe(0x82);
    expect(JSON.parse(opened.messages[1]?.subarray(1).toString("utf8") ?? "")).toEqual(
      UNAVAILABLE_CONFIG,
    );
  }

  async function expectRefused(
    url: string,
    token: string | undefined,
    refusal: { readonly status: number; readonly code: string | undefined },
  ): Promise<void> {
    const opened = await openInput(url, token);
    expect({ code: opened.code, status: opened.status }).toEqual(refusal);
    expect(opened.messages).toEqual([]);
  }

  it(
    "opens WS /v1/leases/{id}/input and gets 0x83 then 0x82, or a refused upgrade",
    { timeout: 60_000 },
    async () => {
      const through = await fleet({ gatewayInput: true, workerInput: true });
      await expectAdmitted(through.inputUrl(), through.holder);
      await expectAdmitted(through.inputUrl(), through.operator);
      const unknown = { code: "UNKNOWN_LEASE", status: 404 };
      await expectRefused(through.inputUrl(), through.other, unknown);
      await expectRefused(through.inputUrl("L-unknown"), through.holder, unknown);
      await expectRefused(through.inputUrl(), undefined, { code: "UNAUTHENTICATED", status: 401 });
      const plain = await fetch(through.plainUrl(), {
        headers: { authorization: `Bearer ${through.holder}` },
      });
      expect(plain.status).toBe(426);

      const direct = await standalone();
      await expectAdmitted(direct.inputUrl(), direct.holder);
      await expectAdmitted(direct.inputUrl(), direct.operator);
      await expectRefused(direct.inputUrl(), direct.other, unknown);
      await expectRefused(direct.inputUrl(), undefined, { code: "UNAUTHENTICATED", status: 401 });
      // why: the stream's lease route exists here, and only the input route takes a socket.
      await expectRefused(direct.inputUrl().replace(/input$/, "stream"), direct.holder, {
        code: undefined,
        status: 404,
      });

      const key = await createTestKey("ES256", "k1");
      const proxied = await standalone({
        proxyAuth: {
          audience: "aud",
          header: "cf-access-jwt-assertion",
          issuer: "https://team.example",
          jwksUrl: await keyServer(key),
        },
      });
      const jwt = await key.sign({
        aud: "aud",
        email: "alice@team.dev",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://team.example",
        sub: "7f3a",
      });
      const signedIn = { "cf-access-jwt-assertion": jwt };
      for (const site of [undefined, "cross-site", "same-site"]) {
        const refused = await openInput(proxied.inputUrl(), undefined, {
          headers: { ...signedIn, ...(site === undefined ? {} : { "sec-fetch-site": site }) },
        });
        expect({ code: refused.code, status: refused.status }).toEqual({
          code: "FORBIDDEN",
          status: 403,
        });
      }
      const sameOrigin = await openInput(proxied.inputUrl(), undefined, {
        headers: { ...signedIn, "sec-fetch-site": "same-origin" },
      });
      expect(sameOrigin.status).toBe(101);

      const gatewayOff = await fleet({ gatewayInput: false, workerInput: true });
      await expectRefused(gatewayOff.inputUrl(), gatewayOff.holder, {
        code: undefined,
        status: 404,
      });

      const workerOff = await fleet({ gatewayInput: true, workerInput: false });
      await expectRefused(workerOff.inputUrl(), workerOff.holder, {
        code: "INPUT_UNAVAILABLE",
        status: 503,
      });
    },
  );

  it(
    "drives a faked device through a gateway in T3 Code's order, and drops a message over 64 KiB",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { holder, inputUrl } = await fleet({ gatewayInput: true, workerInput: true, input });
      const first = await openInput(inputUrl(), holder);
      await vi.waitFor(() => expect(tags(first)).toEqual([0x83, 0x82]), { timeout: 10_000 });
      expect(config(first, 1)).toEqual({ height: 2556, orientation: "portrait", width: 1179 });

      const touches = [
        { type: "begin", x: 0.4, y: 0.7 },
        { type: "move", x: 0.5, y: 0.6 },
        { type: "end", x: 0.5, y: 0.6 },
      ] as const;
      for (const touch of touches) first.socket.send(message(0x03, touch));
      first.socket.send(message(0x06, { type: "down", usage: 4 }));
      first.socket.send(message(0x04, { button: "home" }));
      await vi.waitFor(() => expect(input.opened[0]?.sent).toHaveLength(5), { timeout: 10_000 });
      expect(input.opened[0]?.sent).toEqual([
        ...touches.map((touch) => ({ kind: "touch", ...touch })),
        { kind: "key", type: "down", usage: 4 },
        { button: "home", kind: "button" },
      ]);

      const second = await openInput(inputUrl(), holder);
      await vi.waitFor(() => expect(tags(second)).toEqual([0x83, 0x82]), { timeout: 10_000 });
      second.socket.send(message(0x04, { button: "back" }));
      await vi.waitFor(() => expect(input.opened[0]?.sent).toHaveLength(6), { timeout: 10_000 });
      expect(input.opened).toHaveLength(1);

      second.socket.send(message(0x03, { pad: "a".repeat(70_000), type: "end", x: 0.5, y: 0.5 }));
      second.socket.send(message(0x04, { button: "lock" }));
      await vi.waitFor(() => expect(input.opened[0]?.sent).toHaveLength(7), { timeout: 10_000 });
      expect(input.opened[0]?.sent.at(-1)).toEqual({ button: "lock", kind: "button" });

      input.opened[0]?.changeConfig({ height: 1179, orientation: "landscape_left", width: 2556 });
      for (const socket of [first, second]) {
        await vi.waitFor(() => expect(tags(socket).at(-1)).toBe(0x82), { timeout: 10_000 });
        await vi.waitFor(
          () =>
            expect(config(socket, socket.messages.length - 1)).toEqual({
              height: 1179,
              orientation: "landscape_left",
              width: 2556,
            }),
          { timeout: 10_000 },
        );
      }

      first.socket.close();
      await vi.waitFor(() => expect(second.socket.readyState).toBe(WebSocket.OPEN));
      expect(input.opened[0]?.closes).toBe(0);
      second.socket.close();
      await vi.waitFor(() => expect(input.opened[0]?.closes).toBe(1), { timeout: 10_000 });
    },
  );

  it(
    "closes with 4001 and the worker's reason through a gateway when the lease ends, and a reconnect gets 404",
    { timeout: 60_000 },
    async () => {
      const { gateway, holder, inputUrl, leaseId, owner } = await fleet({
        gatewayInput: true,
        workerInput: true,
      });
      const opened = await openInput(inputUrl(), holder);
      await vi.waitFor(() => expect(tags(opened)).toEqual([0x83, 0x82]), { timeout: 10_000 });

      await gateway.dispatch("lease.release", { leaseId }, owner);
      await vi.waitFor(() => expect(opened.closed).toEqual({ code: 4001, reason: "explicit" }), {
        timeout: 10_000,
      });
      await expectRefused(inputUrl(), holder, { code: "UNKNOWN_LEASE", status: 404 });
    },
  );

  it(
    "closes the socket when the client misses its pong, the worker stops, or the daemon stops",
    { timeout: 60_000 },
    async () => {
      const clock = new FakeClock();
      const direct = await standalone({ clock });
      const quiet = await openInput(direct.inputUrl(), direct.holder, { autoPong: false });
      const alive = await openInput(direct.inputUrl(), direct.holder);
      await vi.waitFor(() => expect(tags(alive)).toEqual([0x83, 0x82]), { timeout: 10_000 });
      let pings = 0;
      quiet.socket.on("ping", () => {
        pings += 1;
      });
      clock.advance(14_999);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pings).toBe(0);
      clock.advance(1);
      await vi.waitFor(() => expect(pings).toBe(1), { timeout: 10_000 });
      clock.advance(14_999);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(quiet.closed).toBeUndefined();
      clock.advance(1);
      await vi.waitFor(() => expect(quiet.closed?.code).toBe(1006), { timeout: 10_000 });
      expect(alive.closed).toBeUndefined();

      await direct.daemon.stop("test");
      await vi.waitFor(
        () => expect(alive.closed).toEqual({ code: 1001, reason: "Simlock is stopping" }),
        { timeout: 10_000 },
      );

      const through = await fleet({ gatewayInput: true, workerInput: true });
      const viaGateway = await openInput(through.inputUrl(), through.holder);
      await vi.waitFor(() => expect(tags(viaGateway)).toEqual([0x83, 0x82]), { timeout: 10_000 });
      const { workers } = await through.gateway.dispatch("worker.list", {}, admin);
      await through.worker.stop("test");
      await vi.waitFor(
        () =>
          expect(viaGateway.closed).toEqual({
            code: 1011,
            reason: `Worker ${workers[0]?.id ?? ""} stopped answering`,
          }),
        { timeout: 10_000 },
      );

      const second = await fleet({ gatewayInput: true, workerInput: true });
      const stopped = await openInput(second.inputUrl(), second.holder);
      await vi.waitFor(() => expect(tags(stopped)).toEqual([0x83, 0x82]), { timeout: 10_000 });
      await second.gateway.stop("test");
      await vi.waitFor(
        () => expect(stopped.closed).toEqual({ code: 1001, reason: "Simlock is stopping" }),
        { timeout: 10_000 },
      );
    },
  );
});
