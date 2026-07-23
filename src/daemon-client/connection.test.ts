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
});
