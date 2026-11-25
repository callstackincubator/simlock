import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../contract/index.js";
import { aggregateStatus } from "./aggregate.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { deviceFixture, hostFixture, leaseFixture } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";
import { view } from "./test-aggregate.js";

function capacity(running: number, limit: number) {
  return {
    android: {
      atRamBudget: false,
      limit,
      maxRunning: limit,
      overLimit: false,
      reserved: 0,
      running: 0,
      used: 0,
      warm: 0,
    },
    global: { maxRunning: limit * 2, overLimit: false, reserved: 0, running, warm: 1 },
    ios: {
      atRamBudget: false,
      limit,
      maxRunning: limit,
      overLimit: false,
      reserved: 0,
      running,
      used: running,
      warm: 1,
    },
  };
}

const GATEWAY_HOST = { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] };

// why: pure logic with many cases; the gateway barrel does not export aggregateStatus, so its cases are asserted here through aggregate.ts.
describe("aggregateStatus", () => {
  it("returns the same shape a worker returns, with the gateway named in the daemon block", () => {
    const status = aggregateStatus([], {
      health: "running",
      version: "0.0.0-test",
      host: GATEWAY_HOST,
      queueDepth: 0,
    });

    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
    expect(status.daemon.mode).toBe("gateway");
    expect(status.workers).toEqual([]);
  });

  it("carries physicalQueueDepth only when the options name one", () => {
    const base = {
      health: "running",
      version: "0.0.0-test",
      host: GATEWAY_HOST,
      queueDepth: 0,
    } as const;

    expect(aggregateStatus([], { ...base, physicalQueueDepth: 2 })).toHaveProperty(
      "physicalQueueDepth",
      2,
    );
    expect(aggregateStatus([], base)).not.toHaveProperty("physicalQueueDepth");
  });

  it("carries an empty warm pool block of its own, and each worker's block under its worker entry as the view holds it", () => {
    const block = { enabled: true, reserveRunning: { android: 0, ios: 1 }, targets: [] };
    const status = aggregateStatus(
      [
        view({ id: "wrk_a", warmPool: block }),
        view({ connection: "disconnected", id: "wrk_b", warmPool: block }),
        view({ id: "wrk_c" }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.warmPool).toStrictEqual({
      enabled: false,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
    });
    expect(status.workers?.map((worker) => worker.warmPool)).toEqual([block, block, undefined]);
  });

  // why: Round 6 review: `aggregateStatus`'s whole `leaseIndex` branch was deletable with a green
  // suite -- replacing it with the pre-#118 `{...lease, workerId}` passthrough broke nothing,
  // because every case here omitted the optional `leaseIndex` and so exercised only the
  // fallback. `lease.list`'s equivalent projection was covered; `status.get`'s was not.
  //
  // What that left unguarded is the reason the parameter exists: an id an operator reads out of
  // `status.get` has to be the id `lease.renew` accepts. A raw worker id answers `UNKNOWN_LEASE`.
  it("reports a gateway-issued lease under the id lease.renew accepts, not the worker's own", () => {
    const leaseIndex = new FleetLeaseIndex("gw:instance-1:");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lease_1",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "gw:instance-1:agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lease_1",
    });

    const status = aggregateStatus(
      [view({ id: "wrk_a", label: "mac-mini-1", leases: [leaseFixture("lease_1", "dev_1")] })],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, leaseIndex, queueDepth: 0 },
    );

    expect(status.leases).toEqual([
      expect.objectContaining({
        id: "wrk_a.lease_1",
        requesterId: "gw:instance-1:agent-1",
        worker: { id: "wrk_a", label: "mac-mini-1" },
        workerId: "wrk_a",
      }),
    ]);
    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
  });

  // why: The other half of the same contract: a lease this gateway never issued is a worker's own
  // local one, and renaming it would invent a gateway id that `lease.renew` would then reject.
  it("leaves a worker's own local lease's id alone", () => {
    const leaseIndex = new FleetLeaseIndex("gw:instance-1:");

    const status = aggregateStatus(
      [view({ id: "wrk_a", label: "mac-mini-1", leases: [leaseFixture("lease_1", "dev_1")] })],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, leaseIndex, queueDepth: 0 },
    );

    expect(status.leases).toEqual([
      expect.objectContaining({ id: "lease_1", requesterId: "agent-1", workerId: "wrk_a" }),
    ]);
    expect(status.leases?.[0]).not.toHaveProperty("worker");
  });

  it("sums capacity across connected workers", () => {
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({ capacity: capacity(2, 4), id: "wrk_b" }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity?.ios).toMatchObject({ limit: 6, running: 3, used: 3, warm: 2 });
    expect(status.capacity?.global).toMatchObject({ maxRunning: 12, running: 3, warm: 2 });
  });

  it("leaves a disconnected worker's capacity out of the sum", () => {
    // why: Free slots on a machine nobody can reach are not capacity: counting them would tell an
    // operator the fleet can take work it cannot.
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({ capacity: capacity(9, 9), connection: "disconnected", id: "wrk_b" }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity?.ios).toMatchObject({ limit: 2, running: 1 });
  });

  it("counts a worker over its own limit as the fleet being over one", () => {
    const overLimit = capacity(3, 2);
    const status = aggregateStatus(
      [
        view({ capacity: capacity(0, 2), id: "wrk_a" }),
        view({
          capacity: { ...overLimit, ios: { ...overLimit.ios, overLimit: true } },
          id: "wrk_b",
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity?.ios.overLimit).toBe(true);
  });

  it("sums the RAM budget over connected workers that report one, over when any worker is", () => {
    const ramBudget = (limitGiB: number, usedGiB: number) => ({
      limitBytes: limitGiB * 1024 ** 3,
      overLimit: usedGiB > limitGiB,
      usedBytes: usedGiB * 1024 ** 3,
    });
    const status = aggregateStatus(
      [
        view({ capacity: { ...capacity(1, 2), ramBudget: ramBudget(8, 3) }, id: "wrk_a" }),
        view({ capacity: { ...capacity(1, 2), ramBudget: ramBudget(4, 5) }, id: "wrk_b" }),
        view({ capacity: capacity(1, 2), id: "wrk_c" }),
        view({
          capacity: { ...capacity(1, 2), ramBudget: ramBudget(64, 1) },
          connection: "disconnected",
          id: "wrk_d",
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    // why: 8 GiB used of a 12 GiB fleet limit, yet over: wrk_b is past its own 4 GiB.
    expect(status.capacity?.ramBudget).toEqual({
      limitBytes: 12 * 1024 ** 3,
      overLimit: true,
      usedBytes: 8 * 1024 ** 3,
    });
    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
  });

  it("is under its RAM limit when no worker is over its own", () => {
    const status = aggregateStatus(
      [
        view({
          capacity: {
            ...capacity(1, 2),
            ramBudget: { limitBytes: 8, overLimit: false, usedBytes: 8 },
          },
          id: "wrk_a",
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity?.ramBudget?.overLimit).toBe(false);
  });

  it("omits the RAM budget when no connected worker reports one", () => {
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({
          capacity: {
            ...capacity(1, 2),
            ramBudget: { limitBytes: 8, overLimit: false, usedBytes: 1 },
          },
          connection: "disconnected",
          id: "wrk_b",
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity).not.toHaveProperty("ramBudget");
  });

  it("stamps every device and lease with the worker it lives on", () => {
    const status = aggregateStatus(
      [
        view({
          devices: [deviceFixture("dev_1", "leased")],
          id: "wrk_a",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
        view({ devices: [deviceFixture("dev_2")], id: "wrk_b" }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.devices).toEqual([
      expect.objectContaining({ id: "dev_1", workerId: "wrk_a" }),
      expect.objectContaining({ id: "dev_2", workerId: "wrk_b" }),
    ]);
    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_a" })]);
  });

  it("keeps a disconnected worker's leases in the aggregate", () => {
    // why: The opposite call from capacity, and deliberately so: a lease on a machine that dropped
    // off is still holding a device, which is exactly what an operator needs to see.
    const status = aggregateStatus(
      [
        view({
          connection: "disconnected",
          id: "wrk_a",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_a" })]);
  });

  it("reports a starting worker's view as it is, with no devices, leases or capacity of its own, and sums capacity over the workers that report it", () => {
    const starting: WorkerView = {
      connection: "connected",
      drained: false,
      health: "starting",
      host: hostFixture(),
      id: "wrk_a",
      lastSeenAt: 1_000,
    };
    const status = aggregateStatus(
      [
        starting,
        view({
          capacity: capacity(1, 4),
          devices: [deviceFixture("dev_1", "leased")],
          id: "wrk_b",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
      ],
      { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.devices).toEqual([expect.objectContaining({ id: "dev_1", workerId: "wrk_b" })]);
    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_b" })]);
    expect(status.capacity).toEqual(capacity(1, 4));
    expect(status.workers?.[0]).toEqual(starting);
  });

  it("reports the gateway's own queue depth and health, not any worker's", () => {
    const status = aggregateStatus([view({ health: "failed", id: "wrk_a", queueDepth: 7 })], {
      health: "starting",
      version: "0.0.0-test",
      host: GATEWAY_HOST,
      queueDepth: 0,
    });

    expect(status).toMatchObject({ daemon: { health: "starting" }, queueDepth: 0 });
    expect(status.workers?.[0]).toMatchObject({ health: "failed", queueDepth: 7 });
  });

  describe("installs (ADR 0010 §3)", () => {
    function install(component: string, since: number) {
      return {
        component,
        platform: "ios" as const,
        since,
        state: "downloading" as const,
        waiters: 1,
      };
    }

    it("lists each connected worker's installs with its workerId", () => {
      const status = aggregateStatus(
        [
          view({ id: "wrk_a", installs: [install("26.4", 10)] }),
          view({ id: "wrk_b", installs: [install("35", 5)] }),
          view({ id: "wrk_c" }),
        ],
        { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
      );

      expect(status.installs).toEqual([
        { ...install("35", 5), workerId: "wrk_b" },
        { ...install("26.4", 10), workerId: "wrk_a" },
      ]);
    });

    it("keeps the 16 oldest across the fleet, so the list fits the contract's bound", () => {
      const status = aggregateStatus(
        [
          view({
            id: "wrk_a",
            installs: Array.from({ length: 10 }, (_, index) =>
              install(`a${String(index)}`, index * 2 + 1),
            ),
          }),
          view({
            id: "wrk_b",
            installs: Array.from({ length: 10 }, (_, index) =>
              install(`b${String(index)}`, index * 2),
            ),
          }),
        ],
        { health: "running", version: "0.0.0-test", host: GATEWAY_HOST, queueDepth: 0 },
      );

      expect(status.installs?.map((entry) => entry.since)).toEqual(
        Array.from({ length: 16 }, (_, index) => index),
      );
    });
  });
});

describe("aggregateStatus at-RAM-budget flag", () => {
  const withBudget = (ios: boolean, android: boolean) => {
    const base = capacity(1, 2);
    return {
      ...base,
      android: { ...base.android, atRamBudget: android },
      ios: { ...base.ios, atRamBudget: ios },
    };
  };
  const options = {
    health: "running",
    version: "0.0.0-test",
    host: GATEWAY_HOST,
    queueDepth: 0,
  } as const;

  it("reports atRamBudget for a platform only when every connected worker does", () => {
    const status = aggregateStatus(
      [
        view({ capacity: withBudget(true, true), id: "wrk_a" }),
        view({ capacity: withBudget(true, false), id: "wrk_b" }),
      ],
      options,
    );

    expect(status.capacity?.ios.atRamBudget).toBe(true);
    expect(status.capacity?.android.atRamBudget).toBe(false);
  });

  it("reports false when the first worker has room and a later one is at its budget", () => {
    const status = aggregateStatus(
      [
        view({ capacity: withBudget(false, false), id: "wrk_a" }),
        view({ capacity: withBudget(true, true), id: "wrk_b" }),
      ],
      options,
    );

    expect(status.capacity?.ios.atRamBudget).toBe(false);
    expect(status.capacity?.android.atRamBudget).toBe(false);
  });

  it("leaves a disconnected worker out of the flag, and reports false for a fleet with no connected worker", () => {
    const status = aggregateStatus(
      [
        view({ capacity: withBudget(true, true), id: "wrk_a" }),
        view({ capacity: withBudget(false, false), connection: "disconnected", id: "wrk_b" }),
      ],
      options,
    );
    const empty = aggregateStatus([], options);

    expect(status.capacity?.ios.atRamBudget).toBe(true);
    expect(empty.capacity?.ios.atRamBudget).toBe(false);
  });
});
