import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import { DeviceTcpError } from "../core/index.js";
import { FakeDeviceTcp } from "../core/testing.js";
import type { WorkerModule } from "../modules/index.js";
import { fakeWorkerContext } from "../modules/testing.js";
import { type FakeClock, MemoryLeaseSocket } from "../ports/index.js";
import { tunnelModule } from "./index.js";

const IDENTITY = { principal: "tok_holder", role: "agent" } as const;

function frame(tag: number, conn: number, body = ""): Uint8Array {
  const bytes = new TextEncoder().encode(body);
  const out = new Uint8Array(5 + bytes.length);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, conn);
  out.set(bytes, 5);
  return out;
}

function frames(socket: MemoryLeaseSocket): { tag: number; conn: number; body: string }[] {
  return socket.sent.map((sent) => ({
    body: new TextDecoder().decode(sent.subarray(5)),
    conn: new DataView(sent.buffer, sent.byteOffset).getUint32(1),
    tag: sent[0] ?? -1,
  }));
}

function sentData(socket: MemoryLeaseSocket, conn: number): number {
  return socket.sent
    .filter(
      (sent) =>
        sent[0] === 0x03 && new DataView(sent.buffer, sent.byteOffset).getUint32(1) === conn,
    )
    .reduce((total, sent) => total + sent.length - 5, 0);
}

function bigData(conn: number): Uint8Array {
  const bytes = new Uint8Array(5 + 65_536);
  bytes[0] = 0x03;
  new DataView(bytes.buffer).setUint32(1, conn);
  return bytes;
}

function hello(...tunnels: { kind: string; devicePort: number }[]): Uint8Array {
  return frame(0x01, 0, JSON.stringify({ tunnels }));
}

async function setup(platform = "android"): Promise<{
  readonly worker: WorkerModule;
  readonly deviceTcp: FakeDeviceTcp;
  readonly clock: FakeClock;
}> {
  const { clock, ctx } = await fakeWorkerContext("tunnel", {});
  const deviceTcp = new FakeDeviceTcp();
  const registry = {
    snapshot: {
      devices: [{ id: "dev_1", spec: { platform } } as unknown as DeviceRecord],
      leases: [{ deviceId: "dev_1", id: "L-1" } as unknown as LeaseRecord],
    },
  };
  const loaded = await tunnelModule.loadWorker();
  const worker = loaded.createWorker({
    ...ctx,
    deviceTcp: {
      connect: (_platform, device, port, signal) => deviceTcp.connect(device, port, signal),
      supports: (named) => named === "android",
      reverse: (_platform, device, port, signal) => deviceTcp.reverse(device, port, signal),
    },
    registry,
  });
  return { clock, deviceTcp, worker };
}

async function attach(worker: WorkerModule): Promise<MemoryLeaseSocket> {
  const opened = await worker.socket?.open(new Request("http://simlock/tunnel"), IDENTITY, {
    deviceId: "dev_1",
    id: "L-1",
  });
  expect(opened).toBeTypeOf("function");
  const socket = new MemoryLeaseSocket();
  if (typeof opened === "function") opened(socket);
  return socket;
}

