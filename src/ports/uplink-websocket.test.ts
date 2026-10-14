/**
 * P3: `WebSocketUplinkListenerFactory#handleUpgrade` reads `x-simlock-worker-id` and the
 * URI-decoded `x-simlock-worker-label` *before* `authenticate` runs -- so anyone who can reach
 * the gateway's HTTP port, with no credential at all, can make it claim an arbitrary worker id
 * and a label up to Node's header budget (~16 KB). Both reach `authenticate`'s `claimed`
 * argument regardless of the outcome, and a refusal still emits `worker.rejected` on the
 * gateway's bus with them attached (`GatewayService`/`WorkerRegistry`, exercised elsewhere) --
 * this file is the one place that can drive a real HTTP upgrade with attacker-shaped headers and
 * observe what actually reaches that boundary, unauthenticated.
 *
 * A real `http.Server` and the real `ws` library on both ends, not a hand-built
 * `IncomingMessage` -- `#handleUpgrade` is private, and a header this large or this shaped is
 * exactly the kind of thing worth proving survives an actual HTTP round trip rather than a
 * fabricated request object.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type {
  ClaimedUplinkIdentity,
  UplinkAuthOutcome,
  UplinkTransportConnection,
} from "./uplink.js";
import { WebSocketUplinkConnector, WebSocketUplinkListenerFactory } from "./uplink-websocket.js";

let server: Server | undefined;
const openConnections: Array<{ close(): unknown }> = [];

afterEach(async () => {
  for (const connection of openConnections.splice(0)) await connection.close();
  if (server === undefined) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** Starts a real gateway-side listener whose `authenticate` always refuses (recording every
 * `claimed` it was handed) and returns the base URL to dial it at. */
async function startRefusingGateway(): Promise<{
  url: string;
  claims: ClaimedUplinkIdentity[];
}> {
  const claims: ClaimedUplinkIdentity[] = [];
  const factory = new WebSocketUplinkListenerFactory();
  await factory.listen({
    authenticate: (_credential, claimed): Promise<UplinkAuthOutcome> => {
      claims.push(claimed);
      return Promise.resolve("unauthenticated");
    },
    accept: () => {
      throw new Error("this gateway never accepts");
    },
  });
  server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  factory.attach(server);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { claims, url: `ws://127.0.0.1:${port}` };
}

/** Dials with no credential the gateway will accept, and swallows the resulting refusal -- every
 * test here is about what `authenticate` was handed, not about the connection succeeding. */
async function dialAndIgnoreRefusal(url: string, workerId: string, label?: string): Promise<void> {
  await new WebSocketUplinkConnector()
    .connect({ token: "irrelevant", url, workerId, ...(label === undefined ? {} : { label }) })
    .catch(() => undefined);
}

describe("WebSocketUplinkListenerFactory / P3", () => {
  it("truncates an over-long claimed workerId before authenticate ever sees it", async () => {
    const { claims, url } = await startRefusingGateway();
    const longId = "w".repeat(10_000);

    await dialAndIgnoreRefusal(url, longId);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.workerId).toHaveLength(128);
    expect(claims[0]?.workerId).toBe(longId.slice(0, 128));
  });

  it("truncates an over-long claimed label the same way", async () => {
    const { claims, url } = await startRefusingGateway();
    const longLabel = "mac-mini-".repeat(100);

    await dialAndIgnoreRefusal(url, "wrk_1", longLabel);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.label).toHaveLength(128);
    expect(claims[0]?.label).toBe(longLabel.slice(0, 128));
  });

  it("drops a claimed label containing a control character instead of passing it through", async () => {
    const { claims, url } = await startRefusingGateway();

    // A worker's own label never contains one; an attacker's header can claim anything.
    await dialAndIgnoreRefusal(url, "wrk_1", "mac-mini-evil\ntitle");

    expect(claims).toHaveLength(1);
    expect(claims[0]?.label).toBeUndefined();
  });

  it("still accepts an ordinary short, printable label unchanged", async () => {
    const { claims, url } = await startRefusingGateway();

    await dialAndIgnoreRefusal(url, "wrk_1", "mac-mini-1");

    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual({ label: "mac-mini-1", workerId: "wrk_1" });
  });
});

