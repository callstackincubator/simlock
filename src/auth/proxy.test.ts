import { describe, expect, it } from "vitest";

import {
  CryptoTokenSecrets,
  FakeClock,
  FakeKeySetFetcher,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { AuthError, createAuth, type Identity, tokensOwner } from "./index.js";
import {
  authConfigWith,
  createTestKey,
  keySetBody,
  personClaims,
  PROXY_NOW,
  proxyAuthConfig,
  proxyRequest,
  signWithHmac,
  type TestKey,
  unsigned,
  withAlteredSignature,
  openMemoryStateDatabase,
} from "./testing.js";

const k1 = await createTestKey("ES256", "k1");
const k1Rsa = await createTestKey("RS256", "k1");
const k2 = await createTestKey("ES256", "k2");
const unlisted = await createTestKey("ES256", "zz");

const NOW_SECONDS = Math.floor(PROXY_NOW / 1000);
const MINUTE = 60_000;

type Outcome =
  | { readonly identity: Identity }
  | { readonly status: number; readonly message: string; readonly details?: unknown };

async function harness(
  options: { proxyAuth?: Record<string, unknown> | null; keys?: readonly TestKey[] } = {},
) {
  const clock = new FakeClock(PROXY_NOW);
  const keySetFetcher = new FakeKeySetFetcher();
  keySetFetcher.answer({ status: 200, body: keySetBody(...(options.keys ?? [k1])) });
  const sink = new MemoryLogSink();
  const filesystem = new MemoryFilesystem();
  const proxyAuth = options.proxyAuth === undefined ? proxyAuthConfig : options.proxyAuth;
  const auth = createAuth({
    config:
      proxyAuth === null
        ? { enabled: true, host: "127.0.0.1", port: 4700 }
        : authConfigWith(proxyAuth),
    dataDirectory: "/home/agent/.simlock",
    database: (await openMemoryStateDatabase([tokensOwner])).database,
    filesystem,
    secrets: new CryptoTokenSecrets(),
    idGenerator: { generate: () => "id" },
    clock,
    logger: new JsonLinesLogger({ clock, sink }),
    keySetFetcher,
  });
  return { auth, clock, keySetFetcher, sink };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function outcome(auth: Harness["auth"], headers: Headers): Promise<Outcome> {
  try {
    return { identity: await auth.authenticateRequest(headers) };
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return {
      status: error.status,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
}

function refused(reason: string): Outcome {
  return {
    status: 401,
    message: `Sign-in proxy identity refused: ${reason}`,
    details: { reason },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function person(identity: Partial<Identity> = {}): Outcome {
  return {
    identity: {
      principal: "proxy:iss1#u1",
      name: "a@x",
      role: "operator",
      via: "proxy",
      ambient: true,
      expiresAt: (NOW_SECONDS + 300) * 1000 + 60_000,
      ...identity,
    },
  };
}

describe("authenticateRequest with the proxy strategy", () => {
  it.each([
    { alg: "ES256", key: k1 },
    { alg: "RS256", key: k1Rsa },
  ])("identifies a $alg JWT signed by a published key as an operator person", async ({ key }) => {
    const { auth } = await harness({ keys: [key] });

    const answer = await outcome(auth, proxyRequest(await key.sign(personClaims())));

    expect(answer).toEqual(person());
  });

  it("gives the person the proxy's name claim when it is a non-empty string, else their email", async () => {
    const { auth } = await harness();

    expect(await outcome(auth, proxyRequest(await k1.sign(personClaims())))).toEqual(person());
    for (const [name, expected] of [
      ["Alice", "Alice"],
      [123, "a@x"],
      ["", "a@x"],
    ] as const) {
      const answer = await outcome(auth, proxyRequest(await k1.sign(personClaims({ name }))));
      expect(answer, JSON.stringify(name)).toEqual(person({ name: expected }));
    }
  });

  it("carries the configured sign-out URL on the person", async () => {
    const signOutUrl = "https://team.example/cdn-cgi/access/logout";
    const withUrl = await harness({ proxyAuth: { ...proxyAuthConfig, signOutUrl } });
    const without = await harness();
    const jwt = await k1.sign(personClaims());

    expect(await outcome(withUrl.auth, proxyRequest(jwt))).toEqual(person({ signOutUrl }));
    expect(await outcome(without.auth, proxyRequest(jwt))).toEqual(person());
  });

  it("accepts an audience list holding the configured one and an exp up to 60 s past, and refuses an exp 61 s past", async () => {
    const { auth } = await harness();
    const exp = (secondsFromNow: number) => NOW_SECONDS + secondsFromNow;
    const expiresAt = (secondsFromNow: number) => exp(secondsFromNow) * 1000 + 60_000;

    expect(
      await outcome(auth, proxyRequest(await k1.sign(personClaims({ aud: ["other", "aud1"] })))),
    ).toEqual(person());
    expect(
      await outcome(auth, proxyRequest(await k1.sign(personClaims({ exp: exp(-30) })))),
    ).toEqual(person({ expiresAt: expiresAt(-30) }));
    expect(
      await outcome(auth, proxyRequest(await k1.sign(personClaims({ exp: exp(-61) })))),
    ).toEqual(refused("expired"));
  });

  it("refuses a JWT it cannot trust with a 401 and the reason", async () => {
    const { auth } = await harness();
    const good = await k1.sign(personClaims());
    expect(await outcome(auth, proxyRequest(good))).toEqual(person());
    const rows: ReadonlyArray<readonly [string, string | Promise<string>]> = [
      ["malformed", k1.sign(personClaims({ exp: undefined }))],
      ["not-yet-valid", k1.sign(personClaims({ nbf: NOW_SECONDS + 61 }))],
      ["wrong-issuer", k1.sign(personClaims({ iss: "iss2" }))],
      ["wrong-audience", k1.sign(personClaims({ aud: "aud2" }))],
      ["algorithm", signWithHmac(personClaims())],
      ["algorithm", unsigned(personClaims())],
      ["unknown-key", unlisted.sign(personClaims())],
      ["bad-signature", withAlteredSignature(good)],
      ["malformed", "abc.def"],
      ["malformed", k1.sign(personClaims({ sub: "s".repeat(121) }))],
    ];

    for (const [reason, jwt] of rows) {
      expect(await outcome(auth, proxyRequest(await jwt)), reason).toEqual(refused(reason));
    }
  });

  it("accepts a sub of 120 characters", async () => {
    const { auth } = await harness();
    const sub = "s".repeat(120);

    const answer = await outcome(auth, proxyRequest(await k1.sign(personClaims({ sub }))));

    expect(answer).toEqual(person({ principal: `proxy:iss1#${sub}` }));
  });

  it("refuses a header over 8 KiB as malformed without asking the key URL", async () => {
    const { auth, keySetFetcher } = await harness();

    const answer = await outcome(auth, proxyRequest("e".repeat(8 * 1024 + 1)));

    expect(answer).toEqual(refused("malformed"));
    expect(keySetFetcher.urls).toHaveLength(0);
  });

  it("does not take a verified JWT with no person claims for a person: its Simlock token decides", async () => {
    const { auth } = await harness();
    const { secret } = await auth.tokens.create("agent", "ci");
    const withToken = (jwt: string) => {
      const headers = proxyRequest(jwt);
      headers.set("authorization", `Bearer ${secret}`);
      return headers;
    };
    expect(await outcome(auth, proxyRequest(await k1.sign(personClaims())))).toEqual(person());

    for (const claims of [{ sub: "" }, { email: undefined }, { email: "" }, { email: 5 }]) {
      const jwt = await k1.sign(personClaims(claims));
      expect(await outcome(auth, proxyRequest(jwt)), JSON.stringify(claims)).toEqual({
        status: 401,
        message: "Missing bearer token",
      });
      expect(await outcome(auth, withToken(jwt)), JSON.stringify(claims)).toMatchObject({
        identity: { via: "token", name: "ci" },
      });
    }
  });

  it("matches the configured header name without regard to case", async () => {
    const jwt = await k1.sign(personClaims());

    for (const [configured, sent] of [
      ["Cf-Access-Jwt-Assertion", "cf-access-jwt-assertion"],
      ["cf-access-jwt-assertion", "Cf-Access-Jwt-Assertion"],
    ] as const) {
      const { auth } = await harness({ proxyAuth: { ...proxyAuthConfig, header: configured } });
      expect(await outcome(auth, proxyRequest(jwt, sent)), `${configured} / ${sent}`).toEqual(
        person(),
      );
    }
  });

  it("sends a Bearer value to the token strategy when it starts slk_ and to the proxy check otherwise, with header authorization", async () => {
    const { auth } = await harness({ proxyAuth: { ...proxyAuthConfig, header: "authorization" } });
    const { secret } = await auth.tokens.create("agent", "ci");
    const bearer = (value: string) => new Headers({ authorization: `Bearer ${value}` });

    expect(await outcome(auth, bearer(secret))).toMatchObject({ identity: { via: "token" } });
    expect(await outcome(auth, bearer(await k1.sign(personClaims())))).toEqual(person());
    expect(await outcome(auth, bearer("abc"))).toEqual(refused("malformed"));
    expect(await outcome(auth, bearer("slk_unknown"))).toEqual({
      status: 401,
      message: "Unknown bearer token",
    });
  });

  it("takes header authorization written with capitals as authorization", async () => {
    const { auth } = await harness({ proxyAuth: { ...proxyAuthConfig, header: "Authorization" } });
    const { secret } = await auth.tokens.create("agent", "ci");

    expect(await outcome(auth, new Headers({ authorization: `Bearer ${secret}` }))).toMatchObject({
      identity: { via: "token" },
    });
    expect(
      await outcome(
        auth,
        new Headers({ authorization: `Bearer ${await k1.sign(personClaims())}` }),
      ),
    ).toEqual(person());
  });

  it("keeps answering Unknown bearer token for a Bearer value that is not a token when proxy sign-in is off", async () => {
    const { auth } = await harness({ proxyAuth: null });

    expect(await outcome(auth, new Headers({ authorization: "Bearer abc" }))).toEqual({
      status: 401,
      message: "Unknown bearer token",
    });
    expect(await outcome(auth, proxyRequest(await k1.sign(personClaims())))).toEqual({
      status: 401,
      message: "Missing bearer token",
    });
  });

  it("answers the token's identity when a good slk_ token and a good JWT are both sent", async () => {
    const { auth } = await harness();
    const { secret, record } = await auth.tokens.create("agent", "ci");
    const jwt = await k1.sign(personClaims());
    expect(await outcome(auth, proxyRequest(jwt))).toEqual(person());
    const headers = proxyRequest(jwt);
    headers.set("authorization", `Bearer ${secret}`);

    const answer = await outcome(auth, headers);

    expect(answer).toMatchObject({ identity: { principal: record.id, via: "token" } });
  });

  it("logs one warn line with the reason for a refused JWT, and never the JWT", async () => {
    const { auth, sink } = await harness();
    const good = await k1.sign(personClaims());
    expect(await outcome(auth, proxyRequest(good))).toEqual(person());
    expect(sink.records.filter((record) => record.level === "warn")).toHaveLength(0);
    const expired = await k1.sign(personClaims({ exp: NOW_SECONDS - 120 }));

    expect(await outcome(auth, proxyRequest(expired))).toEqual(refused("expired"));

    const warnings = sink.records.filter((record) => record.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("expired");
    expect(JSON.stringify(sink.records)).not.toContain(expired);
  });
});

describe("the proxy strategy's key URL", () => {
  it.each([
    ["answers 500", (fetcher: FakeKeySetFetcher) => fetcher.answer({ status: 500, body: "" })],
    [
      "answers a redirect",
      (fetcher: FakeKeySetFetcher) => fetcher.answer({ status: 302, body: keySetBody(k1) }),
    ],
    [
      "answers a body that is not JSON",
      (fetcher: FakeKeySetFetcher) => fetcher.answer({ status: 200, body: "not json" }),
    ],
    [
      "answers an object with no keys",
      (fetcher: FakeKeySetFetcher) => fetcher.answer({ status: 200, body: "{}" }),
    ],
    [
      "answers a body over 64 KiB",
      (fetcher: FakeKeySetFetcher) =>
        fetcher.answer({
          status: 200,
          body: JSON.stringify({ keys: [k1.publicJwk], padding: "p".repeat(64 * 1024) }),
        }),
    ],
    [
      "fails on the network",
      (fetcher: FakeKeySetFetcher) => fetcher.fail(new Error("connect ECONNREFUSED")),
    ],
  ])("is keys-unavailable when it %s and no keys were fetched", async (_title, script) => {
    const { auth, keySetFetcher } = await harness();
    const jwt = await k1.sign(personClaims());
    expect(await outcome(auth, proxyRequest(jwt))).toEqual(person());
    const failing = await harness();
    script(failing.keySetFetcher);

    expect(await outcome(failing.auth, proxyRequest(jwt))).toEqual(refused("keys-unavailable"));
    expect(keySetFetcher.urls).toEqual([proxyAuthConfig.jwksUrl]);
    expect(failing.keySetFetcher.urls).toEqual([proxyAuthConfig.jwksUrl]);
  });

  it("is keys-unavailable when it gives no answer within 5 s, and not before", async () => {
    const { auth, clock, keySetFetcher } = await harness();
    keySetFetcher.hang();
    const settled: Outcome[] = [];
    const pending = outcome(auth, proxyRequest(await k1.sign(personClaims()))).then((answer) => {
      settled.push(answer);
    });
    await flush();
    expect(keySetFetcher.urls).toHaveLength(1);

    clock.advance(4_999);
    await flush();
    expect(settled).toEqual([]);
    expect(keySetFetcher.signals[0]?.aborted).toBe(false);
    clock.advance(1);
    await flush();

    expect(settled).toEqual([refused("keys-unavailable")]);
    await pending;
    expect(keySetFetcher.signals[0]?.aborted).toBe(true);
  });

  it("serves a second JWT from the keys it holds and fetches again once they are 10 minutes old", async () => {
    const { auth, clock, keySetFetcher } = await harness();
    const jwt = () => k1.sign(personClaims({ exp: NOW_SECONDS + 3600 }));

    await outcome(auth, proxyRequest(await jwt()));
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { via: "proxy" },
    });
    expect(keySetFetcher.urls).toHaveLength(1);

    clock.advance(10 * MINUTE - MINUTE);
    await outcome(auth, proxyRequest(await jwt()));
    expect(keySetFetcher.urls).toHaveLength(1);

    clock.advance(2 * MINUTE);
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { via: "proxy" },
    });
    expect(keySetFetcher.urls).toHaveLength(2);
  });

  it("keeps verifying with keys under 10 minutes old when a fetch fails, and drops them past 10 minutes", async () => {
    const { auth, clock, keySetFetcher } = await harness();
    const jwt = () => k1.sign(personClaims({ exp: NOW_SECONDS + 3600 }));
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { via: "proxy" },
    });
    keySetFetcher.fail(new Error("connect ECONNREFUSED"));

    clock.advance(31_000);
    expect(await outcome(auth, proxyRequest(await unlisted.sign(personClaims())))).toEqual(
      refused("unknown-key"),
    );
    expect(keySetFetcher.urls).toHaveLength(2);
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { via: "proxy" },
    });

    clock.advance(10 * MINUTE - 1_000 - 31_000);
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { via: "proxy" },
    });

    clock.advance(2_000);
    expect(await outcome(auth, proxyRequest(await jwt()))).toEqual(refused("keys-unavailable"));
  });

  it("refetches for an unknown key id at most once per 30 s from the last good fetch", async () => {
    const { auth, clock, keySetFetcher } = await harness();
    const jwt = () => k2.sign(personClaims({ exp: NOW_SECONDS + 3600 }));

    expect(await outcome(auth, proxyRequest(await jwt()))).toEqual(refused("unknown-key"));
    expect(keySetFetcher.urls).toHaveLength(1);
    keySetFetcher.answer({ status: 200, body: keySetBody(k1, k2) });

    clock.advance(29_000);
    expect(await outcome(auth, proxyRequest(await jwt()))).toEqual(refused("unknown-key"));
    expect(keySetFetcher.urls).toHaveLength(1);

    clock.advance(2_000);
    expect(await outcome(auth, proxyRequest(await jwt()))).toMatchObject({
      identity: { principal: "proxy:iss1#u1" },
    });
    expect(keySetFetcher.urls).toHaveLength(2);
  });

  it("counts the 30 s from the last good fetch, not from a failed attempt", async () => {
    const { auth, clock, keySetFetcher } = await harness();
    const unknown = () => unlisted.sign(personClaims());
    await outcome(auth, proxyRequest(await k1.sign(personClaims())));
    keySetFetcher.fail(new Error("connect ECONNREFUSED"));

    clock.advance(31_000);
    expect(await outcome(auth, proxyRequest(await unknown()))).toEqual(refused("unknown-key"));
    expect(keySetFetcher.urls).toHaveLength(2);

    clock.advance(5_000);
    expect(await outcome(auth, proxyRequest(await unknown()))).toEqual(refused("unknown-key"));
    expect(keySetFetcher.urls).toHaveLength(3);
  });

  it("shares one fetch between JWTs checked at once with an empty cache", async () => {
    const { auth, keySetFetcher } = await harness();
    const held = keySetFetcher.hold();
    const first = outcome(auth, proxyRequest(await k1.sign(personClaims())));
    const second = outcome(auth, proxyRequest(await k1.sign(personClaims({ sub: "u2" }))));
    await flush();
    expect(keySetFetcher.urls).toHaveLength(1);

    held.release({ status: 200, body: keySetBody(k1) });

    expect(await first).toEqual(person());
    expect(await second).toEqual(person({ principal: "proxy:iss1#u2" }));
    expect(keySetFetcher.urls).toHaveLength(1);
  });
});
