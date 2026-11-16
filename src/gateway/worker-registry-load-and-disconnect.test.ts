import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  catalogFixture,
  deviceFixture,
  hostFixture,
  leaseFixture,
  physicalDeviceFixture,
  statusFixture,
} from "./test-support.js";
import { RETENTION_MS, registry } from "./test-worker-registry.js";

describe("WorkerRegistry", () => {
  describe("a worker's load on its view", () => {
    const load = {
      cpu: { busyPercent: 34, cores: 10, limited: false },
      readAt: 900,
    };
    const incompatible = (workers: ReturnType<typeof registry>["workers"], workerId: string) =>
      workers.incompatible(
        workerId,
        undefined,
        { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
        "0.2.0",
      );

    it("the registry drops a worker's load when it disconnects, turns incompatible, or connects again", () => {
      const { workers } = registry();
      for (const id of ["wrk_1", "wrk_2", "wrk_3"]) {
        workers.connected(id, undefined, "0.3.0");
        workers.refresh(id, { load });
      }
      expect(workers.view("wrk_1")?.load).toEqual(load);

      workers.disconnected("wrk_1");
      const turned = incompatible(workers, "wrk_2");
      const reconnected = workers.connected("wrk_3", undefined, "0.3.0");

      expect(workers.view("wrk_1")).not.toHaveProperty("load");
      expect(turned).not.toHaveProperty("load");
      expect(workers.view("wrk_2")).not.toHaveProperty("load");
      expect(reconnected).not.toHaveProperty("load");
      expect(workers.view("wrk_3")).not.toHaveProperty("load");
    });

    it("a refresh without load leaves the view without load, after one with load", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", { load });
      expect(workers.view("wrk_1")?.load).toEqual(load);

      workers.refresh("wrk_1", { queueDepth: 1 });

      expect(workers.view("wrk_1")?.queueDepth).toBe(1);
      expect(workers.view("wrk_1")).not.toHaveProperty("load");
    });

    it("a refresh that reaches a disconnected or an incompatible view leaves no load on it", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.connected("wrk_2", undefined, "0.3.0");
      workers.refresh("wrk_1", { load });
      workers.disconnected("wrk_1");
      incompatible(workers, "wrk_2");

      workers.refresh("wrk_1", { load });
      workers.refresh("wrk_2", { load });

      expect(workers.view("wrk_1")?.connection).toBe("disconnected");
      expect(workers.view("wrk_1")).not.toHaveProperty("load");
      expect(workers.view("wrk_2")?.connection).toBe("incompatible");
      expect(workers.view("wrk_2")).not.toHaveProperty("load");
    });
  });

  it("drops a worker's installs from its view when it disconnects or turns incompatible", () => {
    const { workers } = registry();
    const installs = [
      {
        component: "26.4",
        platform: "ios" as const,
        since: 1,
        state: "downloading" as const,
        waiters: 1,
      },
    ];
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.connected("wrk_2", undefined, "0.3.0");
    workers.refresh("wrk_1", { installs });
    workers.refresh("wrk_2", { installs });

    workers.disconnected("wrk_1");
    const incompatible = workers.incompatible(
      "wrk_2",
      undefined,
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(workers.view("wrk_1")?.installs).toBeUndefined();
    expect(incompatible.installs).toBeUndefined();
    expect(workers.view("wrk_2")?.installs).toBeUndefined();
  });

  describe("a worker's warm pool block", () => {
    const warmPool = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [],
    };

    it("is on the view after a refresh, and stays on a disconnected worker's view as it was last read", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, "0.3.0");

      workers.refresh("wrk_1", { warmPool });
      workers.disconnected("wrk_1");

      expect(workers.view("wrk_1")?.warmPool).toEqual(warmPool);
    });

    it("is absent for a worker whose status was never read", () => {
      const { workers } = registry();

      expect(workers.connected("wrk_1", undefined, "0.3.0").warmPool).toBeUndefined();
    });

    it("is dropped from the view when the worker turns incompatible or starts over", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.connected("wrk_2", undefined, "0.3.0");
      workers.refresh("wrk_1", { warmPool });
      workers.refresh("wrk_2", { warmPool });

      const incompatible = workers.incompatible(
        "wrk_1",
        undefined,
        { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
        "0.2.0",
      );
      workers.refresh("wrk_2", { health: "starting" });

      expect(incompatible.warmPool).toBeUndefined();
      expect(workers.view("wrk_1")?.warmPool).toBeUndefined();
      expect(workers.view("wrk_2")?.warmPool).toBeUndefined();
    });
  });

  it("drops a worker's waiting requests from its view when it disconnects or turns incompatible", () => {
    const { workers } = registry();
    const waiting = [
      {
        createdAt: 1,
        id: "req_1",
        queuePosition: 1,
        requesterId: "local-agent",
        spec: { model: "iPhone 17", platform: "ios" as const },
        stage: "queued" as const,
      },
    ];
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.connected("wrk_2", undefined, "0.3.0");
    workers.refresh("wrk_1", { waiting });
    workers.refresh("wrk_2", { waiting });
    expect(workers.view("wrk_1")?.waiting).toEqual(waiting);

    workers.disconnected("wrk_1");
    const incompatible = workers.incompatible(
      "wrk_2",
      undefined,
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(workers.view("wrk_1")?.waiting).toBeUndefined();
    expect(incompatible.waiting).toBeUndefined();
    expect(workers.view("wrk_2")?.waiting).toBeUndefined();
  });

  it("keeps a disconnected view with the leases it last reported", () => {
    const { clock, events, workers } = registry();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    clock.advance(1_000);
    workers.disconnected("wrk_1");

    expect(workers.view("wrk_1")).toMatchObject({
      connection: "disconnected",
      lastSeenAt: 2_000,
      leases: [{ id: "lease_1" }],
    });
    expect(events.at(-1)).toMatchObject({
      event: "worker.disconnected",
      payload: { leaseCount: 1, label: "mac-mini-1", workerId: "wrk_1" },
    });
  });

  it("reports no leases for a worker that disconnects while starting when none was ever read from it, and lists none on its view", () => {
    const { events, workers } = registry();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

    workers.disconnected("wrk_1");

    expect(events.at(-1)).toMatchObject({
      event: "worker.disconnected",
      payload: { leaseCount: 0, workerId: "wrk_1" },
    });
    expect(Object.keys(workers.view("wrk_1") ?? {})).not.toContain("leases");
  });

  it("reports the leases last read for a worker that disconnects while starting, though its view lists none", () => {
    const { events, workers } = registry();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", {
      leases: [leaseFixture("lease_1", "dev_1"), leaseFixture("lease_2", "dev_2")],
    });
    workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

    workers.disconnected("wrk_1");

    expect(events.at(-1)).toMatchObject({
      event: "worker.disconnected",
      payload: { leaseCount: 2, workerId: "wrk_1" },
    });
    expect(Object.keys(workers.view("wrk_1") ?? {})).not.toContain("leases");
  });

  describe("a starting refresh", () => {
    const running = {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      devices: [],
      health: "running" as const,
      host: hostFixture(),
      installs: [],
      leases: [leaseFixture("lease_1", "dev_1")],
      physicalQueueDepth: 1,
      queueDepth: 0,
      waiting: [],
    };

    it("drops capacity, catalog, catalogReadAt, devices, installs, leases, queueDepth, physicalQueueDepth and waiting a running read filled in, on a worker that stays connected", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", running);
      workers.refresh("wrk_1", { catalog: running.catalog });

      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(Object.keys(workers.view("wrk_1") ?? {}).sort()).toEqual([
        "connection",
        "drained",
        "health",
        "host",
        "id",
        "lastSeenAt",
      ]);
    });

    it("keeps the last catalog for routing while the view leaves it out", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", running);

      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(workers.view("wrk_1")?.catalog).toBeUndefined();
      expect(workers.routingViews()[0]?.catalog).toEqual(running.catalog);
      expect(workers.routingViews()[0]?.catalogReadAt).toBeUndefined();
    });

    it("carries the physical devices last read from a starting worker in its routing view, and its views() entry lists no devices", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const phone = physicalDeviceFixture("dev_p", "ready");
      workers.refresh("wrk_1", {
        ...running,
        devices: [phone, deviceFixture("dev_sim", "ready")],
      });

      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(workers.routingViews()[0]?.devices).toEqual([phone]);
      expect(workers.view("wrk_1")?.devices).toBeUndefined();
      expect(workers.views()[0]).not.toHaveProperty("devices");
    });

    it("drops a removed worker's last physical devices, so one that comes back starting has none in its routing view", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", { ...running, devices: [physicalDeviceFixture("dev_p", "ready")] });
      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });
      expect(workers.routingViews()[0]?.devices).toHaveLength(1);
      workers.disconnected("wrk_1");
      clock.advance(RETENTION_MS);
      await workers.pruneExpired();
      expect(workers.routingViews()).toEqual([]);

      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(workers.routingViews()[0]?.devices).toBeUndefined();
    });

    it("has no catalog for routing from a worker whose catalog was never read", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(Object.keys(workers.routingViews()[0] ?? {})).not.toContain("catalog");
    });

    it("forgets the last catalog and leases with the view, so a worker that comes back starting is unknown", async () => {
      const { clock, events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", running);
      workers.disconnected("wrk_1");
      clock.advance(RETENTION_MS);
      await workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeUndefined();

      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", { health: "starting", host: hostFixture() });

      expect(workers.routingViews()[0]?.catalog).toBeUndefined();
      workers.disconnected("wrk_1");
      expect(events.at(-1)).toMatchObject({
        event: "worker.disconnected",
        payload: { leaseCount: 0 },
      });
    });
  });

  it("says nothing when a view that is already disconnected disconnects again", () => {
    const { events, workers } = registry();
    workers.connected("wrk_1", undefined, undefined);
    workers.disconnected("wrk_1");
    const before = events.length;

    workers.disconnected("wrk_1");

    expect(events).toHaveLength(before);
  });
});
