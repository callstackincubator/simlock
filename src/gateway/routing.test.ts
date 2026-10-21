import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "./routing.js";
import {
  canServe,
  freeCapacity,
  freeSlot,
  healthy,
  idleQueue,
  ramBudget,
  takesRequests,
  warmHit,
} from "./routing/index.js";
import {
  catalogFixture,
  deviceFixture,
  physicalDeviceFixture,
  statusFixture,
} from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

const REQUEST = {
  physical: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

function view(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
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
    capacity: statusFixture().capacity,
    queueDepth: 0,
    ...overrides,
  };
}

describe("the registered warm-then-free policy", () => {
  const policy = createRoutingPolicy("warm-then-free");

  function withIos(slots: { maxRunning: number; running?: number; reserved?: number }) {
    return {
      ...statusFixture().capacity,
      ios: { ...statusFixture().capacity.ios, ...slots },
    };
  }

  it("picks the worker with the most free running capacity, even when it sorts last by id", () => {
    // wrk_a_tight has the higher maxRunning, but its running and reserved slots leave it 2 free
    // against wrk_z_roomy's 5. The ascending-id tie-break alone would pick wrk_a_tight.
    const tight = view("wrk_a_tight", {
      capacity: withIos({ maxRunning: 10, reserved: 4, running: 4 }),
    });
    const roomy = view("wrk_z_roomy", { capacity: withIos({ maxRunning: 5 }) });

    expect(policy.select(REQUEST, [tight, roomy])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_z_roomy",
    });
  });

  it("the gateway picks the same worker for a request whether or not the views carry load", () => {
    const load = { cpu: { busyPercent: 100, cores: 2, limited: false }, readAt: 1 };
    const quiet = view("wrk_a_quiet", { capacity: withIos({ maxRunning: 5 }) });
    const busy = view("wrk_z_busy", { capacity: withIos({ maxRunning: 9 }) });

    const without = policy.select(REQUEST, [quiet, busy]);
    const withLoad = policy.select(REQUEST, [
      { ...quiet, load: { readAt: 1 } },
      { ...busy, load },
    ]);

    expect(without).toMatchObject({ workerId: "wrk_z_busy" });
    expect(withLoad).toEqual(without);
  });

  it("picks a worker with a warm device over a cold one with more free running capacity", () => {
    // The warm worker sorts last by id and has less room, so only warm-hit can pick it.
    const cold = view("wrk_a_cold", { capacity: withIos({ maxRunning: 5 }) });
    const warm = view("wrk_z_warm", {
      capacity: withIos({ maxRunning: 1 }),
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [cold, warm])).toEqual({
      reason: "warm-hit",
      stage: "warm-hit",
      workerId: "wrk_z_warm",
    });
  });

  it("does not dispatch a full request as a warm hit to a slim warm device while another worker has free capacity", () => {
    // The slim worker sorts last and has less room, so only a warm hit could pick it.
    const cold = view("wrk_a_cold", { capacity: withIos({ maxRunning: 5 }) });
    const slim = view("wrk_z_slim", {
      capacity: withIos({ maxRunning: 1 }),
      devices: [deviceFixture("dev_slim", "ready", "slim")],
    });

    expect(policy.select({ ...REQUEST, mode: "full" }, [cold, slim])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_a_cold",
    });
  });

  it("does not dispatch a slim request as a warm hit to a full warm device while another worker has free capacity", () => {
    const cold = view("wrk_a_cold", { capacity: withIos({ maxRunning: 5 }) });
    const full = view("wrk_z_full", {
      capacity: withIos({ maxRunning: 1 }),
      devices: [deviceFixture("dev_full", "ready", "full")],
    });

    expect(policy.select({ ...REQUEST, mode: "slim" }, [cold, full])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_a_cold",
    });
  });

  it.each([
    ["starting", "starting" as const],
    ["failed", "failed" as const],
    ["not reporting its health", undefined],
  ])("sends a worker that is %s nothing while a healthy one serves", (_label, health) => {
    // wrk_a sorts first and holds a warm device, so only the health stage can pass it over.
    const { health: _drop, ...base } = view("wrk_a", {
      devices: [deviceFixture("dev_1", "ready")],
    });
    const sick = health === undefined ? base : { ...base, health };

    expect(policy.select(REQUEST, [sick, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [sick])).toBeUndefined();
  });

  it("passes over a worker with its own waiters queued, warm device or not", () => {
    const warmQueued = view("wrk_a", {
      devices: [deviceFixture("dev_1", "ready")],
      queueDepth: 1,
    });
    const coldQueued = view("wrk_a", { queueDepth: 1 });

    for (const queued of [warmQueued, coldQueued]) {
      expect(policy.select(REQUEST, [queued, view("wrk_b")])?.workerId).toBe("wrk_b");
      expect(policy.select(REQUEST, [queued])).toBeUndefined();
    }
  });

  it("picks a worker whose only slot is held by its own warm device, ahead of the free-slot check", () => {
    // The ready device counts as running, so wrk_a has no free slot; only warm-hit running
    // before free-slot can still pick it.
    const warm = view("wrk_a", {
      capacity: withIos({ maxRunning: 1, running: 1 }),
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [warm, view("wrk_b")])).toMatchObject({
      reason: "warm-hit",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [warm])).toMatchObject({ workerId: "wrk_a" });
  });

  it("drops a worker with no free slot before it ranks RAM, so a worker at its budget with a free slot is picked", () => {
    // wrk_a is under budget but full; wrk_b is at budget with a free slot. With RAM ranked
    // first only wrk_a would survive the rank, and the free-slot filter would then leave no pick.
    const full = view("wrk_a", { capacity: withIos({ maxRunning: 1, running: 1 }) });
    const capacity = withIos({ maxRunning: 1 });
    const atBudget = view("wrk_b", {
      capacity: { ...capacity, ios: { ...capacity.ios, atRamBudget: true } },
    });

    expect(policy.select(REQUEST, [full, atBudget])).toMatchObject({ workerId: "wrk_b" });
  });

  it("passes over a worker at its RAM budget while another has room, and asks it when it is the only one", () => {
    // wrk_b has more free running capacity, so only the RAM rank can prefer wrk_a over it.
    const atBudget = (maxRunning: number) => ({
      ...withIos({ maxRunning }),
      ios: { ...withIos({ maxRunning }).ios, atRamBudget: true },
    });
    const roomy = view("wrk_a", { capacity: withIos({ maxRunning: 1 }) });
    const full = view("wrk_b", { capacity: atBudget(5) });

    expect(policy.select(REQUEST, [full, roomy])).toMatchObject({ workerId: "wrk_a" });
    // Equal free capacity: only the RAM rank removes a worker, so it is the deciding stage.
    const equal = view("wrk_b", { capacity: atBudget(1) });
    expect(policy.select(REQUEST, [equal, roomy])).toEqual({
      reason: "free-capacity",
      stage: "ram-budget",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [full])).toMatchObject({ workerId: "wrk_b" });
  });

  it("still picks a worker at its RAM budget for a warm device it holds", () => {
    const capacity = withIos({ maxRunning: 1 });
    const atBudget = view("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, atRamBudget: true } },
      devices: [deviceFixture("dev_1", "ready")],
    });

    expect(policy.select(REQUEST, [atBudget, view("wrk_b")])).toMatchObject({
      reason: "warm-hit",
      workerId: "wrk_a",
    });
  });

  it("keeps a worker whose running slots hold only devices that are not leased, and a request no warm device fits is dispatched to it at once", () => {
    // The ready device is another runtime, so no warm hit: only free-slot can decide. The
    // planner evicts it, so the slot is free, on the platform and globally.
    const other = {
      ...deviceFixture("dev_1", "ready"),
      spec: { physical: false, model: "iPhone 17", osVersion: "25.0", platform: "ios" as const },
    };
    const capacity = statusFixture().capacity;
    const platformHeld = view("wrk_a", {
      capacity: {
        ...capacity,
        global: { ...capacity.global, running: 1, warm: 1 },
        ios: { ...capacity.ios, maxRunning: 1, running: 1, warm: 1 },
      },
      devices: [other],
    });
    const globalHeld = view("wrk_a", {
      capacity: {
        ...capacity,
        global: { ...capacity.global, maxRunning: 1, running: 1, warm: 1 },
        ios: { ...capacity.ios, running: 1, warm: 1 },
      },
      devices: [other],
    });

    for (const held of [platformHeld, globalHeld]) {
      expect(policy.select(REQUEST, [held])).toMatchObject({ workerId: "wrk_a" });
    }
  });

  it("passes over a worker with no free global slot although its platform has one", () => {
    const capacity = statusFixture().capacity;
    const noGlobal = view("wrk_a", {
      capacity: { ...capacity, global: { ...capacity.global, maxRunning: 1, running: 1 } },
    });

    expect(capacity.ios.maxRunning - capacity.ios.running - capacity.ios.reserved).toBeGreaterThan(
      0,
    );
    expect(policy.select(REQUEST, [noGlobal, view("wrk_b")])?.workerId).toBe("wrk_b");
    expect(policy.select(REQUEST, [noGlobal])).toBeUndefined();
  });

  it("counts a reserved slot as taken, on the platform and globally, when it looks for a free one", () => {
    const capacity = statusFixture().capacity;
    const platformReserved = view("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 1, reserved: 1 } },
    });
    const globalReserved = view("wrk_a", {
      capacity: { ...capacity, global: { ...capacity.global, maxRunning: 1, reserved: 1 } },
    });

    for (const full of [platformReserved, globalReserved]) {
      expect(policy.select(REQUEST, [full, view("wrk_b")])?.workerId).toBe("wrk_b");
      expect(policy.select(REQUEST, [full])).toBeUndefined();
    }
  });

  it("looks at the request's platform only when it asks about the RAM budget", () => {
    const capacity = statusFixture().capacity;
    // wrk_a is at its budget for android only: for an iOS request it is as good as wrk_b.
    const androidFull = view("wrk_a", {
      capacity: { ...capacity, android: { ...capacity.android, atRamBudget: true } },
    });

    expect(policy.select(REQUEST, [androidFull, view("wrk_b")])?.workerId).toBe("wrk_a");
  });
});

