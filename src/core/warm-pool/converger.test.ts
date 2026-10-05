import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../../ports/index.js";
import type { RunningCapacity } from "../capacity/index.js";
import { DeviceOperationClaims } from "../device-operation-claims.js";
import type { DeviceRecord, LeaseRecord, WaitingDemand } from "../domain.js";
import { SerializedDecision } from "../serialized-decision.js";
import { WARM_POOL_TICK_MS, WarmPool, type WarmPoolOptions } from "./converger.js";

const minute = 60_000;
const now = 1_000 * minute;

function device(
  id: string,
  state: DeviceRecord["state"],
  endedAgo: number,
  platform: "ios" | "android" = "ios",
): DeviceRecord {
  return {
    createdAt: 1,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    lastLeaseEndedAt: now - endedAgo,
    mode: "full",
    spec:
      platform === "ios"
        ? { model: "iPhone 15", osVersion: "26.0", platform }
        : { model: "Pixel 8", osVersion: "35", platform },
    state,
  };
}

function leaseOn(deviceId: string): LeaseRecord {
  return {
    deviceId,
    grantedAt: 1,
    id: `lease-${deviceId}`,
    lastRenewedAt: 1,
    ownerId: "holder",
    requesterId: "holder",
    ttlDeadline: now + minute,
    ttlMs: minute,
  };
}

function harness(
  initial: readonly DeviceRecord[],
  options: {
    limit?: number;
    enabled?: boolean;
    refuseBoot?: boolean;
    shutdown?: (target: DeviceRecord) => Promise<DeviceRecord | undefined>;
    boot?: (target: DeviceRecord) => Promise<DeviceRecord | undefined>;
    waiting?: () => readonly WaitingDemand[];
    maintenance?: () => boolean;
    refuseClaim?: boolean;
  } = {},
) {
  const clock = new FakeClock(now);
  const eventBus = new EventBus(clock);
  const sink = new MemoryLogSink();
  const claims = new DeviceOperationClaims();
  const state = { devices: [...initial], leases: [] as LeaseRecord[] };
  const setState = (id: string, next: DeviceRecord["state"]): DeviceRecord => {
    const current = state.devices.find((item) => item.id === id);
    if (current === undefined) throw new Error(`no device ${id}`);
    const updated = { ...current, state: next };
    state.devices = state.devices.map((item) => (item.id === id ? updated : item));
    return updated;
  };
  const lease = (id: string): void => {
    setState(id, "leased");
    state.leases.push(leaseOn(id));
  };
  const reservations: { released: number; claimedAtBoot?: boolean }[] = [];
  const kick = vi.fn();
  const waitingDemand = vi.fn(options.waiting ?? (() => []));
  const shutdownCalls: string[] = [];
  const shutdownArgs: unknown[][] = [];
  const bootCalls: string[] = [];
  const poolOptions: WarmPoolOptions = {
    acquisition: {
      kick,
      get maintenanceActive() {
        return options.maintenance?.() ?? false;
      },
      waitingDemand,
    },
    capacity: {
      runningCapacity: (devices): RunningCapacity => {
        const running = devices.filter((item) =>
          ["ready", "leased", "reclaiming", "quarantined"].includes(item.state),
        ).length;
        const entry = {
          maxRunning: options.limit ?? 10,
          overLimit: running > (options.limit ?? 10),
          reserved: 0,
          running,
        };
        return { android: entry, global: entry, ios: entry };
      },
      tryReserveBoot: () => {
        if (options.refuseBoot === true) return { ok: false, reason: "ram-budget" };
        const reservation = { released: 0 };
        reservations.push(reservation);
        return {
          ok: true,
          reservation: {
            release: () => {
              reservation.released += 1;
            },
          },
        };
      },
    },
    claims: {
      isClaimed: (id) => claims.isClaimed(id),
      operationFor: (id) => claims.operationFor(id),
      tryClaim: (id, operation) =>
        options.refuseClaim === true ? undefined : claims.tryClaim(id, operation),
    },
    clock,
    config: { enabled: options.enabled ?? true },
    decisions: new SerializedDecision(),
    eventBus,
    idle: { shutdownAfterMs: 10 * minute },
    lifecycle: {
      bootWarm: async (target, claim) => {
        bootCalls.push(target.id);
        const claimed = claims.isClaimed(target.id) && claims.isActive(claim);
        const last = reservations.at(-1);
        if (last !== undefined) last.claimedAtBoot = claimed;
        // Unlike the real lifecycle this leaves the claim to the caller, so what the pool does
        // about it is what the test sees.
        if (options.boot !== undefined) return options.boot(target);
        return setState(target.id, "ready");
      },
      shutdown: async (target, ...rest) => {
        shutdownCalls.push(target.id);
        shutdownArgs.push(rest);
        if (options.shutdown !== undefined) return options.shutdown(target);
        return setState(target.id, "shutdown");
      },
    },
    logger: new JsonLinesLogger({ clock, sink }),
    registry: {
      get snapshot() {
        return { devices: state.devices, leases: state.leases };
      },
    },
  };
  const pool = new WarmPool(poolOptions);
  return {
    bootCalls,
    claims,
    clock,
    eventBus,
    kick,
    lease,
    pool,
    reservations,
    shutdownArgs,
    shutdownCalls,
    sink,
    state,
    waitingDemand,
  };
}

