import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../contract/index.js";
import { aggregateCatalog, aggregateStatus } from "./aggregate.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { deviceFixture, hostFixture, leaseFixture } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

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

function view(overrides: Partial<WorkerView> & { readonly id: string }): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    lastSeenAt: 1_000,
    leases: [],
    ...overrides,
  };
}

describe("aggregateStatus", () => {
  it("returns the same shape a worker returns, with the gateway named in the daemon block", () => {
    const status = aggregateStatus([], { health: "running", host: GATEWAY_HOST, queueDepth: 0 });

    // The contract is the arbiter: a gateway's answer parses as `status.get`'s output or it is
    // not the same shape.
    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
    expect(status.daemon.mode).toBe("gateway");
    expect(status.workers).toEqual([]);
  });

  it("reports the gateway's own host with no tools, not any worker's", () => {
    const status = aggregateStatus(
      [view({ host: hostFixture({ os: "macOS", osVersion: "15.5" }), id: "wrk_a" })],
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.host).toEqual({ arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] });
    expect(status.workers?.[0]?.host?.os).toBe("macOS");
  });

  // Round 6 review: `aggregateStatus`'s whole `leaseIndex` branch was deletable with a green
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
      { health: "running", host: GATEWAY_HOST, leaseIndex, queueDepth: 0 },
    );

    expect(status.leases).toEqual([
      expect.objectContaining({
        id: "wrk_a.lease_1",
        requesterId: "gw:instance-1:agent-1",
        worker: { id: "wrk_a", label: "mac-mini-1" },
        workerId: "wrk_a",
      }),
    ]);
    // Still the same shape a worker returns (ADR §20) with the projection applied.
    expect(() => OPERATIONS["status.get"].output.parse(status)).not.toThrow();
  });

  // The other half of the same contract: a lease this gateway never issued is a worker's own
  // local one, and renaming it would invent a gateway id that `lease.renew` would then reject.
  it("leaves a worker's own local lease's id alone", () => {
    const leaseIndex = new FleetLeaseIndex("gw:instance-1:");

    const status = aggregateStatus(
      [view({ id: "wrk_a", label: "mac-mini-1", leases: [leaseFixture("lease_1", "dev_1")] })],
      { health: "running", host: GATEWAY_HOST, leaseIndex, queueDepth: 0 },
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.capacity?.ios).toMatchObject({ limit: 6, running: 3, used: 3, warm: 2 });
    expect(status.capacity?.global).toMatchObject({ maxRunning: 12, running: 3, warm: 2 });
  });

  it("leaves a disconnected worker's capacity out of the sum", () => {
    // Free slots on a machine nobody can reach are not capacity: counting them would tell an
    // operator the fleet can take work it cannot.
    const status = aggregateStatus(
      [
        view({ capacity: capacity(1, 2), id: "wrk_a" }),
        view({ capacity: capacity(9, 9), connection: "disconnected", id: "wrk_b" }),
      ],
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
        // A `fixed` worker reports no budget and adds nothing to the sum.
        view({ capacity: capacity(1, 2), id: "wrk_c" }),
        view({
          capacity: { ...capacity(1, 2), ramBudget: ramBudget(64, 1) },
          connection: "disconnected",
          id: "wrk_d",
        }),
      ],
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
    );

    // 8 GiB used of a 12 GiB fleet limit, yet over: wrk_b is past its own 4 GiB.
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.devices).toEqual([
      expect.objectContaining({ id: "dev_1", workerId: "wrk_a" }),
      expect.objectContaining({ id: "dev_2", workerId: "wrk_b" }),
    ]);
    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_a" })]);
  });

  it("keeps a disconnected worker's leases in the aggregate", () => {
    // The opposite call from capacity, and deliberately so: a lease on a machine that dropped
    // off is still holding a device, which is exactly what an operator needs to see.
    const status = aggregateStatus(
      [
        view({
          connection: "disconnected",
          id: "wrk_a",
          leases: [leaseFixture("lease_1", "dev_1")],
        }),
      ],
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
      { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
    );

    expect(status.devices).toEqual([expect.objectContaining({ id: "dev_1", workerId: "wrk_b" })]);
    expect(status.leases).toEqual([expect.objectContaining({ id: "lease_1", workerId: "wrk_b" })]);
    expect(status.capacity).toEqual(capacity(1, 4));
    expect(status.workers?.[0]).toEqual(starting);
  });

  it("reports the gateway's own queue depth and health, not any worker's", () => {
    const status = aggregateStatus([view({ health: "failed", id: "wrk_a", queueDepth: 7 })], {
      health: "starting",
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
        { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
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
        { health: "running", host: GATEWAY_HOST, queueDepth: 0 },
      );

      expect(status.installs?.map((entry) => entry.since)).toEqual(
        Array.from({ length: 16 }, (_, index) => index),
      );
    });
  });
});

