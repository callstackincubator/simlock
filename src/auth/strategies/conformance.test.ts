import { describe, expect, it } from "vitest";

import { authStrategies } from "./index.js";
import { tokenFixture } from "./token/testing.js";

interface Fixture {
  readonly deps: typeof tokenFixture.deps;
  readonly goodRequest: typeof tokenFixture.goodRequest;
}

const fixtures: Record<string, Fixture> = { token: tokenFixture };

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
