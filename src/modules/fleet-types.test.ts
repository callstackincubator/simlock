import { describe, expectTypeOf, it } from "vitest";

import type { FleetLeaseEntry, FleetLeaseIndex } from "../gateway/index.js";
import type { FleetLease, FleetLeases } from "./index.js";

describe("the fleet types a module sees, declared by shape", () => {
  it("FleetLease and the FleetLeaseEntry fields it copies are assignable both ways", () => {
    expectTypeOf<FleetLease>().toEqualTypeOf<
      Pick<
        FleetLeaseEntry,
        "gatewayLeaseId" | "workerId" | "workerLeaseId" | "requesterId" | "ownerId" | "grantedAt"
      >
    >();
  });

  it("FleetLeases and the Pick of FleetLeaseIndex's all, resolve and onRemoved are assignable both ways", () => {
    expectTypeOf<FleetLeases>().toEqualTypeOf<
      Pick<FleetLeaseIndex, "all" | "resolve" | "onRemoved">
    >();
  });
});
