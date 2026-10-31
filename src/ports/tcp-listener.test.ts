import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { NodeTcpListenerFactory } from "./tcp-listener.js";
import { NodeTcpStreamConnector } from "./tcp-stream.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

// why: an adapter over node:net, proven by what a real loopback socket does, which the fake cannot show.
describe("NodeTcpListenerFactory", () => {
  it("hands out a loopback port whose connections arrive as streams, answers undefined for a taken port, and frees the port on close", async () => {
    const port = await freePort();
    const factory = new NodeTcpListenerFactory();
    const listener = await factory.listen(port);
    expect(listener?.port).toBe(port);
    expect(await factory.listen(port)).toBeUndefined();

    const received = new Promise<string>((resolve) => {
      listener?.onConnection((stream) => {
        void (async () => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream.readable) chunks.push(chunk);
          resolve(Buffer.concat(chunks).toString());
        })();
      });
    });
    const client = await new NodeTcpStreamConnector().connect(port, 1000);
    await client.write("hello");
    client.end();
    expect(await received).toBe("hello");
    client.close();

    await listener?.close();
    const again = await factory.listen(port);
    expect(again?.port).toBe(port);
    await again?.close();
  });
});
