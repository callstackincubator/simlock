import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FetchWebhookPoster } from "./webhook-poster.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface Seen {
  method: string | undefined;
  header: string | string[] | undefined;
  body: string;
}

async function listen(
  handler: (url: string, response: ServerResponse, seen: Seen) => void,
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () =>
      handler(request.url ?? "", response, {
        method: request.method,
        header: request.headers["x-a"],
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("FetchWebhookPoster", () => {
  it("returns a 301 without following it, cancels the response body unread, and rejects when the signal aborts", async () => {
    const hits: string[] = [];
    let bodyClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      bodyClosed = resolve;
    });
    const sent: Seen[] = [];
    const base = await listen((url, response, seen) => {
      hits.push(url);
      sent.push(seen);
      if (url === "/moved-done") {
        response.writeHead(301, { Location: "/target" }).end("moved");
        return;
      }
      if (url === "/moved") {
        response.writeHead(301, { Location: "/target" });
        response.write("x".repeat(1024));
        response.on("close", bodyClosed);
        return;
      }
      if (url === "/silent") return;
      response.writeHead(200).end("ok");
    });
    const poster = new FetchWebhookPoster();
    const controller = new AbortController();
    const post = (path: string, signal = controller.signal) =>
      poster.post({ url: `${base}${path}`, headers: { "X-A": "1" }, body: "{}", signal });

    await expect(post("/ok")).resolves.toEqual({ status: 200 });
    expect(sent[0]).toEqual({ method: "POST", header: "1", body: "{}" });
    await expect(post("/moved-done")).resolves.toEqual({ status: 301 });
    await expect(post("/moved")).resolves.toEqual({ status: 301 });
    await closed;
    expect(hits).toEqual(["/ok", "/moved-done", "/moved"]);

    const pending = post("/silent");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
