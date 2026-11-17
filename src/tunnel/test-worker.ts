import { expect } from "vitest";
import type { DeviceRecord, LeaseRecord } from "../core/index.js";
import { FakeDeviceTcp } from "../core/testing.js";
import type { WorkerModule } from "../modules/index.js";
import { fakeWorkerContext } from "../modules/testing.js";
import { type FakeClock, MemoryLeaseSocket } from "../ports/index.js";
import { tunnelModule } from "./index.js";

export const IDENTITY = { principal: "tok_holder", role: "agent" } as const;

export function frame(tag: number, conn: number, body = ""): Uint8Array {
  const bytes = new TextEncoder().encode(body);
  const out = new Uint8Array(5 + bytes.length);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, conn);
  out.set(bytes, 5);
  return out;
}

export function frames(socket: MemoryLeaseSocket): { tag: number; conn: number; body: string }[] {
  return socket.sent.map((sent) => ({
    body: new TextDecoder().decode(sent.subarray(5)),
    conn: new DataView(sent.buffer, sent.byteOffset).getUint32(1),
    tag: sent[0] ?? -1,
  }));
}

export function ending(reason: "device-lost" | "expired" | "explicit" | "killed") {
  return {
    deviceId: "dev_1",
    grantedAt: 1_000,
    leaseId: "L-1",
    ownerId: "tok_holder",
    platform: "android",
    reason,
  } as const;
}

export function hello(...tunnels: { kind: string; devicePort: number }[]): Uint8Array {
  return frame(0x01, 0, JSON.stringify({ tunnels }));
}

export async function setup(
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
      connect: (_platform, device, port, signal) => deviceTcp.connect(device, port, signal),
      supports: (named) => named === "android",
      supportsEmulatorPort: (named, device) => named === "android" && !device.physical,
      connectEmulatorPort: (_platform, device, name, signal) =>
        deviceTcp.connectEmulatorPort(device, name, signal),
      reverse: (_platform, device, port, signal) => deviceTcp.reverse(device, port, signal),
    },
    registry,
  });
  return { clock, deviceTcp, worker };
}

export async function attach(worker: WorkerModule, leaseId = "L-1"): Promise<MemoryLeaseSocket> {
  const opened = await worker.socket?.open(new Request("http://simlock/tunnel"), IDENTITY, {
    deviceId: "dev_1",
    id: leaseId,
  });
  expect(opened).toBeTypeOf("function");
  const socket = new MemoryLeaseSocket();
  if (typeof opened === "function") opened(socket);
  return socket;
}
