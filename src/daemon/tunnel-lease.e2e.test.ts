import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { encodeTunnelFrame, TUNNEL_TAG } from "../contract/index.js";
import {
  FakeDeviceTcp,
  FakeDriver,
  FakeInputFactory,
  fakeDeviceDataTables,
} from "../core/testing.js";
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

function inputMessage(tag: number, body: unknown): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);
}

function pattern(length: number, step: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * step) % 251;
  return bytes;
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
    // why: given, the input module is on at both ends and the worker's device input is this fake.
    readonly input?: FakeInputFactory;
    readonly clock?: FakeClock;
  }) {
    const port = await freeLoopbackPort();
    const input = { enabled: options.input !== undefined };
    const clock = options.clock === undefined ? {} : { clock: options.clock };
    const gateway = await startDaemon({
      ...clock,
      configOverrides: {
        capabilities: { input, tunnel: { enabled: options.gatewayTunnel } },
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
      ...clock,
      configOverrides: {
        capabilities: { input, tunnel: { enabled: options.workerTunnel } },
        gateway: { label: "w", token, url: `ws://127.0.0.1:${String(port)}` },
      },
      dataDirectory: await directory("worker"),
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          ...(options.input === undefined ? {} : { input: options.input }),
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
      inputUrl: `ws://127.0.0.1:${String(port)}/v1/leases/${leaseId}/input`,
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
      const device = through.deviceTcp.openFromDevice(5174);
      await vi.waitFor(() => expect(carried.messages).toHaveLength(2), { timeout: 10_000 });
      expect(carried.messages[1]?.[0]).toBe(0x02);
      device.send(new Uint8Array(65_536).fill(7));
      await vi.waitFor(() => expect(carried.messages).toHaveLength(3), { timeout: 10_000 });
      expect(carried.messages[2]?.length).toBe(65_541);
      expect(carried.messages[2]?.[0]).toBe(0x03);

      const largest = Buffer.concat([Buffer.from([0x03, 0, 0, 0, 1]), Buffer.alloc(65_536)]);
      expect(largest.length).toBe(65_541);
      carried.socket.send(largest);
      await vi.waitFor(() => expect(carried.messages).toHaveLength(4), { timeout: 10_000 });
      expect(carried.messages[3]?.[0]).toBe(0x04);
      expect(carried.closed).toBeUndefined();

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
    },
  );

  async function inputAdmitted(url: string, token: string): Promise<OpenedSocket> {
    const opened = await openTunnel(url, token);
    expect(opened.status).toBe(101);
    await vi.waitFor(() => expect(opened.messages.map((entry) => entry[0])).toEqual([0x83, 0x82]), {
      timeout: 10_000,
    });
    return opened;
  }

  async function tunnelReady(
    url: string,
    token: string,
    devicePort: number,
  ): Promise<OpenedSocket> {
    const opened = await openTunnel(url, token);
    expect(opened.status).toBe(101);
    opened.socket.send(hello(devicePort));
    await vi.waitFor(() => expect(opened.messages.map((entry) => entry[0])).toEqual([0x81]), {
      timeout: 10_000,
    });
    return opened;
  }

  it(
    "carries a holder's taps in order and 1 MiB each way through a reverse tunnel intact, on one lease through a gateway at once",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2400, orientation: "portrait", width: 1080 });
      const both = await fleet({ gatewayTunnel: true, input, workerTunnel: true });
      const tunnel = await tunnelReady(both.url(), both.holder, 5173);
      const taps = await inputAdmitted(both.inputUrl, both.holder);

      const device = both.deviceTcp.openFromDevice(5173);
      await vi.waitFor(() => expect(tunnel.messages[1]?.[0]).toBe(TUNNEL_TAG.open), {
        timeout: 10_000,
      });
      const conn = tunnel.messages[1]?.readUInt32BE(1) ?? 0;
      const fromDevice: Buffer[] = [];
      const granted = { bytes: 262_144 };
      tunnel.socket.on("message", (data: Buffer) => {
        if (data.readUInt32BE(1) !== conn) return;
        if (data[0] === TUNNEL_TAG.data) {
          fromDevice.push(data.subarray(5));
          const credit = Buffer.alloc(4);
          credit.writeUInt32BE(data.length - 5);
          tunnel.socket.send(encodeTunnelFrame(TUNNEL_TAG.credit, conn, credit));
        }
        if (data[0] === TUNNEL_TAG.credit) granted.bytes += data.readUInt32BE(5);
      });

      const chunk = 65_536;
      const toCaller = pattern(16 * chunk, 7);
      const toDevice = pattern(16 * chunk, 13);
      for (let at = 0; at < toCaller.length; at += chunk) {
        device.send(toCaller.subarray(at, at + chunk));
      }
      const sentTaps: unknown[] = [];
      for (let index = 0; index < 16; index += 1) {
        await vi.waitFor(() => expect(granted.bytes).toBeGreaterThanOrEqual(chunk), {
          timeout: 10_000,
        });
        granted.bytes -= chunk;
        const at = index * chunk;
        tunnel.socket.send(
          encodeTunnelFrame(TUNNEL_TAG.data, conn, toDevice.subarray(at, at + chunk)),
        );
        for (const touch of [
          { type: "begin", x: index / 16, y: 0.25 },
          { type: "end", x: index / 16, y: 0.75 },
        ]) {
          taps.socket.send(inputMessage(0x03, touch));
          sentTaps.push({ kind: "touch", ...touch });
        }
      }

      await vi.waitFor(() => expect(Buffer.concat(fromDevice).length).toBe(toCaller.length), {
        timeout: 20_000,
      });
      expect(Buffer.concat(fromDevice).equals(toCaller)).toBe(true);
      await vi.waitFor(() => expect(Buffer.concat(device.written).length).toBe(toDevice.length), {
        timeout: 20_000,
      });
      expect(Buffer.concat(device.written).equals(toDevice)).toBe(true);
      await vi.waitFor(() => expect(input.opened[0]?.sent).toHaveLength(32), { timeout: 10_000 });
      expect(input.opened[0]?.sent).toEqual(sentTaps);
      expect([tunnel.closed, taps.closed]).toEqual([undefined, undefined]);
    },
  );

  it(
    "closes a lease's input and tunnel sockets through a gateway 4001 with the worker's reason when it is released, its reverse rule gone when the release returns, and 1011 when the worker stops, with its rule and device input let go",
    { timeout: 60_000 },
    async () => {
      const endingInput = new FakeInputFactory({
        height: 2400,
        orientation: "portrait",
        width: 1080,
      });
      const ends = await fleet({ gatewayTunnel: true, input: endingInput, workerTunnel: true });
      const endingTunnel = await tunnelReady(ends.url(), ends.holder, 5173);
      const endingTaps = await inputAdmitted(ends.inputUrl, ends.holder);
      expect(ends.deviceTcp.reversed).toEqual([5173]);
      await ends.gateway.dispatch("lease.release", { leaseId: ends.leaseId }, ends.owner);
      expect(ends.deviceTcp.reversed).toEqual([]);
      for (const socket of [endingTunnel, endingTaps]) {
        await vi.waitFor(() => expect(socket.closed).toEqual({ code: 4001, reason: "explicit" }), {
          timeout: 10_000,
        });
      }

      const stoppingInput = new FakeInputFactory({
        height: 2400,
        orientation: "portrait",
        width: 1080,
      });
      const stopping = await fleet({
        gatewayTunnel: true,
        input: stoppingInput,
        workerTunnel: true,
      });
      const tunnel = await tunnelReady(stopping.url(), stopping.holder, 5173);
      const taps = await inputAdmitted(stopping.inputUrl, stopping.holder);
      expect(stoppingInput.opened[0]?.closes).toBe(0);
      const { workers } = await stopping.gateway.dispatch("worker.list", {}, admin);
      await stopping.worker.stop("test");
      expect(stopping.deviceTcp.reversed).toEqual([]);
      expect(stoppingInput.opened[0]?.closes).toBe(1);
      const gone = { code: 1011, reason: `Worker ${workers[0]?.id ?? ""} stopped answering` };
      for (const socket of [tunnel, taps]) {
        await vi.waitFor(() => expect(socket.closed).toEqual(gone), { timeout: 10_000 });
        expect(socket.socket.readyState).toBe(WebSocket.CLOSED);
      }
    },
  );

  it(
    "carries input through a gateway to a worker with tunnels off, and answers that worker's tunnel upgrade 503 TUNNEL_UNAVAILABLE",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2400, orientation: "portrait", width: 1080 });
      const workerOff = await fleet({ gatewayTunnel: true, input, workerTunnel: false });
      const taps = await inputAdmitted(workerOff.inputUrl, workerOff.holder);
      taps.socket.send(inputMessage(0x04, { button: "home" }));
      await vi.waitFor(
        () => expect(input.opened[0]?.sent).toEqual([{ button: "home", kind: "button" }]),
        { timeout: 10_000 },
      );
      const refused = await openTunnel(workerOff.url(), workerOff.holder);
      expect({ code: refused.code, status: refused.status }).toEqual({
        code: "TUNNEL_UNAVAILABLE",
        status: 503,
      });
    },
  );

  it(
    "keeps a quiet tunnel through a gateway open past the relay's 15 s silence bound, and a device connection still reaches the holder",
    { timeout: 60_000 },
    async () => {
      const clock = new FakeClock();
      const quiet = await fleet({ clock, gatewayTunnel: true, workerTunnel: true });
      const tunnel = await tunnelReady(quiet.url(), quiet.holder, 5173);
      for (let second = 0; second < 20; second += 1) {
        clock.advance(1_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(tunnel.closed).toBeUndefined();
      quiet.deviceTcp.openFromDevice(5173);
      await vi.waitFor(() => expect(tunnel.messages.at(-1)?.[0]).toBe(TUNNEL_TAG.open), {
        timeout: 10_000,
      });
      expect(tunnel.closed).toBeUndefined();
    },
  );

  it(
    "sweeps each platform's driver at start with its devices, a leased one marked leased, before any request is served",
    { timeout: 120_000 },
    async () => {
      const path = await mkdtemp(join(tmpdir(), "simlock-e2e-sweep-"));
      directories.push(path);
      const start = async (deviceTcp: FakeDeviceTcp): Promise<DaemonServer> =>
        await startDaemon({
          configOverrides: { http: { enabled: false } },
          dataDirectory: path,
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

      const empty = new FakeDeviceTcp();
      const first = await start(empty);
      expect(empty.sweeps).toEqual([[]]);
      const holder = await first.dispatch(
        "token.create",
        { label: "holder", role: "agent" },
        admin,
      );
      const session = { ...agent, principal: holder.token.id };
      await first.dispatch("lease.request", { model: "Pixel-A", platform: "android" }, session);
      await first.stop("test");

      const whileLeased = new FakeDeviceTcp();
      const second = await start(whileLeased);
      expect(whileLeased.sweeps).toHaveLength(1);
      expect(whileLeased.sweeps[0]).toEqual([
        { device: expect.objectContaining({ physical: false }), leased: true },
      ]);
      await second.stop("test");

      const idle = new FakeDeviceTcp();
      daemons.push(await start(idle));
      expect(idle.sweeps).toHaveLength(1);
      expect(idle.sweeps[0]).toEqual([
        { device: expect.objectContaining({ physical: false }), leased: false },
      ]);
    },
  );
});
