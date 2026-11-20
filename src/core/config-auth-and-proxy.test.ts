import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AuthStrategyDefinition } from "../auth/index.js";
import { MemoryFilesystem } from "../ports/index.js";
import { type Config, loadConfig } from "./index.js";
import { dottedValue, configPath, createStats } from "./test-config.js";

describe("loadConfig over the auth strategies' config keys", () => {
  const fake: AuthStrategyDefinition = {
    name: "fake",
    config: {
      key: "fake",
      schema: z.object({ limit: z.number().int().positive() }),
      defaults: { limit: 5 },
    },
    enabled: () => true,
    create: () => ({ authenticate: async () => ({ kind: "not-mine", sawCredential: false }) }),
  };

  async function load(http: unknown) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ http }));
    return loadConfig({
      authStrategies: [fake],
      configPath,
      filesystem,
      systemStats: createStats(),
    });
  }

  it("fills a registered strategy's defaults and validates the key it owns", async () => {
    expect(dottedValue(await load({}), "http.fake.limit")).toBe(5);
    expect(dottedValue(await load({ fake: { limit: 9 } }), "http.fake.limit")).toBe(9);
    await expect(load({ fake: { limit: "many" } })).rejects.toThrow("http.fake");
  });
});

describe("loadConfig over http.proxyAuth", () => {
  const complete = {
    header: "cf-access-jwt-assertion",
    jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    issuer: "https://team.cloudflareaccess.com",
    audience: "4f1c0e",
  };

  async function load(proxyAuth: unknown) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      configPath,
      JSON.stringify(proxyAuth === undefined ? {} : { http: { proxyAuth } }),
    );
    return loadConfig({ configPath, filesystem, systemStats: createStats() });
  }

  function proxyAuthOf(config: Config): unknown {
    return dottedValue(config, "http.proxyAuth");
  }

  it("starts with proxy sign-in off when http.proxyAuth is not set, and on with the four keys", async () => {
    expect(proxyAuthOf(await load(undefined))).toBeUndefined();
    expect(proxyAuthOf(await load(complete))).toEqual(complete);
    expect(proxyAuthOf(await load({ ...complete, signOutUrl: "http://localhost:1/out" }))).toEqual({
      ...complete,
      signOutUrl: "http://localhost:1/out",
    });
  });

  it.each(["http://127.0.0.1:9000/keys", "http://localhost:9000/keys", "http://[::1]:9000/keys"])(
    "accepts the key URL %s over http on the local host",
    async (jwksUrl) => {
      expect(proxyAuthOf(await load({ ...complete, jwksUrl }))).toEqual({ ...complete, jwksUrl });
    },
  );

  it("refuses a key URL that is neither https nor http on 127.0.0.1, ::1 or localhost, naming the key", async () => {
    await expect(load(complete)).resolves.toBeDefined();

    for (const jwksUrl of ["http://keys.team.dev/certs", "not a url"]) {
      await expect(load({ ...complete, jwksUrl }), jwksUrl).rejects.toThrow(
        'Invalid config value for "http.proxyAuth.jwksUrl": expected an https:// URL, or http:// on 127.0.0.1, ::1 or localhost',
      );
    }
  });

  it("refuses an incomplete set, naming the first missing key", async () => {
    await expect(load(complete)).resolves.toBeDefined();

    for (const missing of ["header", "jwksUrl", "issuer", "audience"] as const) {
      const rest = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== missing));
      await expect(load(rest), missing).rejects.toThrow(
        `Invalid config value for "http.proxyAuth.${missing}": expected set with the other http.proxyAuth keys`,
      );
    }
    await expect(load({ header: complete.header })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.jwksUrl": expected set with the other http.proxyAuth keys',
    );
    await expect(load({ signOutUrl: "https://team.dev/out" })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.header": expected set with the other http.proxyAuth keys',
    );
  });

  it("accepts a header written in any case, and refuses one that is not an HTTP header name", async () => {
    expect(
      proxyAuthOf(await load({ ...complete, header: "Cf-Access-Jwt-Assertion" })),
    ).toMatchObject({ header: "Cf-Access-Jwt-Assertion" });

    await expect(load({ ...complete, header: "x bad" })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.header": expected an HTTP header name',
    );
  });

  it("bounds the header name to 64 characters, the audience to 512, and refuses an empty issuer or audience", async () => {
    await expect(load({ ...complete, header: "h".repeat(64) })).resolves.toBeDefined();
    await expect(load({ ...complete, header: "h".repeat(65) })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.header": expected an HTTP header name',
    );
    await expect(load({ ...complete, audience: "a".repeat(512) })).resolves.toBeDefined();
    await expect(load({ ...complete, audience: "a".repeat(513) })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.audience": expected at most 512 characters',
    );
    await expect(load({ ...complete, issuer: "" })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.issuer": expected a non-empty string',
    );
    await expect(load({ ...complete, audience: "" })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.audience": expected a non-empty string',
    );
  });

  it("accepts a proxy sign-in URL and refuses non-web URLs", async () => {
    const signInUrl = "https://login.example.test/start";
    expect(proxyAuthOf(await load({ ...complete, signInUrl }))).toEqual({ ...complete, signInUrl });
    const longest = "https://login.example.test/".padEnd(2048, "a");
    expect(proxyAuthOf(await load({ ...complete, signInUrl: longest }))).toEqual({
      ...complete,
      signInUrl: longest,
    });
    await expect(load({ ...complete, signInUrl: longest + "a" })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.signInUrl": expected an http:// or https:// URL of at most 2048 characters',
    );
    const template = "https://fleet.example.com/oauth2/start?rd={path}";
    expect(proxyAuthOf(await load({ ...complete, signInUrl: template }))).toEqual({
      ...complete,
      signInUrl: template,
    });
    for (const signInUrl of [
      "javascript:alert(1)",
      "//login.example.test/start",
      "not a url",
      "{path}",
      "{path}://login.example.test/start",
    ]) {
      await expect(load({ ...complete, signInUrl })).rejects.toThrow(
        'Invalid config value for "http.proxyAuth.signInUrl"',
      );
    }
  });

  it("refuses a sign-out URL that is not an http or https URL", async () => {
    for (const signOutUrl of ["not a url", "ftp://team.dev/out"]) {
      await expect(load({ ...complete, signOutUrl }), signOutUrl).rejects.toThrow(
        'Invalid config value for "http.proxyAuth.signOutUrl": expected an http:// or https:// URL',
      );
    }
  });

  it("refuses a wrong-type header, jwksUrl or signOutUrl with our message", async () => {
    const cases = [
      ["header", "an HTTP header name"],
      ["jwksUrl", "an https:// URL, or http:// on 127.0.0.1, ::1 or localhost"],
      ["signOutUrl", "an http:// or https:// URL"],
    ] as const;
    for (const [key, message] of cases) {
      await expect(load({ ...complete, [key]: 7 }), key).rejects.toThrow(
        `Invalid config value for "http.proxyAuth.${key}": expected ${message}`,
      );
    }
  });

  it("accepts an issuer of 128 characters and refuses one of 129", async () => {
    await expect(load({ ...complete, issuer: "i".repeat(128) })).resolves.toBeDefined();

    await expect(load({ ...complete, issuer: "i".repeat(129) })).rejects.toThrow(
      'Invalid config value for "http.proxyAuth.issuer": expected at most 128 characters',
    );
  });
});
