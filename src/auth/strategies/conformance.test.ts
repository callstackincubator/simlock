import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../../contract/index.js";
import { FakeClock, FakeKeySetFetcher, NoopLogger } from "../../ports/index.js";
import type { AuthDeps } from "../strategy.js";
import {
  authConfigWith,
  createTestKey,
  keySetBody,
  personClaims,
  PROXY_NOW,
  proxyRequest,
} from "../testing.js";
import { authStrategies } from "./index.js";
import { tokenFixture } from "./token/testing.js";

interface Fixture {
  readonly deps: typeof tokenFixture.deps;
  readonly goodRequest: typeof tokenFixture.goodRequest;
}

const proxyKey = await createTestKey("ES256", "k1");
const proxyJwt = await proxyKey.sign(personClaims());

const proxyFixture: Fixture = {
  deps(): AuthDeps {
    const keySetFetcher = new FakeKeySetFetcher();
    keySetFetcher.answer({ status: 200, body: keySetBody(proxyKey) });
    return {
      config: authConfigWith(),
      tokens: { verify: async () => undefined },
      clock: new FakeClock(PROXY_NOW),
      logger: new NoopLogger(),
      keySetFetcher,
    };
  },
  goodRequest: () => ({ headers: proxyRequest(proxyJwt) }),
};

const fixtures: Record<string, Fixture> = { token: tokenFixture, proxy: proxyFixture };

describe.each(authStrategies.map((definition) => ({ definition })))(
  "the $definition.name strategy",
  ({ definition }) => {
    const fixture = fixtures[definition.name];

    it("answers not-mine with no credential of its kind", async () => {
      const strategy = definition.create(fixture!.deps());

      for (const authorization of [undefined, "Basic x"]) {
        const headers = new Headers(authorization === undefined ? {} : { authorization });
        await expect(strategy.authenticate({ headers })).resolves.toMatchObject({
          kind: "not-mine",
        });
      }
    });

    it("identifies its good request with a principal, a name and via equal to its name", async () => {
      const strategy = definition.create(fixture!.deps());

      const answer = await strategy.authenticate(fixture!.goodRequest());

      expect(answer.kind).toBe("identified");
      if (answer.kind !== "identified") return;
      expect(answer.identity.principal).toEqual(expect.any(String));
      expect(answer.identity.principal).not.toBe("");
      expect(answer.identity.name).toEqual(expect.any(String));
      expect(answer.identity.name).not.toBe("");
      expect(answer.identity.via).toBe(definition.name);
    });
  },
);

describe("the strategy registry and identity.get", () => {
  it("every registered strategy's name is a value of identity.get's via enum", () => {
    const via: readonly string[] = OPERATIONS["identity.get"].output.shape.via.options;

    expect(authStrategies.length).toBeGreaterThan(0);
    for (const definition of authStrategies) expect(via).toContain(definition.name);
  });
});
