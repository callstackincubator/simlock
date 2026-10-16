import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "../../routing.js";
import { catalogFixture, deviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";

function view(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    catalogReadAt: 1,
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id,
    lastSeenAt: 1,
    leases: [],
    queueDepth: 0,
    ...overrides,
  };
}

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

describe("takes-requests in the registered policy", () => {
  const policy = createRoutingPolicy("warm-then-free");

  it.each([
    ["disconnected", { connection: "disconnected" as const }],
    ["incompatible", { connection: "incompatible" as const }],
    ["drained", { drained: true }],
    ["whose capacity has not been read", { capacity: undefined }],
    ["whose catalog has not been read since it connected", { catalogReadAt: undefined }],
  ])("passes over a worker that is %s for one that takes requests", (_label, overrides) => {
    // wrk_a sorts first and holds a warm device, so only takes-requests can pass it over.
    const { capacity, ...rest } = {
      ...view("wrk_a", { devices: [deviceFixture("dev_1", "ready")] }),
      ...overrides,
    };
    const excluded = capacity === undefined ? rest : { ...rest, capacity };

    expect(policy.select(REQUEST, [excluded, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [excluded])).toBeUndefined();
  });
});

describe("takes-requests for a worker that answered starting", () => {
  const policy = createRoutingPolicy("warm-then-free");
  const {
    capacity: _capacity,
    catalogReadAt: _readAt,
    devices: _d,
    leases: _l,
    queueDepth: _q,
    ...base
  } = view("wrk_a");
  const starting: WorkerView = { ...base, health: "starting" };

  it("keeps it when the gateway holds a catalog for it, so a request only it can serve waits instead of failing, and routes it nothing", () => {
    expect(policy.assess(REQUEST, [starting])).toEqual({ kind: "route-or-wait" });
    expect(policy.select(REQUEST, [starting])).toBeUndefined();
    expect(policy.select(REQUEST, [starting, view("wrk_b")])?.workerId).toBe("wrk_b");
  });

  it("drops it when no catalog was ever read from it, so the request fails at once", () => {
    const { catalog: _catalog, ...unread } = starting;

    expect(policy.assess(REQUEST, [unread])).toMatchObject({ code: "NO_CAPACITY" });
  });

  it.each([
    ["disconnected", { connection: "disconnected" as const }],
    ["drained", { drained: true }],
  ])("drops it when it is %s", (_label, overrides) => {
    expect(policy.assess(REQUEST, [{ ...starting, ...overrides }])).toMatchObject({
      code: "NO_CAPACITY",
    });
  });
});
