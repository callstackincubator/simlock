import { describe, expect, it } from "vitest";

import { identityGet } from "../daemon/dispatch.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeKeySetFetcher,
  MemoryFilesystem,
  NoopLogger,
} from "../ports/index.js";
import type { Identity } from "../auth/index.js";
import { createAuth, tokensOwner } from "../auth/index.js";
import {
  authConfigWith,
  createTestKey,
  keySetBody,
  personClaims,
  PROXY_NOW,
  proxyAuthConfig,
  openMemoryStateDatabase,
} from "../auth/testing.js";
import {
  agentAuth,
  buildHarness,
  createLeaseRequest,
  defaultBody,
  readSseFrames,
} from "./test-app.js";
import { makeDevice, makeLease, waitForDispatch } from "./test-fakes.js";

describe("a person the sign-in proxy signed in", () => {
  const signedInAt = 1_000;
  const SIGN_OUT_URL = "https://team.example/cdn-cgi/access/logout";
  const proxyHeaders = { authorization: "Bearer slk_proxy" };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  function proxyPerson(expiresAt: number, signOutUrl?: string): Identity {
    return {
      principal: "proxy:iss1#u1",
      name: "a@x",
      role: "operator",
      via: "proxy",
      ambient: true,
      expiresAt,
      ...(signOutUrl === undefined ? {} : { signOutUrl }),
    };
  }

  function harnessFor(identity: Identity) {
    return buildHarness({ identities: { slk_proxy: identity } });
  }

  function watchEnd(response: Response): { ended(): boolean } {
    let ended = false;
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("response has no body");
    void (async () => {
      while (!(await reader.read()).done);
      ended = true;
    })();
    return { ended: () => ended };
  }

  it("is an admin over HTTP with via proxy, their name and the configured sign-out URL", async () => {
    const { app, dispatcher } = harnessFor(proxyPerson(signedInAt + 120_000, SIGN_OUT_URL));
    dispatcher.handlers["identity.get"] = identityGet;

    const response = await app.request("/v1/identity", { headers: proxyHeaders });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: "proxy:iss1#u1",
      name: "a@x",
      role: "admin",
      via: "proxy",
      signOutUrl: SIGN_OUT_URL,
    });
    expect(dispatcher.calls[0]?.session).toMatchObject({
      role: "admin",
      via: "proxy",
      name: "a@x",
      signOutUrl: SIGN_OUT_URL,
    });
  });

  it("answers a refused JWT with 401 UNAUTHENTICATED, the refusal's message and its reason in the body", async () => {
    const key = await createTestKey("ES256", "k1");
    const keySetFetcher = new FakeKeySetFetcher();
    keySetFetcher.answer({ status: 200, body: keySetBody(key) });
    const clock = new FakeClock(PROXY_NOW);
    const auth = createAuth({
      config: authConfigWith(),
      dataDirectory: "/home/agent/.simlock",
      database: (await openMemoryStateDatabase([tokensOwner])).database,
      filesystem: new MemoryFilesystem(),
      secrets: new CryptoTokenSecrets(),
      idGenerator: { generate: () => "id" },
      clock,
      logger: new NoopLogger(),
      keySetFetcher,
    });
    const { app, dispatcher } = buildHarness({ auth });
    dispatcher.handlers["identity.get"] = identityGet;
    const header = proxyAuthConfig.header;
    const good = await app.request("/v1/identity", {
      headers: { [header]: await key.sign(personClaims()) },
    });
    expect(good.status).toBe(200);

    const expired = await key.sign(personClaims({ exp: Math.floor(PROXY_NOW / 1000) - 120 }));
    const response = await app.request("/v1/identity", { headers: { [header]: expired } });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        message: "Sign-in proxy identity refused: expired",
        reason: "expired",
      },
    });
  });

  describe("follow streams", () => {
    const openers: ReadonlyArray<
      readonly [string, (harness: ReturnType<typeof harnessFor>) => Promise<Response>]
    > = [
      [
        "GET /v1/events/stream",
        async ({ app, dispatcher }) => {
          dispatcher.handlers["events.subscribe"] = (_input, session) => ({
            subscribed: true,
            subscriptionId: session.manageEventSubscription(true),
          });
          return app.request("/v1/events/stream", { headers: proxyHeaders });
        },
      ],
      [
        "GET /v1/leases/{id}/events",
        async ({ app, registry }) => {
          registry.devices = [makeDevice({ id: "dev_1" })];
          registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_other" })];
          return app.request("/v1/leases/lse_1/events", { headers: proxyHeaders });
        },
      ],
      [
        "GET /v1/lease-requests/{id}/events",
        async ({ app, dispatcher }) => {
          const { id } = await createLeaseRequest(app, dispatcher, defaultBody, {
            ...proxyHeaders,
            "sec-fetch-site": "same-origin",
          });
          return app.request(`/v1/lease-requests/${id}/events`, { headers: proxyHeaders });
        },
      ],
    ];

    it.each(openers)("%s ends at the person's expiresAt, not before", async (_route, open) => {
      const harness = harnessFor(proxyPerson(signedInAt + 2 * 60_000));
      const stream = watchEnd(await open(harness));
      await flush();
      expect(stream.ended()).toBe(false);

      harness.clock.advance(2 * 60_000 - 1);
      await flush();
      expect(stream.ended()).toBe(false);
      harness.clock.advance(1);
      await flush();

      expect(stream.ended()).toBe(true);
    });

    it("does not end a stream opened with a token", async () => {
      const harness = buildHarness();
      harness.registry.devices = [makeDevice({ id: "dev_1" })];
      harness.registry.leases = [
        makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" }),
      ];
      const stream = watchEnd(
        await harness.app.request("/v1/leases/lse_1/events", { headers: agentAuth }),
      );

      harness.clock.advance(60 * 60_000);
      await flush();

      expect(stream.ended()).toBe(false);
    });

    it("ends a stream whose expiresAt is 40 days away at the 2^31-1 ms cap", async () => {
      const cap = 2 ** 31 - 1;
      const harness = harnessFor(proxyPerson(signedInAt + 40 * 24 * 60 * 60_000));
      const [, open] = openers[1]!;
      const stream = watchEnd(await open(harness));

      harness.clock.advance(cap - 1);
      await flush();
      expect(stream.ended()).toBe(false);
      harness.clock.advance(1);
      await flush();

      expect(stream.ended()).toBe(true);
    });
  });

  describe("command streams", () => {
    it("keeps an exec stream running past expiresAt", async () => {
      const harness = harnessFor(proxyPerson(signedInAt + 2 * 60_000));
      const responsePromise = harness.app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], tool: "simctl" }),
        headers: {
          ...proxyHeaders,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const call = await waitForDispatch(harness.dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const framesPromise = readSseFrames(response, 2);

      harness.clock.advance(10 * 60_000);
      call.session.onOutput?.("stdout", "late");
      call.resolve({ exitCode: 0 });

      const frames = await framesPromise;
      expect(frames.map((frame) => frame.event)).toEqual(["output", "exit"]);
    });

    it("keeps a component install stream running past expiresAt", async () => {
      const harness = harnessFor(proxyPerson(signedInAt + 2 * 60_000));
      const responsePromise = harness.app.request("/v1/components/install", {
        body: JSON.stringify({ platform: "android", version: "35" }),
        headers: {
          ...proxyHeaders,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const call = await waitForDispatch(harness.dispatcher, "component.install");
      call.session.onStarted?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const framesPromise = readSseFrames(response, 2);

      harness.clock.advance(10 * 60_000);
      call.session.onComponentProgress?.({ stage: "waiting" });
      call.resolve({ component: "35", outcome: "installed", platform: "android", version: "35" });

      const frames = await framesPromise;
      expect(frames.map((frame) => frame.event)).toEqual(["progress", "result"]);
    });
  });

  describe("changing requests", () => {
    const CSRF_BODY = {
      error: {
        code: "FORBIDDEN",
        message:
          "Cross-site request refused: a request signed in through a sign-in proxy must come from the console",
      },
    };
    const changing: ReadonlyArray<readonly [string, string, string, number]> = [
      ["POST", "/v1/workers/w/drain", "worker.drain", 200],
      ["DELETE", "/v1/leases/lse_1", "lease.release", 202],
    ];
    const refused: ReadonlyArray<string | undefined> = [
      "cross-site",
      "same-site",
      "none",
      "Same-Origin",
      "same-origin, cross-site",
      undefined,
    ];

    function changingHarness() {
      const harness = harnessFor(proxyPerson(signedInAt + 120_000));
      harness.registry.devices = [makeDevice({ id: "dev_1" })];
      harness.registry.leases = [
        makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_other" }),
      ];
      harness.dispatcher.handlers["worker.drain"] = () => ({ workerId: "w" });
      harness.dispatcher.handlers["lease.release"] = () => ({ leaseId: "lse_1" });
      return harness;
    }

    function withSite(site: string | undefined): Record<string, string> {
      return site === undefined ? proxyHeaders : { ...proxyHeaders, "sec-fetch-site": site };
    }

    describe.each(changing)("%s %s", (method, path, operation, accepted) => {
      it("is dispatched with Sec-Fetch-Site same-origin", async () => {
        const { app, dispatcher } = changingHarness();

        const response = await app.request(path, { headers: withSite("same-origin"), method });

        expect(response.status).toBe(accepted);
        expect(dispatcher.calls.map((call) => call.operation)).toContain(operation);
      });

      it.each(refused)("is 403 and dispatches nothing with Sec-Fetch-Site %s", async (site) => {
        const { app, dispatcher } = changingHarness();

        const response = await app.request(path, { headers: withSite(site), method });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(CSRF_BODY);
        expect(dispatcher.calls).toEqual([]);
      });
    });

    describe("to a mount", () => {
      function mountedHarness() {
        const seen: string[] = [];
        const harness = buildHarness({
          identities: { slk_proxy: proxyPerson(signedInAt + 120_000) },
          mounts: [
            {
              prefix: "stream",
              handle: (request: Request) => {
                seen.push(request.method);
                return new Response("ok");
              },
            },
          ] as never,
        });
        return { ...harness, seen };
      }

      it.each(["PUT", "PATCH"])(
        "refuses %s with cross-site and does not call it",
        async (method) => {
          const { app, seen } = mountedHarness();

          const response = await app.request("/v1/stream/x", {
            headers: withSite("cross-site"),
            method,
          });

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual(CSRF_BODY);
          expect(seen).toEqual([]);
        },
      );

      it.each(["PUT", "PATCH"])("calls it for %s with same-origin", async (method) => {
        const { app, seen } = mountedHarness();

        const response = await app.request("/v1/stream/x", {
          headers: withSite("same-origin"),
          method,
        });

        expect(response.status).toBe(200);
        expect(seen).toEqual([method]);
      });

      it.each(["GET", "HEAD", "OPTIONS"])("calls it for %s with cross-site", async (method) => {
        const { app, seen } = mountedHarness();

        const response = await app.request("/v1/stream/x", {
          headers: withSite("cross-site"),
          method,
        });

        expect(response.status).toBe(200);
        expect(seen).toEqual([method]);
      });
    });

    it("dispatches GET /v1/leases with cross-site", async () => {
      const { app, dispatcher } = changingHarness();

      const response = await app.request("/v1/leases", { headers: withSite("cross-site") });

      expect(response.status).toBe(200);
      expect(dispatcher.calls.map((call) => call.operation)).toContain("lease.list");
    });

    it("dispatches DELETE /v1/leases/x from a token identity with cross-site", async () => {
      const { app, dispatcher, registry } = buildHarness();
      registry.devices = [makeDevice({ id: "dev_1" })];
      registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
      dispatcher.handlers["lease.release"] = () => ({ leaseId: "lse_1" });

      const response = await app.request("/v1/leases/lse_1", {
        headers: { ...agentAuth, "sec-fetch-site": "cross-site" },
        method: "DELETE",
      });

      expect(response.status).toBe(202);
      expect(dispatcher.calls.map((call) => call.operation)).toContain("lease.release");
    });
  });
});