describe("the warm-then-free policy for a physical request", () => {
  const policy = createRoutingPolicy("warm-then-free");
  const PHYSICAL = { model: "iPhone 17", physical: true as const, platform: "ios" as const };
  const iphone = (id = "dev_p", state: "ready" | "leased" | "absent" = "ready") =>
    physicalDeviceFixture(id, state, { model: "iPhone 17", osVersion: "26.0" });

  function withIos(slots: { maxRunning: number; running?: number; atRamBudget?: boolean }) {
    return {
      ...statusFixture().capacity,
      ios: { ...statusFixture().capacity.ios, ...slots },
    };
  }

  it("picks the worker with a ready enrolled match over one with a warm simulator of the same model and more free capacity; reason and stage are warm-hit", () => {
    const simulator = view("wrk_a_sim", {
      capacity: withIos({ maxRunning: 5 }),
      devices: [deviceFixture("dev_sim", "ready")],
    });
    const enrolled = view("wrk_z_phone", {
      capacity: withIos({ maxRunning: 1 }),
      devices: [iphone()],
    });

    expect(policy.select(PHYSICAL, [simulator, enrolled])).toEqual({
      reason: "warm-hit",
      stage: "warm-hit",
      workerId: "wrk_z_phone",
    });
  });

  it("gives no pick for a physical request when no taking worker has a ready enrolled match", () => {
    const leased = view("wrk_a", { devices: [iphone("dev_p", "leased")] });
    const absent = view("wrk_b", { devices: [iphone("dev_q", "absent")] });
    const none = view("wrk_c", { devices: [deviceFixture("dev_sim", "ready")] });

    expect(policy.select(PHYSICAL, [leased, absent, none])).toBeUndefined();
  });

  it.each(["locked", "untrusted", "not-present"] as const)(
    "gives no pick for a physical request whose only ready enrolled match has presence not present (%s), and picks it when presence is present or absent",
    (reason) => {
      const read = (presence?: { present: true } | { present: false; reason: typeof reason }) =>
        view("wrk_a", {
          devices: [
            physicalDeviceFixture("dev_p", "ready", {
              model: "iPhone 17",
              osVersion: "26.0",
              ...(presence === undefined ? {} : { presence }),
            }),
          ],
        });

      expect(policy.select(PHYSICAL, [read({ present: false, reason })])).toBeUndefined();
      expect(policy.select(PHYSICAL, [read({ present: true })])?.workerId).toBe("wrk_a");
      expect(policy.select(PHYSICAL, [read()])?.workerId).toBe("wrk_a");
    },
  );

  it("picks, for a physical request, a worker with no free running slot and at its RAM budget when it holds the only ready enrolled match", () => {
    const full = view("wrk_a", {
      capacity: withIos({ atRamBudget: true, maxRunning: 0 }),
      devices: [iphone()],
    });
    const roomy = view("wrk_b", { capacity: withIos({ maxRunning: 5 }) });

    expect(policy.select(PHYSICAL, [roomy, full])).toMatchObject({ workerId: "wrk_a" });
  });

  it("drops, for a physical request, a worker that is not running, as for a virtual one", () => {
    const starting = view("wrk_a", { devices: [iphone()], health: "starting" });
    const running = view("wrk_b", { devices: [iphone("dev_q")] });

    expect(policy.select(PHYSICAL, [starting])).toBeUndefined();
    expect(policy.select(PHYSICAL, [starting, running])?.workerId).toBe("wrk_b");
  });

  it("picks, for a physical request, a worker with a ready enrolled match whose queueDepth and physicalQueueDepth are both above zero; a virtual request still drops a worker whose queueDepth is above zero", () => {
    const queued = view("wrk_a", {
      devices: [iphone(), deviceFixture("dev_sim", "ready")],
      physicalQueueDepth: 1,
      queueDepth: 1,
    } as Partial<WorkerView>);

    expect(policy.select(PHYSICAL, [queued])).toMatchObject({
      stage: "warm-hit",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [queued])).toBeUndefined();
  });

  it("picks, for a physical request, a worker that idle-queue and free-slot would drop and ram-budget would demote, by warm-hit; the four stages are the ones that skip a physical request", () => {
    const blocked = view("wrk_a", {
      capacity: withIos({ atRamBudget: true, maxRunning: 0 }),
      devices: [iphone()],
      queueDepth: 2,
    });
    const roomy = view("wrk_b", { capacity: withIos({ maxRunning: 5 }) });

    expect(policy.select(PHYSICAL, [roomy, blocked])).toEqual({
      reason: "warm-hit",
      stage: "warm-hit",
      workerId: "wrk_a",
    });
    expect(policy.select(REQUEST, [roomy, view("wrk_c", { ...blocked, queueDepth: 2 })])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_b",
    });
    const stages = {
      canServe,
      freeCapacity,
      freeSlot,
      healthy,
      idleQueue,
      ramBudget,
      takesRequests,
      warmHit,
    };
    const skipped = Object.entries(stages)
      .filter(([, stage]) => (stage as { appliesToPhysical?: boolean }).appliesToPhysical === false)
      .map(([name]) => name)
      .sort();
    expect(skipped).toEqual(["freeCapacity", "freeSlot", "idleQueue", "ramBudget"]);
  });

  it("gives a virtual request the same pick, reason and stage with and without a ready physical device of its model in the views", () => {
    const sim = view("wrk_b", {
      capacity: withIos({ maxRunning: 3 }),
      devices: [deviceFixture("dev_sim", "ready")],
    });
    const cold = view("wrk_a", { capacity: withIos({ maxRunning: 5 }) });
    const phoneOnA = view("wrk_a", { capacity: withIos({ maxRunning: 5 }), devices: [iphone()] });
    const phoneOnC = view("wrk_c", {
      capacity: withIos({ maxRunning: 9 }),
      devices: [iphone("dev_q")],
    });

    const without = policy.select(REQUEST, [cold, sim]);
    expect(without).toEqual({ reason: "warm-hit", stage: "warm-hit", workerId: "wrk_b" });
    expect(policy.select(REQUEST, [phoneOnA, sim, phoneOnC])).toEqual(without);
    expect(policy.select(REQUEST, [phoneOnA, phoneOnC])).toEqual(
      policy.select(REQUEST, [cold, view("wrk_c", { capacity: withIos({ maxRunning: 9 }) })]),
    );
  });
});
