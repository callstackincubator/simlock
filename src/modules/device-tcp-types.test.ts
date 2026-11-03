import { describe, expectTypeOf, it } from "vitest";

import type { DeviceTcp, Platform } from "../core/index.js";
import type { ModuleDeviceTcp } from "./index.js";

describe("the device port a module sees, declared by shape", () => {
  it("ModuleDeviceTcp is core's DeviceTcp with the platform in front of each call", () => {
    expectTypeOf<Parameters<ModuleDeviceTcp["supports"]>>().toEqualTypeOf<
      [Platform, ...Parameters<DeviceTcp["supports"]>]
    >();
    expectTypeOf<Parameters<ModuleDeviceTcp["reverse"]>>().toEqualTypeOf<
      [Platform, ...Parameters<DeviceTcp["reverse"]>]
    >();
    expectTypeOf<ReturnType<ModuleDeviceTcp["reverse"]>>().toEqualTypeOf<
      ReturnType<DeviceTcp["reverse"]>
    >();
  });
});
