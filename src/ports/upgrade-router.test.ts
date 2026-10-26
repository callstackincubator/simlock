import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

async function listen(accept: LeaseSocketAccept): Promise<number> {
  const listening = createServer();
  createUpgradeRouter({ leaseSocket: () => Promise.resolve({ accept }) }).attach(listening);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return (listening.address() as AddressInfo).port;
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
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
  });
});
