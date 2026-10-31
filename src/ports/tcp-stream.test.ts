import { createConnection, createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeTcpStreamConnector, tcpStreamOf } from "./tcp-stream.js";

let server: Server | undefined;
const held: Socket[] = [];

afterEach(async () => {
  for (const socket of held.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  server = createServer(onConnection);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

// why: an adapter over node:net, proven by what a real loopback socket does, which the fake cannot show.
describe("NodeTcpStreamConnector", () => {
  it("carries bytes both ways until the peer hangs up", async () => {
    const port = await listen((socket) => {
      socket.once("data", (request: Buffer) => {
        socket.end(Buffer.concat([Buffer.from("echo:"), request]));
      });
    });
    const stream = await new NodeTcpStreamConnector().connect(port, 1000);
    await stream.write("ping");
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.readable) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("echo:ping");
  });

  it("rejects a port nothing listens on", async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(new NodeTcpStreamConnector().connect(port, 1000)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("close ends the connection the peer sees", async () => {
    const peerClosed = new Promise<void>((resolve) => {
      void listen((socket) => {
        socket.on("close", () => resolve());
      }).then(async (port) => {
        const stream = await new NodeTcpStreamConnector().connect(port, 1000);
        stream.close();
      });
    });
    await expect(peerClosed).resolves.toBeUndefined();
  });

  it("ends its readable when the peer closes or the socket errors, pauses the socket while the reader is behind, and destroys it when the reader cancels", async () => {
    let accepted: Socket | undefined;
    const port = await listen((socket) => {
      accepted = socket;
      socket.on("error", () => undefined);
    });
    const open = async (): Promise<{
      socket: Socket;
      peer: Socket;
      stream: ReturnType<typeof tcpStreamOf>;
    }> => {
      const socket = createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      await vi.waitFor(() => expect(accepted).toBeDefined());
      const peer = accepted as Socket;
      accepted = undefined;
      held.push(socket, peer);
      return { peer, socket, stream: tcpStreamOf(socket) };
    };

    const closing = await open();
    closing.peer.destroy();
    await expect(closing.stream.readable.getReader().read()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    const failing = await open();
    const failed = failing.stream.readable.getReader().read();
    failing.socket.emit("error", new Error("the connection broke"));
    await expect(failed).resolves.toEqual({ done: true, value: undefined });

    const behind = await open();
    behind.peer.write("one");
    await vi.waitFor(() => expect(behind.socket.isPaused()).toBe(true));
    const reader = behind.stream.readable.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await vi.waitFor(() => expect(behind.socket.isPaused()).toBe(false));

    await reader.cancel();
    expect(behind.socket.destroyed).toBe(true);
  });
});
