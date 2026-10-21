import { describe, expect, expectTypeOf, it } from "vitest";

import * as admin from "./index.js";
import type { SimlockAdminClient } from "./index.js";

describe("simlock/admin", () => {
  it("SimlockAdminClient as simlock/admin exports it has no relay methods", () => {
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayRequest");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayBody");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("relayCancel");
    expectTypeOf<SimlockAdminClient>().not.toHaveProperty("openChannel");

    expect(Object.keys(admin).filter((name) => /relay/i.test(name))).toEqual([]);
  });
});
