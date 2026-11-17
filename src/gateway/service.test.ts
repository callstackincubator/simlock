import { describe, expect, it, vi } from "vitest";
import {
  catalogFixture,
  deviceFixture,
  hostFixture,
  leaseFixture,
  protocolMismatchError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { WORKER_CALL_TIMEOUT_MS } from "./worker-link.js";
import { eventNames, fleet, REFRESH_MS } from "./test-service.js";

describe("GatewayService", () => {
  it("builds a view from the four calls ADR 0005 §7 prescribes", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ leases: [leaseFixture("lease_1", "dev_1")], queueDepth: 1 });
    worker.devices = [deviceFixture("dev_1", "leased")];
    worker.catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    expect(worker.calls).toContain("status.get");
    expect(worker.calls).toContain("list.get:devices");
    expect(worker.calls).toContain("catalog.get");
    expect(worker.calls).toContain("events.subscribe");
    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      catalog: [{ models: ["iPhone 17"] }],
      connection: "connected",
      devices: [{ id: "dev_1" }],
      downloads: { policy: "on-request" },
      id: "wrk_1",
      label: "mac-mini-1",
      leases: [{ id: "lease_1" }],
      queueDepth: 1,
      version: "0.3.0",
    });
    expect(eventNames(harness.events)).toContain("worker.connected");

    await harness.service.stop();
  });

  it("WorkerLink stamps a view's load with the gateway clock's time when status.get answered", async () => {
    const harness = fleet();
    await harness.service.start();
    harness.clock.advance(19_000);
    // why: the device read lands later than status, so a stamp taken after it would be 5 s fresher.
    class SlowDevices extends ScriptedWorkerClient {
      override async list(input: { readonly kind?: string }): Promise<unknown> {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        harness.clock.advance(5_000);
        return super.list(input);
      }
    }
    const worker = new SlowDevices();
    worker.status = statusFixture({
      load: { ageMs: 2_000, disk: { freeBytes: 120, totalBytes: 500 } },
    });

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.load).toBeDefined());

    expect(harness.service.workers.view("wrk_1")?.load).toEqual({
      disk: { freeBytes: 120, totalBytes: 500 },
      readAt: 18_000,
    });
    await harness.service.stop();
  });

  it("builds a starting worker's view from health and host alone, asks it for nothing else, and builds the full view once it answers running", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = {
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: hostFixture({ arch: "x64" }),
    };
    worker.devices = [deviceFixture("dev_1", "leased")];

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.health).toBe("starting"));

    const view = harness.service.workers.view("wrk_1");
    expect(view?.host).toEqual(hostFixture({ arch: "x64" }));
    for (const field of [
      "capacity",
      "catalog",
      "devices",
      "installs",
      "leases",
      "queueDepth",
      "waiting",
    ]) {
      expect(Object.keys(view ?? {})).not.toContain(field);
    }
    expect(
      worker.calls.filter((call) => !["status.get", "events.subscribe"].includes(call)),
    ).toEqual([]);

    worker.status = statusFixture({ leases: [leaseFixture("lease_1", "dev_1")] });
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    worker.pushEvent({ event: "lease.granted" });
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.health).toBe("running"));

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      catalog: [],
      catalogReadAt: harness.clock.now(),
      devices: [{ id: "dev_1" }],
      leases: [{ id: "lease_1" }],
    });
    await harness.service.stop();
  });

  it("builds the full view of a worker that was starting when first read, once its startup ends, before the next tick", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = {
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: hostFixture(),
    };
    worker.devices = [deviceFixture("dev_1", "leased")];
    worker.catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);
    let endStartup!: () => void;
    const startupEnded = new Promise<void>((resolve) => {
      endStartup = resolve;
    });
    let subscribeCalled = false;
    worker.subscribeEvents = async () => {
      worker.calls.push("events.subscribe");
      subscribeCalled = true;
      await startupEnded;
      return async () => undefined;
    };

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(subscribeCalled).toBe(true));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.health).toBe("starting"));
    const startedAt = harness.clock.now();

    worker.status = statusFixture({ leases: [leaseFixture("lease_1", "dev_1")], queueDepth: 1 });
    endStartup();

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")).toMatchObject({
        capacity: { ios: { limit: 2 } },
        catalog: [{ models: ["iPhone 17"] }],
        catalogReadAt: startedAt,
        devices: [{ id: "dev_1" }],
        health: "running",
        leases: [{ id: "lease_1" }],
        queueDepth: 1,
      }),
    );
    expect(harness.clock.now()).toBe(startedAt);

    await harness.service.stop();
  });

  it("reads nothing more from a worker whose late subscription answer arrives after the service stopped", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    let endStartup!: () => void;
    const startupEnded = new Promise<void>((resolve) => {
      endStartup = resolve;
    });
    let subscribeCalled = false;
    let unsubscribed = false;
    worker.subscribeEvents = async () => {
      worker.calls.push("events.subscribe");
      subscribeCalled = true;
      await startupEnded;
      return async () => {
        unsubscribed = true;
      };
    };

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(subscribeCalled).toBe(true));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);
    await vi.waitFor(() => expect(worker.calls).toContain("status.get"));
    await harness.service.stop();
    const callsBefore = [...worker.calls];

    endStartup();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(worker.calls).toEqual(callsBefore);
    expect(unsubscribed).toBe(false);
  });

  it("reads the catalog for a catalog refresh that arrives while a refresh without one is in flight", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_a", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_a")?.capacity).toBeDefined());
    const catalogReads = () => worker.calls.filter((call) => call === "catalog.get").length;
    expect(catalogReads()).toBe(1);

    const release = worker.holdStatus();
    worker.pushEvent({ event: "device.state-changed" });
    await vi.waitFor(() => expect(worker.calls.at(-1)).toBe("status.get"));
    void harness.service.target("wrk_a")?.refresh({ includeCatalog: true });
    harness.clock.advance(250);
    release();

    await vi.waitFor(() => expect(catalogReads()).toBe(2));
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.catalogReadAt).toBe(harness.clock.now()),
    );
    await harness.service.stop();
  });

  it("the worker view builder gives a gateway the view it built before the builder moved, plus when it read the catalog", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient("admin", "9.8.7");
    const install = {
      component: "26.0",
      platform: "ios" as const,
      since: 500,
      state: "downloading" as const,
      waiters: 2,
    };
    const capacity = {
      ...statusFixture().capacity,
      global: { maxRunning: 4, overLimit: false, reserved: 1, running: 2, warm: 1 },
    };
    const waiting = {
      createdAt: 600,
      id: "req_1",
      queuePosition: 1,
      requesterId: "local-agent",
      spec: { model: "iPhone 17", platform: "ios" as const },
      stage: "queued" as const,
    };
    worker.status = statusFixture({
      capacity,
      daemon: {
        health: "failed",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: hostFixture({ arch: "x64" }),
      installs: [install],
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 3,
      waiting: [waiting],
    });
    worker.devices = [
      { ...deviceFixture("dev_1", "leased"), createdAt: 1, driverData: { private: true } },
    ];
    worker.catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);
    worker.downloadPolicy = "always";
    worker.downloadTimeoutMs = 45 * 60_000;
    worker.leaseMaxTtlMs = 6 * 60 * 60_000;

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

    expect(harness.service.workers.view("wrk_1")).toEqual({
      baselines: [],
      capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      catalogReadAt: 1_000,
      connection: "connected",
      devices: [deviceFixture("dev_1", "leased")],
      downloads: { policy: "always", timeoutMs: 45 * 60_000 },
      drained: false,
      health: "failed",
      host: hostFixture({ arch: "x64" }),
      id: "wrk_1",
      installs: [install],
      label: "mac-mini-1",
      lastSeenAt: 1_000,
      lastUpdateFailure: null,
      latestVersion: null,
      lease: { maxTtlMs: 6 * 60 * 60_000 },
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 3,
      update: null,
      version: "9.8.7",
      waiting: [waiting],
    });

    await harness.service.stop();
  });

  it("narrows a worker's device records: no driver-private data crosses the fleet", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      {
        ...deviceFixture("dev_1"),
        createdAt: 1,
        driverData: { secret: "a driver's private blob" },
        driverDeviceId: "UDID-1",
      },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(1));

    const device = harness.service.workers.view("wrk_1")?.devices?.[0];
    expect(device).toMatchObject({ id: "dev_1", state: "ready" });
    expect(device).not.toHaveProperty("driverData");
    expect(device).not.toHaveProperty("driverDeviceId");

    await harness.service.stop();
  });

  it("keeps a worker's devices in the grant shape beside its view, with driverDeviceId, leaving out one that has none", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      {
        ...deviceFixture("dev_1"),
        createdAt: 1,
        driverData: { secret: "a driver's private blob" },
        driverDeviceId: "UDID-1",
      },
      { ...deviceFixture("dev_2"), createdAt: 1, driverData: {} },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(2));

    for (const device of harness.service.workers.view("wrk_1")?.devices ?? []) {
      expect(device).not.toHaveProperty("driverDeviceId");
    }
    expect(harness.service.workers.grantedDevices()).toEqual([
      {
        physical: false,
        driverDeviceId: "UDID-1",
        id: "dev_1",
        mode: "full",
        spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
        workerId: "wrk_1",
      },
    ]);

    await harness.service.stop();
  });

  it("keeps a worker's physical device in the grant shape beside its view, with physical and class and no mode, so a lease on it is not UNKNOWN_LEASE", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      {
        class: "phone",
        createdAt: 1,
        driverData: {},
        driverDeviceId: "00008110-001A2B3C4D5E",
        id: "dev_p",
        physical: true,
        servesDefaultMode: false,
        spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
        state: "ready",
      },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(1));

    expect(harness.service.workers.view("wrk_1")?.devices?.[0]).toMatchObject({
      class: "phone",
      id: "dev_p",
      physical: true,
    });
    expect(harness.service.workers.grantedDevices()).toEqual([
      {
        class: "phone",
        driverDeviceId: "00008110-001A2B3C4D5E",
        id: "dev_p",
        physical: true,
        spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
        workerId: "wrk_1",
      },
    ]);

    await harness.service.stop();
  });

  it("keeps each worker device's mode in the view", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      { ...deviceFixture("dev_slim", "ready", "slim"), createdAt: 1, driverData: {} },
      { ...deviceFixture("dev_full", "ready", "full"), createdAt: 1, driverData: {} },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(2));

    expect(
      harness.service.workers.view("wrk_1")?.devices?.map(({ id, mode }) => ({ id, mode })),
    ).toEqual([
      { id: "dev_slim", mode: "slim" },
      { id: "dev_full", mode: "full" },
    ]);

    await harness.service.stop();
  });

  it("a gateway's worker view carries a worker device's stalled flag", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      {
        ...deviceFixture("dev_stuck"),
        state: "provisioning" as const,
        createdAt: 1,
        driverData: {},
        stalled: true,
        transitionAgeMs: 120_000,
      },
      { ...deviceFixture("dev_ready", "ready"), createdAt: 1, driverData: {} },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(2));

    const [stuck, ready] = harness.service.workers.view("wrk_1")?.devices ?? [];
    expect(stuck).toMatchObject({ id: "dev_stuck", stalled: true });
    expect(ready?.id).toBe("dev_ready");
    expect(ready).not.toHaveProperty("stalled");

    await harness.service.stop();
  });
});

