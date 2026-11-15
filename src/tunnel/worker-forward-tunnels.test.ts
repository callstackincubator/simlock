import { describe, expect, it, vi } from "vitest";
import { DeviceTcpError } from "../core/index.js";
import { attach, ending, frame, frames, hello, setup } from "./test-worker.js";

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
        body: '{"reason":"too many connections"}',
        conn: 514,
        tag: 0x06,
      }),
    );
    expect(deviceTcp.connections).toHaveLength(128);
    const past = deviceTcp.openFromDevice(5173);
    await vi.waitFor(() => expect(past.closed).toBe(true));
    expect(socket.closed).toBeUndefined();

    const failing = await ready();
    failing.deviceTcp.listening.delete(9229);
    failing.deviceTcp.connectFailures.set(9231, new DeviceTcpError("TUNNEL_FAILED", "timeout"));
    failing.socket.receive(open(2, 9229));
    await vi.waitFor(() =>
      expect(frames(failing.socket).at(-1)).toEqual({
        body: '{"reason":"closed"}',
        conn: 2,
        tag: 0x06,
      }),
    );
    expect(failing.socket.closed).toBeUndefined();

    const silent = await ready();
    silent.deviceTcp.connectFailures.set(9229, new DeviceTcpError("TUNNEL_FAILED", "timeout"));
    silent.socket.receive(open(2, 9229));
    await vi.waitFor(() =>
      expect(frames(silent.socket).at(-1)).toEqual({
        body: '{"reason":"timeout"}',
        conn: 2,
        tag: 0x06,
      }),
    );

    const ended = await ready();
    await ended.worker.hooks?.beforeDeviceReclaim?.(
      ending("expired"),
      new AbortController().signal,
    );
    ended.socket.receive(open(2, 9229));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended.deviceTcp.connections).toHaveLength(0);
  });
});
