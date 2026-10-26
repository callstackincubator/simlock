import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { LeaseSocketAccept } from "./lease-socket.js";
import { createUpgradeRouter } from "./upgrade-router.js";

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  closing?.closeAllConnections();
  await new Promise<void>((resolve) => closing?.close(() => resolve()));
});

// why: `ended` settles when each connection the server saw has closed, so a test reads what the router did on the close after it fired, not before.
const ended: Promise<void>[] = [];

async function listen(
  accept: LeaseSocketAccept,
  gate: Promise<void> = Promise.resolve(),
): Promise<number> {
  const listening = createServer();
  listening.on("connection", (connection) => {
    ended.push(new Promise<void>((resolve) => connection.once("close", () => resolve())));
  });
  createUpgradeRouter({ leaseSocket: () => gate.then(() => ({ accept })) }).attach(listening);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return (listening.address() as AddressInfo).port;
}

function rawUpgrade(port: number): Socket {
  const raw = connect(port, "127.0.0.1");
  raw.on("error", () => undefined);
  raw.write(
    "GET /v1/leases/L-1/input HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  return raw;
}

function upgradeWithVersion(port: number, version: string): Promise<number> {
  return new Promise((resolve) => {
    const upgrading = request({
      headers: {
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": version,
        upgrade: "websocket",
      },
      host: "127.0.0.1",
      path: "/v1/leases/L-1/input",
      port,
    });
    upgrading.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgrading.end();
  });
}

// why: `upgrade-router.ts` is not exported through `ports/index.ts` (the CLI must not load `ws`), and the claim is an ordering the surface cannot force: what `ws` does on a refused handshake -- it answers and destroys the socket without calling the accept back.
describe("the upgrade router's lease socket", () => {
  it("abandons what the module opened when the handshake is refused, and not when it succeeds", async () => {
    const abandon = vi.fn();
    const accepted = vi.fn();
    const port = await listen(Object.assign(accepted, { abandon }));

    expect(await upgradeWithVersion(port, "99")).toBe(400);
    await vi.waitFor(() => expect(abandon).toHaveBeenCalledTimes(1));
    expect(accepted).not.toHaveBeenCalled();

    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/leases/L-1/input`);
    await new Promise((resolve) => client.once("open", resolve));
    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    await Promise.all(ended);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("abandons what the module opened, and survives, when the client resets before the module answers", async () => {
    const abandon = vi.fn();
    let release: () => void = () => undefined;
    const port = await listen(
      Object.assign(vi.fn(), { abandon }),
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const crashes: unknown[] = [];
    const saved = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (error) => crashes.push(error));
    try {
      const raw = rawUpgrade(port);
      await new Promise((resolve) => raw.once("connect", resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      raw.resetAndDestroy();
      await Promise.all(ended);
      release();
      await vi.waitFor(() => expect(abandon).toHaveBeenCalledTimes(1));
      expect(crashes).toEqual([]);
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const listener of saved) process.on("uncaughtException", listener);
    }
  });
});
