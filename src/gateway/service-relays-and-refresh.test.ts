import { describe, expect, it, vi } from "vitest";
import { MemoryEndedLeaseIds } from "./index.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { createRoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  hostFixture,
  leaseFixture,
  physicalDeviceFixture,
  type PhysicalPresenceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { eventNames, fleet, REFRESH_MS, RecordingLogger } from "./test-service.js";

// why: the documented bound (src/gateway/AGENTS.md); a payload nested this deep is refused.
const MAX_RELAYED_PAYLOAD_DEPTH = 64;

describe("GatewayService", () => {
  it("a relayed event differs from the worker's only in seq and payload.workerId", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    const sent = {
      event: "lease.granted",
      id: "evt_worker-made",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
      seq: 41,
      timestamp: 777,
    };

    worker.pushEvent(sent);

    const relayed = harness.events.find((event) => event.event === "lease.granted");
    const { seq: relayedSeq, payload: relayedPayload, ...relayedRest } = relayed ?? {};
    const { seq: sentSeq, payload: sentPayload, ...sentRest } = sent;
    expect(relayedRest).toEqual(sentRest);
    expect(relayedPayload).toEqual({ ...sentPayload, workerId: "wrk_1" });
    expect(relayedSeq).not.toBe(sentSeq);

    await harness.service.stop();
  });

  it.each([
    { levels: MAX_RELAYED_PAYLOAD_DEPTH - 1, relayed: true },
    { levels: MAX_RELAYED_PAYLOAD_DEPTH, relayed: false },
    { levels: 6_189, relayed: false },
    { levels: 20_000, relayed: false },
  ])(
    "a relayed event whose payload nests $levels levels is relayed: $relayed, and a refused one logs one error while the next event arrives",
    async ({ levels, relayed }) => {
      const logger = new RecordingLogger();
      const harness = fleet({ logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));
      const nested = JSON.parse("[".repeat(levels) + "]".repeat(levels)) as unknown;

      worker.pushEvent({
        event: "queue.changed",
        id: "evt_nested",
        module: "wait-queue",
        payload: { depth: 1, nested },
      });
      worker.pushEvent({
        event: "queue.changed",
        id: "evt_after",
        module: "wait-queue",
        payload: { depth: 2 },
      });

      const ids = harness.events
        .filter((event) => event.event === "queue.changed")
        .map((event) => event.id);
      expect(ids).toEqual(relayed ? ["evt_nested", "evt_after"] : ["evt_after"]);
      expect(logger.errors).toHaveLength(relayed ? 0 : 1);

      await harness.service.stop();
    },
  );

  it("republishes a worker's queue.changed with its workerId and emits no queue.changed of its own", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "queue.changed",
      id: "evt_worker-queue",
      module: "wait-queue",
      payload: { depth: 3 },
      seq: 5,
      timestamp: 900,
    });

    expect(harness.events.filter((event) => event.event === "queue.changed")).toMatchObject([
      { module: "wait-queue", payload: { depth: 3, workerId: "wrk_1" } },
    ]);

    await harness.service.stop();
  });

  // why: nothing about the admin protocol proves that a pushed event's *name* is genuinely the
  // worker's own -- `workerId` is merged in last so it cannot be spoofed, but a worker (or
  // anything speaking its protocol) could otherwise forge a fact only a gateway authors, such as
  // `worker.drain-ended`, straight into the operator's audit trail.
  it.each([
    {
      event: "worker.drain-ended",
      module: "gateway",
      payload: { workerId: "wrk_forged", label: "not-this-worker" },
    },
    {
      event: "request.granted",
      module: "fleet-lease-coordinator",
      payload: { leaseId: "wrk_1.lease_1", requestId: "req_forged", worker: "wrk_1" },
    },
  ])(
    "refuses to republish a $event a worker pushes under a name reserved for the gateway itself (ADR 0021 §4)",
    async (forgedEvent) => {
      const harness = fleet();
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));

      worker.pushEvent(forgedEvent);
      worker.pushEvent({
        event: "lease.granted",
        module: "lease-engine",
        payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
      });
      await vi.waitFor(() =>
        expect(harness.events.some((event) => event.event === "lease.granted")).toBe(true),
      );

      // why: never forwarded, and never with the forged `workerId` a real gateway-authored event
      // for a *different* worker would otherwise be indistinguishable from.
      expect(harness.events.filter((event) => event.event === forgedEvent.event)).toEqual([]);

      await harness.service.stop();
    },
  );

  it("refuses to republish a request.dispatched a worker pushes, which only the gateway itself emits", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "request.dispatched",
      module: "fleet-lease-coordinator",
      payload: {
        platform: "ios",
        queuedMs: 0,
        reason: "warm-hit",
        requestId: "req_forged",
        requesterId: "agent-1",
        stage: "warm-hit",
        workerId: "wrk_forged",
      },
    });
    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });
    await vi.waitFor(() =>
      expect(harness.events.some((event) => event.event === "lease.granted")).toBe(true),
    );

    expect(harness.events.filter((event) => event.event === "request.dispatched")).toEqual([]);

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

  it("refreshes a worker's view at once on its memory.pressure-changed", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    const capacity = statusFixture().capacity;
    worker.status = statusFixture({
      capacity: { ...capacity, memoryPressure: { step: "new-devices-paused" } },
    });

    worker.pushEvent({ event: "memory.pressure-changed" });

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.capacity?.memoryPressure?.step).toBe(
        "new-devices-paused",
      ),
    );

    await harness.service.stop();
  });

  it("asks a worker that refused a request again once its memory.pressure-changed lifts the step, and not before", async () => {
    const harness = fleet();
    await harness.service.start();
    const coordinator = new FleetLeaseCoordinator({
      clock: harness.clock,
      endedLeaseIds: new MemoryEndedLeaseIds({ clock: harness.clock, retentionMs: 86_400_000 }),
      describeFailure: (error) => ({ code: "INTERNAL", message: String(error) }),
      directory: harness.service,
      eventBus: harness.eventBus,
      execTimeoutMs: 11 * 60_000,
      idGenerator: {
        generate: (() => {
          let next = 1;
          return () => `${next++}`;
        })(),
      },
      leaseIndex: new FleetLeaseIndex("gw:instance-1:"),
      leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: createRoutingPolicy("warm-then-free"),
      views: harness.service.workers,
    });
    const worker = new ScriptedWorkerClient();
    const capacity = statusFixture().capacity;
    worker.status = statusFixture({
      capacity: { ...capacity, memoryPressure: { step: "new-devices-paused" } },
    });
    worker.catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.capacity?.memoryPressure?.step).toBe(
        "new-devices-paused",
      ),
    );
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.catalog).toHaveLength(1));
    const leaseRequests = () => worker.calls.filter((call) => call.startsWith("lease.request"));

    void coordinator
      .request(
        { model: "iPhone 17", platform: "ios" },
        { allowDownload: false, noWait: false, ownerId: "agent-1", requesterId: "agent-1" },
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(leaseRequests()).toHaveLength(1));

    worker.pushEvent({ event: "memory.pressure-changed" });
    await vi.waitFor(() =>
      expect(worker.calls.filter((c) => c === "status.get").length).toBeGreaterThan(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leaseRequests()).toHaveLength(1);

    worker.status = statusFixture({ capacity: { ...capacity, memoryPressure: { step: "none" } } });
    worker.pushEvent({ event: "memory.pressure-changed" });

    await vi.waitFor(() => expect(leaseRequests()).toHaveLength(2));

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
      expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.models).toEqual([
        "iPhone 17",
        "iPad Pro",
      ]),
    );

    await harness.service.stop();
  });

  it("sends a waiting physical request its worker refused to that worker again on the first periodic refresh after the worker's view reports the device present, with no worker event", async () => {
    const harness = fleet();
    await harness.service.start();
    const coordinator = new FleetLeaseCoordinator({
      clock: harness.clock,
      endedLeaseIds: new MemoryEndedLeaseIds({ clock: harness.clock, retentionMs: 86_400_000 }),
      describeFailure: (error) => ({ code: "INTERNAL", message: String(error) }),
      directory: harness.service,
      eventBus: harness.eventBus,
      execTimeoutMs: 11 * 60_000,
      idGenerator: {
        generate: (() => {
          let next = 1;
          return () => `${next++}`;
        })(),
      },
      leaseIndex: new FleetLeaseIndex("gw:instance-1:"),
      leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: createRoutingPolicy("warm-then-free"),
      views: harness.service.workers,
    });
    const worker = new ScriptedWorkerClient();
    const phone = (presence: PhysicalPresenceFixture) =>
      physicalDeviceFixture("dev_p", "ready", { presence });
    worker.devices = [phone({ present: true })];
    worker.catalog = catalogFixture([
      { models: ["iPhone 15 Pro"], platform: "ios", runtimes: ["18.4"] },
    ]);
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(1));
    const leaseRequests = () => worker.calls.filter((call) => call.startsWith("lease.request"));

    void coordinator
      .request(
        { physical: true, platform: "ios" },
        { allowDownload: false, noWait: false, ownerId: "agent-1", requesterId: "agent-1" },
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(leaseRequests()).toHaveLength(1));
    const callsBefore = worker.calls.length;

    worker.devices = [phone({ present: false, reason: "not-present" })];
    harness.clock.advance(REFRESH_MS);
    await vi.waitFor(() => expect(worker.calls.length).toBeGreaterThan(callsBefore));
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.devices?.[0]).toMatchObject({
        presence: { present: false, reason: "not-present" },
      }),
    );
    expect(leaseRequests()).toHaveLength(1);

    worker.devices = [phone({ present: true })];
    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() => expect(leaseRequests()).toHaveLength(2));

    await harness.service.stop();
  });

  it("shows a pairing that changes on a worker on its view after the next refresh tick", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.catalog = catalogFixture([
      {
        modelRuntimes: { "iPhone 17": ["26.0"] },
        models: ["iPhone 17"],
        platform: "ios",
        runtimes: ["25.4", "26.0"],
      },
    ]);
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.modelRuntimes).toEqual({
        "iPhone 17": ["26.0"],
      }),
    );
    worker.catalog = catalogFixture([
      {
        modelRuntimes: { "iPhone 17": ["25.4", "26.0"] },
        models: ["iPhone 17"],
        platform: "ios",
        runtimes: ["25.4", "26.0"],
      },
    ]);

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.modelRuntimes).toEqual({
        "iPhone 17": ["25.4", "26.0"],
      }),
    );

    await harness.service.stop();
  });

  it("carries the host facts its worker last reported on the view", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ host: hostFixture({ arch: "x64", osVersion: "14.7" }) });

    await harness.join("wrk_1", worker);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.host).toEqual(
        hostFixture({ arch: "x64", osVersion: "14.7" }),
      ),
    );

    await harness.service.stop();
  });

  it("shows a changed tool version on the view after the next refresh", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.host?.tools[0]?.version).toBe("16.4"),
    );
    worker.status = statusFixture({
      host: hostFixture({
        tools: [{ build: "17A324", name: "xcode", platform: "ios", version: "26.0" }],
      }),
    });

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.host?.tools[0]?.version).toBe("26.0"),
    );

    await harness.service.stop();
  });
});