describe("a worker's tunnel socket", () => {
  it("answers HELLO with READY, announces a device connection as OPEN and carries what the device writes as DATA", async () => {
    const { deviceTcp, worker } = await setup();
    const socket = await attach(worker);

    socket.receive(hello({ devicePort: 5173, kind: "reverse" }));
    await vi.waitFor(() =>
      expect(frames(socket)).toEqual([
        { body: '{"tunnels":[{"kind":"reverse","devicePort":5173}]}', conn: 0, tag: 0x81 },
      ]),
    );
    expect(deviceTcp.reversed).toEqual([5173]);

    const device = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({
        body: '{"kind":"reverse","devicePort":5173}',
        conn: 1,
        tag: 0x02,
      }),
    );
    device.send("from the device");
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({ body: "from the device", conn: 1, tag: 0x03 }),
    );
  });

  it("serves two tunnels, half-closes with END from each side, and closes a device connection past 256 open", async () => {
    const { deviceTcp, worker } = await setup();
    const socket = await attach(worker);
    socket.receive(
      hello({ devicePort: 5173, kind: "reverse" }, { devicePort: 5174, kind: "reverse" }),
    );
    await vi.waitFor(() =>
      expect(frames(socket)).toEqual([
        {
          body: '{"tunnels":[{"kind":"reverse","devicePort":5173},{"kind":"reverse","devicePort":5174}]}',
          conn: 0,
          tag: 0x81,
        },
      ]),
    );
    const first = deviceTcp.openFromDevice(5173);
    const second = deviceTcp.openFromDevice(5174);
    await vi.waitFor(() =>
      expect(frames(socket).slice(1)).toEqual([
        { body: '{"kind":"reverse","devicePort":5173}', conn: 1, tag: 0x02 },
        { body: '{"kind":"reverse","devicePort":5174}', conn: 3, tag: 0x02 },
      ]),
    );

    first.end();
    await vi.waitFor(() => expect(frames(socket).at(-1)).toEqual({ body: "", conn: 1, tag: 0x05 }));
    socket.receive(frame(0x03, 1, "after the device's END"));
    await vi.waitFor(() => expect(first.writtenText()).toBe("after the device's END"));
    expect(first.writeEnded).toBe(false);
    socket.receive(frame(0x05, 1));
    await vi.waitFor(() => expect(first.writeEnded).toBe(true));
    expect(second.writeEnded).toBe(false);
    second.send("the other tunnel is untouched");
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({
        body: "the other tunnel is untouched",
        conn: 3,
        tag: 0x03,
      }),
    );

    const opens = () => frames(socket).filter((sent) => sent.tag === 0x02).length;
    const peers = Array.from({ length: 255 }, () => deviceTcp.openFromDevice(5173));
    await vi.waitFor(() => expect(opens()).toBe(257));
    expect(peers.every((peer) => !peer.closed)).toBe(true);
    const past = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() => expect(past.closed).toBe(true));
    expect(opens()).toBe(257);

    socket.receive(frame(0x06, 3, '{"reason":"done"}'));
    await vi.waitFor(() => expect(second.closed).toBe(true));
    const after = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() => expect(opens()).toBe(258));
    expect(after.closed).toBe(false);
  });

  it("refuses a HELLO that cannot be met whole with REFUSED and close 4003, and leaves nothing it named set up", async () => {
    const reverse = (devicePort: number) => ({ devicePort, kind: "reverse" });
    const cases = [
      {
        code: "TUNNEL_BAD_PORT",
        message: "reverse 80: device ports are 1024 to 65535",
        tunnels: [reverse(5173), reverse(80)],
      },
      {
        code: "TUNNEL_BAD_PORT",
        message: "reverse 70000: device ports are 1024 to 65535",
        tunnels: [reverse(70_000)],
      },
      {
        code: "TUNNEL_LIMIT",
        message: "the lease already has 9 tunnels; at most 8",
        tunnels: Array.from({ length: 9 }, (_, index) => reverse(5000 + index)),
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "ios devices take no tunnel",
        platform: "ios",
        tunnels: [{ devicePort: 9229, kind: "forward" }],
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "ios devices take no tunnel",
        platform: "ios",
        tunnels: [reverse(5173)],
      },
      {
        code: "TUNNEL_PORT_IN_USE",
        failures: new Map([
          [5174, new DeviceTcpError("TUNNEL_PORT_IN_USE", "port 5174 is reversed")],
        ]),
        message: "port 5174 is reversed",
        tunnels: [reverse(5173), reverse(5174)],
      },
      {
        code: "TUNNEL_FAILED",
        failures: new Map([[5174, new DeviceTcpError("TUNNEL_FAILED", "device offline")]]),
        message: "device offline",
        tunnels: [reverse(5173), reverse(5174)],
      },
      {
        code: "TUNNEL_FAILED",
        failures: new Map([[5174, new Error("adb exploded")]]),
        message: "adb exploded",
        tunnels: [reverse(5173), reverse(5174)],
      },
    ];
    for (const refused of cases) {
      const { deviceTcp, worker } = await setup(refused.platform);
      for (const [port, failure] of refused.failures ?? []) deviceTcp.failures.set(port, failure);
      const socket = await attach(worker);
      socket.receive(hello(...refused.tunnels));
      await vi.waitFor(() =>
        expect(socket.closed).toEqual({ code: 4003, reason: refused.message }),
      );
      expect(frames(socket)).toEqual([
        {
          body: JSON.stringify({ code: refused.code, message: refused.message }),
          conn: 0,
          tag: 0x82,
        },
      ]);
      expect(deviceTcp.reversed).toEqual([]);
    }

    const { deviceTcp, worker } = await setup();
    const first = await attach(worker);
    first.receive(hello(...[5001, 5002, 5003, 5004].map(reverse)));
    await vi.waitFor(() => expect(frames(first).map((sent) => sent.tag)).toEqual([0x81]));
    const second = await attach(worker);
    second.receive(hello(...[5005, 5006, 5007, 5008, 5009].map(reverse)));
    await vi.waitFor(() =>
      expect(frames(second)).toEqual([
        {
          body: JSON.stringify({
            code: "TUNNEL_LIMIT",
            message: "the lease already has 9 tunnels; at most 8",
          }),
          conn: 0,
          tag: 0x82,
        },
      ]),
    );
    expect(second.closed?.code).toBe(4003);
    expect(first.closed).toBeUndefined();
    expect(deviceTcp.reversed).toEqual([5001, 5002, 5003, 5004]);
  });

  it("carries bytes both ways under a 262144-byte window per direction, and a reader that grants no credit pauses only its own connection", async () => {
    const { deviceTcp, worker } = await setup();
    const socket = await attach(worker);
    socket.receive(hello({ devicePort: 5173, kind: "reverse" }));
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
    const first = deviceTcp.openFromDevice(5173);
    const second = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() =>
      expect(frames(socket).map((sent) => sent.tag)).toEqual([0x81, 0x02, 0x02]),
    );

    socket.receive(frame(0x03, 1, "to the device"));
    await vi.waitFor(() => expect(first.writtenText()).toBe("to the device"));
    await vi.waitFor(() =>
      expect(socket.sent.at(-1)).toEqual(Uint8Array.from([0x04, 0, 0, 0, 1, 0, 0, 0, 13])),
    );

    first.send(new Uint8Array(300_000));
    await vi.waitFor(() => expect(sentData(socket, 1)).toBe(262_144));
    second.send("still flowing");
    await vi.waitFor(() => expect(sentData(socket, 3)).toBe(13));
    expect(sentData(socket, 1)).toBe(262_144);

    socket.receive(Uint8Array.from([0x04, 0, 0, 0, 1, 0, 0x01, 0x86, 0xa0]));
    await vi.waitFor(() => expect(sentData(socket, 1)).toBe(300_000));
    expect(frames(socket).every((sent) => sent.tag !== 0x03 || sent.body.length <= 65_536)).toBe(
      true,
    );
  });

  it("refuses a bad frame with BAD_REQUEST and close 4003, while a frame for an already closed connection is ignored and other connections go on", async () => {
    const tunnel = { devicePort: 5173, kind: "reverse" };
    const credit = (conn: number, granted: number): Uint8Array => {
      const bytes = new Uint8Array(9);
      bytes[0] = 0x04;
      const view = new DataView(bytes.buffer);
      view.setUint32(1, conn);
      view.setUint32(5, granted);
      return bytes;
    };
    const cases: {
      readonly message: string;
      readonly ready: boolean;
      readonly send: (socket: MemoryLeaseSocket) => void;
    }[] = [
      {
        message: "a frame came before HELLO",
        ready: false,
        send: (socket) => socket.receive(frame(0x03, 1, "early")),
      },
      {
        message: "HELLO is not valid JSON",
        ready: false,
        send: (socket) => socket.receive(frame(0x01, 0, "{not json")),
      },
      {
        message: "HELLO must name 1 to 8 tunnels",
        ready: false,
        send: (socket) => socket.receive(frame(0x01, 0, '{"tunnels":[]}')),
      },
      {
        message: "HELLO must name 1 to 8 tunnels",
        ready: false,
        send: (socket) => socket.receive(frame(0x01, 0, '{"tunnels":"all"}')),
      },
      {
        message: "HELLO is longer than 4096 bytes",
        ready: false,
        send: (socket) => socket.receive(frame(0x01, 0, ` ${" ".repeat(4096)}{"tunnels":[]}`)),
      },
      {
        message: "HELLO came twice",
        ready: true,
        send: (socket) => socket.receive(hello(tunnel)),
      },
      {
        message: "unknown frame tag 127",
        ready: true,
        send: (socket) => socket.receive(frame(0x7f, 1)),
      },
      {
        message: "DATA is past the granted window",
        ready: true,
        send: (socket) => {
          for (let sent = 0; sent < 5; sent += 1) {
            socket.receive(bigData(1));
          }
        },
      },
      {
        message: "connection 99 was never opened",
        ready: true,
        send: (socket) => socket.receive(frame(0x03, 99, "x")),
      },
      {
        message: "connection 2 was never opened",
        ready: true,
        send: (socket) => socket.receive(credit(2, 1)),
      },
      {
        message: "the window is above 2147483648",
        ready: true,
        send: (socket) => socket.receive(credit(1, 2 ** 31)),
      },
    ];
    for (const bad of cases) {
      const { deviceTcp, worker } = await setup();
      const socket = await attach(worker);
      if (bad.ready) {
        socket.receive(hello(tunnel));
        await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
        deviceTcp.openFromDevice(5173);
        await vi.waitFor(() => expect(frames(socket)).toHaveLength(2));
      }
      expect(socket.closed).toBeUndefined();
      bad.send(socket);
      await vi.waitFor(() => expect(socket.closed).toEqual({ code: 4003, reason: bad.message }));
      expect(frames(socket).at(-1)).toEqual({
        body: JSON.stringify({ code: "BAD_REQUEST", message: bad.message }),
        conn: 0,
        tag: 0x82,
      });
    }

    const { deviceTcp, worker } = await setup();
    const socket = await attach(worker);
    socket.receive(hello(tunnel));
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
    const closing = deviceTcp.openFromDevice(5173);
    const going = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(3));
    socket.receive(frame(0x06, 1, '{"reason":"caller closed"}'));
    await vi.waitFor(() => expect(closing.closed).toBe(true));
    socket.receive(credit(1, 10));
    socket.receive(frame(0x03, 1, "late"));
    going.send("still here");
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({ body: "still here", conn: 3, tag: 0x03 }),
    );
    expect(socket.closed).toBeUndefined();
  });

  it("removes the tunnel's rules and closes its connections when the socket closes, the lease ends or the daemon stops, and keeps going when a removal fails", async () => {
    const tunnel = { devicePort: 5173, kind: "reverse" };
    async function open(): Promise<{
      readonly deviceTcp: FakeDeviceTcp;
      readonly worker: WorkerModule;
      readonly socket: MemoryLeaseSocket;
      readonly device: ReturnType<FakeDeviceTcp["openFromDevice"]>;
    }> {
      const { deviceTcp, worker } = await setup();
      const socket = await attach(worker);
      socket.receive(hello(tunnel));
      await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
      const device = deviceTcp.openFromDevice(5173);
      await vi.waitFor(() => expect(frames(socket)).toHaveLength(2));
      return { device, deviceTcp, socket, worker };
    }

    const client = await open();
    client.socket.drop();
    await vi.waitFor(() => expect(client.deviceTcp.reversed).toEqual([]));
    expect(client.device.closed).toBe(true);
    const again = await attach(client.worker);
    again.receive(
      hello(
        ...Array.from({ length: 8 }, (_, index) => ({ devicePort: 6000 + index, kind: "reverse" })),
      ),
    );
    await vi.waitFor(() => expect(frames(again).map((sent) => sent.tag)).toEqual([0x81]));

    const ended = await open();
    await ended.worker.hooks?.beforeDeviceReclaim?.(
      {
        deviceId: "dev_1",
        leaseId: "L-1",
        ownerId: "tok_holder",
        platform: "android",
        reason: "expired",
      },
      new AbortController().signal,
    );
    expect(ended.deviceTcp.reversed).toEqual([]);
    expect(ended.device.closed).toBe(true);
    expect(ended.socket.closed).toEqual({ code: 4001, reason: "expired" });

    const stopped = await open();
    await stopped.worker.hooks?.beforeDrain?.();
    expect(stopped.deviceTcp.reversed).toEqual([]);
    expect(stopped.device.closed).toBe(true);
    expect(stopped.socket.closed).toEqual({ code: 1001, reason: "Simlock is stopping" });

    const failing = await open();
    failing.deviceTcp.closeFailure = new Error("adb did not answer");
    await failing.worker.hooks?.beforeDeviceReclaim?.(
      {
        deviceId: "dev_1",
        leaseId: "L-1",
        ownerId: "tok_holder",
        platform: "android",
        reason: "killed",
      },
      new AbortController().signal,
    );
    expect(failing.socket.closed).toEqual({ code: 4001, reason: "killed" });
    expect(failing.device.closed).toBe(true);

    const reclaimed = await open();
    const aborted = new AbortController();
    aborted.abort();
    await reclaimed.worker.hooks?.beforeDeviceReclaim?.(
      {
        deviceId: "dev_1",
        leaseId: "L-1",
        ownerId: "tok_holder",
        platform: "android",
        reason: "device-lost",
      },
      aborted.signal,
    );
    expect(reclaimed.socket.closed).toEqual({ code: 4001, reason: "device-lost" });
    expect(reclaimed.deviceTcp.reversed).toEqual([5173]);

    const racing = await setup();
    let release: () => void = () => undefined;
    racing.deviceTcp.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const early = await attach(racing.worker);
    early.receive(hello(tunnel));
    early.drop();
    release();
    await vi.waitFor(() => expect(racing.deviceTcp.reversed).toEqual([]));
  });

  it("keeps an idle relay alive with a heartbeat every 5 s and closes it with an 0xF1 {code, reason}", async () => {
    const { clock, worker } = await setup();
    const toGateway = new TransformStream<Uint8Array, Uint8Array>();
    const fromGateway = new TransformStream<Uint8Array, Uint8Array>();
    const written: number[] = [];
    void toGateway.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          written.push(...chunk);
        },
      }),
    );
    const idleTimers = clock.pendingTimerCount;
    const answer = await worker.relayTwoWay?.(new Request("http://simlock/tunnel"), "gw:t", "L-1", {
      readable: fromGateway.readable,
      signal: new AbortController().signal,
      writable: toGateway.writable,
    });
    expect(answer?.status).toBe(200);
    const heartbeat = [0, 0, 0, 1, 0xf0];
    const heartbeats = (): number => {
      let count = 0;
      for (let at = 0; at + 5 <= written.length; at += 1) {
        if (heartbeat.every((byte, offset) => written[at + offset] === byte)) count += 1;
      }
      return count;
    };

    clock.advance(4_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heartbeats()).toBe(0);
    clock.advance(1);
    await vi.waitFor(() => expect(heartbeats()).toBe(1));
    clock.advance(5_000);
    await vi.waitFor(() => expect(heartbeats()).toBe(2));

    await worker.hooks?.beforeDeviceReclaim?.(
      { leaseId: "L-1", reason: "explicit" } as never,
      new AbortController().signal,
    );
    const json = new TextEncoder().encode(JSON.stringify({ code: 4001, reason: "explicit" }));
    await vi.waitFor(() =>
      expect(written.slice(-(json.length + 5))).toEqual([
        0,
        0,
        (json.length + 1) >> 8,
        (json.length + 1) & 0xff,
        0xf1,
        ...json,
      ]),
    );
    expect(clock.pendingTimerCount).toBe(idleTimers);
    clock.advance(20_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heartbeats()).toBe(2);
    expect(clock.pendingTimerCount).toBe(idleTimers);
  });
});

