import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, LeaseRecord } from "../core/index.js";
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

function hello(...tunnels: { kind: string; devicePort: number }[]): Uint8Array {
  return frame(0x01, 0, JSON.stringify({ tunnels }));
}

async function setup(): Promise<{
  readonly worker: WorkerModule;
  readonly deviceTcp: FakeDeviceTcp;
}> {
  const { ctx } = await fakeWorkerContext("tunnel", {});
  const deviceTcp = new FakeDeviceTcp();
  const registry = {
    snapshot: {
      devices: [{ id: "dev_1", spec: { platform: "android" } } as unknown as DeviceRecord],
      leases: [{ deviceId: "dev_1", id: "L-1" } as unknown as LeaseRecord],
    },
  };
  const loaded = await tunnelModule.loadWorker();
  const worker = loaded.createWorker({
    ...ctx,
    deviceTcp: {
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
    ];
    for (const refused of cases) {
      const { deviceTcp, worker } = await setup();
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
});