describe("warm pool converger", () => {
  it("still kicks acquisition when a boot fails", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => {
        throw new Error("emulator did not come up");
      },
    });

    await rig.pool.pass();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.kick).toHaveBeenCalledTimes(1);
  });

  it("kicks acquisition after a boot or a shutdown that succeeds", async () => {
    const booted = harness([device("shut", "shutdown", 1_000)]);
    await booted.pool.pass();
    const shutDown = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
    });
    await shutDown.pool.pass();

    expect(booted.bootCalls).toEqual(["shut"]);
    expect(booted.kick).toHaveBeenCalledTimes(1);
    expect(shutDown.shutdownCalls).toEqual(["a"]);
    expect(shutDown.kick).toHaveBeenCalledTimes(1);
  });

  it("leaves a device alone that was leased between the proposal and the action", async () => {
    let lease: (id: string) => void = () => undefined;
    const rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          // The first shutdown runs outside the decision gate; `b` is leased while it does.
          lease("b");
          return { ...target, state: "shutdown" };
        },
      },
    );
    lease = rig.lease;

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
    expect(rig.sink.records).toEqual([]);
    expect(rig.kick).toHaveBeenCalledTimes(1);
  });

  it("leaves a device alone whose lease appears before its state does", async () => {
    let lease: () => void = () => undefined;
    const rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          // `b` gets a lease record while its snapshot state still reads `ready`.
          lease();
          return { ...target, state: "shutdown" };
        },
      },
    );
    lease = () => void rig.state.leases.push(leaseOn("b"));

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

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
    const boot = harness([device("shut", "shutdown", 1_000)], { boot: async () => undefined });

    await shutdown.pool.pass();
    await boot.pool.pass();

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

  it("holds a boot reservation and a boot claim through the boot, and releases the reservation when it commits", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)]);

    await rig.pool.pass();

    expect(rig.reservations).toHaveLength(1);
    expect(rig.reservations[0]?.claimedAtBoot).toBe(true);
    expect(rig.reservations[0]?.released).toBe(1);
    expect(rig.claims.isClaimed("shut")).toBe(false);
  });

  it("releases the boot reservation and the claim when the boot fails", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => {
        throw new Error("boot failed");
      },
    });

    await rig.pool.pass();

    expect(rig.reservations).toHaveLength(1);
    expect(rig.reservations[0]?.released).toBe(1);
    expect(rig.claims.isClaimed("shut")).toBe(false);
    const lines = rig.sink.records.filter((record) => record.level === "warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      fields: { deviceId: "shut", step: "boot" },
      message: "warm pool boot of a device failed",
    });
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
    rig.eventBus.emit("device.deleted", { deviceId: "y", initiator: "test" }, "test");
    release();
    await rig.pool.settle();

    expect(rig.waitingDemand).toHaveBeenCalledTimes(2);
    rig.pool.dispose();
  });

  it("does not try a device again within a tick of its boot failing, and does after", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      boot: async () => {
        throw new Error("boot failed");
      },
    });

    await rig.pool.pass();
    await rig.pool.pass();
    expect(rig.bootCalls).toEqual(["shut"]);

    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.pass();
    expect(rig.bootCalls).toEqual(["shut", "shut"]);
  });

  it("does not boot a device that was claimed between the proposal and the action", async () => {
    let claimY: () => void = () => undefined;
    const rig = harness([device("x", "shutdown", 1_000), device("y", "shutdown", 2_000)], {
      boot: async (target) => {
        // The first boot runs outside the decision gate; another operation takes `y` meanwhile.
        claimY();
        return { ...target, state: "ready" };
      },
    });
    claimY = () => void rig.claims.tryClaim("y", "eviction");

    await rig.pool.pass();

    expect(rig.bootCalls).toEqual(["x"]);
    expect(rig.reservations).toHaveLength(1);
  });

  it("boots nothing, takes no claim and does not kick when capacity refuses the reservation", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], { refuseBoot: true });

    await rig.pool.pass();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.claims.isClaimed("shut")).toBe(false);
    expect(rig.kick).not.toHaveBeenCalled();
    expect(rig.sink.records).toEqual([]);
  });

  it("proposes no budget shutdown while a ready device is claimed for a boot on its way to a lease", async () => {
    const rig = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], { limit: 1 });
    const handoff = rig.claims.tryClaim("b", "boot");

    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual([]);

    handoff?.release();
    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual(["a"]);
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

  it("releases the reservation and boots nothing when the device claim is refused", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], { refuseClaim: true });

    await rig.pool.pass();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.reservations).toHaveLength(1);
    expect(rig.reservations[0]?.released).toBe(1);
    expect(rig.sink.records).toEqual([]);
    expect(rig.kick).not.toHaveBeenCalled();
  });

  it("leaves a device alone whose state changed between the proposal and the shutdown", async () => {
    let change: () => void = () => undefined;
    const rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          change();
          return { ...target, state: "shutdown" };
        },
      },
    );
    change = () => {
      rig.state.devices = rig.state.devices.map((item) =>
        item.id === "b" ? { ...item, state: "reclaiming" } : item,
      );
    };

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("leaves a device alone that left the registry between the proposal and the shutdown", async () => {
    let remove: () => void = () => undefined;
    const rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          remove();
          return { ...target, state: "shutdown" };
        },
      },
    );
    remove = () => {
      rig.state.devices = rig.state.devices.filter((item) => item.id !== "b");
    };

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
    expect(rig.sink.records).toEqual([]);
  });

  it("leaves a shut-down device alone that is no longer shut down when its boot comes", async () => {
    let change: () => void = () => undefined;
    const rig = harness([device("x", "shutdown", 1_000), device("y", "shutdown", 2_000)], {
      boot: async (target) => {
        change();
        return { ...target, state: "ready" };
      },
    });
    change = () => {
      rig.state.devices = rig.state.devices.map((item) =>
        item.id === "y" ? { ...item, state: "ready" } : item,
      );
    };

    await rig.pool.pass();

    expect(rig.bootCalls).toEqual(["x"]);
  });

  it("disposes without error when it was never started", async () => {
    const rig = harness([]);

    expect(() => rig.pool.dispose()).not.toThrow();
  });

  it("logs one line for a shutdown that fails and leaves the device ready", async () => {
    const rig = harness([device("a", "ready", 5_000), device("b", "ready", 1_000)], {
      limit: 1,
      shutdown: async () => {
        throw new Error("simctl shutdown failed");
      },
    });

    await rig.pool.pass();

    const lines = rig.sink.records.filter((record) => record.level === "warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      fields: { deviceId: "a", step: "shutdown" },
      message: "warm pool shutdown of a device failed",
    });
    expect(String(lines[0]?.fields?.["error"])).toContain("simctl shutdown failed");
    expect(rig.state.devices.find((item) => item.id === "a")?.state).toBe("ready");
    expect(rig.kick).toHaveBeenCalledTimes(1);
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
      ["device.deleted", { deviceId: "d", initiator: "test" }],
      ["cleanup.executed", { action: "shutdown", reason: "r", ruleName: "n", target: "d" }],
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

    rig.pool.dispose();
    const afterDispose = rig.waitingDemand.mock.calls.length;
    rig.eventBus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.waitingDemand.mock.calls.length).toBe(afterDispose);
  });
});
