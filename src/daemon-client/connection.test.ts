import { describe, expect, it } from "vitest";

import { MemoryIpcTransport } from "../ports/index.js";
import { IpcDaemonConnection } from "./connection.js";

describe("IpcDaemonConnection", () => {
  it("buffers torn frames and dispatches responses and pushes", async () => {
    const ipc = new MemoryIpcTransport();
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    await ipc.listen("/daemon.sock", (connection) => {
      server = connection;
    });
    const client = new IpcDaemonConnection(await ipc.connect("/daemon.sock"));
    const pushes: unknown[] = [];
    client.onPush((_kind, payload) => pushes.push(payload));
    const response = client.request("status.get", {});
    await server?.write('{"push":"event","payload":{"id":1}}\n{"id":1,"ok":');
    await server?.write('true,"payload":{"ok":true}}\n');
    await expect(response).resolves.toEqual({ ok: true });
    expect(pushes).toEqual([{ id: 1 }]);
  });

  it("multiplexes concurrent ids and preserves daemon errors", async () => {
    const ipc = new MemoryIpcTransport();
    await ipc.listen("/daemon.sock", (server) => {
      server.onData((contents) => {
        const frame = JSON.parse(contents) as { readonly id: number; readonly type: string };
        void server.write(
          frame.type === "bad"
            ? `${JSON.stringify({ error: { code: "BAD", message: "failed" }, id: frame.id, ok: false })}\n`
            : `${JSON.stringify({ id: frame.id, ok: true, payload: frame.type })}\n`,
        );
      });
    });
    const client = new IpcDaemonConnection(await ipc.connect("/daemon.sock"));
    await expect(
      Promise.all([client.request("one", {}), client.request("two", {})]),
    ).resolves.toEqual(["one", "two"]);
    await expect(client.request("bad", {})).rejects.toMatchObject({
      code: "BAD",
      message: "failed",
    });
  });

  it("rejects pending work when the transport closes and closes idempotently", async () => {
    const ipc = new MemoryIpcTransport();
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    await ipc.listen("/daemon.sock", (connection) => {
      server = connection;
    });
    const client = new IpcDaemonConnection(await ipc.connect("/daemon.sock"));
    const pending = client.request("wait", {});
    await server?.close();
    await expect(pending).rejects.toThrow("Daemon connection closed");
    await client.close();
    await client.close();
  });
});
