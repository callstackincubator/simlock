import { expect } from "vitest";

import type { TestEnv } from "./env.js";

/** why: a gateway pins a join token to the first worker that joins with it, so each worker in a test needs its own. */
export async function mintJoinToken(gateway: Pick<TestEnv, "cli">): Promise<string> {
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  expect(minted.code, minted.stderr).toBe(0);
  return (minted.json as { secret: string }).secret;
}
