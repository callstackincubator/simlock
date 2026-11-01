import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FetchHttpJsonClient } from "./http-json.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// why: the 10 s bound is real time against a server that never answers, so it lives in the timing project, not in a unit test where a loaded runner would move it.
describe("FetchHttpJsonClient's time limit", () => {
  it("rejects a server that never answers after 10 s, not before", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;

    const started = Date.now();
    await expect(new FetchHttpJsonClient().get(url, "t")).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);
});
