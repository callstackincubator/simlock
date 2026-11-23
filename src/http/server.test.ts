import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { connect, Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import type { Identity } from "../auth/index.js";
import { fakeAuth, tokenIdentity } from "../auth/testing.js";
import { createHttpApp } from "./app.js";
import { CONSOLE_CONTENT_SECURITY_POLICY, HttpGateway, withConsole } from "./server.js";
import { FakeDispatcher, FakeRegistry, noLeaseFiles, sequenceIdGenerator } from "./test-fakes.js";

const PAGE = '<!doctype html><title>Simlock</title><div id="root"></div>';
const SCRIPT = "console.log('console');";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A built console as `vite build` lays it out: the page, one hashed asset, one public file. */
async function builtConsole(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simlock-console-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), PAGE);
  await writeFile(join(root, "assets", "index-3f2a9c.js"), SCRIPT);
  await writeFile(join(root, "favicon.svg"), "<svg/>");
  return root;
}

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simlock-console-"));
  roots.push(root);
  return root;
}

/** The real HTTP app, behind the console, with a log sink to read its request log from. */
function harness(root: string) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const dispatcher = new FakeDispatcher(clock);
  dispatcher.handlers["status.get"] = () => ({ ok: true });
  const registry = new FakeRegistry();
  const auth = fakeAuth(
    new Map<string, Identity>([["slk_operator", tokenIdentity("tok_operator", "operator")]]),
  );
  const logger = new JsonLinesLogger({ clock, sink: new MemoryLogSink() });
  const app = createHttpApp({
    clock,
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leaseRequests: dispatcher.requests,
    logger,
    ownerRoutedFacts: new OwnerRoutedFactBus(eventBus, registry),
    registry,
    auth,
    leaseFiles: noLeaseFiles,
  });
  const site = withConsole(app, { logger, root });
  const get = (path: string, init: RequestInit = {}) =>
    Promise.resolve(site.fetch(new Request(`http://127.0.0.1:4700${path}`, init)));
  return { app, get };
}

