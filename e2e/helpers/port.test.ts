import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { holdLoopbackPort, waitFor } from "./index.js";

// why: any program on the machine may connect to a held port (a port scanner sends `GET /` and
// keeps the connection alive, or closes its side and waits), and a test that releases the port
// must still go on.
function connectAndRequest(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect(port, "127.0.0.1", () => {
      client.write("GET / HTTP/1.1\r\nhost: localhost\r\nconnection: keep-alive\r\n\r\n");
      resolve(client);
    });
    client.once("error", reject);
  });
}

describe("holdLoopbackPort", () => {
  it("release finishes while one client keeps its connection open and another has closed its side", async () => {
    const held = await holdLoopbackPort();
    const keptOpen = await connectAndRequest(held.port);
    const halfClosed = await connectAndRequest(held.port);
    halfClosed.end();
    let released = false;
    try {
      void held.release().then(() => {
        released = true;
      });

      await waitFor(() => released, {
        timeout: 10_000,
        label: "the held port released with two client connections still on it",
      });
      expect(released).toBe(true);
    } finally {
      keptOpen.destroy();
      halfClosed.destroy();
    }
  });
});
