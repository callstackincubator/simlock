import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { FakeClock, MemoryUplinkTransport, type UplinkAuthOutcome } from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { GatewayService } from "./service.js";
import {
  catalogFixture,
  deviceFixture,
  leaseFixture,
  protocolMismatchError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";

const RETENTION_MS = 24 * 60 * 60_000;
const REFRESH_MS = 30_000;

function fleet(options: { readonly authenticate?: () => UplinkAuthOutcome } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const transport = new MemoryUplinkTransport();
  /** The scripted worker each uplink resolves to, keyed by the principal-free order they join. */
  const clients: ScriptedWorkerClient[] = [];
  const service = new GatewayService({
    authenticate: async () => options.authenticate?.() ?? "accept",
    clock,
    connect: async () => {
      const client = clients.at(-1);
      if (client === undefined) throw new Error("no scripted worker was queued for this uplink");
      return client.asClient();
    },
    drainStore: new MemoryDrainStore(),
    eventBus,
    principal: "gw:instance-1",
    refreshIntervalMs: REFRESH_MS,
    retentionMs: RETENTION_MS,
    uplinks: transport,
  });
  return {
    clients,
    clock,
    events,
    service,
    transport,
    /** Queues the worker the next uplink resolves to, then dials it. */
    join: async (workerId: string, client: ScriptedWorkerClient, label?: string) => {
      clients.push(client);
      return transport.connect({
        token: "join-secret",
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
  };
}

function eventNames(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.event);
}

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

    const device = harness.service.workers.view("wrk_1")?.devices[0];
    expect(device).toMatchObject({ id: "dev_1", state: "ready" });
    expect(device).not.toHaveProperty("driverData");
    expect(device).not.toHaveProperty("driverDeviceId");

    await harness.service.stop();
  });

  it("republishes a worker's events with its workerId, into its own ring buffer", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });

    const republished = harness.events.find((event) => event.event === "lease.granted");
    expect(republished).toMatchObject({
      // The name and the emitting module travel unchanged -- the fact happened in that
      // worker's lease engine, and `workerId` is what says which machine.
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", workerId: "wrk_1" },
    });

    await harness.service.stop();
  });

  it("refreshes the view on a worker event that changes capacity or leases", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    const callsBefore = worker.calls.length;
    worker.status = statusFixture({ leases: [leaseFixture("lease_9", "dev_9")] });

    worker.pushEvent({ event: "lease.granted" });

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.leases).toEqual([
        expect.objectContaining({ id: "lease_9" }),
      ]),
    );
    expect(worker.calls.length).toBeGreaterThan(callsBefore);

    await harness.service.stop();
  });

  it("does not re-read the fleet for an event that changes neither", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    const callsBefore = worker.calls.length;

    worker.pushEvent({ event: "doctor.reconciled" });
    // Still republished -- every worker fact reaches the gateway's buffer -- just not a reason
    // to re-read anything.
    await vi.waitFor(() => expect(eventNames(harness.events)).toContain("doctor.reconciled"));

    expect(worker.calls).toHaveLength(callsBefore);

    await harness.service.stop();
  });

  it("refreshes every view on the periodic tick, catalog included", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    worker.catalog = catalogFixture([
      { models: ["iPhone 17", "iPad Pro"], platform: "ios", runtimes: ["26.0"] },
    ]);

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.catalog[0]?.models).toEqual([
        "iPhone 17",
        "iPad Pro",
      ]),
    );

    await harness.service.stop();
  });

  it("marks a worker incompatible when hello finds no overlapping range, and asks it nothing else", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    // What `connectSimlockAdmin`'s degraded client does after a failed negotiation: every call
    // rejects with the captured error, carrying both ranges.
    worker.failWith = protocolMismatchError({ min: 4, max: 4 });

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: { min: 5, max: 5 }, worker: { min: 4, max: 4 } },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);
    expect(harness.events.at(-1)).toMatchObject({
      event: "worker.rejected",
      payload: { reason: "incompatible", workerId: "wrk_1" },
    });

    await harness.service.stop();
  });

  it("flips a view to disconnected the moment its uplink closes -- no polling", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    await workerEnd.close();

    // Not on the next tick: the uplink is the reachability signal (ADR 0005 §6).
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  it("sweeps a retired view on the tick, once retention has passed", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    await workerEnd.close();
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );

    harness.clock.advance(RETENTION_MS + REFRESH_MS);

    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")).toBeUndefined());
    expect(eventNames(harness.events)).toContain("worker.removed");

    await harness.service.stop();
  });

  it("reports an uplink it turned away, without inventing a worker for it", async () => {
    const harness = fleet({ authenticate: () => "unauthenticated" });
    await harness.service.start();

    await expect(harness.join("wrk_1", new ScriptedWorkerClient())).rejects.toMatchObject({
      code: "rejected",
    });

    expect(harness.service.workers.views()).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({
      event: "worker.rejected",
      payload: { reason: "unauthenticated" },
    });

    await harness.service.stop();
  });

  it("closes the uplink when a worker does not grant the gateway admin", async () => {
    const harness = fleet();
    await harness.service.start();
    // A worker older than #117, or one that resolved the session some other way: nothing the
    // gateway asks would be answered, so there is no view worth keeping.
    const worker = new ScriptedWorkerClient("agent");

    const workerEnd = await harness.join("wrk_1", worker);

    await vi.waitFor(() => expect(worker.closed).toBe(true));
    expect(workerEnd.closed).toBe(true);
    expect(harness.service.workers.views()).toEqual([]);

    await harness.service.stop();
  });

  it("stops the tick and closes every link on stop", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    await harness.service.stop();

    expect(worker.closed).toBe(true);
    const callsAfterStop = worker.calls.length;
    harness.clock.advance(10 * REFRESH_MS);
    expect(worker.calls).toHaveLength(callsAfterStop);
  });
});
