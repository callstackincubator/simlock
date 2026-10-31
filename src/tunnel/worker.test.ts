import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import { DeviceTcpError } from "../core/index.js";
import { FakeDeviceTcp } from "../core/testing.js";
import type { WorkerModule } from "../modules/index.js";
import { fakeWorkerContext } from "../modules/testing.js";
import { MemoryLeaseSocket } from "../ports/index.js";
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
}> {
  const { ctx } = await fakeWorkerContext("tunnel", {});
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
      supports: (named) => named === "android",
      reverse: (_platform, device, port, signal) => deviceTcp.reverse(device, port, signal),
    },
    registry,
  });
  return { deviceTcp, worker };
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

    const device = deviceTcp.connect(5173);
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
        message: "forward tunnels are not available yet",
        tunnels: [reverse(5173), { devicePort: 9229, kind: "forward" }],
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
    const first = deviceTcp.connect(5173);
    const second = deviceTcp.connect(5173);
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
        deviceTcp.connect(5173);
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
    const closing = deviceTcp.connect(5173);
    const going = deviceTcp.connect(5173);
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
      readonly device: ReturnType<FakeDeviceTcp["connect"]>;
    }> {
      const { deviceTcp, worker } = await setup();
      const socket = await attach(worker);
      socket.receive(hello(tunnel));
      await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
      const device = deviceTcp.connect(5173);
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
  });
});
