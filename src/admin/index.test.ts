import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as admin from "./index.js";
import type { SimlockAdminClient } from "./index.js";

describe("simlock/admin", () => {
  it("SimlockAdminClient as simlock/admin exports it has no relay methods, and docs/CLIENT.md lists none", () => {
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayRequest");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayBody");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayCancel");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("openChannel");

    const documented = readFileSync(new URL("../../docs/CLIENT.md", import.meta.url), "utf8");
    expect(Object.keys(admin).filter((name) => /relay/i.test(name))).toEqual([]);
    expect(documented).not.toMatch(/relay(Request|Body|Cancel)/);
  });
});
