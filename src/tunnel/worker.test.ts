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

function oversizeData(conn: number): Uint8Array {
  const bytes = new Uint8Array(5 + 65_537);
  bytes[0] = 0x03;
  new DataView(bytes.buffer).setUint32(1, conn);
  return bytes;
}

function ending(reason: "device-lost" | "expired" | "explicit" | "killed") {
  return {
    deviceId: "dev_1",
    leaseId: "L-1",
    ownerId: "tok_holder",
    platform: "android",
    reason,
  } as const;
}

function hello(...tunnels: { kind: string; devicePort: number }[]): Uint8Array {
  return frame(0x01, 0, JSON.stringify({ tunnels }));
}

async function setup(
  platform = "android",
  physical = false,
): Promise<{
  readonly worker: WorkerModule;
  readonly deviceTcp: FakeDeviceTcp;
  readonly clock: FakeClock;
}> {
  const { clock, ctx } = await fakeWorkerContext("tunnel", {});
  const deviceTcp = new FakeDeviceTcp();
  const registry = {
    snapshot: {
      devices: [{ id: "dev_1", physical, spec: { platform } } as unknown as DeviceRecord],
      leases: [
        { deviceId: "dev_1", id: "L-1" } as unknown as LeaseRecord,
        { deviceId: "dev_1", id: "L-2" } as unknown as LeaseRecord,
      ],
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
  return { clock, deviceTcp, worker };
}

async function attach(worker: WorkerModule, leaseId = "L-1"): Promise<MemoryLeaseSocket> {
  const opened = await worker.socket?.open(new Request("http://simlock/tunnel"), IDENTITY, {
    deviceId: "dev_1",
    id: leaseId,
  });
  expect(opened).toBeTypeOf("function");
  const socket = new MemoryLeaseSocket();
  if (typeof opened === "function") opened(socket);
  return socket;
}

async function carriesOneTunnel(): Promise<void> {
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
}

async function halfClosesAndLimitsConnections(): Promise<void> {
  const { deviceTcp, worker } = await setup();
  const socket = await attach(worker);
  socket.receive(
    hello({ devicePort: 1024, kind: "reverse" }, { devicePort: 65535, kind: "reverse" }),
  );
  await vi.waitFor(() =>
    expect(frames(socket)).toEqual([
      {
        body: '{"tunnels":[{"kind":"reverse","devicePort":1024},{"kind":"reverse","devicePort":65535}]}',
        conn: 0,
        tag: 0x81,
      },
    ]),
  );
  const first = deviceTcp.connect(1024);
  const second = deviceTcp.connect(65535);
  await vi.waitFor(() =>
    expect(frames(socket).slice(1)).toEqual([
      { body: '{"kind":"reverse","devicePort":1024}', conn: 1, tag: 0x02 },
      { body: '{"kind":"reverse","devicePort":65535}', conn: 3, tag: 0x02 },
    ]),
  );

  first.end();
  await vi.waitFor(() => expect(frames(socket).at(-1)).toEqual({ body: "", conn: 1, tag: 0x05 }));
  expect(first.closed).toBe(false);
  socket.receive(frame(0x03, 1, "after the device's END"));
  await vi.waitFor(() => expect(first.writtenText()).toBe("after the device's END"));
  expect(first.writeEnded).toBe(false);
  socket.receive(frame(0x05, 1));
  await vi.waitFor(() => expect(first.writeEnded).toBe(true));
  await vi.waitFor(() => expect(first.closed).toBe(true));
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
  const peers = Array.from({ length: 255 }, () => deviceTcp.connect(1024));
  await vi.waitFor(() => expect(opens()).toBe(257));
  expect(peers.every((peer) => !peer.closed)).toBe(true);
  const past = deviceTcp.connect(1024);
  await vi.waitFor(() => expect(past.closed).toBe(true));
  expect(opens()).toBe(257);

  socket.receive(frame(0x06, 3, '{"reason":"done"}'));
  await vi.waitFor(() => expect(second.closed).toBe(true));
  const after = deviceTcp.connect(1024);
  await vi.waitFor(() => expect(opens()).toBe(258));
  expect(after.closed).toBe(false);
}

async function pausesOnlyTheConnectionWithoutCredit(): Promise<void> {
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
}

describe("a worker's tunnel socket", () => {
  it("opens the tunnel socket on a lone worker: answers HELLO with READY, announces device connections as OPEN, carries bytes both ways under credit, half-closes with END from each side, closes the 257th connection, pauses only the connection whose reader grants no credit, and refuses a lease that is gone", async () => {
    await carriesOneTunnel();
    await halfClosesAndLimitsConnections();
    await pausesOnlyTheConnectionWithoutCredit();

    const exact = await setup();
    const padded = `{"tunnels":[{"kind":"reverse","devicePort":5173}]}`.padEnd(4096, " ");
    expect(new TextEncoder().encode(padded)).toHaveLength(4096);
    const socket = await attach(exact.worker);
    socket.receive(frame(0x01, 0, padded));
    await vi.waitFor(() => expect(frames(socket).map((sent) => sent.tag)).toEqual([0x81]));
    expect(socket.closed).toBeUndefined();

    const gone = await exact.worker.socket?.open(new Request("http://simlock/tunnel"), IDENTITY, {
      deviceId: "dev_1",
      id: "L-gone",
    });
    expect(gone).toBeInstanceOf(Response);
    expect((gone as Response).status).toBe(404);
    expect(((await (gone as Response).json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
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
        message: "the lease already has 0 tunnels; at most 8",
        tunnels: Array.from({ length: 9 }, (_, index) => reverse(5000 + index)),
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "forward tunnels are not available yet",
        tunnels: [reverse(5173), { devicePort: 9229, kind: "forward" }],
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "the lease is on an iOS simulator; tunnels need an Android emulator or phone",
        platform: "ios",
        tunnels: [reverse(5173)],
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "the lease is on an iPhone; tunnels need an Android emulator or phone",
        physical: true,
        platform: "ios",
        tunnels: [reverse(5173)],
      },
      {
        code: "TUNNEL_PORT_IN_USE",
        failures: new Map([
          [
            5174,
            new DeviceTcpError(
              "TUNNEL_PORT_IN_USE",
              "reverse 5174: the device port is already reversed; remove that rule first",
            ),
          ],
        ]),
        message: "reverse 5174: the device port is already reversed; remove that rule first",
        tunnels: [reverse(5173), reverse(5174)],
      },
      {
        code: "TUNNEL_FAILED",
        failures: new Map([
          [5174, new DeviceTcpError("TUNNEL_FAILED", "reverse 5174: device offline")],
        ]),
        message: "reverse 5174: device offline",
        tunnels: [reverse(5173), reverse(5174)],
      },
      {
        code: "TUNNEL_FAILED",
        failures: new Map([[5174, new Error("adb exploded")]]),
        message: "reverse 5174: adb exploded",
        tunnels: [reverse(5173), reverse(5174)],
      },
      {
        code: "TUNNEL_FAILED",
        failures: new Map([
          [5174, new DeviceTcpError("TUNNEL_FAILED", `reverse 5174: ${"x".repeat(300)}`)],
        ]),
        message: `reverse 5174: ${"x".repeat(300)}`,
        reason: `reverse 5174: ${"x".repeat(109)}`,
        tunnels: [reverse(5173), reverse(5174)],
      },
    ];
    for (const refused of cases) {
      const { deviceTcp, worker } = await setup(refused.platform, refused.physical);
      for (const [port, failure] of refused.failures ?? []) deviceTcp.failures.set(port, failure);
      const socket = await attach(worker);
      socket.receive(hello(...refused.tunnels));
      await vi.waitFor(() =>
        expect(socket.closed).toEqual({ code: 4003, reason: refused.reason ?? refused.message }),
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
            message: "the lease already has 4 tunnels; at most 8",
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
        message: "HELLO tunnels must each be {kind, devicePort}",
        ready: false,
        send: (socket) => socket.receive(hello({ devicePort: 5173, kind: "bogus" })),
      },
      {
        message: "HELLO tunnels must each be {kind, devicePort}",
        ready: false,
        send: (socket) =>
          socket.receive(frame(0x01, 0, '{"tunnels":[{"kind":"reverse","devicePort":5173.5}]}')),
      },
      {
        message: "HELLO tunnels must each be {kind, devicePort}",
        ready: false,
        send: (socket) =>
          socket.receive(frame(0x01, 0, '{"tunnels":[{"kind":"reverse","devicePort":"5173"}]}')),
      },
      {
        message: "HELLO tunnels must each be {kind, devicePort}",
        ready: false,
        send: (socket) => socket.receive(frame(0x01, 0, '{"tunnels":[null]}')),
      },
      {
        message: "a frame is shorter than its 5-byte header",
        ready: false,
        send: (socket) => socket.receive(Uint8Array.of(0x01, 0, 0, 0)),
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
          for (let sent = 0; sent < 4; sent += 1) {
            socket.receive(bigData(1));
          }
          expect(socket.closed).toBeUndefined();
          socket.receive(bigData(1));
        },
      },
      {
        message: "CREDIT is 4 bytes",
        ready: true,
        send: (socket) => socket.receive(Uint8Array.of(0x04, 0, 0, 0, 1, 0, 0)),
      },
      {
        message: "CREDIT is 4 bytes",
        ready: true,
        send: (socket) => socket.receive(Uint8Array.of(0x04, 0, 0, 0, 1, 0, 0, 0, 1, 0)),
      },
      {
        message: "DATA is 1 to 65536 bytes",
        ready: true,
        send: (socket) => socket.receive(frame(0x03, 1)),
      },
      {
        message: "DATA is 1 to 65536 bytes",
        ready: true,
        send: (socket) => {
          socket.receive(bigData(1));
          expect(socket.closed).toBeUndefined();
          socket.receive(oversizeData(1));
        },
      },
      {
        message: "connection 99 was never opened",
        ready: true,
        send: (socket) => socket.receive(frame(0x03, 99, "x")),
      },
      {
        message: "connection 5 was never opened",
        ready: true,
        send: (socket) => socket.receive(frame(0x03, 5, "x")),
      },
      {
        message: "connection 2 was never opened",
        ready: true,
        send: (socket) => socket.receive(credit(2, 1)),
      },
      {
        message: "the window is above 2147483648",
        ready: true,
        send: (socket) => {
          socket.receive(credit(1, 2 ** 31 - 262_144));
          expect(socket.closed).toBeUndefined();
          socket.receive(credit(1, 1));
        },
      },
    ];
    for (const bad of cases) {
      const { deviceTcp, worker } = await setup();
      const socket = await attach(worker);
      if (bad.ready) {
        socket.receive(hello(tunnel));
        await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
        deviceTcp.connect(5173);
        deviceTcp.connect(5173);
        await vi.waitFor(() => expect(frames(socket)).toHaveLength(3));
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

    going.writeFailure = new Error("the device socket broke");
    socket.receive(frame(0x03, 3, "into a broken socket"));
    await vi.waitFor(() =>
      expect(frames(socket).at(-1)).toEqual({
        body: '{"reason":"the device connection failed"}',
        conn: 3,
        tag: 0x06,
      }),
    );
    expect(going.closed).toBe(true);
    expect(socket.closed).toBeUndefined();
  });

  it("removes the tunnel's rules and closes its connections when the socket closes, the lease ends or the daemon stops, and keeps going when a removal fails", async () => {
    const tunnel = { devicePort: 5173, kind: "reverse" };
    async function open(): Promise<{
      readonly clock: FakeClock;
      readonly deviceTcp: FakeDeviceTcp;
      readonly worker: WorkerModule;
      readonly socket: MemoryLeaseSocket;
      readonly device: ReturnType<FakeDeviceTcp["connect"]>;
    }> {
      const { clock, deviceTcp, worker } = await setup();
      const socket = await attach(worker);
      socket.receive(hello(tunnel));
      await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
      const device = deviceTcp.connect(5173);
      await vi.waitFor(() => expect(frames(socket)).toHaveLength(2));
      return { clock, device, deviceTcp, socket, worker };
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
    let releaseRemoval: () => void = () => undefined;
    ended.deviceTcp.closeGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let returned = false;
    const hook = ended.worker.hooks
      ?.beforeDeviceReclaim?.(ending("expired"), new AbortController().signal)
      .then(() => {
        returned = true;
      });
    await vi.waitFor(() => expect(ended.device.closed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ reversed: ended.deviceTcp.reversed, returned }).toEqual({
      reversed: [5173],
      returned: false,
    });
    releaseRemoval();
    await hook;
    expect(ended.deviceTcp.reversed).toEqual([]);
    expect(ended.device.closed).toBe(true);
    expect(ended.socket.closed).toEqual({ code: 4001, reason: "expired" });

    const pair = await open();
    const bystander = await attach(pair.worker, "L-2");
    bystander.receive(hello({ devicePort: 5180, kind: "reverse" }));
    await vi.waitFor(() => expect(frames(bystander)).toHaveLength(1));
    await pair.worker.hooks?.beforeDeviceReclaim?.(
      {
        deviceId: "dev_1",
        leaseId: "L-1",
        ownerId: "tok_holder",
        platform: "android",
        reason: "expired",
      },
      new AbortController().signal,
    );
    expect(pair.socket.closed).toEqual({ code: 4001, reason: "expired" });
    expect(bystander.closed).toBeUndefined();
    expect(pair.deviceTcp.reversed).toEqual([5180]);

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

    const twoRules = await setup();
    const both = await attach(twoRules.worker);
    both.receive(
      hello({ devicePort: 5173, kind: "reverse" }, { devicePort: 5174, kind: "reverse" }),
    );
    await vi.waitFor(() => expect(frames(both)).toHaveLength(1));
    let releaseFirst: () => void = () => undefined;
    twoRules.deviceTcp.closeGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const midway = new AbortController();
    const interrupted = twoRules.worker.hooks?.beforeDeviceReclaim?.(
      ending("expired"),
      midway.signal,
    );
    await vi.waitFor(() => expect(both.closed).toEqual({ code: 4001, reason: "expired" }));
    midway.abort();
    releaseFirst();
    await interrupted;
    expect(twoRules.deviceTcp.reversed).toEqual([5174]);

    const hung = await open();
    hung.deviceTcp.closeGate = new Promise<void>(() => undefined);
    let hungReturned = false;
    void hung.worker.hooks
      ?.beforeDeviceReclaim?.(ending("expired"), new AbortController().signal)
      .then(() => {
        hungReturned = true;
      });
    await vi.waitFor(() => expect(hung.device.closed).toBe(true));
    expect(hungReturned).toBe(false);
    hung.clock.advance(10_000);
    await vi.waitFor(() => expect(hungReturned).toBe(true));

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
    expect(reclaimed.deviceTcp.connect(5173).closed).toBe(true);

    const racing = await setup();
    let release: () => void = () => undefined;
    racing.deviceTcp.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const early = await attach(racing.worker);
    early.receive(hello(tunnel));
    early.drop();
    release();
    await vi.waitFor(() => expect(racing.deviceTcp.reverseLog).toEqual([5173]));
    await vi.waitFor(() => expect(racing.deviceTcp.reversed).toEqual([]));

    const abortedRace = await setup();
    let releaseReverse: () => void = () => undefined;
    abortedRace.deviceTcp.gate = new Promise<void>((resolve) => {
      releaseReverse = resolve;
    });
    const pending = await attach(abortedRace.worker);
    pending.receive(hello(tunnel));
    const stopping = new AbortController();
    stopping.abort();
    await abortedRace.worker.hooks?.beforeDeviceReclaim?.(ending("device-lost"), stopping.signal);
    releaseReverse();
    await vi.waitFor(() => expect(abortedRace.deviceTcp.reverseLog).toEqual([5173]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abortedRace.deviceTcp.reversed).toEqual([5173]);
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
