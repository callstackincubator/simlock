import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../../ports/index.js";
import type { RunningCapacity } from "../capacity/index.js";
import { DeviceOperationClaims } from "../device-operation-claims.js";
import type {
  DeviceRecord,
  DeviceSpec,
  LeaseRecord,
  TargetResolution,
  WaitingDemand,
} from "../domain.js";
import { BootTimeoutError, type DeviceRequest } from "../driver.js";
import { SerializedDecision } from "../serialized-decision.js";
import type { WarmTarget } from "./config.js";
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
    targets?: readonly WarmTarget[];
    maxConcurrentBoots?: number;
    /** The mode a request naming none plans on iOS: `ios.defaultMode`; full when none is set. */
    defaultMode?: "slim" | "full";
    /** What a target resolves to; by default the request's own model and OS (26.0 when none). */
    resolve?: (request: DeviceRequest) => TargetResolution | Promise<TargetResolution>;
    /** Holds a creation until the test lets it go; the creation fails when this rejects. */
    provision?: (spec: DeviceSpec, attempt: number) => Promise<void>;
    refuseProvision?: boolean;
    /** The budget allows a creation when asked, then refuses the reservation: a lost race. */
    refuseReservation?: boolean;
    /** The budget's reservation call throws, which no refusal does. */
    reserveThrows?: boolean;
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
  const reservations: { released: number; claimedAtBoot?: boolean; releasedAtBoot?: number }[] = [];
  const kick = vi.fn();
  // One read per pass. A pool that spins fails every pass after the 200th here (the pass logs it
  // and ends) instead of exhausting the worker's heap; no test asserts on this guard.
  const passes = { count: 0 };
  const waitingDemand = vi.fn(() => {
    passes.count += 1;
    if (passes.count > 200) throw new Error("the warm pool is spinning");
    return options.waiting?.() ?? [];
  });
  const shutdownCalls: string[] = [];
  const shutdownArgs: unknown[][] = [];
  const bootCalls: string[] = [];
  const resolveCalls: DeviceRequest[] = [];
  const provisionCalls: {
    spec: DeviceSpec;
    claim: { kind: string; owner?: string | undefined } | undefined;
    reservationReleasedAtReturn: number;
    deviceId?: string;
  }[] = [];
  const provisionReservations: { released: number }[] = [];
  const reserveAttempts = { count: 0 };
  const poolOptions: WarmPoolOptions = {
    acquisition: {
      kick,
      get maintenanceActive() {
        return options.maintenance?.() ?? false;
      },
      resolve: async (request) => {
        resolveCalls.push(request);
        if (options.resolve !== undefined) return options.resolve(request);
        return {
          spec: {
            model: request.model ?? "",
            osVersion: request.osVersion ?? "26.0",
            platform: request.platform,
            ...((request.mode ?? options.defaultMode) === "slim" ? { mode: "slim" as const } : {}),
          },
        };
      },
      defaultMode: () => options.defaultMode ?? "full",
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
      canBoot: () =>
        options.refuseBoot === true ? { ok: false, reason: "ram-budget" } : { ok: true },
      canProvision: () =>
        options.refuseProvision === true ? { ok: false, reason: "device-limit" } : { ok: true },
      tryReserveProvisioning: () => {
        reserveAttempts.count += 1;
        if (options.reserveThrows === true) throw new Error("the budget is unreadable");
        if (options.refuseProvision === true || options.refuseReservation === true)
          return { ok: false, reason: "device-limit" };
        const reservation = { released: 0 };
        provisionReservations.push(reservation);
        return {
          ok: true,
          reservation: {
            release: () => {
              reservation.released += 1;
            },
          },
        };
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
    config: {
      enabled: options.enabled ?? true,
      maxConcurrentBoots: options.maxConcurrentBoots ?? 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: options.targets ?? [],
    },
    decisions: new SerializedDecision(),
    eventBus,
    idle: { shutdownAfterMs: 10 * minute },
    lifecycle: {
      bootWarm: async (target, claim) => {
        bootCalls.push(target.id);
        const claimed = claims.isClaimed(target.id) && claims.isActive(claim);
        const last = reservations.at(-1);
        if (last !== undefined) {
          last.claimedAtBoot = claimed;
          last.releasedAtBoot = last.released;
        }
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
    provisioner: {
      provision: async (spec, provisionOptions) => {
        const record: (typeof provisionCalls)[number] = {
          claim: provisionOptions.claim,
          reservationReleasedAtReturn: 0,
          spec,
        };
        provisionCalls.push(record);
        try {
          await options.provision?.(spec, provisionCalls.length);
        } catch (error: unknown) {
          provisionOptions.reservation.release();
          throw error instanceof Error ? error : new BootTimeoutError("new");
        }
        const id = `new-${provisionCalls.length}`;
        const created: DeviceRecord = {
          createdAt: now,
          driverData: {},
          driverDeviceId: `driver-${id}`,
          id,
          mode: "full",
          readyAt: clock.now(),
          spec,
          state: "ready",
        };
        state.devices = [...state.devices, created];
        const claim = claims.tryClaim(
          id,
          provisionOptions.claim?.kind ?? "boot",
          provisionOptions.claim?.owner,
        );
        if (claim === undefined) throw new Error("the new device is already claimed");
        provisionOptions.reservation.release();
        record.deviceId = id;
        return { claim, device: created };
      },
    },
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
    provisionCalls,
    provisionReservations,
    reservations,
    reserveAttempts,
    resolveCalls,
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
    expect(rig.reservations[0]?.releasedAtBoot).toBe(0);
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
    expect(rig.sink.records).toEqual([]);
  });

  it("marks only devices that are shut down while a reset holds acquisition closed, and copes with one that left the registry", async () => {
    let closed = true;
    const rig = harness([device("up", "ready", 1_000), device("gone", "shutdown", 2_000)], {
      maintenance: () => closed,
    });
    await rig.pool.pass();
    closed = false;

    // `up` is shut down only after the reset; `gone` leaves the registry before the next pass.
    rig.state.devices = rig.state.devices
      .filter((item) => item.id !== "gone")
      .map((item) => ({ ...item, state: "shutdown" as const }));
    await rig.pool.pass();

    expect(rig.bootCalls).toEqual(["up"]);
    expect(rig.sink.records).toEqual([]);
  });

  it("clears the reset mark once the device has left shutdown, so it is an ordinary recently released device again", async () => {
    let closed = true;
    const rig = harness([device("down", "shutdown", 1_000)], { maintenance: () => closed });
    await rig.pool.pass();
    closed = false;

    rig.state.devices = rig.state.devices.map((item) => ({ ...item, state: "leased" }));
    await rig.pool.pass();
    rig.state.devices = rig.state.devices.map((item) => ({ ...item, state: "shutdown" }));
    await rig.pool.pass();

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

describe("warm pool targets", () => {
  const iphone17: WarmTarget = { count: 1, model: "iPhone 17", osVersion: "26.0", platform: "ios" };
  const kind = { model: "iPhone 17", osVersion: "26.0", platform: "ios" } as const;
  const ofKind = (id: string, state: DeviceRecord["state"], createdAt = 1): DeviceRecord => ({
    createdAt,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    mode: "full",
    spec: kind,
    state,
  });
  /** A creation the test holds open until it calls `finish`, or fails with `fail`. */
  function held() {
    let finish: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const gate = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return { fail, finish, gate };
  }
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  };

  it("with a target and no device, makes one creation under an ownerless boot claim and a provisioning reservation, and releases the claim once the device is ready", async () => {
    const rig = harness([], { targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.provisionCalls[0]?.spec).toEqual(kind);
    expect(rig.provisionCalls[0]?.claim).toEqual({ kind: "boot" });
    expect(rig.provisionReservations).toHaveLength(1);
    expect(rig.claims.isClaimed("new-1")).toBe(false);
    expect(rig.state.devices.map((item) => item.state)).toEqual(["ready"]);
    expect(rig.kick).toHaveBeenCalled();
  });

  it("boots a shut-down device of the target's kind before creating one, and counts the target filled", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.provisionCalls).toEqual([]);
    expect(rig.reservations[0]?.claimedAtBoot).toBe(true);
    expect(rig.claims.isClaimed("shut")).toBe(false);
  });

  it("creates nothing when the target's count of devices is ready, and never shuts a device down for it", async () => {
    const rig = harness([ofKind("a", "ready"), ofKind("b", "ready")], {
      limit: 2,
      targets: [{ ...iphone17, count: 2 }],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.shutdownCalls).toEqual([]);
    expect(rig.bootCalls).toEqual([]);
  });

  it("shuts a never-leased device no target counts down with the warm-pool initiator once it has been ready past idle.shutdownAfterMs", async () => {
    const rig = harness([{ ...ofKind("extra", "ready"), readyAt: now - 11 * minute }]);

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["extra"]);
    expect(rig.shutdownArgs).toEqual([["warm-pool", "cleanup"]]);
  });

  it("runs the target creations one after the other with maxConcurrentBoots 1, the second starting only after the first is ready", async () => {
    const first = held();
    const second = held();
    const gates = [first, second];
    const rig = harness([], {
      provision: async (_spec, attempt) => gates[attempt - 1]?.gate,
      targets: [{ ...iphone17, count: 2 }],
    });

    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    // A further pass while the first is still running starts no second one.
    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    first.finish();
    await flush();
    expect(rig.provisionCalls).toHaveLength(2);
    second.finish();
    await rig.pool.settle();
    expect(rig.state.devices.map((item) => item.state)).toEqual(["ready", "ready"]);
  });

  it("runs two creations at once with maxConcurrentBoots 2 and not a third", async () => {
    const gate = held();
    const rig = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => gate.gate,
      targets: [{ ...iphone17, count: 3 }],
    });

    await rig.pool.pass();
    await flush();

    expect(rig.provisionCalls).toHaveLength(2);
    gate.finish();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
  });

  it("does not return from a pass for a creation it started, and settle waits for it", async () => {
    const gate = held();
    const rig = harness([], { provision: async () => gate.gate, targets: [iphone17] });

    await rig.pool.pass();
    let settled = false;
    const settling = rig.pool.settle().then(() => {
      settled = true;
    });
    await flush();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(settled).toBe(false);
    gate.finish();
    await settling;
    expect(settled).toBe(true);
  });

  it("makes one creation attempt per allowed attempt when it fails: none on the passes between, one a minute after the first, the next two minutes after that", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });
    rig.pool.start();

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    // Passes triggered by events and ticks within the minute change nothing.
    rig.eventBus.emit("device.shutdown", { deviceId: "d", initiator: "test" }, "test");
    await rig.pool.settle();
    rig.clock.advance(WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    rig.clock.advance(minute - WARM_POOL_TICK_MS);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);

    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
    rig.pool.dispose();
  });

  it("arms a timer for the next allowed attempt, so a pass runs when it is due with no event and no tick", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);

    // `start()` was never called: no tick and no subscription, only the retry timer is armed.
    rig.clock.advance(minute);
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(2);
  });

  it("reports the target short with boot-failed between tries, and logs it once", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("the runtime would not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    await rig.pool.pass();
    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ count: 1, ready: 0, short: "boot-failed" }),
    ]);
    const shortLines = rig.sink.records.filter(
      (record) => record.message === "a warm pool target is short",
    );
    expect(shortLines).toHaveLength(1);
    expect(shortLines[0]?.fields).toMatchObject({
      short: "boot-failed",
      target: "ios iPhone 17 26.0",
    });
    const failure = rig.sink.records.filter(
      (record) => record.message === "warm pool creation of a device failed",
    );
    expect(failure).toHaveLength(1);
    expect(failure[0]?.fields).toMatchObject({ model: "iPhone 17", step: "provision" });
    expect(String(failure[0]?.fields?.["error"])).toContain("the runtime would not boot");
  });

  it("holds a failed boot of a shut-down device of the kind back for a minute, then boots it again", async () => {
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => {
        throw new Error("simulator did not boot");
      },
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut"]);

    rig.clock.advance(minute - 1);
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut"]);
    rig.clock.advance(1);
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual(["shut", "shut"]);
  });

  it("clears the schedule when a creation succeeds, so a later failure waits one minute again", async () => {
    let failing = true;
    const rig = harness([], {
      provision: async () => {
        if (failing) throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
    failing = false;
    rig.clock.advance(2 * minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(3);
    expect(rig.state.devices).toHaveLength(1);

    // The device is leased: the target is short again, and now fails once more.
    failing = true;
    rig.lease("new-3");
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(4);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(5);
  });

  it("reports a target naming a runtime that is not installed as runtime-missing, creates nothing and logs the reason", async () => {
    const rig = harness([], {
      resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
      targets: [{ ...iphone17, osVersion: "27.0" }],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([
      {
        booting: 0,
        count: 1,
        kind: { mode: "full", model: "iPhone 17", osVersion: "27.0", platform: "ios" },
        message: "iOS 27.0 is not installed",
        ready: 0,
        short: "runtime-missing",
        target: "ios iPhone 17 27.0",
      },
    ]);
    const shortLines = rig.sink.records.filter(
      (record) => record.message === "a warm pool target is short",
    );
    expect(shortLines).toHaveLength(1);
    expect(shortLines[0]?.fields).toMatchObject({
      count: 1,
      message: "iOS 27.0 is not installed",
      ready: 0,
      short: "runtime-missing",
      target: "ios iPhone 17 27.0",
    });
  });

  it.each([
    ["no-driver", "there is no android driver"],
    ["unknown-model", "Unknown ios model: iPhone 99"],
    ["unresolvable", "the simulator service is down"],
  ] as const)(
    "reports a target the resolver answers %s for, with its message",
    async (refusal, message) => {
      const rig = harness([], { resolve: () => ({ message, refusal }), targets: [iphone17] });

      await rig.pool.pass();

      expect(rig.pool.targets()).toEqual([expect.objectContaining({ message, short: refusal })]);
      expect(rig.provisionCalls).toEqual([]);
    },
  );

  it("resolves every target again each pass, so a runtime installed since takes effect without a restart", async () => {
    let installed = false;
    const rig = harness([], {
      resolve: () =>
        installed
          ? { spec: kind }
          : { message: "not installed", refusal: "runtime-missing" as const },
      targets: [iphone17],
    });
    await rig.pool.pass();
    expect(rig.provisionCalls).toEqual([]);

    installed = true;
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.resolveCalls.length).toBeGreaterThanOrEqual(2);
    expect(rig.provisionCalls).toHaveLength(1);
  });

  it("resolves a target as the request it is: platform, exact model, and the OS and mode it names", async () => {
    const rig = harness([], {
      targets: [
        { count: 1, mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
        { count: 1, model: "Pixel 9", platform: "android" },
      ],
    });

    await rig.pool.pass();

    expect(rig.resolveCalls).toStrictEqual([
      { mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
      { model: "Pixel 9", platform: "android" },
    ]);
  });

  it("creates two devices for two targets resolving to one spec, one after the other, as one target of the summed count", async () => {
    const first = held();
    const second = held();
    const rig = harness([], {
      provision: async (_spec, attempt) => [first, second][attempt - 1]?.gate,
      resolve: () => ({ spec: kind }),
      targets: [iphone17, { ...iphone17, osVersion: ">=26" }],
    });

    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);
    first.finish();
    await flush();
    expect(rig.provisionCalls).toHaveLength(2);
    second.finish();
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(2);
    expect(rig.pool.targets()).toHaveLength(1);
    expect(rig.pool.targets()[0]).toMatchObject({ count: 2, ready: 2 });
  });

  it("does nothing for a target while an operator reset holds acquisition closed", async () => {
    const rig = harness([], { maintenance: () => true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
  });

  it("creates nothing for a target the capacity strategy refuses, and reports why", async () => {
    const rig = harness([], { refuseProvision: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "device-limit" })]);
  });

  it("creates nothing, and reports no failure, when the budget refuses the reservation after the policy allowed the creation", async () => {
    const rig = harness([], { refuseReservation: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.sink.records.filter((record) => record.level === "error")).toEqual([]);
    // A declined creation asks for no pass of its own: the same view would propose it again.
    expect(rig.resolveCalls).toHaveLength(1);
    // Not a failure: the target is not held back, and the next pass tries it again.
    await rig.pool.pass();
    expect(rig.resolveCalls).toHaveLength(2);
    expect(rig.pool.targets()[0]?.short).toBeUndefined();
  });

  it("boots nothing, and asks for no pass of its own, when the device's boot claim is refused", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { refuseClaim: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.reservations.every((reservation) => reservation.released === 1)).toBe(true);
  });

  it("asks for no pass of its own when the lifecycle declines a target's boot", async () => {
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => undefined,
      targets: [iphone17],
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual(["shut"]);
    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.kick).not.toHaveBeenCalled();
  });

  it("reports and logs nothing before its first pass", () => {
    const rig = harness([ofKind("ready", "ready")], { targets: [iphone17] });

    expect(rig.pool.targets()).toEqual([]);
    expect(rig.sink.records).toEqual([]);
  });

  it("resolves the targets itself when asked which devices they keep before any pass has run", async () => {
    const rig = harness([ofKind("ready", "ready")], { targets: [iphone17] });

    expect([...(await rig.pool.targeted())]).toEqual(["ready"]);
    expect(rig.resolveCalls).toHaveLength(1);
    // Resolved once: a later ask reads what is there, and a pass resolves again on its own.
    await rig.pool.targeted();
    expect(rig.resolveCalls).toHaveLength(1);
  });

  it("stops acting on the rest of a pass's proposals once a drain begins", async () => {
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness(
      [
        device("a", "ready", 90 * minute),
        device("b", "ready", 80 * minute),
        device("c", "ready", 70 * minute),
      ],
      {
        limit: 1,
        shutdown: async (target) => {
          void rig?.pool.drain();
          return { ...target, state: "shutdown" };
        },
      },
    );

    await rig.pool.pass();

    expect(rig.shutdownCalls).toEqual(["a"]);
  });

  it("does not hold a target back for a keep boot that succeeds or fails, which no target owns", async () => {
    const released = device("released", "shutdown", 1_000, "ios");
    const ipad = { ...released, spec: { ...released.spec, model: "iPad Pro" } };
    const failing = harness([ipad, ofKind("ready", "ready")], {
      boot: async () => {
        throw new Error("simulator did not boot");
      },
      targets: [iphone17],
    });
    await failing.pool.pass();
    await failing.pool.settle();
    await failing.pool.pass();
    expect(failing.bootCalls).toEqual(["released"]);
    expect(failing.sink.records.filter((record) => record.level === "error")).toEqual([]);
    expect(failing.clock.pendingTimerCount).toBe(0);

    const working = harness([ipad, ofKind("ready", "ready")], { targets: [iphone17] });
    await working.pool.pass();
    await working.pool.settle();
    expect(working.sink.records.filter((record) => record.level !== "info")).toEqual([]);
  });

  it("resolves no target, reports none and names no device with warmPool disabled", async () => {
    const rig = harness([ofKind("ready", "ready")], {
      enabled: false,
      resolve: () => ({ message: "not installed", refusal: "runtime-missing" }),
      targets: [iphone17],
    });

    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([]);
    expect([...(await rig.pool.targeted())]).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
    expect(
      rig.sink.records.filter((record) => record.message === "a warm pool target is short"),
    ).toEqual([]);
  });

  it("keeps a target's last resolved spec when one pass cannot resolve it, and drops it for a settled refusal", async () => {
    let answer: TargetResolution = { spec: kind };
    const stale = { ...ofKind("stale", "ready"), readyAt: now - 11 * minute };
    const rig = harness([stale], { resolve: () => answer, targets: [{ ...iphone17, count: 2 }] });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.shutdownCalls).toEqual([]);
    expect(rig.provisionCalls).toHaveLength(1);
    rig.lease("new-1");

    // The target is one short, but the spec it may no longer have plans no creation for it.
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.shutdownCalls).toEqual([]);
    expect([...(await rig.pool.targeted())]).toEqual(["stale"]);
    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ message: "simctl timed out", ready: 1, short: "unresolvable" }),
    ]);
    const line = rig.sink.records.filter(
      (record) => record.message === "a warm pool target is short",
    );
    expect(line[0]?.fields).toMatchObject({ ready: 1, short: "unresolvable" });

    answer = { message: "gone", refusal: "runtime-missing" };
    await rig.pool.pass();
    expect(rig.shutdownCalls).toEqual(["stale"]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "runtime-missing" })]);

    // The spec it once had is gone with a settled refusal: a later failed read has none to keep.
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    rig.state.devices = rig.state.devices.map((item) =>
      item.id === "stale" ? { ...item, state: "ready" as const } : item,
    );
    await rig.pool.pass();
    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ ready: 0, short: "unresolvable" }),
    ]);
    expect([...(await rig.pool.targeted())]).toEqual([]);
  });

  it("lets a target boot a device whose keep boot failed a moment ago, which no target owns", async () => {
    const targets: WarmTarget[] = [];
    let attempts = 0;
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => {
        attempts += 1;
        throw new Error("simulator did not boot");
      },
      targets,
    });
    rig.state.devices = rig.state.devices.map((item) => ({
      ...item,
      lastLeaseEndedAt: now - 10 * minute + 10_000,
    }));
    await rig.pool.pass();
    await rig.pool.settle();
    expect(attempts).toBe(1);

    // No longer recently released, so the keep rule leaves it; the 30 s pause has not ended.
    rig.clock.advance(15_000);
    targets.push(iphone17);
    await rig.pool.pass();
    await rig.pool.settle();

    expect(attempts).toBe(2);
  });

  it("starts nothing once closed, before it drains", async () => {
    const rig = harness([], { targets: [iphone17] });

    rig.pool.close();
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.provisionCalls).toEqual([]);
    expect(rig.resolveCalls).toEqual([]);
  });

  it("does not count a claimed device as ready in the report of a target it cannot resolve", async () => {
    let answer: TargetResolution = { spec: kind };
    const rig = harness([ofKind("busy", "ready")], { resolve: () => answer, targets: [iphone17] });
    await rig.pool.pass();
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ ready: 1 })]);

    rig.claims.tryClaim("busy", "eviction");
    answer = { message: "simctl timed out", refusal: "unresolvable" };
    await rig.pool.pass();

    expect(rig.pool.targets()).toEqual([
      expect.objectContaining({ ready: 0, short: "unresolvable" }),
    ]);
  });

  it("does not pause a device after a failed target boot, so a keep boot of it a moment later is not dropped", async () => {
    const targets: WarmTarget[] = [iphone17];
    let attempts = 0;
    const rig = harness([ofKind("shut", "shutdown")], {
      boot: async () => {
        attempts += 1;
        throw new Error("simulator did not boot");
      },
      targets,
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(attempts).toBe(1);

    // The target is dropped and the device was released a moment ago: the keep rule boots it,
    // well inside the 30 s a keep boot's own failure would hold it.
    targets.length = 0;
    rig.state.devices = rig.state.devices.map((item) => ({
      ...item,
      lastLeaseEndedAt: now - 1_000,
    }));
    rig.clock.advance(1_000);
    await rig.pool.pass();
    await rig.pool.settle();

    expect(attempts).toBe(2);
  });

  it("starts nothing new once draining, though a creation that was running ends", async () => {
    const gate = held();
    const rig = harness([], {
      provision: async () => gate.gate,
      targets: [{ ...iphone17, count: 3 }],
    });
    await rig.pool.pass();
    await flush();
    expect(rig.provisionCalls).toHaveLength(1);

    const draining = rig.pool.drain();
    gate.finish();
    await draining;
    const resolved = rig.resolveCalls.length;
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.resolveCalls).toHaveLength(resolved);

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.state.devices).toHaveLength(1);
    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("logs a boot or creation that throws outside the driver, holds the target back and asks for no immediate retry", async () => {
    const rig = harness([], { reserveThrows: true, targets: [iphone17] });

    await rig.pool.pass();
    // Bounded by turns, not by settle: a pool that retried at once would never settle.
    await flush();

    expect(rig.reserveAttempts.count).toBe(1);
    const errors = rig.sink.records.filter((record) => record.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      fields: { step: "flight" },
      message: "a warm pool boot or creation failed",
    });
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "boot-failed" })]);
    expect(rig.clock.pendingTimerCount).toBe(1);
  });

  it("reports ram-budget and boots nothing when the capacity strategy refuses the shut-down device's boot", async () => {
    const rig = harness([ofKind("shut", "shutdown")], { refuseBoot: true, targets: [iphone17] });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.bootCalls).toEqual([]);
    expect(rig.pool.targets()).toEqual([expect.objectContaining({ short: "ram-budget" })]);
  });

  it("counts a creation still running toward its target, so a second pass starts no second one even with room for two boots", async () => {
    const gate = held();
    const rig = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => gate.gate,
      targets: [iphone17],
    });

    await rig.pool.pass();
    await flush();
    await rig.pool.pass();
    await flush();

    expect(rig.provisionCalls).toHaveLength(1);
    expect(rig.sink.records.filter((record) => record.level === "error")).toEqual([]);
    gate.finish();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
  });

  it("asks for no pass and arms no timer once disposed, for a creation that ends afterwards", async () => {
    const gate = held();
    const rig = harness([], { provision: async () => gate.gate, targets: [iphone17] });
    await rig.pool.pass();
    await flush();

    rig.pool.dispose();
    gate.fail(new Error("the runtime would not boot"));
    await flush();

    expect(rig.resolveCalls).toHaveLength(1);
    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("cancels the retry timer on dispose, and arms none when a pass that was running ends after it", async () => {
    let hold: Promise<void> | undefined;
    const rig = harness([], {
      provision: async () => {
        throw new Error("no luck");
      },
      resolve: async (request) => {
        await hold;
        return {
          spec: { model: request.model ?? "", osVersion: "26.0", platform: request.platform },
        };
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.clock.pendingTimerCount).toBe(1);

    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = rig.pool.pass();
    rig.pool.dispose();
    expect(rig.clock.pendingTimerCount).toBe(0);
    release();
    await running;

    expect(rig.clock.pendingTimerCount).toBe(0);
  });

  it("keeps one retry timer however many passes run while a target is held back", async () => {
    const rig = harness([], {
      provision: async () => {
        throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();

    await rig.pool.pass();
    await rig.pool.pass();
    await rig.pool.settle();

    expect(rig.clock.pendingTimerCount).toBe(1);
  });

  it("arms the timer for a second held-back target when the first one's retry succeeds, so no tick is needed", async () => {
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness([], {
      provision: async (spec, attempt) => {
        // Attempt 1 (iPhone 17) fails at once, attempt 2 (iPhone 16) fails ten seconds later,
        // attempt 3 (iPhone 17 again) succeeds, attempt 4 (iPhone 16 again) is the one under test.
        if (attempt === 2) rig?.clock.advance(10_000);
        if (attempt <= 2) throw new Error(`no luck for ${spec.model}`);
      },
      targets: [iphone17, { ...iphone17, model: "iPhone 16" }],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual(["iPhone 17", "iPhone 16"]);

    // iPhone 17 may be tried at 60s and succeeds; iPhone 16 failed ten seconds later.
    rig.clock.advance(50_000);
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual([
      "iPhone 17",
      "iPhone 16",
      "iPhone 17",
    ]);

    rig.clock.advance(10_000);
    await rig.pool.settle();
    expect(rig.provisionCalls.map((call) => call.spec.model)).toEqual([
      "iPhone 17",
      "iPhone 16",
      "iPhone 17",
      "iPhone 16",
    ]);
  });

  it("clears the schedule when a boot of a shut-down device succeeds, so a later failure waits one minute again", async () => {
    let bootAttempts = 0;
    let creating = false;
    let rig: ReturnType<typeof harness> | undefined;
    rig = harness([ofKind("shut", "shutdown")], {
      boot: async (target) => {
        bootAttempts += 1;
        if (bootAttempts === 1) throw new Error("simulator did not boot");
        const ready = { ...target, state: "ready" as const };
        if (rig !== undefined) rig.state.devices = [ready];
        return ready;
      },
      provision: async () => {
        if (creating) throw new Error("no luck");
      },
      targets: [iphone17],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(bootAttempts).toBe(1);

    // The boot is retried after a minute and succeeds.
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(bootAttempts).toBe(2);

    // The device is then leased, the target is short again, and a creation fails: one minute
    // later it is tried again, not two.
    creating = true;
    rig.lease("shut");
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(1);
    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.provisionCalls).toHaveLength(2);
  });

  it("logs a target again when the reason it is short changes, and logs two targets short for the same reason once each", async () => {
    let refusal: "runtime-missing" | "unresolvable" = "runtime-missing";
    const rig = harness([], {
      resolve: () => ({ message: "why", refusal }),
      targets: [iphone17, { ...iphone17, model: "iPhone 16" }],
    });

    await rig.pool.pass();
    await rig.pool.pass();
    refusal = "unresolvable";
    await rig.pool.pass();

    const lines = rig.sink.records
      .filter((record) => record.message === "a warm pool target is short")
      .map((record) => `${String(record.fields?.["target"])}:${String(record.fields?.["short"])}`);
    expect(lines).toEqual([
      "ios iPhone 17 26.0:runtime-missing",
      "ios iPhone 16 26.0:runtime-missing",
      "ios iPhone 17 26.0:unresolvable",
      "ios iPhone 16 26.0:unresolvable",
    ]);
  });

  describe("figures", () => {
    const wanted = {
      mode: "full",
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios",
    } as const;

    it("lists a target with its kind, count, ready and booting, and no reason while it fills", async () => {
      let finish: () => void = () => undefined;
      const rig = harness([ofKind("ready", "ready")], {
        limit: 5,
        provision: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        targets: [{ ...iphone17, count: 2 }],
      });

      await rig.pool.pass();

      expect(rig.pool.figures()).toStrictEqual({
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [{ ...wanted, booting: 1, count: 2, ready: 1 }],
      });
      finish();
      await rig.pool.settle();
    });

    it("lists a target the resolver refuses with the kind it was configured with and the refusal as short", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
        targets: [{ ...iphone17, osVersion: "27.0" }],
      });

      await rig.pool.pass();

      expect(rig.pool.figures().targets).toStrictEqual([
        { ...wanted, booting: 0, count: 1, osVersion: "27.0", ready: 0, short: "runtime-missing" },
      ]);
    });

    it("lists every configured target as short disabled with the pool off, before and after a pass", async () => {
      const rig = harness([ofKind("ready", "ready")], {
        enabled: false,
        targets: [iphone17, { ...iphone17, mode: "slim", model: "iPhone 16" }],
      });
      const expected = {
        enabled: false,
        reserveRunning: { android: 0, ios: 0 },
        targets: [
          { ...wanted, booting: 0, count: 1, ready: 0, short: "disabled" },
          {
            ...wanted,
            booting: 0,
            count: 1,
            mode: "slim",
            model: "iPhone 16",
            ready: 0,
            short: "disabled",
          },
        ],
      };

      expect(rig.pool.figures()).toStrictEqual(expected);
      await rig.pool.pass();
      expect(rig.pool.figures()).toStrictEqual(expected);
    });

    it("lists every configured target before the first pass with no reason, so a status read just after a start is not empty", () => {
      const rig = harness([], { targets: [iphone17] });

      expect(rig.pool.figures()).toStrictEqual({
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [{ ...wanted, booting: 0, count: 1, ready: 0 }],
      });
    });

    it("names the platform's default mode for a target that names none, before a pass, with the pool off, refused and resolved", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const modes = async (options: { enabled?: boolean; refuse?: boolean; pass: boolean }) => {
        const rig = harness([], {
          defaultMode: "slim",
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
          ...(options.refuse === true
            ? { resolve: () => ({ message: "why", refusal: "no-driver" as const }) }
            : {}),
          targets: [unversioned],
        });
        if (options.pass) await rig.pool.pass();
        return rig.pool.figures().targets.map((target) => target.mode);
      };

      expect(await modes({ pass: false })).toEqual(["slim"]);
      expect(await modes({ enabled: false, pass: true })).toEqual(["slim"]);
      expect(await modes({ pass: true, refuse: true })).toEqual(["slim"]);
      expect(await modes({ pass: true })).toEqual(["slim"]);
    });

    it("counts only the boots of the spec a target keeps while its resolution is refused unresolvable, and none for one that never resolved", async () => {
      const creation = held();
      let refuse17 = false;
      const rig = harness([], {
        limit: 5,
        maxConcurrentBoots: 2,
        provision: () => creation.gate,
        resolve: (request) => {
          if (request.model === "iPhone 15") return { message: "why", refusal: "no-driver" };
          if (request.model === "iPhone 17" && refuse17) {
            return { message: "why", refusal: "unresolvable" };
          }
          return {
            spec: { model: request.model ?? "", osVersion: "26.0", platform: request.platform },
          };
        },
        targets: [
          iphone17,
          { ...iphone17, model: "iPhone 16" },
          { ...iphone17, model: "iPhone 15" },
        ],
      });
      const figures = () =>
        Object.fromEntries(rig.pool.figures().targets.map((target) => [target.model, target]));
      await rig.pool.pass();
      expect(figures()["iPhone 17"]?.booting).toBe(1);

      refuse17 = true;
      await rig.pool.pass();

      expect(figures()["iPhone 17"]).toMatchObject({ booting: 1, short: "unresolvable" });
      expect(figures()["iPhone 16"]).toMatchObject({ booting: 1 });
      expect(figures()["iPhone 15"]).toMatchObject({ booting: 0, short: "no-driver" });
      creation.finish();
      await rig.pool.settle();
    });

    it("leaves out osVersion for a refused target that names none", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const rig = harness([], {
        resolve: () => ({ message: "no driver", refusal: "no-driver" }),
        targets: [unversioned],
      });

      await rig.pool.pass();

      expect(rig.pool.figures().targets[0]).toStrictEqual({
        booting: 0,
        count: 1,
        mode: "full",
        model: "iPhone 17",
        platform: "ios",
        ready: 0,
        short: "no-driver",
      });
    });
  });

  describe("warm-pool.target-missed", () => {
    const missed = (rig: ReturnType<typeof harness>): unknown[] => {
      const payloads: unknown[] = [];
      rig.eventBus.subscribe("warm-pool.target-missed", (envelope) => {
        payloads.push(envelope.payload);
      });
      return payloads;
    };

    it("fires once when a target first ends a pass short, with its kind, count, ready and reason", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
        targets: [{ ...iphone17, osVersion: "27.0" }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        {
          count: 1,
          mode: "full",
          model: "iPhone 17",
          osVersion: "27.0",
          platform: "ios",
          ready: 0,
          reason: "runtime-missing",
        },
      ]);
    });

    it("does not fire again on the next pass that leaves the target short", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "why", refusal: "runtime-missing" }),
        targets: [iphone17],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toHaveLength(1);
    });

    it("names the pool as the emitter, and leaves osVersion out for a target that names none", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const rig = harness([], {
        resolve: () => ({ message: "no driver", refusal: "no-driver" }),
        targets: [unversioned],
      });
      const seen: { module: string; payload: unknown }[] = [];
      rig.eventBus.subscribe("warm-pool.target-missed", (envelope) => {
        seen.push({ module: envelope.module, payload: envelope.payload });
      });

      await rig.pool.pass();

      expect(seen).toStrictEqual([
        {
          module: "warm-pool",
          payload: {
            count: 1,
            mode: "full",
            model: "iPhone 17",
            platform: "ios",
            ready: 0,
            reason: "no-driver",
          },
        },
      ]);
    });

    it("fires again when the target was met in between, ready reaching its count, and is missed again", async () => {
      let refuse = true;
      const rig = harness([ofKind("ready", "ready")], {
        resolve: (request) =>
          refuse
            ? { message: "why", refusal: "runtime-missing" }
            : {
                spec: { model: request.model ?? "", osVersion: "26.0", platform: request.platform },
              },
        targets: [iphone17],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      refuse = false;
      await rig.pool.pass();
      await rig.pool.settle();
      expect(rig.pool.figures().targets[0]).toMatchObject({ count: 1, ready: 1 });
      refuse = true;
      await rig.pool.pass();

      expect(payloads).toHaveLength(2);
    });

    it("does not fire again for a target that is only not short on a pass, filling or retrying, until it is met", async () => {
      const rig = harness([], {
        limit: 5,
        provision: async () => {
          throw new Error("no luck");
        },
        targets: [iphone17],
      });
      const payloads = missed(rig);

      // The first creation fails and the target is short `boot-failed`; the retry a minute later
      // is a pass that is not short (a creation runs), and it fails again.
      await rig.pool.pass();
      await rig.pool.settle();
      expect(rig.pool.figures().targets[0]?.short).toBe("boot-failed");
      rig.clock.advance(minute);
      await rig.pool.settle();
      rig.clock.advance(2 * minute);
      await rig.pool.settle();

      expect(rig.provisionCalls).toHaveLength(3);
      expect(payloads).toStrictEqual([expect.objectContaining({ reason: "boot-failed" })]);
    });

    it("fires once for a target with no OS that is refused one pass and short the next, though its kind changes", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      let refuse = true;
      const rig = harness([], {
        limit: 0,
        resolve: (request) =>
          refuse
            ? { message: "why", refusal: "unresolvable" }
            : {
                spec: { model: request.model ?? "", osVersion: "26.0", platform: request.platform },
              },
        targets: [unversioned],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      refuse = false;
      await rig.pool.pass();

      expect(rig.pool.figures().targets[0]).toMatchObject({
        osVersion: "26.0",
        short: "running-limit",
      });
      expect(payloads).toStrictEqual([expect.objectContaining({ reason: "unresolvable" })]);
    });

    it("fires once for two targets that resolve to one spec, and on no later pass", async () => {
      const rig = harness([], {
        limit: 0,
        targets: [iphone17, { ...iphone17, count: 2 }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        expect.objectContaining({ count: 3, reason: "running-limit" }),
      ]);
    });

    it("fires for each of two configured targets of one kind that are both refused, not once for the kind", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "why", refusal: "runtime-missing" }),
        targets: [iphone17, { ...iphone17, count: 2 }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        expect.objectContaining({ count: 1, model: "iPhone 17", reason: "runtime-missing" }),
        expect.objectContaining({ count: 2, model: "iPhone 17", reason: "runtime-missing" }),
      ]);
    });

    it("keeps each configured target's edge apart: one met and one short, then the met one missed, fires for it too", async () => {
      const rig = harness([ofKind("ready", "ready")], {
        limit: 0,
        targets: [iphone17, { ...iphone17, model: "iPhone 16" }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      rig.lease("ready");
      await rig.pool.pass();

      expect(payloads.map((payload) => (payload as { model: string }).model)).toEqual([
        "iPhone 16",
        "iPhone 17",
      ]);
    });

    it("fires nothing for a target that is filling, and nothing with the pool off", async () => {
      const filling = harness([], { limit: 5, targets: [iphone17] });
      const fillingPayloads = missed(filling);
      await filling.pool.pass();
      await filling.pool.settle();
      const off = harness([], { enabled: false, targets: [iphone17] });
      const offPayloads = missed(off);
      await off.pool.pass();

      expect(fillingPayloads).toEqual([]);
      expect(offPayloads).toEqual([]);
    });
  });

  describe("targeted", () => {
    it("names, once a pass has resolved the targets, the ready unleased devices of the kind up to the count, oldest first", async () => {
      const rig = harness(
        [ofKind("newer", "ready", 20), ofKind("older", "ready", 10), ofKind("oldest", "ready", 5)],
        { limit: 5, targets: [{ ...iphone17, count: 2 }] },
      );
      await rig.pool.pass();

      expect([...(await rig.pool.targeted())].sort()).toEqual(["older", "oldest"]);
    });

    it("does not name a device that is leased or claimed", async () => {
      const rig = harness([ofKind("leased", "ready", 1), ofKind("claimed", "ready", 2)], {
        limit: 5,
        targets: [{ ...iphone17, count: 2 }],
      });
      await rig.pool.pass();
      rig.lease("leased");
      rig.claims.tryClaim("claimed", "boot");

      expect([...(await rig.pool.targeted())]).toEqual([]);
    });
  });
});
