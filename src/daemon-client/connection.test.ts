import { describe, expect, it, vi } from "vitest";

import { MemoryIpcTransport, type IpcConnection } from "../ports/index.js";
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

  it("auto-answers a lease.heartbeat push with a request frame, and re-surfaces the ack as a push", async () => {
    const ipc = new MemoryIpcTransport();
    const serverRequests: Array<{
      readonly id: number;
      readonly type: string;
      readonly payload: unknown;
    }> = [];
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    await ipc.listen("/daemon.sock", (connection) => {
      server = connection;
      connection.onData((contents) => {
        const frame = JSON.parse(contents) as {
          readonly id: number;
          readonly type: string;
          readonly payload: unknown;
        };
        serverRequests.push(frame);
        if (frame.type === "lease.heartbeat") {
          void connection.write(
            `${JSON.stringify({
              id: frame.id,
              ok: true,
              payload: { leases: [{ leaseId: "lse_1", ttlDeadline: 5_000 }] },
            })}\n`,
          );
        }
      });
    });
    const client = new IpcDaemonConnection(await ipc.connect("/daemon.sock"));
    const pushes: Array<{ readonly kind: string; readonly payload: unknown }> = [];
    client.onPush((kind, payload) => pushes.push({ kind, payload }));

    await server?.write('{"push":"lease.heartbeat","payload":{"nonce":7}}\n');
    await vi.waitFor(() => expect(pushes).toHaveLength(1));

    // The client never surfaces the raw server push (nonce) to its own listeners...
    expect(serverRequests).toEqual([{ id: 1, payload: { nonce: 7 }, type: "lease.heartbeat" }]);
    // ...only the ack it got back, under the same push kind.
    expect(pushes).toEqual([
      { kind: "lease.heartbeat", payload: { leases: [{ leaseId: "lse_1", ttlDeadline: 5_000 }] } },
    ]);
  });

  it("swallows a lease.heartbeat push it cannot answer (connection already closed)", async () => {
    const ipc = new MemoryIpcTransport();
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    await ipc.listen("/daemon.sock", (connection) => {
      server = connection;
    });
    const client = new IpcDaemonConnection(await ipc.connect("/daemon.sock"));
    const pushes: unknown[] = [];
    client.onPush((kind, payload) => pushes.push({ kind, payload }));
    await client.close();

    await expect(
      server?.write('{"push":"lease.heartbeat","payload":{"nonce":1}}\n'),
    ).resolves.toBeUndefined();
    expect(pushes).toEqual([]);
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

  it("rejects pending work when the daemon sends malformed JSON", async () => {
    const transport = new FakeIpcConnection();
    const client = new IpcDaemonConnection(transport);
    const pending = client.request("status.get", {});
    transport.emitData("{not json}\n");
    await expect(pending).rejects.toThrow("Daemon sent invalid JSON");
  });

  it("rejects pending work when the daemon sends a primitive frame", async () => {
    const transport = new FakeIpcConnection();
    const client = new IpcDaemonConnection(transport);
    const pending = client.request("status.get", {});
    transport.emitData("42\n");
    await expect(pending).rejects.toThrow("Daemon sent an invalid frame");
  });

  it("rejects and clears the associated request when a write fails", async () => {
    const transport = new FakeIpcConnection();
    transport.writeError = new Error("write failed");
    const client = new IpcDaemonConnection(transport);
    await expect(client.request("status.get", {})).rejects.toThrow("write failed");
    expect(transport.writes).toEqual(['{"id":1,"payload":{},"type":"status.get"}\n']);
  });

  it("rejects pending work with the original transport error", async () => {
    const transport = new FakeIpcConnection();
    const client = new IpcDaemonConnection(transport);
    const pending = client.request("status.get", {});
    const error = new Error("connection reset");
    transport.emitError(error);
    await expect(pending).rejects.toBe(error);
  });

  it("rejects pending work when explicitly closed and is idempotent", async () => {
    const transport = new FakeIpcConnection();
    const client = new IpcDaemonConnection(transport);
    const pending = client.request("status.get", {});
    const rejection = expect(pending).rejects.toThrow("Daemon connection closed");
    await client.close();
    await client.close();
    await rejection;
    expect(transport.closeCalls).toBe(1);
  });
});

class FakeIpcConnection implements IpcConnection {
  readonly #closeListeners = new Set<() => void>();
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly writes: string[] = [];
  closeCalls = 0;
  closed = false;
  writeError: Error | undefined;

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  async write(contents: string): Promise<void> {
    this.writes.push(contents);
    if (this.writeError !== undefined) throw this.writeError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#closeListeners) listener();
  }

  emitData(chunk: string): void {
    for (const listener of this.#dataListeners) listener(chunk);
  }

  emitError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}
