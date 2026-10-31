import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { FakeDeviceTcp, FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
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

const sockets: WebSocket[] = [];

async function openTunnel(url: string, token: string | undefined): Promise<OpenedSocket> {
  const socket = new WebSocket(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  const messages: Buffer[] = [];
  socket.on("message", (data) => messages.push(data as Buffer));
  const state: { closed: { code: number; reason: string } | undefined } = { closed: undefined };
  socket.on("close", (code, reason) => {
    state.closed = { code, reason: reason.toString("utf8") };
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
      return state.closed;
    },
    messages,
    socket,
  };
}

function hello(devicePort: number): Buffer {
  const body = Buffer.from(JSON.stringify({ tunnels: [{ devicePort, kind: "reverse" }] }));
  return Buffer.concat([Buffer.from([0x01, 0, 0, 0, 0]), body]);
}

describe("a lease's tunnel socket", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function directory(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `simlock-e2e-tunnel-${name}-`));
    directories.push(path);
    return path;
  }

  async function standalone(enabled: boolean) {
    const port = await freeLoopbackPort();
    const path = await mkdtemp(join(tmpdir(), "simlock-e2e-tunnel-"));
    directories.push(path);
    const daemon = await startDaemon({
      configOverrides: {
        capabilities: { tunnel: { enabled } },
        http: { enabled: true, host: "127.0.0.1", port },
      },
      dataDirectory: path,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          deviceTcp: new FakeDeviceTcp(),
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    const make = (label: string, role: "agent" | "operator") =>
      daemon.dispatch("token.create", { label, role }, admin);
    const holder = await make("holder", "agent");
    const operator = await make("op", "operator");
    const other = await make("other", "agent");
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal: holder.token.id },
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    return {
      holder: holder.secret,
      leaseId,
      operator: operator.secret,
      other: other.secret,
      plainUrl: (id = leaseId) => `http://127.0.0.1:${String(port)}/v1/leases/${id}/tunnel`,
      url: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/tunnel`,
    };
  }

  async function fleet(options: {
    readonly gatewayTunnel: boolean;
    readonly workerTunnel: boolean;
  }) {
    const port = await freeLoopbackPort();
    const gateway = await startDaemon({
      configOverrides: {
        capabilities: { tunnel: { enabled: options.gatewayTunnel } },
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
    const deviceTcp = new FakeDeviceTcp();
    const worker = await startDaemon({
      configOverrides: {
        capabilities: { tunnel: { enabled: options.workerTunnel } },
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: await directory("worker"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          deviceTcp,
          knownModels: ["Pixel-A"],
          platform: "android",
        }),
      ],
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
    const holder = await gateway.dispatch(
      "token.create",
      { label: "holder", role: "agent" },
      admin,
    );
    const granted = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", platform: "android" },
      { ...agent, principal: holder.token.id },
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    await vi.waitFor(
      () => gateway.dispatch("lease.get", { leaseId }, { ...agent, principal: holder.token.id }),
      { timeout: 10_000 },
    );
    return {
      deviceTcp,
      gateway,
      holder: holder.secret,
      leaseId,
      owner: { ...agent, principal: holder.token.id },
      url: (id = leaseId) => `ws://127.0.0.1:${String(port)}/v1/leases/${id}/tunnel`,
      worker,
    };
  }

  async function expectReady(url: string, token: string, devicePort: number): Promise<void> {
    const opened = await openTunnel(url, token);
    expect(opened.status).toBe(101);
    opened.socket.send(hello(devicePort));
    await vi.waitFor(() => expect(opened.messages).toHaveLength(1), { timeout: 10_000 });
    expect(opened.messages[0]?.[0]).toBe(0x81);
    expect(JSON.parse(opened.messages[0]?.subarray(5).toString("utf8") ?? "")).toEqual({
      tunnels: [{ devicePort, kind: "reverse" }],
    });
  }

  it(
    "opens WS /v1/leases/{id}/tunnel on a lone worker for the holder and an operator, and refuses the rest",
    { timeout: 60_000 },
    async () => {
      const on = await standalone(true);
      await expectReady(on.url(), on.holder, 5173);
      await expectReady(on.url(), on.operator, 5174);
      const unknown = { code: "UNKNOWN_LEASE", status: 404 };
      for (const refused of [
        await openTunnel(on.url(), on.other),
        await openTunnel(on.url("L-unknown"), on.holder),
      ]) {
        expect({ code: refused.code, status: refused.status }).toEqual(unknown);
      }
      const plain = await fetch(on.plainUrl(), {
        headers: { authorization: `Bearer ${on.holder}` },
      });
      expect(plain.status).toBe(426);

      const off = await standalone(false);
      const disabled = await openTunnel(off.url(), off.holder);
      expect({ code: disabled.code, status: disabled.status }).toEqual({
        code: undefined,
        status: 404,
      });
    },
  );

  it(
    "opens the tunnel socket through a gateway and relays it to the lease's worker",
    { timeout: 60_000 },
    async () => {
      const through = await fleet({ gatewayTunnel: true, workerTunnel: true });
      await expectReady(through.url(), through.holder, 5173);

      const carried = await openTunnel(through.url(), through.holder);
      carried.socket.send(hello(5174));
      await vi.waitFor(() => expect(carried.messages).toHaveLength(1), { timeout: 10_000 });
      const device = through.deviceTcp.connect(5174);
      await vi.waitFor(() => expect(carried.messages).toHaveLength(2), { timeout: 10_000 });
      expect(carried.messages[1]?.[0]).toBe(0x02);
      device.send(new Uint8Array(65_536).fill(7));
      await vi.waitFor(() => expect(carried.messages).toHaveLength(3), { timeout: 10_000 });
      expect(carried.messages[2]?.length).toBe(65_541);
      expect(carried.messages[2]?.[0]).toBe(0x03);

      const tooBig = Buffer.concat([Buffer.from([0x03, 0, 0, 0, 1]), Buffer.alloc(65_537)]);
      expect(tooBig.length).toBe(65_542);
      carried.socket.send(tooBig);
      await vi.waitFor(() => expect(carried.closed?.code).toBe(4003), { timeout: 10_000 });
      const last = carried.messages.at(-1);
      expect(last?.[0]).toBe(0x82);
      expect(JSON.parse(last?.subarray(5).toString("utf8") ?? "")).toMatchObject({
        code: "BAD_REQUEST",
      });

      const refusedHello = await openTunnel(through.url(), through.holder);
      refusedHello.socket.send(hello(80));
      await vi.waitFor(() => expect(refusedHello.closed?.code).toBe(4003), { timeout: 10_000 });
      expect(refusedHello.messages.map((entry) => entry[0])).toEqual([0x82]);

      const ends = await fleet({ gatewayTunnel: true, workerTunnel: true });
      const ending = await openTunnel(ends.url(), ends.holder);
      ending.socket.send(hello(5173));
      await vi.waitFor(() => expect(ending.messages).toHaveLength(1), { timeout: 10_000 });
      await ends.gateway.dispatch("lease.release", { leaseId: ends.leaseId }, ends.owner);
      await vi.waitFor(() => expect(ending.closed).toEqual({ code: 4001, reason: "explicit" }), {
        timeout: 10_000,
      });

      const stopping = await fleet({ gatewayTunnel: true, workerTunnel: true });
      const viaWorker = await openTunnel(stopping.url(), stopping.holder);
      viaWorker.socket.send(hello(5173));
      await vi.waitFor(() => expect(viaWorker.messages).toHaveLength(1), { timeout: 10_000 });
      const { workers } = await stopping.gateway.dispatch("worker.list", {}, admin);
      await stopping.worker.stop("test");
      await vi.waitFor(
        () =>
          expect(viaWorker.closed).toEqual({
            code: 1011,
            reason: `Worker ${workers[0]?.id ?? ""} stopped answering`,
          }),
        { timeout: 10_000 },
      );

      const draining = await fleet({ gatewayTunnel: true, workerTunnel: true });
      const viaGateway = await openTunnel(draining.url(), draining.holder);
      viaGateway.socket.send(hello(5173));
      await vi.waitFor(() => expect(viaGateway.messages).toHaveLength(1), { timeout: 10_000 });
      await draining.gateway.stop("test");
      await vi.waitFor(
        () => expect(viaGateway.closed).toEqual({ code: 1001, reason: "Simlock is stopping" }),
        { timeout: 10_000 },
      );

      const workerOff = await fleet({ gatewayTunnel: true, workerTunnel: false });
      const refused = await openTunnel(workerOff.url(), workerOff.holder);
      expect({ code: refused.code, status: refused.status }).toEqual({
        code: "TUNNEL_UNAVAILABLE",
        status: 503,
      });
    },
  );
});