describe("withConsole", () => {
  it("GET /workers answers the console page so a page URL survives a reload", async () => {
    const { get } = harness(await builtConsole());

    const response = await get("/workers");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe(PAGE);
  });

  it("GET /assets/missing.js answers 404, not the page", async () => {
    const { get } = harness(await builtConsole());

    const response = await get("/assets/missing.js");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(PAGE);
  });

  it("a path under /assets/ with no file extension answers 404, never the page", async () => {
    const { get } = harness(await builtConsole());

    for (const path of ["/assets/chunk", "/assets/"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-cache");
      expect(await response.text(), path).not.toContain(PAGE);
    }
  });

  it("GET /v1 itself goes to the API, not the page", async () => {
    const { app, get } = harness(await builtConsole());

    const response = await get("/v1");
    const direct = await app.request("/v1");

    expect(response.status).toBe(direct.status);
    expect(await response.text()).toBe(await direct.text());
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("GET /v1/unknown answers the API's 404, not the page", async () => {
    const { app, get } = harness(await builtConsole());

    const response = await get("/v1/unknown");
    const direct = await app.request("/v1/unknown");

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(PAGE);
    expect(body).toBe(await direct.text());
    // The API's own answer, so none of the console's headers.
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("a console file answers without a token", async () => {
    const { get } = harness(await builtConsole());

    const script = await get("/assets/index-3f2a9c.js");
    const page = await get("/");

    expect(script.status).toBe(200);
    expect(await script.text()).toBe(SCRIPT);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
  });

  it("files under /assets/ are served immutable and index.html is served no-cache", async () => {
    const { get } = harness(await builtConsole());

    const asset = await get("/assets/index-3f2a9c.js");
    const root = await get("/");
    const page = await get("/workers");
    const index = await get("/index.html");
    const favicon = await get("/favicon.svg");
    const missing = await get("/assets/missing.js");

    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const response of [root, page, index, favicon, missing]) {
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("every console response carries the Content-Security-Policy from ADR 0011", async () => {
    const { get } = harness(await builtConsole());
    const responses = await Promise.all([
      get("/"),
      get("/workers"),
      get("/assets/index-3f2a9c.js"),
      get("/favicon.svg"),
      get("/assets/missing.js"),
      get("/", { method: "HEAD" }),
      get("/", { method: "POST" }),
    ]);

    expect(CONSOLE_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    );
    for (const response of responses) {
      expect(response.headers.get("content-security-policy")).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("answers 404 to a method other than GET or HEAD on a console path", async () => {
    const { get } = harness(await builtConsole());

    const head = await get("/workers", { method: "HEAD" });
    const post = await get("/workers", { method: "POST" });

    expect(head.status).toBe(200);
    expect(post.status).toBe(404);
  });

  it("answers 404 on the page and on files when the console is not built", async () => {
    const root = await emptyRoot();
    // A stray file in an unbuilt root is still not served: without index.html there is no console.
    await writeFile(join(root, "favicon.svg"), "<svg/>");
    const { get } = harness(root);

    expect((await get("/")).status).toBe(404);
    expect((await get("/workers")).status).toBe(404);
    expect((await get("/favicon.svg")).status).toBe(404);
    expect((await get("/assets/index-3f2a9c.js")).status).toBe(404);
    expect((await get("/v1/healthz")).status).toBe(200);
  });
});

describe("HttpGateway", () => {
  async function started(
    root: string,
    onServerCreated?: (server: Server) => void,
    fetch: (request: Request) => Response | Promise<Response> = () => new Response("api"),
  ) {
    const logSink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(0), sink: logSink });
    const gateway = new HttpGateway(
      { fetch },
      {
        consoleRoot: root,
        host: "127.0.0.1",
        logger,
        port: 0,
        ...(onServerCreated === undefined ? {} : { onServerCreated }),
      },
    );
    const { port } = await gateway.start();
    const warnings = () =>
      logSink.records.filter((record) => record.level === "warn").map((r) => r.message);
    return { gateway, port, warnings };
  }

  it("serves the console page at / on its listener, with no warning when it is built", async () => {
    const { gateway, port, warnings } = await started(await builtConsole());
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      const api = await fetch(`http://127.0.0.1:${port}/v1/healthz`);

      expect(page.status).toBe(200);
      expect(await page.text()).toBe(PAGE);
      expect(await api.text()).toBe("api");
      expect(warnings()).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it("the HTTP listener has no total request time limit, so a slow upload that keeps moving is not cut", async () => {
    let created: Server | undefined;
    const { gateway } = await started(await emptyRoot(), (server) => {
      created = server;
    });
    try {
      expect(created?.requestTimeout).toBe(0);
    } finally {
      await gateway.stop();
    }
  });

  it("an upload refused after its first bytes were read is answered, then its connection is cut while the client still sends, even when the adapter's half-close never becomes a close", async () => {
    const refuseAfterFirstChunk = async (request: Request) => {
      await request.body?.getReader().read();
      return new Response("refused", { status: 503 });
    };
    const { gateway, port } = await started(await emptyRoot(), undefined, refuseAfterFirstChunk);
    // why: on the macOS gateway in issue 1810 the adapter's `destroySoon()` sent the FIN and the close never followed; this holds the socket in that state.
    const halfCloseOnly = vi.spyOn(Socket.prototype, "destroySoon").mockImplementation(function (
      this: Socket,
    ) {
      this.end();
    });
    const client = connect({ allowHalfOpen: true, host: "127.0.0.1", port });
    const sending = setInterval(() => client.write(Buffer.alloc(64 * 1024)), 5);
    try {
      let received = "";
      client.on("data", (chunk: Buffer) => (received += chunk.toString()));
      client.on("error", () => undefined);
      const cut = new Promise<boolean>((resolve) => {
        client.once("close", () => resolve(true));
        setTimeout(() => resolve(false), 8_000);
      });
      client.write(
        "PUT /v1/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 1099511627776\r\n\r\n",
      );

      const wasCut = await cut;

      expect(received).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n[\s\S]*\r\nrefused/);
      expect(wasCut).toBe(true);
    } finally {
      clearInterval(sending);
      halfCloseOnly.mockRestore();
      client.destroy();
      await gateway.stop();
    }
  }, 15_000);

  it("a request whose whole body arrived keeps its connection open for the next request, though the app never read the body", async () => {
    const { gateway, port } = await started(await emptyRoot());
    const client = connect({ host: "127.0.0.1", port });
    try {
      let received = "";
      client.on("data", (chunk: Buffer) => (received += chunk.toString()));
      const put = "PUT /v1/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\n\r\nbody";
      client.write(put);
      await vi.waitFor(() => expect(received).toMatch(/\r\napi\r\n0\r\n\r\n$/));
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      client.write("GET /v1/healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");

      await vi.waitFor(() => expect(received.match(/\r\napi\r\n/g)).toHaveLength(2));
      expect(client.destroyed).toBe(false);
    } finally {
      client.destroy();
      await gateway.stop();
    }
  }, 15_000);
});
