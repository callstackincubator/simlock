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
    expect(freeSlot.check(view(statusFixture().capacity), REQUEST)).toBeUndefined();
    expect(freeSlot.check(view(undefined), REQUEST)).toBeDefined();
  });
});

describe("free-slot's reason", () => {
  const base = statusFixture().capacity;
  const full = { maxRunning: 1, running: 1, reserved: 0, warm: 0 };
  const ios = (entry: object) => ({ ...base, ios: { ...base.ios, ...entry } });
  const global = (entry: object) => ({ ...base, global: { ...base.global, ...entry } });

  it("names full with platform-running-limit when the platform has no free or evictable slot, also when global has none", () => {
    const platformFull = { reason: "full", capacityReason: "platform-running-limit" };

    expect(freeSlot.check(view(statusFixture().capacity), REQUEST)).toBeUndefined();
    expect(freeSlot.check(view(ios(full)), REQUEST)).toEqual(platformFull);
    expect(
      freeSlot.check(view({ ...ios(full), global: { ...base.global, ...full } }), REQUEST),
    ).toEqual(platformFull);
  });

  it("names full with global-running-limit when only global has no free or evictable slot, and counts an unleased running device as free", () => {
    expect(freeSlot.check(view(global(full)), REQUEST)).toEqual({
      capacityReason: "global-running-limit",
      reason: "full",
    });
    expect(freeSlot.check(view(global({ ...full, warm: 1 })), REQUEST)).toBeUndefined();
    expect(freeSlot.check(view(ios({ ...full, warm: 1 })), REQUEST)).toBeUndefined();
  });
});
