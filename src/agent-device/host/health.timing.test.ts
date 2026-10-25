import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { NodeAgentDeviceHealthProbe } from "./health.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// why: the probe's limit is an AbortSignal timer on a real socket, so only real time shows that
// it keeps the limit it was given rather than `DEFAULT_HEALTH_TIMEOUT_MS`.
describe("NodeAgentDeviceHealthProbe", () => {
  it("rejects a server that never answers once its time limit passes", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = Date.now();

    await expect(new NodeAgentDeviceHealthProbe(50).read(baseUrl)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
