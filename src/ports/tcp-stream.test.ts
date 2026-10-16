import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { NodeTcpStreamConnector } from "./tcp-stream.js";

let server: Server | undefined;

afterEach(async () => {
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
});
