import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FetchHttpJsonClient } from "./http-json.js";

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// why: an adapter over fetch, proven by what a real HTTP server does with the bearer token, the body cap and a redirect, which the fake cannot show.
describe("FetchHttpJsonClient", () => {
  it("sends the bearer token, answers status and JSON body, and rejects a redirect or a body past 1 MiB", async () => {
    let authorization: string | undefined;
    const base = await serve((request, response) => {
      authorization = request.headers.authorization;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/answer" }).end();
      } else if (request.url === "/big") {
        response.writeHead(200).end("x".repeat(1_048_577));
      } else if (request.url === "/edge") {
        response.writeHead(200).end(JSON.stringify({ pad: "x".repeat(1_048_576 - 10) }));
      } else if (request.url === "/text") {
        response.writeHead(502).end("bad gateway");
      } else {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":{"code":"X"}}');
      }
    });
    const client = new FetchHttpJsonClient();

    expect(await client.get(`${base}/answer`, "sk_token")).toEqual({
      body: { error: { code: "X" } },
      status: 401,
    });
    expect(authorization).toBe("Bearer sk_token");
    expect((await client.get(`${base}/edge`, "t")).status).toBe(200);
    expect(await client.get(`${base}/text`, "t")).toEqual({ body: undefined, status: 502 });
    await expect(client.get(`${base}/big`, "t")).rejects.toThrow("longer than 1048576 bytes");
    await expect(client.get(`${base}/redirect`, "t")).rejects.toThrow();
  });
});
