import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { NodeWebSocketClientConnector, WebSocketRefusedError } from "./websocket-client.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// why: an adapter over ws, proven by what a real upgrade does: the refusal's status and body, the headers sent, and the pings, close and bytes that arrive.
describe("NodeWebSocketClientConnector", () => {
  it("rejects a refused upgrade with its status and body, and reports headers, messages, pings and the close", async () => {
    const refusing = createServer();
    refusing.on("upgrade", (_request, socket) => {
      const body = '{"error":{"code":"TUNNEL_UNAVAILABLE"}}';
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`,
      );
    });
    const connector = new NodeWebSocketClientConnector();
    const options = { handshakeTimeoutMs: 5_000, headers: { authorization: "Bearer sk_x" } };
    const refused = await connector
      .connect(await listen(refusing), options)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WebSocketRefusedError);
    expect(refused).toMatchObject({ body: '{"error":{"code":"TUNNEL_UNAVAILABLE"}}', status: 503 });

    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    let authorization: string | undefined;
    wss.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      let hellos = 0;
      socket.on("message", (data) => {
        hellos += 1;
        if (hellos === 1) {
          socket.ping();
          socket.send(Buffer.from([1, 2, 3]));
        } else socket.close(4001, `got ${String((data as Buffer).length)}`);
      });
    });
    const client = await connector.connect(await listen(http), options);
    const messages: number[][] = [];
    let pings = 0;
    const closes: [number, string][] = [];
    client.onMessage((bytes) => messages.push([...bytes]));
    client.onPing(() => {
      pings += 1;
    });
    client.onClose((code, reason) => closes.push([code, reason]));
    client.send(new Uint8Array([7]));
    await vi.waitFor(() => expect(messages).toEqual([[1, 2, 3]]));
    expect(pings).toBe(1);
    expect(authorization).toBe("Bearer sk_x");
    client.send(new Uint8Array([9, 9]));
    await vi.waitFor(() => expect(closes).toEqual([[4001, "got 2"]]));
    const late: [number, string][] = [];
    client.onClose((code, reason) => late.push([code, reason]));
    expect(late).toEqual([[4001, "got 2"]]);
  });
});
