import { describe, expect, it, vi } from "vitest";
import type { FakeTcpPeer } from "../ports/index.js";
import { attach, frame, frames, hello, setup } from "./test-worker.js";

describe("a worker's tunnel socket with an emulator tunnel", () => {
  const emulatorHello = (): Uint8Array =>
    frame(0x01, 0, JSON.stringify({ tunnels: [{ kind: "emulator", emulatorPort: "adb" }] }));
  const open = (conn: number, body: unknown = { kind: "emulator", emulatorPort: "adb" }) =>
    frame(0x02, conn, JSON.stringify(body));

  async function ready(withEmulator = true) {
    const { deviceTcp, worker } = await setup();
    deviceTcp.emulatorPortsListening.add("adb");
    const socket = await attach(worker);
    socket.receive(withEmulator ? emulatorHello() : hello({ devicePort: 9229, kind: "forward" }));
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
    return { deviceTcp, socket };
  }

  it("carries a caller's emulator connection to the emulator's adb port, bytes both ways, resets one the port refuses, and closes the socket 4003 on an OPEN when HELLO named none", async () => {
    const accepted = await ready();
    expect(frames(accepted.socket)).toEqual([
      { body: '{"tunnels":[{"kind":"emulator","emulatorPort":"adb"}]}', conn: 0, tag: 0x81 },
    ]);
    accepted.socket.receive(open(2));
    await vi.waitFor(() => expect(accepted.deviceTcp.emulatorConnections).toHaveLength(1));
    const { name, peer } = accepted.deviceTcp.emulatorConnections[0] as {
      name: string;
      peer: FakeTcpPeer;
    };
    expect(name).toBe("adb");
    accepted.socket.receive(frame(0x03, 2, "from the caller"));
    await vi.waitFor(() => expect(peer.writtenText()).toBe("from the caller"));
    peer.send("from adb");
    await vi.waitFor(() =>
      expect(frames(accepted.socket).at(-1)).toEqual({ body: "from adb", conn: 2, tag: 0x03 }),
    );
    expect(accepted.deviceTcp.connections).toHaveLength(0);

    const refusing = await ready();
    refusing.deviceTcp.emulatorPortsListening.delete("adb");
    refusing.socket.receive(open(2));
    await vi.waitFor(() =>
      expect(frames(refusing.socket).at(-1)).toEqual({
        body: '{"reason":"closed"}',
        conn: 2,
        tag: 0x06,
      }),
    );
    expect(refusing.socket.closed).toBeUndefined();

    const unnamed = await ready(false);
    unnamed.socket.receive(open(2));
    await vi.waitFor(() =>
      expect(unnamed.socket.closed).toEqual({
        code: 4003,
        reason: "OPEN must name a forward tunnel of this socket",
      }),
    );
    expect(unnamed.deviceTcp.emulatorConnections).toHaveLength(0);

    const other = await ready();
    other.socket.receive(open(2, { kind: "emulator", emulatorPort: "console" }));
    await vi.waitFor(() =>
      expect(other.socket.closed).toEqual({
        code: 4003,
        reason: "OPEN must name a forward tunnel of this socket",
      }),
    );
    expect(other.deviceTcp.emulatorConnections).toHaveLength(0);
  });
});

describe("a worker's HELLO with an emulator tunnel", () => {
  const emulator = { kind: "emulator", emulatorPort: "adb" };
  const send = (...tunnels: unknown[]): Uint8Array => frame(0x01, 0, JSON.stringify({ tunnels }));

  it("checks a holder's emulator entry and answers it: READY echoing it, counted toward 8, BAD_REQUEST for another name, TUNNEL_UNSUPPORTED off an emulator", async () => {
    const forward = (devicePort: number) => ({ kind: "forward", devicePort });
    const { worker } = await setup();
    const first = await attach(worker);
    first.receive(send(emulator, forward(9229), forward(9230)));
    await vi.waitFor(() =>
      expect(frames(first)).toEqual([
        {
          body: JSON.stringify({ tunnels: [emulator, forward(9229), forward(9230)] }),
          conn: 0,
          tag: 0x81,
        },
      ]),
    );
    const second = await attach(worker);
    second.receive(send(...[9231, 9232, 9233, 9234, 9235].map(forward)));
    await vi.waitFor(() => expect(frames(second).map((sent) => sent.tag)).toEqual([0x81]));
    const third = await attach(worker);
    third.receive(send(emulator));
    await vi.waitFor(() =>
      expect(frames(third)).toEqual([
        {
          body: JSON.stringify({
            code: "TUNNEL_LIMIT",
            message: "the lease already has 8 tunnels; at most 8",
          }),
          conn: 0,
          tag: 0x82,
        },
      ]),
    );

    const badName = "HELLO emulator tunnels must name the port adb";
    const refusals = [
      {
        code: "BAD_REQUEST",
        message: badName,
        tunnel: { kind: "emulator", emulatorPort: "console" },
      },
      { code: "BAD_REQUEST", message: badName, tunnel: { kind: "emulator" } },
      { code: "BAD_REQUEST", message: badName, tunnel: { kind: "emulator", emulatorPort: 5555 } },
      {
        code: "TUNNEL_UNSUPPORTED",
        message:
          "emulator adb: the lease is on an Android phone; emulator ports need an Android emulator",
        physical: true,
        platform: "android",
        tunnel: emulator,
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message:
          "emulator adb: the lease is on an iOS simulator; emulator ports need an Android emulator",
        platform: "ios",
        tunnel: emulator,
      },
      {
        code: "TUNNEL_UNSUPPORTED",
        message: "emulator adb: the lease is on an iPhone; emulator ports need an Android emulator",
        physical: true,
        platform: "ios",
        tunnel: emulator,
      },
    ];
    for (const refused of refusals) {
      const { worker: other } = await setup(refused.platform, refused.physical);
      const socket = await attach(other);
      socket.receive(send(refused.tunnel));
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
    }
  });
});
