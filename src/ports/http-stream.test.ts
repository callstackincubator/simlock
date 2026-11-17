import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { NodeHttpStreamClient } from "./http-stream.js";

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

// why: an adapter over node:http, proven by what a real server receives (the bearer token, the streamed body with its length) and what the caller reads back, which the fake cannot show.
describe("NodeHttpStreamClient", () => {
  it("sends the bearer token and the streamed body, answers status and a streamed body of any status, and rejects when the caller aborts", async () => {
    const received: {
      authorization: string | undefined;
      length: string | undefined;
      body: string;
    }[] = [];
    const base = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
          length: request.headers["content-length"],
        });
        if (request.url === "/hang") return;
        response.writeHead(request.url === "/refused" ? 413 : 201).end("answer-bytes");
      });
    });
    const client = new NodeHttpStreamClient();
    const text = async (stream: ReadableStream<Uint8Array>) => await new Response(stream).text();

    const stored = await client.request({
      body: new Response("file-bytes").body as ReadableStream<Uint8Array>,
      contentLength: 10,
      method: "PUT",
      signal: new AbortController().signal,
      token: "sk_token",
      url: `${base}/stored`,
    });
    expect(stored.status).toBe(201);
    expect(await text(stored.body)).toBe("answer-bytes");
    expect(received.at(-1)).toEqual({
      authorization: "Bearer sk_token",
      body: "file-bytes",
      length: "10",
    });

    const refused = await client.request({
      method: "GET",
      signal: new AbortController().signal,
      token: "t",
      url: `${base}/refused`,
    });
    expect(refused.status).toBe(413);
    expect(await text(refused.body)).toBe("answer-bytes");

    const controller = new AbortController();
    const hanging = client.request({
      method: "GET",
      signal: controller.signal,
      token: "t",
      url: `${base}/hang`,
    });
    controller.abort();
    // why: a client that ignores the abort never settles, so the race names the failure instead of the test timing out.
    const outcome = await Promise.race([
      hanging.then(
        () => "answered",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(outcome).toBe("rejected");
  });
});