describe("a worker's tunnel socket with forward tunnels", () => {
  const tunnels = [
    { devicePort: 9229, kind: "forward" },
    { devicePort: 5173, kind: "reverse" },
  ];
  const open = (conn: number, devicePort: number, kind = "forward"): Uint8Array =>
    frame(0x02, conn, JSON.stringify({ devicePort, kind }));

  async function ready() {
    const { deviceTcp, worker } = await setup();
    deviceTcp.listening.add(9229);
    const socket = await attach(worker);
    socket.receive(hello(...tunnels));
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
    expect(deviceTcp.reversed).toEqual([5173]);
    return { deviceTcp, socket, worker };
  }

  it("refuses a caller OPEN that is not an even rising id for a forward tunnel of the socket with BAD_REQUEST and close 4003, and counts caller and device connections together toward 256", async () => {
    const accepted = await ready();
    accepted.socket.receive(open(2, 9229));
    await vi.waitFor(() => expect(accepted.deviceTcp.connections).toHaveLength(1));
    expect(accepted.socket.closed).toBeUndefined();

    const cases = [
      { frames: [open(2, 9230)], message: "OPEN must name a forward tunnel of this socket" },
      { frames: [open(2, 5173)], message: "OPEN must name a forward tunnel of this socket" },
      {
        frames: [open(2, 9229, "reverse")],
        message: "OPEN must name a forward tunnel of this socket",
      },
      { frames: [open(1, 9229)], message: "OPEN needs an even connection id above the last" },
      {
        frames: [open(2, 9229), open(2, 9229)],
        message: "OPEN needs an even connection id above the last",
      },
      {
        frames: [open(4, 9229), open(2, 9229)],
        message: "OPEN needs an even connection id above the last",
      },
      {
        frames: [frame(0x02, 2, "{nope")],
        message: "OPEN must name a forward tunnel of this socket",
      },
    ];
    for (const bad of cases) {
      const { socket } = await ready();
      for (const sent of bad.frames) socket.receive(sent);
      await vi.waitFor(() => expect(socket.closed).toEqual({ code: 4003, reason: bad.message }));
      expect(frames(socket).at(-1)).toEqual({
        body: JSON.stringify({ code: "BAD_REQUEST", message: bad.message }),
        conn: 0,
        tag: 0x82,
      });
    }

    const { deviceTcp, socket } = await ready();
    for (let conn = 2; conn <= 512; conn += 2) {
      if (conn <= 256) deviceTcp.openFromDevice(5173);
      else socket.receive(open(conn, 9229));
    }
    await vi.waitFor(() => expect(deviceTcp.connections).toHaveLength(128));
    socket.receive(open(514, 9229));
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({
        body: '{"reason":"256 connections are open"}',
        conn: 514,
        tag: 0x06,
      }),
    );
    expect(deviceTcp.connections).toHaveLength(128);
    const past = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() => expect(past.closed).toBe(true));
    expect(socket.closed).toBeUndefined();
  });
});
