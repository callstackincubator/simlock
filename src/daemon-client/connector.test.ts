import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import { MemoryIpcTransport } from "../ports/index.js";
import { IpcDaemonConnector } from "./connector.js";

describe("IpcDaemonConnector", () => {
  it("sends the hello protocol payload", async () => {
    const ipc = new MemoryIpcTransport();
    let payload: unknown;
    await ipc.listen("/daemon.sock", (connection) => {
      connection.onData((contents) => {
        const frame = JSON.parse(contents) as { readonly id: number; readonly payload: unknown };
        payload = frame.payload;
        void connection.write(`${JSON.stringify({ id: frame.id, ok: true, payload: {} })}\n`);
      });
    });
    const connection = await new IpcDaemonConnector(ipc, "/daemon.sock").connect();
    await connection.close();
    // Sends both the legacy exact protocolVersion and the new range (ADR 0003 §6), so an old
    // protocol-2 daemon (which only ever reads the former) still answers intelligibly.
    expect(payload).toEqual({
      clientVersion: "1.0.0",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      protocolRange: PROTOCOL_VERSION_RANGE,
    });
  });

  it("declares capabilities at hello only when given some, per capability negotiation rules", async () => {
    const ipc = new MemoryIpcTransport();
    const payloads: unknown[] = [];
    await ipc.listen("/daemon.sock", (connection) => {
      connection.onData((contents) => {
        const frame = JSON.parse(contents) as { readonly id: number; readonly payload: unknown };
        payloads.push(frame.payload);
        void connection.write(`${JSON.stringify({ id: frame.id, ok: true, payload: {} })}\n`);
      });
    });

    const withHeartbeat = await new IpcDaemonConnector(ipc, "/daemon.sock", {
      heartbeat: true,
    }).connect();
    await withHeartbeat.close();
    expect(payloads[0]).toMatchObject({ capabilities: { heartbeat: true } });

    const withoutCapabilities = await new IpcDaemonConnector(ipc, "/daemon.sock").connect();
    await withoutCapabilities.close();
    expect(payloads[1]).not.toHaveProperty("capabilities");
  });

  it("closes transport after a failed handshake", async () => {
    const ipc = new MemoryIpcTransport();
    let serverClosed = false;
    await ipc.listen("/daemon.sock", (connection) => {
      connection.onClose(() => {
        serverClosed = true;
      });
      connection.onData((contents) => {
        const frame = JSON.parse(contents) as { readonly id: number };
        void connection.write(
          `${JSON.stringify({ error: { code: "BAD", message: "no" }, id: frame.id, ok: false })}\n`,
        );
      });
    });
    await expect(new IpcDaemonConnector(ipc, "/daemon.sock").connect()).rejects.toMatchObject({
      code: "BAD",
    });
    expect(serverClosed).toBe(true);
  });
});
