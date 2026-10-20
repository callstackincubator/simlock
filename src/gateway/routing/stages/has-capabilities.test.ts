import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "../../routing.js";
import { catalogFixture, physicalDeviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { hasCapabilities } from "./has-capabilities.js";

type Capabilities = NonNullable<WorkerView["capabilities"]>;

function view(
  id: string,
  capabilities: Capabilities | undefined,
  overrides: Partial<WorkerView> = {},
): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    catalogReadAt: 1,
    ...(capabilities === undefined ? {} : { capabilities }),
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id,
    lastSeenAt: 1,
    leases: [],
    queueDepth: 0,
    ...overrides,
  } as WorkerView;
}

const REQUEST = { model: "iPhone 17", platform: "ios" as const };
const REQUIRES_AGENT_DEVICE = { ...REQUEST, requires: ["agent-device"] };

describe("has-capabilities", () => {
  const policy = createRoutingPolicy("warm-then-free");

  it("keeps a worker listing every required name as available, drops one listing it unavailable, off or not at all, keeps every worker when requires is empty, and applies to physical requests", () => {
    const available = view("wrk_a", [{ name: "agent-device", state: "available" }]);
    const unavailable = view("wrk_b", [
      { name: "agent-device", reason: "starting", state: "unavailable" },
    ]);
    const off = view("wrk_c", [{ name: "agent-device", state: "off" }]);
    const absent = view("wrk_d", [{ name: "x-other", state: "available" }]);
    const unread = view("wrk_e", undefined);
    const partly = view("wrk_f", [
      { name: "agent-device", state: "available" },
      { name: "x-other", state: "off" },
    ]);

    expect(hasCapabilities.check(available, REQUIRES_AGENT_DEVICE)).toBeUndefined();
    for (const lacking of [unavailable, off, absent, unread]) {
      expect(hasCapabilities.check(lacking, REQUIRES_AGENT_DEVICE)).toBeDefined();
    }
    expect(
      hasCapabilities.check(partly, { ...REQUEST, requires: ["agent-device"] }),
    ).toBeUndefined();
    expect(
      hasCapabilities.check(partly, { ...REQUEST, requires: ["agent-device", "x-other"] }),
    ).toBeDefined();
    for (const worker of [available, unavailable, off, absent, unread]) {
      expect(hasCapabilities.check(worker, { ...REQUEST, requires: [] })).toBeUndefined();
      expect(hasCapabilities.check(worker, REQUEST)).toBeUndefined();
    }
    expect(hasCapabilities.appliesToPhysical).toBe(true);
  });

  it("is a stage of warm-then-free that runs for a virtual request: the capable worker is picked over a lower-id worker without the capability", () => {
    const lacking = view("wrk_a", [{ name: "agent-device", state: "off" }]);
    const capable = view("wrk_b", [{ name: "agent-device", state: "available" }]);

    expect(policy.select(REQUEST, [lacking, capable])).toMatchObject({ workerId: "wrk_a" });
    expect(policy.select(REQUIRES_AGENT_DEVICE, [lacking, capable])).toMatchObject({
      workerId: "wrk_b",
    });
    expect(policy.select(REQUIRES_AGENT_DEVICE, [lacking])).toBeUndefined();
  });

  it("a physical request with requires is routed only to a capable worker", () => {
    const physical = { model: "iPhone 17", physical: true as const, platform: "ios" as const };
    const devices = [physicalDeviceFixture("dev_p", "ready", { model: "iPhone 17" })];
    const lacking = view("wrk_a", [{ name: "agent-device", state: "unavailable", reason: "x" }], {
      devices,
    });
    const capable = view("wrk_b", [{ name: "agent-device", state: "available" }], { devices });

    expect(policy.select(physical, [lacking, capable])).toMatchObject({ workerId: "wrk_a" });
    expect(
      policy.select({ ...physical, requires: ["agent-device"] }, [lacking, capable]),
    ).toMatchObject({ workerId: "wrk_b" });
    expect(policy.select({ ...physical, requires: ["agent-device"] }, [lacking])).toBeUndefined();
  });
});

describe("has-capabilities' reason", () => {
  it("names capability-missing for a worker lacking a required name as available, and nothing for one that lists it", () => {
    const available = view("wrk_a", [{ name: "agent-device", state: "available" }]);
    const off = view("wrk_b", [{ name: "agent-device", state: "off" }]);

    expect(hasCapabilities.check(available, REQUIRES_AGENT_DEVICE)).toBeUndefined();
    expect(hasCapabilities.check(off, REQUIRES_AGENT_DEVICE)).toEqual({
      reason: "capability-missing",
    });
    expect(hasCapabilities.check(view("wrk_c", undefined), REQUIRES_AGENT_DEVICE)).toEqual({
      reason: "capability-missing",
    });
  });
});
