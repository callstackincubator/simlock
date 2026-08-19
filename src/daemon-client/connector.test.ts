import { describe, expect, it } from "vitest";

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
    expect(payload).toEqual({ clientVersion: "1.0.0", protocolVersion: DAEMON_PROTOCOL_VERSION });
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
