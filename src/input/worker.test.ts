import { describe, expect, it, vi } from "vitest";

import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import { FakeInputFactory } from "../core/testing.js";
import type { WorkerModule } from "../modules/index.js";
import { fakeWorkerContext } from "../modules/testing.js";
import { type FakeClock, MemoryLeaseSocket } from "../ports/index.js";
import { inputModule } from "./index.js";

const IDENTITY = { principal: "tok_holder", role: "agent" } as const;
const SCREEN = { height: 2556, orientation: "portrait", width: 1179 } as const;

function message(tag: number, body: unknown): Uint8Array {
  return Uint8Array.from([tag, ...new TextEncoder().encode(JSON.stringify(body))]);
}

async function setup(): Promise<{
  readonly worker: WorkerModule;
  readonly factory: FakeInputFactory;
  readonly clock: FakeClock;
}> {
  const { clock, ctx } = await fakeWorkerContext("input", {});
  const factory = new FakeInputFactory(SCREEN);
  const registry = {
    snapshot: {
      devices: [{ id: "dev_1", spec: { platform: "android" } } as unknown as DeviceRecord],
      leases: [{ deviceId: "dev_1", id: "L-1" } as unknown as LeaseRecord],
    },
  };
  const loaded = await inputModule.loadWorker();
  const worker = loaded.createWorker({
    ...ctx,
    inputs: { openInput: () => factory.open() },
    registry,
  });
  return { clock, factory, worker };
}

async function attach(worker: WorkerModule): Promise<MemoryLeaseSocket> {
  const opened = await worker.socket?.open(new Request("http://simlock/input"), IDENTITY, {
    deviceId: "dev_1",
    id: "L-1",
  });
  if (typeof opened !== "function") throw new Error("the socket was refused");
  const socket = new MemoryLeaseSocket();
  opened(socket);
  return socket;
}

async function admitted(worker: WorkerModule): Promise<MemoryLeaseSocket> {
  const socket = await attach(worker);
  await vi.waitFor(() => expect(socket.sent.map((sent) => sent[0])).toEqual([0x83, 0x82]));
  return socket;
}

const REFUSED = { code: 1013, reason: "Input is unavailable for this lease" };

describe("a worker's input socket", () => {
  it("keeps the socket and sends nothing to the device when a client sends a bad message", async () => {
    const { factory, worker } = await setup();
    const socket = await admitted(worker);
    const device = factory.opened[0];

    const valid = [
      message(0x03, { type: "begin", x: 0, y: 1 }),
      message(0x04, { button: "back" }),
      message(0x06, { type: "down", usage: 4 }),
      message(0x0b, { dx: 0, dy: -0.25, x: 0.5, y: 0.5 }),
    ];
    for (const accepted of valid) socket.receive(accepted);
    expect(device?.sent).toEqual([
      { kind: "touch", type: "begin", x: 0, y: 1 },
      { button: "back", kind: "button" },
      { kind: "key", type: "down", usage: 4 },
      { dx: 0, dy: -0.25, kind: "scroll", x: 0.5, y: 0.5 },
    ]);

    const dropped = [
      Uint8Array.from([0x03, ...new TextEncoder().encode("{not json")]),
      Uint8Array.from([0x55, ...new TextEncoder().encode("{}")]),
      message(0x07, { orientation: "landscape_left" }),
      message(0x03, { type: "begin", x: 1.5, y: 0.5 }),
      message(0x03, { type: "begin", x: 0.5, y: -0.1 }),
      message(0x03, { type: "begin", x: "0.5", y: 0.5 }),
      message(0x03, { type: "wiggle", x: 0.5, y: 0.5 }),
      message(0x03, null),
      message(0x04, { button: "volume_up" }),
      message(0x06, { type: "down", usage: 300 }),
      Uint8Array.from([
        0x03,
        ...new TextEncoder().encode(`{"x":0.5,"pad":"${"a".repeat(65_536)}"}`),
      ]),
    ];
    for (const refused of dropped) socket.receive(refused);
    expect(device?.sent).toHaveLength(valid.length);
    expect(socket.closed).toBeUndefined();

    const sentBefore = socket.sent.length;
    socket.receive(message(0x10, { command: "set-pose", requestId: 7 }));
    expect(socket.sent).toHaveLength(sentBefore + 1);
    const answer = socket.sent.at(-1);
    expect(answer?.[0]).toBe(0x90);
    expect(JSON.parse(new TextDecoder().decode(answer?.subarray(1)))).toEqual({
      error: "This device cannot change its pose",
      ok: false,
      requestId: 7,
    });
    expect(device?.sent).toHaveLength(valid.length);
  });

  it("closes a 9th socket and a failed device input's sockets with 1013, and refuses a reconnect within 10 s of a failed open without a new open", async () => {
    const { clock, factory, worker } = await setup();
    const sockets: MemoryLeaseSocket[] = [];
    for (let count = 0; count < 8; count += 1) sockets.push(await admitted(worker));
    const ninth = await attach(worker);
    await vi.waitFor(() => expect(ninth.closed).toEqual(REFUSED));
    expect(ninth.sent).toEqual([]);
    expect(sockets.map((socket) => socket.closed)).toEqual(Array(8).fill(undefined));
    expect(factory.opened).toHaveLength(1);

    factory.opened[0]?.fail(new Error("the controller died"));
    expect(sockets.map((socket) => socket.closed)).toEqual(Array(8).fill(REFUSED));
    expect(factory.opened[0]?.closes).toBe(1);

    factory.failWith = new Error("the controller cannot start");
    const opensBefore = factory.opens;
    const failed = await attach(worker);
    await vi.waitFor(() => expect(failed.closed).toEqual(REFUSED));
    expect(failed.sent).toEqual([]);
    expect(factory.opens).toBe(opensBefore + 1);

    clock.advance(9_999);
    const retry = await attach(worker);
    await vi.waitFor(() => expect(retry.closed).toEqual(REFUSED));
    expect(factory.opens).toBe(opensBefore + 1);

    clock.advance(1);
    const later = await attach(worker);
    await vi.waitFor(() => expect(later.closed).toEqual(REFUSED));
    expect(factory.opens).toBe(opensBefore + 2);
  });
});
