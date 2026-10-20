import { FakeClock, FakeKeySetFetcher, NoopLogger } from "../../../ports/index.js";
import type { AuthConfig, AuthDeps } from "../../strategy.js";
import type { TokenRecord } from "../../tokens.js";

const record: TokenRecord = {
  id: "tok_good",
  hash: "unused",
  role: "agent",
  label: "ci",
  createdAt: 1,
};

const config: AuthConfig = { enabled: true, host: "127.0.0.1", port: 4700 };

export const tokenFixture = {
  config,
  deps(): AuthDeps {
    return {
      config,
      tokens: { verify: async (secret) => (secret === "slk_good" ? record : undefined) },
      clock: new FakeClock(1_000),
      logger: new NoopLogger(),
      keySetFetcher: new FakeKeySetFetcher(),
    };
  },
  goodRequest(): { headers: Headers } {
    return { headers: new Headers({ authorization: "Bearer slk_good" }) };
  },
};
