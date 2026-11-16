import { describe, expect, it } from "vitest";
import { streamModule } from "../stream/index.js";
import { createStreamMount } from "../stream/testing.js";
import { agentAuth, buildHarness, operatorAuth, readSseFrames } from "./test-app.js";

// why: the stream index exports only the definition, so a registry reads no module code; the real mount is reached through `testing.ts` to prove the listed route against the real handler.
describe("the stream mount's listed route", () => {
  it("is the route its handler answers: the listed path gets a status the definition lists, and /v1/stream/x gets its listed 404", async () => {
    const route = streamModule.http?.routes[0];
    if (route === undefined) throw new Error("the stream definition lists no route");
    const link = {
      serve: () =>
        Promise.resolve({
          body: new ReadableStream<Uint8Array>(),
          close: () => Promise.resolve(),
          meta: { codec: "h264" as const, fps: 30, height: 720, width: 330 },
        }),
    };
    const { app } = buildHarness({
      mounts: [{ prefix: "stream", ...createStreamMount({ link }) }],
    });
    const listed = Object.keys(route.statuses).map(Number);
    const answer = (path: string, method = "GET") =>
      app.request(path, { headers: agentAuth, method });

    const listedPath = route.path.replace("{workerId}", "w1").replace("{deviceId}", "dev_1");
    const found = await answer(listedPath);
    const other = await answer("/v1/stream/x");
    const wrongMethod = await answer(listedPath, "POST");

    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("application/vnd.simlock.stream+h264");
    expect([other.status, wrongMethod.status]).toEqual([404, 405]);
    expect(listed).toEqual(
      expect.arrayContaining([found.status, other.status, wrongMethod.status]),
    );
    expect(await other.json()).toMatchObject({ error: { code: "UNKNOWN_DEVICE" } });
    await found.body?.cancel();
  });
});

describe("ETag on a JSON read under /v1", () => {
  it("304 and no body for an unchanged read, 200 for a stale tag, a new ETag once the data changes, no ETag on a 404 or a mount", async () => {
    const tokens: { id: string }[] = [{ id: "tok_1" }];
    const { app, dispatcher, eventBus } = buildHarness({
      mounts: [
        {
          prefix: "json-mount",
          handle: () => Response.json({ ok: true }),
        },
      ] as never,
    });
    dispatcher.handlers["token.list"] = () => ({ tokens: [...tokens] });
    dispatcher.handlers["events.subscribe"] = (_input, session) => ({
      subscribed: true,
      subscriptionId: session.manageEventSubscription(true),
    });
    const read = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { ...operatorAuth, ...headers } });

    const first = await read("/v1/tokens");
    const tag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(tag).toMatch(/^"[^"]+"$/);

    const unchanged = await read("/v1/tokens", { "If-None-Match": tag ?? "" });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(tag);

    const stale = await read("/v1/tokens", { "If-None-Match": '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).toBe(tag);

    tokens.push({ id: "tok_2" });
    const changed = await read("/v1/tokens", { "If-None-Match": tag ?? "" });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);

    const missing = await read("/v1/leases/lse_none");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("etag")).toBeNull();

    const mount = await read("/v1/json-mount/x");
    expect(mount.status).toBe(200);
    expect(mount.headers.get("content-type")).toContain("application/json");
    expect(mount.headers.get("etag")).toBeNull();

    const streamOrStall = await Promise.race([
      read("/v1/events/stream"),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 500)),
    ]);
    if (streamOrStall === "stalled") expect.fail("the event stream was buffered, not answered");
    const stream = streamOrStall;
    expect(stream.headers.get("etag")).toBeNull();
    const framesPromise = readSseFrames(stream, 1);
    await Promise.resolve();
    eventBus.emit("daemon.stopping", { reason: "live" }, "test");
    expect((await framesPromise)[0]?.event).toBe("daemon.stopping");
  });
});

describe("Cache-Control on a JSON answer under /v1", () => {
  it("a JSON read, its 304, a JSON error and /v1/healthz each carry Cache-Control: no-store, so a CDN never stores an answer, and a mount's answer keeps the Cache-Control it set", async () => {
    const { app, dispatcher } = buildHarness({
      mounts: [
        { prefix: "json-mount", handle: () => Response.json({ ok: true }) },
        {
          prefix: "cached-mount",
          handle: () => Response.json({ ok: true }, { headers: { "Cache-Control": "max-age=60" } }),
        },
      ] as never,
    });
    dispatcher.handlers["token.list"] = () => ({ tokens: [{ id: "tok_1" }] });
    const read = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { ...operatorAuth, ...headers } });

    const first = await read("/v1/tokens");
    const unchanged = await read("/v1/tokens", {
      "If-None-Match": first.headers.get("etag") ?? "",
    });
    const missing = await read("/v1/leases/lse_none");
    const health = await app.request("/v1/healthz");
    const plainMount = await read("/v1/json-mount");
    const cachedMount = await read("/v1/cached-mount");

    expect([first.status, unchanged.status, missing.status, health.status]).toEqual([
      200, 304, 404, 200,
    ]);
    expect({
      plain: plainMount.headers.get("cache-control"),
      cached: cachedMount.headers.get("cache-control"),
    }).toEqual({ plain: null, cached: "max-age=60" });
    expect({
      read: first.headers.get("cache-control"),
      notModified: unchanged.headers.get("cache-control"),
      error: missing.headers.get("cache-control"),
      healthz: health.headers.get("cache-control"),
    }).toEqual({
      read: "no-store",
      notModified: "no-store",
      error: "no-store",
      healthz: "no-store",
    });
  });
});
