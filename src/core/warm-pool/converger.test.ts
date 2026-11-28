import { describe, expect, it, vi } from "vitest";
import { WARM_POOL_TICK_MS } from "./converger.js";
import { RETRY_FIRST_MS } from "./retry.js";
import { device, harness, iphone15, leaseOn, minute } from "./test-fixtures.js";

type Rig = ReturnType<typeof harness>;

// why: the warm pool is a decomposed module (ADR 0063 section 2); these tests drive its converger part directly.
describe("warm pool converger", () => {
  it("still kicks acquisition when a boot fails", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => {
        throw new Error("emulator did not come up");
      },
      targets: [iphone15],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.kick).toHaveBeenCalledTimes(1);
  });

  it("kicks acquisition after a boot or a shutdown that succeeds", async () => {
    const booted = harness([device("shut", "shutdown", 1_000)], { targets: [iphone15] });
    await booted.pool.pass();
    await booted.pool.settle();
    const shutDown = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
    });
    await shutDown.pool.pass();

    expect(booted.bootCalls).toEqual(["shut"]);
    expect(booted.kick).toHaveBeenCalledTimes(1);
    expect(shutDown.shutdownCalls).toEqual(["a"]);
    expect(shutDown.kick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["is leased", (rig: Rig) => rig.lease("b")],
    ["gets a lease record before its state does", (rig: Rig) => void rig.state.leases.push(leaseOn("b"))],
    [
      "changes state to reclaiming",
      (rig: Rig) => {
        rig.state.devices = rig.state.devices.map((item) =>
          item.id === "b" ? { ...item, state: "reclaiming" } : item,
        );
      },
    ],
    [
      "leaves the registry",
      (rig: Rig) => {
        rig.state.devices = rig.state.devices.filter((item) => item.id !== "b");
      },
    ],
  ])(
    "leaves a device alone that %s between the proposal and the shutdown",
    async (_change, change) => {
      const rig: Rig = harness(
        [
          device("a", "ready", 90 * minute),
          device("b", "ready", 80 * minute),
          device("c", "ready", 70 * minute),
        ],
        {
          limit: 1,
          shutdown: async (target) => {
            // The first shutdown runs outside the decision gate; `b` changes while it does.
            change(rig);
            return { ...target, state: "shutdown" };
          },
        },
      );

      await rig.pool.pass();

      expect(rig.shutdownCalls).toEqual(["a"]);
      expect(rig.sink.records.map((record) => record.fields)).toEqual([
        { deviceId: "a", reason: "over-budget" },
      ]);
      expect(rig.kick).toHaveBeenCalledTimes(1);
    },
  );

  it("shuts down with the warm-pool initiator under the cleanup claim", async () => {
    const rig = harness([device("a", "ready", 90 * minute), device("b", "ready", 80 * minute)], {
      limit: 1,
    });

    await rig.pool.pass();

    expect(rig.shutdownArgs).toEqual([["warm-pool", "cleanup"]]);
  });

  it("does not kick when the lifecycle declines a shutdown or a boot", async () => {
    const shutdown = harness([device("a", "ready", 90 * minute), device("b", "ready", 1_000)], {
      limit: 1,
      shutdown: async () => undefined,
    });
    const boot = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => undefined,
      targets: [iphone15],
    });

    await shutdown.pool.pass();
    await boot.pool.pass();
    await boot.pool.settle();

    expect(shutdown.shutdownCalls).toEqual(["a"]);
    expect(shutdown.kick).not.toHaveBeenCalled();
    expect(boot.bootCalls).toEqual(["shut"]);
    expect(boot.kick).not.toHaveBeenCalled();
  });

  it("leaves a claimed device out of the budget's choice instead of proposing it and then skipping it", async () => {
    const rig = harness(
      [
        device("claimed", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      { limit: 2 },
    );
    rig.claims.tryClaim("claimed", "eviction");

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["b"]);
  });

  it("still shuts down over the budget while a shut-down device is claimed for a boot", async () => {
    const rig = harness(
      [
        device("a", "ready", 5_000),
        device("b", "ready", 1_000),
        device("s", "shutdown", 60 * minute),
      ],
      { limit: 1 },
    );
    rig.claims.tryClaim("s", "boot");

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("holds a device through its boot, and boots it again once the boot has committed", async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const rig: Rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async (target) => {
        await gate;
        rig.state.devices = rig.state.devices.map((item) =>
          item.id === target.id ? { ...item, state: "ready" } : item,
        );
        return { ...target, state: "ready" };
      },
      maxConcurrentBoots: 2,
      // why: a second copy is wanted but cannot be created, so the one shut-down device is the only candidate for it.
      refuseProvision: true,
      targets: [{ ...iphone15, count: 2 }],
    });

    await rig.pool.pass();
    await vi.waitFor(() => expect(rig.bootCalls).toEqual(["shut"]));
    await rig.pool.pass();

    expect(rig.bootCalls).toEqual(["shut"]);

    finish();
    await rig.pool.settle();
    rig.state.devices = rig.state.devices.map((item) => ({ ...item, state: "shutdown" }));
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut", "shut"]);
  });

  it("boots a device again after its boot failed", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => {
        throw new Error("boot failed");
      },
      targets: [iphone15],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    const lines = rig.sink.records.filter(
      (record) => record.level === "warn" && record.message.startsWith("warm pool boot"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      fields: { deviceId: "shut", step: "boot" },
      message: "warm pool boot of a device failed",
    });

    rig.clock.advance(RETRY_FIRST_MS);
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut", "shut"]);
  });

  it("runs exactly one more pass for two triggers that arrive during one pass", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
      shutdown: async (target) => {
        await gate;
        return { ...target, state: "shutdown" };
      },
    });
    rig.pool.start();

    rig.eventBus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await vi.waitFor(() => expect(rig.shutdownCalls).toEqual(["a"]));
    expect(rig.waitingDemand).toHaveBeenCalledTimes(1);
    rig.eventBus.emit("device.shutdown", { deviceId: "x", initiator: "test" }, "test");
    rig.eventBus.emit(
      "device.deleted",
      { deviceId: "y", initiator: "test", physical: false },
      "test",
    );
    release();
    await rig.pool.settle();

    expect(rig.waitingDemand).toHaveBeenCalledTimes(2);
    rig.pool.dispose();
  });

  it.each([
    [
      "is claimed for eviction",
      (rig: Rig) => void rig.claims.tryClaim("y", "eviction"),
    ],
    [
      "is no longer shut down",
      (rig: Rig) => {
        rig.state.devices = rig.state.devices.map((item) =>
          item.id === "y" ? { ...item, state: "ready" } : item,
        );
      },
    ],
  ])("does not boot a shut-down device that %s between the proposal and its boot", async (_change, change) => {
    const rig: Rig = harness([device("x", "shutdown", 1_000), device("y", "shutdown", 2_000)], {
      maxConcurrentBoots: 2,
      onAdmit: (id) => {
        if (id === "y") change(rig);
      },
      targets: [{ ...iphone15, count: 2 }],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["x"]);
    expect(rig.reservations).toHaveLength(1);
    expect(rig.sink.records).toEqual([]);
  });

  it("boots nothing when the device claim is refused", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      refuseClaim: true,
      targets: [iphone15],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.sink.records).toEqual([]);
    expect(rig.kick).not.toHaveBeenCalled();
  });

  it("marks only devices that are shut down while a reset holds acquisition closed, and copes with one that left the registry", async () => {
    let closed = true;
    const rig = harness([device("up", "ready", 1_000), device("gone", "shutdown", 2_000)], {
      maintenance: () => closed,
      targets: [iphone15],
    });
    await rig.pool.pass();
    closed = false;

    // `up` is shut down only after the reset; `gone` leaves the registry before the next pass.
    rig.state.devices = rig.state.devices
      .filter((item) => item.id !== "gone")
      .map((item) => ({ ...item, state: "shutdown" as const }));
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["up"]);
    expect(rig.sink.records).toEqual([]);
  });

  it("clears the reset mark once the device has left shutdown, so it is an ordinary device again", async () => {
    let closed = true;
    const rig = harness([device("down", "shutdown", 1_000)], {
      maintenance: () => closed,
      targets: [iphone15],
    });
    await rig.pool.pass();
    closed = false;

    rig.state.devices = rig.state.devices.map((item) => ({ ...item, state: "leased" }));
    await rig.pool.pass();
    rig.state.devices = rig.state.devices.map((item) => ({ ...item, state: "shutdown" }));
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["down"]);
  });

  it("does not boot back a device left shut down while an operator reset holds acquisition closed", async () => {
    let closed = true;
    // The shut-down device is not the first in the registry: its mark is read by its own id.
    const rig = harness([device("busy", "leased", 1_000), device("down", "shutdown", 1_000)], {
      maintenance: () => closed,
    });

    await rig.pool.pass();
    closed = false;
    await rig.pool.pass();

    expect(rig.bootCalls).toEqual([]);
  });

  it("does nothing while an operator reset holds acquisition closed, and acts again once it is open", async () => {
    let closed = true;
    const rig = harness(
      [device("a", "ready", 5_000), device("b", "ready", 1_000), device("s", "shutdown", 1_000)],
      { limit: 1, maintenance: () => closed },
    );

    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual([]);
    expect(rig.bootCalls).toEqual([]);
    expect(rig.waitingDemand).not.toHaveBeenCalled();

    closed = false;
    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("stops acting on the rest of a pass when an operator reset begins during it", async () => {
    let closed = false;
    const rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        maintenance: () => closed,
        shutdown: async (target) => {
          closed = true;
          return { ...target, state: "shutdown" };
        },
      },
    );

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("subscribes once however many times it is started", async () => {
    const rig = harness([]);
    rig.pool.start();
    rig.pool.start();

    rig.eventBus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await rig.pool.settle();
    rig.pool.dispose();

    expect(rig.waitingDemand).toHaveBeenCalledTimes(1);
    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("disposes without error when it was never started", async () => {
    const rig = harness([]);

    expect(() => rig.pool.dispose()).not.toThrow();
  });

  it("still kicks acquisition and leaves the device ready when a shutdown fails", async () => {
    const rig = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
      shutdown: async () => {
        throw new Error("simctl shutdown failed");
      },
    });

    await rig.pool.pass();

    expect(rig.state.devices.find((item) => item.id === "a")?.state).toBe("ready");
    expect(rig.kick).toHaveBeenCalledTimes(1);
  });

  it("does not try a failed shutdown of a device again within a tick, and does after", async () => {
    const attempts: string[] = [];
    const rig = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
      shutdown: async (target) => {
        attempts.push(target.id);
        throw new Error("simctl shutdown failed");
      },
    });

    await rig.pool.pass();
    rig.clock.advance(WARM_POOL_TICK_MS - 1);
    await rig.pool.pass();

    expect(attempts).toEqual(["a"]);

    rig.clock.advance(1);
    await rig.pool.pass();

    expect(attempts).toEqual(["a", "a"]);
  });

  it("runs a pass on each trigger event and on the tick, and none once disposed", async () => {
    const triggers = [
      ["daemon.started", { configSnapshot: {}, version: "test" }],
      ["device.reclaimed", { deviceId: "d", duration: 1, strategy: "erase" }],
      ["device.quarantine-recovered", { attempts: 1, deviceId: "d", strategy: "erase" }],
      [
        "lease.granted",
        { deviceId: "d", leaseId: "l", requestId: "r", requester: "q", source: "warm" },
      ],
      ["lease.released", { deviceId: "d", leaseId: "l", ownerId: "o", reason: "explicit" }],
      ["device.shutdown", { deviceId: "d", initiator: "test" }],
      ["device.deleted", { deviceId: "d", initiator: "test", physical: false }],
      ["cleanup.executed", { action: "shutdown", reason: "r", ruleName: "n", target: "d" }],
      ["lease.queued", { queuePosition: 2, requestId: "r" }],
    ] as const;
    const rig = harness([]);
    rig.pool.start();

    for (const [event, payload] of triggers) {
      const before = rig.waitingDemand.mock.calls.length;
      rig.eventBus.emit(event, payload as never, "test");
      await rig.pool.settle();
      expect(rig.waitingDemand.mock.calls.length, event).toBe(before + 1);
    }
    const beforeTick = rig.waitingDemand.mock.calls.length;
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.waitingDemand.mock.calls.length).toBe(beforeTick + 1);
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.waitingDemand.mock.calls.length).toBe(beforeTick + 2);

    rig.pool.dispose();
    const afterDispose = rig.waitingDemand.mock.calls.length;
    rig.eventBus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.waitingDemand.mock.calls.length).toBe(afterDispose);
  });
});
