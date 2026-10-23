import { describe, expectTypeOf, it } from "vitest";

import type { TokenOperations } from "../auth/index.js";
import type { EndedLease, LeaseEndParticipant } from "../leasing/index.js";
import type { HttpMount } from "../http/app.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import type {
  ModuleCapabilitySource,
  ModuleDispatch,
  ModuleEndedLease,
  ModuleLeaseEndParticipant,
  ModuleMount,
  ModuleRelayTarget,
  ModuleTokens,
} from "../modules/index.js";
import type { CapabilitySource } from "./dispatcher.js";
import type { RelayTarget } from "./relay.js";

describe("the shapes src/modules declares by shape", () => {
  it("each by-shape type in src/modules and its original are assignable both ways", () => {
    expectTypeOf<ModuleCapabilitySource>().toExtend<CapabilitySource>();
    expectTypeOf<CapabilitySource>().toExtend<ModuleCapabilitySource>();
    expectTypeOf<ModuleTokens>().toExtend<TokenOperations>();
    expectTypeOf<TokenOperations>().toExtend<ModuleTokens>();
    expectTypeOf<ModuleRelayTarget>().toExtend<RelayTarget>();
    expectTypeOf<RelayTarget>().toExtend<ModuleRelayTarget>();
    expectTypeOf<ModuleEndedLease>().toExtend<EndedLease>();
    expectTypeOf<EndedLease>().toExtend<ModuleEndedLease>();
    expectTypeOf<ModuleLeaseEndParticipant>().toExtend<LeaseEndParticipant>();
    expectTypeOf<LeaseEndParticipant>().toExtend<ModuleLeaseEndParticipant>();
    expectTypeOf<ModuleDispatch>().toExtend<HttpDispatch>();
    expectTypeOf<HttpDispatch>().toExtend<ModuleDispatch>();
    expectTypeOf<ModuleMount>().toExtend<HttpMount>();
    expectTypeOf<HttpMount>().toExtend<ModuleMount>();
  });
});