async function startAcceptingGateway(): Promise<{
  url: string;
  accepted: Promise<UplinkTransportConnection>;
}> {
  let resolveAccepted: ((connection: UplinkTransportConnection) => void) | undefined;
  const accepted = new Promise<UplinkTransportConnection>((resolve) => {
    resolveAccepted = resolve;
  });
  const factory = new WebSocketUplinkListenerFactory();
  await factory.listen({
    authenticate: () => Promise.resolve("accept"),
    accept: (uplink) => {
      openConnections.push(uplink.connection);
      resolveAccepted?.(uplink.connection);
    },
  });
  server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  factory.attach(server);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { accepted, url: `ws://127.0.0.1:${port}` };
}

const dialOptions = (url: string) => ({ token: "join", url, workerId: "wrk_1" });

describe("WebSocketUplinkConnection binary messages", () => {
  it("sends writeBinary bytes as one binary message and resolves on its send callback, and at once on a closed socket", async () => {
    const { accepted, url } = await startAcceptingGateway();
    const client = new WebSocket(`${url}/v1/uplink`, {
      headers: { authorization: "Bearer join", "x-simlock-worker-id": "wrk_1" },
    });
    openConnections.push(client);
    const messages: Array<{ binary: boolean; length: number }> = [];
    client.on("message", (data: Buffer, isBinary: boolean) =>
      messages.push({ binary: isBinary, length: data.length }),
    );
    const gateway = await accepted;

    await gateway.writeBinary(new Uint8Array(100 * 1024));
    await vi.waitFor(() => expect(messages).toEqual([{ binary: true, length: 100 * 1024 }]));
    await gateway.close();
    await gateway.writeBinary(new Uint8Array(4));

    expect(messages).toHaveLength(1);
  });

  it("delivers a received binary message to onBinary", async () => {
    const { accepted, url } = await startAcceptingGateway();
    const worker = await new WebSocketUplinkConnector().connect(dialOptions(url));
    const gateway = await accepted;
    const received: number[][] = [];
    gateway.onBinary((bytes) => received.push([...bytes]));

    await worker.writeBinary(new Uint8Array([4, 5, 6]));

    await vi.waitFor(() => expect(received).toEqual([[4, 5, 6]]));
  });

  it("drops a binary message that arrives with no listener", async () => {
    const { accepted, url } = await startAcceptingGateway();
    const worker = await new WebSocketUplinkConnector().connect(dialOptions(url));
    const gateway = await accepted;
    const text: string[] = [];
    gateway.onData((chunk) => text.push(chunk));
    await worker.writeBinary(new Uint8Array([1]));
    await worker.write("marker\n");
    await vi.waitFor(() => expect(text).toEqual(["marker\n"]));
    const received: number[][] = [];
    gateway.onBinary((bytes) => received.push([...bytes]));

    await worker.writeBinary(new Uint8Array([2]));

    await vi.waitFor(() => expect(received).toEqual([[2]]));
  });

  it("unsentBytes follows the socket's buffered amount with onSent firing when a send completes", async () => {
    const { accepted, url } = await startAcceptingGateway();
    const worker = await new WebSocketUplinkConnector().connect(dialOptions(url));
    await accepted;
    const onSent = vi.fn();
    worker.onSent(onSent);
    expect(worker.unsentBytes).toBe(0);

    const write = worker.writeBinary(new Uint8Array(16 * 1024 * 1024));
    const buffered = worker.unsentBytes;
    await write;

    expect(buffered).toBeGreaterThan(0);
    expect(worker.unsentBytes).toBe(0);
    expect(onSent).toHaveBeenCalled();
  });

  it("onSent fires when a text send completes", async () => {
    const { accepted, url } = await startAcceptingGateway();
    const worker = await new WebSocketUplinkConnector().connect(dialOptions(url));
    await accepted;
    const onSent = vi.fn();
    worker.onSent(onSent);

    await worker.write("hello");

    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
