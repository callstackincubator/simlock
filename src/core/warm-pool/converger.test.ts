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
    /** What a target resolves to; by default the request's own model and OS (26.0 when none). */
    resolve?: (request: DeviceRequest) => TargetResolution | Promise<TargetResolution>;
    /** Holds a creation until the test lets it go; the creation fails when this rejects. */
    provision?: (spec: DeviceSpec, attempt: number) => Promise<void>;
    refuseProvision?: boolean;
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
  const waitingDemand = vi.fn(options.waiting ?? (() => []));
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
            ...(request.mode === "slim" ? { mode: "slim" as const } : {}),
          },
        };
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
      canBoot: () => ({ ok: true }),
      canProvision: () =>
        options.refuseProvision === true ? { ok: false, reason: "device-limit" } : { ok: true },
      tryReserveProvisioning: () => {
        if (options.refuseProvision === true) return { ok: false, reason: "device-limit" };
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
        count: 1,
        message: "iOS 27.0 is not installed",
        ready: 0,
        short: "runtime-missing",
        target: "ios iPhone 17 27.0",
      },
    ]);
    expect(
      rig.sink.records.filter((record) => record.message === "a warm pool target is short"),
    ).toHaveLength(1);
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

    expect(rig.resolveCalls).toHaveLength(2);
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

    expect(rig.resolveCalls).toEqual([
      { mode: "slim", model: "iPhone 16", osVersion: ">=18", platform: "ios" },
      { model: "Pixel 9", platform: "android" },
    ]);
  });

  it("creates two devices for two targets resolving to one spec, one after the other, as one target of the summed count", async () => {
    const rig = harness([], {
      resolve: () => ({ spec: kind }),
      targets: [iphone17, { ...iphone17, osVersion: ">=26" }],
    });

    await rig.pool.pass();
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

  describe("targeted", () => {
    it("names, once a pass has resolved the targets, the ready unleased devices of the kind up to the count, oldest first", async () => {
      const rig = harness(
        [ofKind("newer", "ready", 20), ofKind("older", "ready", 10), ofKind("oldest", "ready", 5)],
        { limit: 5, targets: [{ ...iphone17, count: 2 }] },
      );
      expect([...rig.pool.targeted()]).toEqual([]);

      await rig.pool.pass();

      expect([...rig.pool.targeted()].sort()).toEqual(["older", "oldest"]);
    });

    it("does not name a device that is leased or claimed", async () => {
      const rig = harness([ofKind("leased", "ready", 1), ofKind("claimed", "ready", 2)], {
        limit: 5,
        targets: [{ ...iphone17, count: 2 }],
      });
      await rig.pool.pass();
      rig.lease("leased");
      rig.claims.tryClaim("claimed", "boot");

      expect([...rig.pool.targeted()]).toEqual([]);
    });
  });
});
