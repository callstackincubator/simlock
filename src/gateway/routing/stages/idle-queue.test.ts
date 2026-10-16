import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "../../routing.js";
import { catalogFixture, physicalDeviceFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { idleQueue } from "./idle-queue.js";

function view(overrides: Partial<WorkerView> & { physicalQueueDepth?: number } = {}): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    catalogReadAt: 1,
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id: "wrk_a",
    lastSeenAt: 1,
    leases: [],
    queueDepth: 0,
    ...overrides,
  } as WorkerView;
}

const VIRTUAL = { model: "iPhone 17", platform: "ios" as const };
const PHYSICAL = { model: "iPhone 17", physical: true as const, platform: "ios" as const };

describe("idle-queue", () => {
  const policy = createRoutingPolicy("warm-then-free");

  it("keeps a worker with queueDepth 0 and physicalQueueDepth 1 for a virtual request, and a physical request is offered to a worker with queueDepth 1", () => {
    const onlyPhysicalWaiters = view({ physicalQueueDepth: 1, queueDepth: 0 });
    const virtualWaiters = view({
      devices: [physicalDeviceFixture("dev_p", "ready", { model: "iPhone 17" })],
      queueDepth: 1,
    });

    expect(idleQueue.keeps(onlyPhysicalWaiters, VIRTUAL)).toBe(true);
    expect(idleQueue.keeps(virtualWaiters, VIRTUAL)).toBe(false);
    expect(policy.select(VIRTUAL, [virtualWaiters])).toBeUndefined();

    expect(policy.select(PHYSICAL, [virtualWaiters])).toMatchObject({ workerId: "wrk_a" });
  });
});
