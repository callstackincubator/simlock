import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { createHttpApp } from "./app.js";
import { CONSOLE_CONTENT_SECURITY_POLICY, HttpGateway, withConsole } from "./server.js";
import {
  FakeDispatcher,
  FakeRegistry,
  FakeTokenVerifier,
  sequenceIdGenerator,
  testConfig,
} from "./test-fakes.js";

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
  const tokens = new FakeTokenVerifier();
  tokens.register("slk_operator", { requesterId: "tok_operator", role: "operator" });
  const logSink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, sink: logSink });
  const app = createHttpApp({
    clock,
    config: testConfig(),
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leaseRequests: dispatcher.requests,
    logger,
    ownerRoutedFacts: new OwnerRoutedFactBus(eventBus, registry),
    registry,
    tokens,
  });
  const site = withConsole(app, { logger, root });
  const get = (path: string, init: RequestInit = {}) =>
    Promise.resolve(site.fetch(new Request(`http://127.0.0.1:4700${path}`, init)));
  return { app, get, logSink };
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

  it("console requests are not written to the request log", async () => {
    const { get, logSink } = harness(await builtConsole());

    await get("/");
    await get("/workers");
    await get("/assets/index-3f2a9c.js");
    await get("/assets/missing.js");
    await get("/v1/status", { headers: { authorization: "Bearer slk_operator" } });

    const logged = logSink.records
      .filter((record) => record.message === "request")
      .map((record) => record.fields?.path);
    // The API's own request still is: the log is wired, and only console paths skip it.
    expect(logged).toEqual(["/v1/status"]);
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
  async function started(root: string) {
    const logSink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(0), sink: logSink });
    const gateway = new HttpGateway(
      { fetch: () => new Response("api") },
      { consoleRoot: root, host: "127.0.0.1", logger, port: 0 },
    );
    const { port } = await gateway.start();
    const warnings = () =>
      logSink.records.filter((record) => record.level === "warn").map((r) => r.message);
    return { gateway, port, warnings };
  }

  it("the daemon warns once at start when the console is not built", async () => {
    const { gateway, port, warnings } = await started(await emptyRoot());
    try {
      // Already logged once the listener is up, before any request arrives.
      const atStart = warnings();
      const page = await fetch(`http://127.0.0.1:${port}/`);
      await fetch(`http://127.0.0.1:${port}/workers`);

      expect(atStart).toEqual(["The web console is not built; console paths answer 404"]);
      expect(page.status).toBe(404);
      expect(warnings()).toEqual(atStart);
    } finally {
      await gateway.stop();
    }
  });

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
});
