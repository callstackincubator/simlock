import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { healthy } from "./healthy.js";

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

function view(health?: WorkerView["health"]): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([]).platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
    ...(health === undefined ? {} : { health }),
  };
}

describe("healthy's reason", () => {
  it("names unhealthy for a worker that is starting or has not reported its health, and nothing for a running one", () => {
    expect(healthy.check(view("running"), REQUEST)).toBeUndefined();
    expect(healthy.check(view("starting"), REQUEST)).toEqual({ reason: "unhealthy" });
    expect(healthy.check(view(), REQUEST)).toEqual({ reason: "unhealthy" });
  });
});
