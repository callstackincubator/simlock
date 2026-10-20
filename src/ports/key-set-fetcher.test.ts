import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { KEY_SET_MAX_BYTES, NodeKeySetFetcher } from "./key-set-fetcher.js";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("NodeKeySetFetcher against a real server", () => {
  it("returns a redirect as its status and never requests the redirect's target", async () => {
    const requested: string[] = [];
    const base = await serve((request, response) => {
      requested.push(request.url ?? "");
      if (request.url === "/keys") response.writeHead(302, { location: "/elsewhere" }).end();
      else response.writeHead(200).end("{}");
    });

    const answer = await new NodeKeySetFetcher().fetch(`${base}/keys`, {
      signal: new AbortController().signal,
    });

    expect(answer.status).toBe(302);
    expect(requested).toEqual(["/keys"]);
  });

  it("ends a request the server never answers when its signal aborts", async () => {
    let received = false;
    const base = await serve(() => {
      received = true;
    });
    const controller = new AbortController();

    const pending = new NodeKeySetFetcher().fetch(`${base}/keys`, { signal: controller.signal });
    let outcome: string | undefined;
    const settled = pending.then(
      () => {
        outcome = "answered";
      },
      (error: unknown) => {
        outcome = (error as Error).name;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(received).toBe(true);
    controller.abort();

    await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);

    expect(outcome).toBe("AbortError");
  });

  it("returns a body of 64 KiB and fails on a body over 64 KiB", async () => {
    const base = await serve((request, response) => {
      const size = request.url === "/exact" ? KEY_SET_MAX_BYTES : KEY_SET_MAX_BYTES + 1;
      response.writeHead(200).end("k".repeat(size));
    });
    const fetcher = new NodeKeySetFetcher();
    const signal = new AbortController().signal;

    const exact = await fetcher.fetch(`${base}/exact`, { signal });
    expect(exact.status).toBe(200);
    expect(exact.body.length).toBe(KEY_SET_MAX_BYTES);

    await expect(fetcher.fetch(`${base}/over`, { signal })).rejects.toThrow();
  });
});