describe("aggregateCatalog", () => {
  const iosOnA = {
    defaultRuntime: "26.0",
    modelAliases: {},
    classDefaults: {},
    modelClasses: {},
    modelRuntimes: { "iPhone 17": ["26.0"] },
    models: ["iPhone 17"],
    platform: "ios" as const,
    runtimes: ["26.0"],
  };
  // B has 25.4 installed, but only the iPad pairs with it there.
  const iosOnB = {
    defaultRuntime: "26.0",
    modelAliases: {},
    classDefaults: {},
    modelClasses: {},
    modelRuntimes: { "iPad Pro": ["25.4", "26.0"], "iPhone 17": ["26.0"] },
    models: ["iPhone 17", "iPad Pro"],
    platform: "ios" as const,
    runtimes: ["26.0", "25.4"],
  };

  it("unions the connected workers' catalogs and annotates every entry", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
    expect(catalog.platforms).toHaveLength(1);
    expect(catalog.platforms[0]).toMatchObject({
      models: ["iPad Pro", "iPhone 17"],
      modelWorkers: { "iPad Pro": ["wrk_b"], "iPhone 17": ["wrk_a", "wrk_b"] },
      platform: "ios",
      runtimes: ["25.4", "26.0"],
      runtimeWorkers: { "25.4": ["wrk_b"], "26.0": ["wrk_a", "wrk_b"] },
    });
  });

  it("carries the union of the connected workers' model classes, and keeps the class of the first worker in id order when two disagree", () => {
    const classed = (modelClasses: Record<string, "phone" | "tablet" | "tv">) => ({
      ...iosOnB,
      modelClasses,
    });

    // Listed with the later id first, so the answer cannot come from input order.
    const catalog = aggregateCatalog([
      view({ catalog: [classed({ "iPad Pro": "phone", "iPhone 17": "tv" })], id: "wrk_b" }),
      view({ catalog: [classed({ "iPhone 17": "phone" })], id: "wrk_a" }),
      view({
        catalog: [classed({ "iPad Pro": "tablet" })],
        connection: "disconnected",
        id: "wrk_0",
      }),
    ]);

    expect(catalog.platforms[0]?.modelClasses).toEqual({
      "iPad Pro": "phone",
      "iPhone 17": "phone",
    });
    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
  });

  it("drops a model class for a name the worker does not list", () => {
    const catalog = aggregateCatalog([
      view({
        catalog: [{ ...iosOnB, modelClasses: { Ghost: "tv", "iPhone 17": "phone" } }],
        id: "wrk_a",
      }),
    ]);

    expect(catalog.platforms[0]?.modelClasses).toEqual({ "iPhone 17": "phone" });
  });

  it("carries a class default only when every connected worker reports the same one", () => {
    // Every default names a model its worker lists, so a disagreement reaches agreedClassDefaults.
    const withDefaults = (
      classDefaults: Record<string, string>,
      base: typeof iosOnA | typeof iosOnB = iosOnA,
    ) => ({
      ...base,
      classDefaults,
      models: [...new Set([...base.models, "iPad Pro", "iPad (A16)"])],
    });

    const agreed = aggregateCatalog([
      view({ catalog: [withDefaults({ phone: "iPhone 17", tablet: "iPad Pro" })], id: "wrk_a" }),
      view({
        catalog: [withDefaults({ phone: "iPhone 17", tablet: "iPad (A16)" }, iosOnB)],
        id: "wrk_b",
      }),
    ]);

    expect(agreed.platforms[0]?.classDefaults).toEqual({ phone: "iPhone 17" });
    expect(() => OPERATIONS["catalog.get"].output.parse(agreed)).not.toThrow();
  });

  it("drops a class default when a connected worker has none for that class", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnA, classDefaults: { phone: "iPhone 17" } }], id: "wrk_a" }),
      view({ catalog: [{ ...iosOnB, classDefaults: {} }], id: "wrk_b" }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({});
  });

  it("drops a class default naming a model the worker does not list", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnB, classDefaults: { phone: "Ghost" } }], id: "wrk_a" }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({});
  });

  it("keeps a class default a lone connected worker reports, and ignores a disconnected worker's", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [{ ...iosOnA, classDefaults: { phone: "iPhone 17" } }], id: "wrk_a" }),
      view({
        catalog: [{ ...iosOnB, classDefaults: { phone: "iPhone 16" } }],
        connection: "disconnected",
        id: "wrk_b",
      }),
    ]);

    expect(catalog.platforms[0]?.classDefaults).toEqual({ phone: "iPhone 17" });
  });

  it("keeps a default runtime only when every worker agrees on it", () => {
    const agreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);
    expect(agreed.platforms[0]?.defaultRuntime).toBe("26.0");

    const disagreed = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [{ ...iosOnB, defaultRuntime: "25.4" }], id: "wrk_b" }),
    ]);
    // Picking one at random would make `simlock lease` non-deterministic across an unchanged
    // fleet, so a fleet that disagrees has no default.
    expect(disagreed.platforms[0]?.defaultRuntime).toBeUndefined();
  });

  it("ignores a disconnected worker: a machine nobody can reach can lease nothing", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], connection: "disconnected", id: "wrk_a" }),
    ]);

    expect(catalog.platforms).toEqual([]);
  });

  it("keeps a drained worker, whose models are still installed", () => {
    const catalog = aggregateCatalog([view({ catalog: [iosOnA], drained: true, id: "wrk_a" })]);

    expect(catalog.platforms[0]?.models).toEqual(["iPhone 17"]);
  });

  it("pairs a model with a runtime when at least one connected worker pairs them", () => {
    const iosOnC = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["25.4"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnC], id: "wrk_c" }),
    ]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ "iPhone 17": ["25.4", "26.0"] });
  });

  it("does not pair a model with a runtime that only another model has", () => {
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    // 25.4 is in the fleet's runtimes, and iPhone 17 is in its models, but no worker pairs them.
    expect(catalog.platforms[0]?.runtimes).toContain("25.4");
    expect(catalog.platforms[0]?.modelRuntimes).toEqual({
      "iPad Pro": ["25.4", "26.0"],
      "iPhone 17": ["26.0"],
    });
  });

  it("ignores the pairings of disconnected and incompatible workers", () => {
    const pairsOld = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["25.4"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnA], id: "wrk_a" }),
      view({ catalog: [pairsOld], connection: "disconnected", id: "wrk_gone" }),
      view({ catalog: [pairsOld], connection: "incompatible", id: "wrk_old" }),
    ]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ "iPhone 17": ["26.0"] });
  });

  it("gives every model in the fleet catalog a modelRuntimes entry, empty when nothing pairs", () => {
    const unpaired = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone XS": [] },
      models: ["iPhone XS"],
      platform: "ios" as const,
      runtimes: ["26.0"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [iosOnB], id: "wrk_b" }),
      view({ catalog: [unpaired], id: "wrk_x" }),
    ]);

    const platform = catalog.platforms[0];
    expect(Object.keys(platform?.modelRuntimes ?? {}).sort()).toEqual(
      [...(platform?.models ?? [])].sort(),
    );
    expect(platform?.modelRuntimes["iPhone XS"]).toEqual([]);
  });

  it("treats a model a worker names after an Object.prototype member like any other", () => {
    // Wire input: a worker that lists `constructor` without pairing it must not make the fleet
    // catalog read the inherited function.
    const odd = OPERATIONS["catalog.get"].output.parse({
      platforms: [
        {
          modelAliases: {},
          classDefaults: {},
          modelClasses: {},
          modelRuntimes: {},
          models: ["constructor"],
          platform: "ios",
          runtimes: [],
        },
      ],
    }).platforms;

    const catalog = aggregateCatalog([view({ catalog: odd, id: "wrk_a" })]);

    expect(catalog.platforms[0]?.modelRuntimes).toEqual({ constructor: [] });
  });

  it("drops a pairing with a runtime the worker does not list itself, even when another worker has it", () => {
    const claimsMore = {
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "iPhone 17": ["25.4", "26.0"] },
      models: ["iPhone 17"],
      platform: "ios" as const,
      runtimes: ["26.0"],
    };
    const catalog = aggregateCatalog([
      view({ catalog: [claimsMore], id: "wrk_a" }),
      view({ catalog: [iosOnB], id: "wrk_b" }),
    ]);

    // 25.4 is in the fleet (on B, for the iPad only); A's claim to pair it is not A's to make.
    expect(catalog.platforms[0]?.modelRuntimes["iPhone 17"]).toEqual(["26.0"]);
  });

  it("filters to one platform when asked", () => {
    const catalog = aggregateCatalog(
      [
        view({
          catalog: [
            iosOnA,
            {
              modelAliases: {},
              classDefaults: {},
              modelClasses: {},
              modelRuntimes: { "Pixel 9": ["35"] },
              models: ["Pixel 9"],
              platform: "android",
              runtimes: ["35"],
            },
          ],
          id: "wrk_a",
        }),
      ],
      "android",
    );

    expect(catalog.platforms.map((entry) => entry.platform)).toEqual(["android"]);
  });

  describe("other names and images", () => {
    const androidOn = (
      overrides: Partial<{
        models: string[];
        modelAliases: Record<string, string[]>;
        images: { runtime: string; tag: string; abi: string }[];
        runtimes: string[];
        customModels: string[];
        classDefaults: {};
        modelClasses: Record<string, "phone">;
      }>,
    ) => {
      const models = overrides.models ?? ["Pixel 8"];
      const runtimes = overrides.runtimes ?? ["34", "35"];
      return {
        ...(overrides.customModels === undefined ? {} : { customModels: overrides.customModels }),
        ...(overrides.images === undefined ? {} : { images: overrides.images }),
        modelAliases: overrides.modelAliases ?? {},
        classDefaults: {},
        modelClasses: overrides.modelClasses ?? {},
        modelRuntimes: Object.fromEntries(models.map((model) => [model, runtimes])),
        models,
        platform: "android" as const,
        runtimes,
      };
    };

    it("unions other names per model, once per spelling ignoring case", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ modelAliases: { "Pixel 8": ["pixel_8"] } })],
          id: "wrk_a",
        }),
        view({
          catalog: [
            androidOn({
              modelAliases: { "Pixel 8": ["PIXEL_8", "pixel8"], "Pixel 9": ["pixel_9"] },
              models: ["Pixel 8", "Pixel 9"],
            }),
          ],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.modelAliases).toEqual({
        "Pixel 8": ["pixel8", "pixel_8"],
        "Pixel 9": ["pixel_9"],
      });
    });

    it("lists each distinct image once", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "34", tag: "default" },
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                { abi: "x86_64", runtime: "35", tag: "google_apis" },
              ],
            }),
          ],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ]);
    });

    it("omits images when no worker reports any", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [iosOnA], id: "wrk_a" }),
        view({ catalog: [iosOnB], id: "wrk_b" }),
      ]);

      expect(catalog.platforms[0]).not.toHaveProperty("images");
    });

    it("does not list a model's own name, in any letter case, as another name for it", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ modelAliases: { "Pixel 8": ["PIXEL 8", "pixel_8"] } })],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.modelAliases).toEqual({ "Pixel 8": ["pixel_8"] });
    });

    it("sorts the fleet's images whatever order the workers report them in", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "35", tag: "google_apis" },
                { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                { abi: "x86_64", runtime: "34", tag: "default" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ]);
    });

    it("keeps the fleet catalog inside the contract's bounds when the union of valid workers is not", () => {
      const names = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index}`);
      const worker = (prefix: string) =>
        androidOn({
          images: names(prefix, 1024).map((tag) => ({ abi: "x86_64", runtime: "34", tag })),
          modelAliases: {
            ...Object.fromEntries(names(`${prefix}m`, 4095).map((model) => [model, ["x"]])),
            "Pixel 8": names(prefix, 32),
          },
          customModels: ["Pixel 8", ...names(`${prefix}m`, 4095)],
          classDefaults: {},
          modelClasses: Object.fromEntries(
            ["Pixel 8", ...names(`${prefix}m`, 4095)].map((model) => [model, "phone" as const]),
          ),
          models: ["Pixel 8", ...names(`${prefix}m`, 4095)],
        });
      const valid = [worker("a"), worker("b")];
      for (const entry of valid) {
        expect(() => OPERATIONS["catalog.get"].output.parse({ platforms: [entry] })).not.toThrow();
      }

      // Worker b connects first, so what survives the cut is decided by sort order, not arrival.
      const catalog = aggregateCatalog([
        view({ catalog: [valid[1]!], id: "wrk_b" }),
        view({ catalog: [valid[0]!], id: "wrk_a" }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      const platform = catalog.platforms[0];
      expect(platform?.images).toHaveLength(1024);
      expect(platform?.images?.every((image) => image.tag.startsWith("a"))).toBe(true);
      const aliasedModels = Object.keys(platform?.modelAliases ?? {});
      expect(aliasedModels).toHaveLength(4096);
      expect(aliasedModels.filter((model) => model.startsWith("bm"))).toEqual([]);
      expect(platform?.modelAliases["Pixel 8"]).toEqual(names("a", 32).sort());
      const classedModels = Object.keys(platform?.modelClasses ?? {});
      expect(classedModels).toHaveLength(4096);
      expect(classedModels.filter((model) => model.startsWith("bm"))).toEqual([]);
      expect(platform?.customModels).toHaveLength(4096);
      expect(platform?.customModels?.filter((model) => model.startsWith("bm"))).toEqual([]);
    });

    it("cuts the fleet's model classes by sort order, not arrival order, when the union is over the bound", () => {
      const names = (prefix: string) =>
        Array.from({ length: 4096 }, (_, index) => `${prefix}${index}`);
      const worker = (prefix: string) =>
        androidOn({
          classDefaults: {},
          modelClasses: Object.fromEntries(names(prefix).map((model) => [model, "phone" as const])),
          models: names(prefix),
        });

      // The worker first in id order holds the names that sort last.
      const catalog = aggregateCatalog([
        view({ catalog: [worker("zm")], id: "wrk_a" }),
        view({ catalog: [worker("am")], id: "wrk_b" }),
      ]);

      const classed = Object.keys(catalog.platforms[0]?.modelClasses ?? {});
      expect(classed).toHaveLength(4096);
      expect(classed.every((model) => model.startsWith("am"))).toBe(true);
    });

    it("marks a model custom when one worker marks it and another lists it as built-in", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [androidOn({ models: ["Pixel 8", "My Tablet"] })], id: "wrk_a" }),
        view({
          catalog: [androidOn({ customModels: ["My Tablet"], models: ["My Tablet"] })],
          id: "wrk_b",
        }),
      ]);

      expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
      expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
    });

    it("drops a custom name the worker does not list in models", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [androidOn({ customModels: ["My Tablet", "Ghost"], models: ["My Tablet"] })],
          id: "wrk_a",
        }),
        // Another worker lists Ghost, but only the worker that marks a name can make it custom.
        view({ catalog: [androidOn({ models: ["Ghost"] })], id: "wrk_b" }),
      ]);

      expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
    });

    it("omits customModels when no worker marks a model it lists", () => {
      const catalog = aggregateCatalog([
        view({ catalog: [androidOn({ customModels: ["Ghost"] })], id: "wrk_a" }),
      ]);

      expect(catalog.platforms[0]).not.toHaveProperty("customModels");
    });

    it("drops an image whose runtime the reporting worker does not list", () => {
      const catalog = aggregateCatalog([
        view({
          catalog: [
            androidOn({
              images: [
                { abi: "x86_64", runtime: "34", tag: "default" },
                { abi: "x86_64", runtime: "99", tag: "default" },
              ],
            }),
          ],
          id: "wrk_a",
        }),
      ]);

      expect(catalog.platforms[0]?.images).toEqual([
        { abi: "x86_64", runtime: "34", tag: "default" },
      ]);
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
  const options = { health: "running", host: GATEWAY_HOST, queueDepth: 0 } as const;

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