describe("GatewayService: a worker's capabilities in its view", () => {
  const unavailable = {
    name: "agent-device",
    reason: "found 0.20.1, need 0.21.28 or later",
    state: "unavailable" as const,
  };
  const available = { name: "agent-device", state: "available" as const };

  async function joinedWith(capabilities: readonly (typeof unavailable | typeof available)[]) {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ capabilities: [...capabilities] });
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.capabilities).toEqual(capabilities),
    );
    return { harness, worker };
  }

  it("shows available after the next refresh tick when the worker's agent-device went from unavailable to running", async () => {
    const { harness, worker } = await joinedWith([unavailable]);
    worker.status = statusFixture({ capabilities: [available] });

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.capabilities).toEqual([available]),
    );
    await harness.service.stop();
  });

  it("shows no list for a worker that reported one and restarted into starting", async () => {
    const { harness } = await joinedWith([available]);
    const restarted = new ScriptedWorkerClient();
    restarted.status = {
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: hostFixture(),
    };

    await harness.join("wrk_1", restarted);

    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.health).toBe("starting"));
    expect(Object.keys(harness.service.workers.view("wrk_1") ?? {})).not.toContain("capabilities");
    await harness.service.stop();
  });

  it("shows no list for a worker that reported one and came back incompatible", async () => {
    const { harness } = await joinedWith([available]);
    const previous = { min: 5, max: 5 };
    const incompatible = new ScriptedWorkerClient();
    incompatible.failWith = protocolMismatchError(previous);

    await harness.join("wrk_1", incompatible);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );
    expect(Object.keys(harness.service.workers.view("wrk_1") ?? {})).not.toContain("capabilities");
    await harness.service.stop();
  });

  it("keeps the list a disconnected worker last reported", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ capabilities: [unavailable] });
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.capabilities).toEqual([unavailable]),
    );

    await workerEnd.close();

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(harness.service.workers.view("wrk_1")?.capabilities).toEqual([unavailable]);
    await harness.service.stop();
  });
});
