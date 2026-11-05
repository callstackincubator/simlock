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
  it("hands out a loopback port whose connections arrive as streams, lets the worker answer after the peer half-closed, answers undefined for a taken port, and frees the port on close", async () => {
    const port = await freePort();
    const factory = new NodeTcpListenerFactory();
    const listener = await factory.listen(port);
    expect(listener?.port).toBe(port);
    expect(listener?.address).toBe("127.0.0.1");
    expect(await factory.listen(port)).toBeUndefined();

    const received = new Promise<string>((resolve) => {
      listener?.onConnection((stream) => {
        void (async () => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream.readable) chunks.push(chunk);
          resolve(Buffer.concat(chunks).toString());
          await stream.write("reply");
          stream.end();
        })();
      });
    });
    const client = await new NodeTcpStreamConnector().connect(port, 1000);
    await client.write("hello");
    client.end();
    expect(await received).toBe("hello");
    const reply: Uint8Array[] = [];
    for await (const chunk of client.readable) reply.push(chunk);
    expect(Buffer.concat(reply).toString()).toBe("reply");
    client.close();

    await listener?.close();
    const again = await factory.listen(port);
    expect(again?.port).toBe(port);
    await again?.close();

    const v6 = await factory.listen(port, "::1");
    expect(v6?.address).toBe("::1");
    expect(await factory.listen(port, "::1")).toBeUndefined();
    const arrived = new Promise<void>((resolve) => v6?.onConnection(() => resolve()));
    const v6Client = await new NodeTcpStreamConnector().connect(port, 1000, "::1");
    await arrived;
    v6Client.close();
    await v6?.close();
  });

  it("reports the port it bound when asked for any free port, and still answers undefined for a taken one", async () => {
    const factory = new NodeTcpListenerFactory();
    const listener = await factory.listen(0);
    expect(listener?.port).toBeGreaterThan(0);
    const port = listener?.port ?? 0;
    const arrived = new Promise<void>((resolve) => listener?.onConnection(() => resolve()));
    const client = await new NodeTcpStreamConnector().connect(port, 1000);
    await arrived;
    client.close();
    expect(await factory.listen(port)).toBeUndefined();
    await listener?.close();
  });
});
