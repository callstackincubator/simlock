import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { freeSlot } from "./free-slot.js";

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

function view(capacity: WorkerView["capacity"]): WorkerView {
  return {
    catalog: catalogFixture([]).platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
    ...(capacity === undefined ? {} : { capacity }),
  };
}

describe("free-slot", () => {
  it("keeps a worker with a free slot for the platform and overall, and drops one whose capacity has not been read", () => {
    expect(freeSlot.keeps(view(statusFixture().capacity), REQUEST)).toBe(true);
    expect(freeSlot.keeps(view(undefined), REQUEST)).toBe(false);
  });
});
