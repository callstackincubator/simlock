import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { negotiateProtocolVersion, PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  FakeClock,
  MemoryUplinkTransport,
  type Logger,
  type UplinkAuthOutcome,
  type UplinkAuthResult,
} from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import { MemoryDrainStore } from "./drain-store.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { createRoutingPolicy } from "./routing.js";
import { GatewayService, REJECTION_COALESCE_WINDOW_MS } from "./service.js";
import {
  catalogFixture,
  deviceFixture,
  hostFixture,
  leaseFixture,
  physicalDeviceFixture,
  type PhysicalPresenceFixture,
  protocolMismatchError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { MAX_CONSECUTIVE_REFRESH_TIMEOUTS, WORKER_CALL_TIMEOUT_MS } from "./worker-link.js";

const RETENTION_MS = 24 * 60 * 60_000;
const previousProtocol = {
  min: PROTOCOL_VERSION_RANGE.min - 1,
  max: PROTOCOL_VERSION_RANGE.max - 1,
};
const REFRESH_MS = 30_000;
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

function fleet(
  options: {
    readonly authenticate?: (
      credential: string | undefined,
    ) => UplinkAuthOutcome | UplinkAuthResult;
    readonly leaseMaxTtlMs?: number;
    readonly logger?: Logger;
    readonly refreshIntervalMs?: number;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const transport = new MemoryUplinkTransport();
  const clients: ScriptedWorkerClient[] = [];
  // why: C3: set to make the *next* `connect()` -- the `hello` round trip itself -- never resolve,
  // the way a peer that completes the WebSocket upgrade and then falls silent would.
  const connectState = { hangNext: false };
  const service = new GatewayService({
    authenticate: async (credential) => options.authenticate?.(credential) ?? "accept",
    clock,
    connect: async () => {
      if (connectState.hangNext) {
        connectState.hangNext = false;
        return new Promise<never>(() => {});
      }
      const client = clients.at(-1);
      if (client === undefined) throw new Error("no scripted worker was queued for this uplink");
      return client.asClient();
    },
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? DEFAULT_LEASE_MAX_TTL_MS,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    principal: "gw:instance-1",
    refreshIntervalMs: options.refreshIntervalMs ?? REFRESH_MS,
    retentionMs: RETENTION_MS,
    uplinks: transport,
  });
  return {
    clients,
    clock,
    eventBus,
    events,
    service,
    transport,
    join: async (
      workerId: string,
      client: ScriptedWorkerClient,
      label?: string,
      token = "join-secret",
    ) => {
      clients.push(client);
      return transport.connect({
        token,
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
    joinSilent: async (workerId: string, label?: string) => {
      connectState.hangNext = true;
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
      daemon: { health: "starting", mode: "worker" },
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

  // why: #414, modelled on a real worker: its `events.subscribe` parks until startup ends (only
  // `status.get` answers while it is `starting`), and it emits `daemon.started` before that parked
  // call subscribes, so the gateway never hears it. A startup longer than `WORKER_CALL_TIMEOUT_MS`
  // times the subscription out, and the refresh after it reads a `starting` answer. The clock
  // stops there, short of the periodic tick.
  it("builds the full view of a worker that was starting when first read, once its startup ends, before the next tick", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = {
      daemon: { health: "starting", mode: "worker" },
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
    // why: Every field a refresh fills, set to a value that is not a default, and the whole view
    // compared as one literal: the expected value is what the gateway built before the view
    // builder moved into the contract, so any field the move dropped, renamed or reshaped
    // fails here by name. `catalogReadAt` is the registry's own record of the read (ADR 0009
    // §4), not the builder's.
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
      daemon: { health: "failed", mode: "worker" },
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
      lease: { maxTtlMs: 6 * 60 * 60_000 },
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 3,
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
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", workerId: "wrk_1" },
    });

    await harness.service.stop();
  });

  it("a worker's event relayed by the gateway keeps the worker's id and timestamp and gains workerId", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    harness.clock.advance(5_000);

    worker.pushEvent({
      event: "lease.granted",
      id: "evt_worker-made",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
      timestamp: 777,
    });

    const relayed = harness.events.find((event) => event.event === "lease.granted");
    expect(relayed).toMatchObject({
      id: "evt_worker-made",
      timestamp: 777,
      payload: { workerId: "wrk_1" },
    });

    await harness.service.stop();
  });

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
  it("refuses to republish a worker's event under a name reserved for the gateway itself", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "worker.drain-ended",
      module: "gateway",
      payload: { workerId: "wrk_forged", label: "not-this-worker" },
    });
    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });
    await vi.waitFor(() =>
      expect(harness.events.some((event) => event.event === "lease.granted")).toBe(true),
    );

    const forged = harness.events.filter((event) => event.event === "worker.drain-ended");
    // why: Never forwarded, and never with the forged `workerId` a real gateway-authored
    // `worker.drain-ended` for a *different* worker would otherwise be indistinguishable from.
    expect(forged).toEqual([]);

    await harness.service.stop();
  });

  it("refuses to republish a request.granted a worker pushes, which only the gateway itself emits (ADR 0021 §4)", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "request.granted",
      module: "fleet-lease-coordinator",
      payload: { leaseId: "wrk_1.lease_1", requestId: "req_forged", worker: "wrk_1" },
    });
    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });
    await vi.waitFor(() =>
      expect(harness.events.some((event) => event.event === "lease.granted")).toBe(true),
    );

    expect(harness.events.filter((event) => event.event === "request.granted")).toEqual([]);

    await harness.service.stop();
  });

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

  describe("waiting requests on the view", () => {
    it("a worker's lease.queued event refreshes its view's waiting list on the gateway", async () => {
      const worker = new ScriptedWorkerClient();
      const harness = fleet();
      await harness.service.start();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.downloads).toBeDefined(),
      );
      expect(harness.service.workers.view("wrk_1")?.waiting).toEqual([]);

      const queued = {
        createdAt: 500,
        id: "req_1",
        queuePosition: 1,
        requesterId: "local-agent",
        spec: { model: "iPhone 17", platform: "ios" as const },
        stage: "queued" as const,
      };
      worker.status = statusFixture({ queueDepth: 1, waiting: [queued] });
      worker.pushEvent({ event: "lease.queued" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.waiting).toEqual([queued]),
      );
      await harness.service.stop();
    });
  });

  describe("installs in progress on the view (ADR 0010 §7)", () => {
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 500,
      state: "downloading" as const,
      waiters: 1,
    };

    async function joined(worker: ScriptedWorkerClient) {
      const harness = fleet();
      await harness.service.start();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.downloads).toBeDefined(),
      );
      return harness;
    }

    it("shows a worker's install after component.install-started and drops it after component.installed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      const harness = await joined(worker);
      expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]);

      worker.status = statusFixture({ installs: [install] });
      worker.pushEvent({ event: "component.install-started" });
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.installs).toEqual([install]),
      );

      worker.status = statusFixture({ installs: [] });
      worker.pushEvent({ event: "component.installed" });
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]));

      await harness.service.stop();
    });

    it("drops a worker's install after component.install-failed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      worker.status = statusFixture({ installs: [install] });
      const harness = await joined(worker);
      expect(harness.service.workers.view("wrk_1")?.installs).toEqual([install]);

      worker.status = statusFixture({ installs: [] });
      worker.pushEvent({ event: "component.install-failed" });

      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]));
      await harness.service.stop();
    });

    it("lists the new runtime in the view's catalog after component.installed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
      ]);
      const harness = await joined(worker);

      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0", "26.4"] },
      ]);
      worker.pushEvent({ event: "component.installed" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.runtimes).toEqual([
          "26.0",
          "26.4",
        ]),
      );
      await harness.service.stop();
    });

    it("re-reads the catalog for a component.installed that queues behind a refresh in flight, and keeps it when another event queues after it", async () => {
      const worker = new ScriptedWorkerClient();
      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
      ]);
      const harness = await joined(worker);

      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0", "26.4"] },
      ]);
      worker.pushEvent({ event: "lease.granted" });
      worker.pushEvent({ event: "component.installed" });
      worker.pushEvent({ event: "lease.released" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.runtimes).toEqual([
          "26.0",
          "26.4",
        ]),
      );
      await harness.service.stop();
    });

    it("yields a view with no installs, still connected, for a worker whose status has no installs field", async () => {
      const worker = new ScriptedWorkerClient();
      const { installs: _absent, ...withoutInstalls } = statusFixture();
      worker.status = { ...withoutInstalls, queueDepth: 3 };

      const harness = await joined(worker);

      const view = harness.service.workers.view("wrk_1");
      expect(view?.queueDepth).toBe(3);
      expect(view?.installs).toEqual([]);
      expect(view?.connection).toBe("connected");
      await harness.service.stop();
    });

    it("truncates a worker's installs to 16 entries and an over-long component to 64 characters, rather than storing them as sent", async () => {
      const worker = new ScriptedWorkerClient();
      worker.status = statusFixture({
        installs: Array.from({ length: 20 }, (_, index) => ({
          ...install,
          component: `${String(index).padStart(2, "0")}${"x".repeat(100)}`,
          since: index,
        })),
      });

      const harness = await joined(worker);

      const installs = harness.service.workers.view("wrk_1")?.installs ?? [];
      expect(installs).toHaveLength(16);
      expect(installs.map((entry) => entry.component)).toEqual(
        Array.from({ length: 16 }, (_, index) =>
          `${String(index).padStart(2, "0")}${"x".repeat(100)}`.slice(0, 64),
        ),
      );
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
      await harness.service.stop();
    });

    it("carries the worker's own downloads.timeoutMs on the view", async () => {
      const worker = new ScriptedWorkerClient();
      worker.downloadTimeoutMs = 45 * 60_000;

      const harness = await joined(worker);

      expect(harness.service.workers.view("wrk_1")?.downloads).toEqual({
        policy: "on-request",
        timeoutMs: 45 * 60_000,
      });
      await harness.service.stop();
    });
  });

  describe("warning on a worker's lower lease.maxTtlMs (ADR 0005 §15)", () => {
    it("warns once the joining worker's own config.get reports a lower cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker, "mac-mini-1");
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      const warning = logger.warnings.find((entry) => entry.fields?.workerId === "wrk_1");
      expect(warning?.fields).toMatchObject({
        gatewayMaxTtlMs: 3_600_000,
        label: "mac-mini-1",
        workerMaxTtlMs: 1_800_000,
      });

      await harness.service.stop();
    });

    it("does not warn when the joining worker's own cap is at or above the gateway's", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 3_600_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      expect(logger.warnings.some((entry) => entry.fields?.workerId === "wrk_1")).toBe(false);

      await harness.service.stop();
    });

    it("does not repeat the warning on the periodic tick's re-read of an unchanged cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());
      const warningsAfterJoin = logger.warnings.filter(
        (entry) => entry.fields?.workerId === "wrk_1",
      ).length;
      expect(warningsAfterJoin).toBe(1);

      const callsBefore = worker.calls.filter((call) => call === "config.get").length;
      harness.clock.advance(REFRESH_MS);
      await vi.waitFor(() =>
        expect(worker.calls.filter((call) => call === "config.get").length).toBeGreaterThan(
          callsBefore,
        ),
      );

      expect(logger.warnings.filter((entry) => entry.fields?.workerId === "wrk_1").length).toBe(
        warningsAfterJoin,
      );

      await harness.service.stop();
    });
  });

  it("puts the warm pool block a worker's status read carries on its view", async () => {
    const warmPool = { enabled: true, reserveRunning: { android: 0, ios: 2 }, targets: [] };
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ warmPool });

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.warmPool).toEqual(warmPool),
    );

    await harness.service.stop();
  });

  it("marks a worker that speaks only the previous protocol version incompatible with both ranges, and asks it nothing else", async () => {
    // why: Protocol 5 is the version before ADR 0008 made `modelRuntimes` required.
    const previous = { min: 5, max: 5 };
    expect(negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, previous)).toBeUndefined();
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(previous);

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: previous },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);

    await harness.service.stop();
  });

  it("marks a worker one protocol version behind the gateway incompatible (ADR 0022 §2: it does not know `device.add` or `device.remove`, and reports no `driverDeviceId`)", async () => {
    const previous = {
      min: PROTOCOL_VERSION_RANGE.max - 1,
      max: PROTOCOL_VERSION_RANGE.max - 1,
    };
    expect(PROTOCOL_VERSION_RANGE.max).toBe(39);
    expect(negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, previous)).toBeUndefined();
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(previous);

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(worker.calls).toEqual(["status.get"]);

    await harness.service.stop();
  });

  it("a worker advertising protocol 10 is incompatible on the gateway and nothing it pushes reaches the gateway's bus", async () => {
    const worker10 = { min: 10, max: 10 };
    expect(negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, worker10)).toBeUndefined();
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(worker10);
    // why: A gateway that subscribed anyway would get a live listener, so the push below could reach it.
    worker.subscribeDespiteFailure = true;

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );
    worker.pushEvent({ event: "lease.granted", payload: { leaseId: "l1" } });

    expect(worker.subscribed).toBe(false);
    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: worker10 },
    });
    expect(eventNames(harness.events)).not.toContain("lease.granted");

    await harness.service.stop();
  });

  it("marks a worker incompatible when hello finds no overlapping range, and asks it nothing else", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(previousProtocol);

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: previousProtocol },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);
    expect(eventNames(harness.events)).not.toContain("worker.rejected");
    expect(eventNames(harness.events)).not.toContain("worker.connected");

    await harness.service.stop();
  });

  it("flips a view to disconnected the moment its uplink closes -- no polling", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    await workerEnd.close();

    // why: Not on the next tick: the uplink is the reachability signal (ADR 0005 §6).
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  // why: D1: `WorkerRegistry` is keyed by worker id, not by link, and a stale link's own close used
  // to call `registry.disconnected` with no check at all -- so a socket the OS had not yet
  // reported dead could mark the *live* successor's view disconnected, permanently (`refresh()`
  // never touches `connection`). Against the code before this fix, no test joined the same
  // worker id twice against a live service; this is that test.
  it("does not let a stale link's late close mark a reconnected worker disconnected (D1)", async () => {
    const harness = fleet();
    await harness.service.start();

    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    const workerEndA = await harness.join("wrk_1", clientA);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected"),
    );

    // why: A's own close, once the reconnect below triggers it, must never actually complete during
    // this test: a hung `events.unsubscribe` (D2) is exactly what stretches a stale link's close
    // from microseconds to minutes in the wild, and here it lets the test control precisely
    // when A's connection actually goes away.
    clientA.hangUnsubscribe = true;

    const clientB = new ScriptedWorkerClient("admin", "9.9.9");
    await harness.join("wrk_1", clientB);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));

    await workerEndA.close();

    expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9");
    expect(eventNames(harness.events)).not.toContain("worker.disconnected");

    await harness.service.stop();
  });

  // why: D2: `close()` awaited `events.unsubscribe` -- a real round trip -- with nothing bounding it.
  // On a half-open socket that promise never settled, so `close()` never reached
  // `connection.close()` and the link (and its WebSocket) leaked for the life of the process.
  it("does not hang close() forever behind an events.unsubscribe that never answers (D2)", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    worker.hangUnsubscribe = true;

    const stopped = harness.service.stop();
    const stoppedState = promiseState(stopped);
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await vi.waitFor(() => expect(stoppedState.state).toBe("fulfilled"));
    await expect(stopped).resolves.toBeUndefined();
    expect(worker.closed).toBe(true);
  });

  // why: D3: a hung round trip inside `#rebuildView` used to latch `#refreshing` forever, since it
  // was cleared only in a `finally` on a promise that never settled -- freezing the view while
  // it still reported `connected`.
  it("does not latch refreshing forever when a round trip hangs, and recovers past the timeout (D3)", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    worker.hangingCalls.add("status.get");
    worker.status = statusFixture({ leases: [leaseFixture("lease_9", "dev_9")] });
    worker.pushEvent({ event: "lease.granted" });

    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    worker.hangingCalls.delete("status.get");
    worker.pushEvent({ event: "lease.granted" });

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.leases).toEqual([
        expect.objectContaining({ id: "lease_9" }),
      ]),
    );

    await harness.service.stop();
  });

  // why: H2: the same asymmetry D1 fixed in `#handleClosed`, one write later -- `#rebuildView` wrote
  // to `registry.refresh` after its own `await` with no re-check of `#closed` or
  // `isCurrentLink`. A stale link's in-flight refresh, started before a reconnect replaced it,
  // could land after its successor's fresher one and overwrite it with stale data for up to
  // `WORKER_CALL_TIMEOUT_MS`.
  it("does not let a stale link's late-arriving refresh overwrite its successor's fresher view (H2)", async () => {
    const harness = fleet();
    await harness.service.start();

    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    await harness.join("wrk_1", clientA);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("0.1.0"));

    let resolveStatus: ((status: ReturnType<typeof statusFixture>) => void) | undefined;
    clientA.getStatus = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    clientA.pushEvent({ event: "lease.granted" });
    await vi.waitFor(() => expect(resolveStatus).toBeDefined());

    const clientB = new ScriptedWorkerClient("admin", "9.9.9");
    await harness.join("wrk_1", clientB);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));

    resolveStatus?.(statusFixture());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9");

    await harness.service.stop();
  });

  it("does not let a stale link's late starting answer overwrite its successor's view", async () => {
    const harness = fleet();
    await harness.service.start();
    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    await harness.join("wrk_1", clientA);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("0.1.0"));
    const release = clientA.holdStatus();
    clientA.pushEvent({ event: "lease.granted" });
    await vi.waitFor(() => expect(clientA.calls.at(-1)).toBe("status.get"));
    const clientB = new ScriptedWorkerClient("admin", "9.9.9");
    clientB.devices = [deviceFixture("dev_b", "ready")];
    await harness.join("wrk_1", clientB);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));

    clientA.status = {
      daemon: { health: "starting", mode: "worker" },
      host: hostFixture(),
    };
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      devices: [{ id: "dev_b" }],
      health: "running",
      version: "9.9.9",
    });
    await harness.service.stop();
  });

  // why: H4: a timed-out `events.subscribe` used to be logged exactly like a rejection ("Worker
  // refused an event subscription"), asserting something this code cannot know -- the worker may
  // never have answered at all, or may have subscribed successfully with the reply just arriving
  // too late to matter. The two are worth telling apart in a log an operator reads.
  it("logs a timed-out event subscription as a timeout, not a refusal (H4)", async () => {
    const logger = new RecordingLogger();
    const harness = fleet({ logger });
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    // why: Never resolves, unlike a real rejection -- the exact shape of a subscribe call that just
    // never gets an answer within `WORKER_CALL_TIMEOUT_MS`. Tracked by hand rather than via
    // `pendingTimerCount` alone: the service's own periodic tick timer is already pending from
    // `service.start()`, so that check alone cannot tell "the subscribe call's own timeout timer
    // is now armed" apart from "some timer, possibly the unrelated tick, exists".
    let subscribeCalled = false;
    worker.subscribeEvents = (): Promise<never> => {
      subscribeCalled = true;
      return new Promise<never>(() => {});
    };

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(subscribeCalled).toBe(true));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await vi.waitFor(() =>
      expect(logger.warnings.some((entry) => entry.message.includes("did not answer"))).toBe(true),
    );
    expect(logger.warnings.some((entry) => entry.message.includes("refused"))).toBe(false);

    await harness.service.stop();
  });

  // why: P1: a refresh timeout used to be swallowed into a debug log with nothing acting on it, so a
  // half-open uplink (NAT rebind, cable pull, kernel panic -- no FIN) had `connection` report
  // `connected` forever with a `lastSeenAt` that never moved again. One timeout recovering on
  // the very next attempt (D3, above) must still not disconnect a worker -- that is a real, slow
  // response, not a dead link -- but the same failure MAX_CONSECUTIVE_REFRESH_TIMEOUTS times in a
  // row, with nothing in between, must make the gateway give up and close the uplink.
  it("closes the uplink once refreshes keep timing out, so a half-open worker stops reporting connected (P1)", async () => {
    expect(MAX_CONSECUTIVE_REFRESH_TIMEOUTS).toBeGreaterThan(1);
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    worker.hangingCalls.add("status.get");

    for (let attempt = 1; attempt < MAX_CONSECUTIVE_REFRESH_TIMEOUTS; attempt++) {
      harness.clock.advance(REFRESH_MS);
      await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
      harness.clock.advance(WORKER_CALL_TIMEOUT_MS);
      // why: Wait for the *next* tick to actually be armed, not just for the (already, trivially
      // true) `connected` check to pass -- that value never changes on a timeout, so checking
      // it alone would resolve before the tick's own promise chain (refresh's catch, then
      // `pruneExpired`, then rescheduling) has actually finished, and the next iteration's
      // `advance(REFRESH_MS)` would fast-forward the clock past a timer that has not been
      // registered yet -- silently skipping a whole tick instead of exercising it.
      await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    }

    harness.clock.advance(REFRESH_MS);
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  // why: C-1: P1's counter used to be driven by the whole bundled refresh timing out, which conflated
  // a dead transport with a merely busy dispatcher -- on a worker mid-`converge`, `runDispatch`
  // parks every call except `status.get` behind the startup-readiness gate, so `list.get` can
  // legitimately hang for tens of seconds while the socket is completely healthy. Reproduces the
  // reviewer's repro: `status.get` keeps answering, `list.get` never does, for well more than
  // `MAX_CONSECUTIVE_REFRESH_TIMEOUTS` refresh cycles in a row. A gateway that still infers
  // transport death from this would flip the link to `disconnected` long before this loop ends.
  it("does not close the link when status.get keeps answering but the dispatcher is busy (C-1)", async () => {
    // why: A refreshIntervalMs far outside this test's clock advances: `#runTick` only reschedules
    // its own timer once a refresh settles (`service.ts`'s `.finally(() => this.#scheduleTick())`),
    // so on a link whose refresh keeps timing out the tick's real cadence drifts to roughly
    // `refreshIntervalMs + WORKER_CALL_TIMEOUT_MS` per cycle -- exercising this via event-driven
    // refreshes instead (as D3 and H2 above do) keeps the periodic tick out of the picture
    // entirely, rather than fighting its drift with hand-tuned clock advances.
    const harness = fleet({ refreshIntervalMs: 10_000_000 });
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    worker.hangingCalls.add("list.get:devices");

    for (let attempt = 1; attempt <= MAX_CONSECUTIVE_REFRESH_TIMEOUTS + 2; attempt++) {
      const listCallsBefore = worker.calls.filter((call) => call === "list.get:devices").length;
      worker.pushEvent({ event: "lease.granted" });
      // why: Waits for `list.get` to have actually been called -- proof `status.get`'s real promise
      // was given a genuine chance to settle and `#rebuildView` moved on to the hung batch.
      // Waiting on `pendingTimerCount` instead would be a false positive: `status.get`'s own
      // bounded wait registers a timer *synchronously*, before its real response has had any
      // chance to arrive, so a bare "a timer exists" check can pass and race the fake clock's
      // `advance` below against `status.get`'s still-pending real resolution -- timing out the
      // liveness call itself instead of the batch behind it, which is exactly the distinction
      // this fix exists to preserve.
      await vi.waitFor(() =>
        expect(worker.calls.filter((call) => call === "list.get:devices").length).toBeGreaterThan(
          listCallsBefore,
        ),
      );
      harness.clock.advance(WORKER_CALL_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    }
    expect(eventNames(harness.events)).not.toContain("worker.disconnected");

    await harness.service.stop();
  });

  // why: C-2, ADR 0005 §8 ("revoking closes the uplink"): a join token was checked once, at upgrade,
  // and nothing ever re-verified a live link -- so revoking a worker's token used to have no
  // observable effect on an already-open uplink at all. `closeLinksForToken` is what
  // `GatewayDispatcher#tokenRevoke` calls after a successful revoke; this exercises it end to
  // end against real `WorkerLink`s, matched by the exact token each authenticated with, so a
  // shared or reused credential (however unlikely) cannot silently take out an unrelated worker.
  it("closes exactly the link a token authorized, and leaves every other link alone (C-2)", async () => {
    const harness = fleet({
      authenticate: (credential) =>
        credential === undefined
          ? "unauthenticated"
          : { outcome: "accept" as const, tokenId: credential },
    });
    await harness.service.start();

    const workerA = new ScriptedWorkerClient();
    await harness.join("wrk_a", workerA, undefined, "tok_a");
    const workerB = new ScriptedWorkerClient();
    await harness.join("wrk_b", workerB, undefined, "tok_b");
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("connected"),
    );
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_b")?.connection).toBe("connected"),
    );

    await harness.service.closeLinksForToken("tok_a");

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("disconnected"),
    );
    expect(harness.service.workers.view("wrk_b")?.connection).toBe("connected");
    expect(eventNames(harness.events)).toEqual(
      expect.arrayContaining(["worker.connected", "worker.connected", "worker.disconnected"]),
    );

    await harness.service.stop();
  });

  // why: C3: `hello` -- inside `connect()`, the first round trip `start()` makes -- had no timeout
  // at all, unlike every call after it. A peer that completes the WebSocket upgrade with a
  // valid join token and then never answers `hello` (a half-open TCP right after upgrade, or a
  // deliberately silent client) used to hang `start()` forever: the link stayed in `#links`
  // (registered before `start()` even runs), holding an open socket and no view, invisible in
  // `simlock worker list` while consuming a slot -- D2's exact failure mode, one call earlier.
  it("does not hang the handshake forever when hello itself never answers (C3)", async () => {
    const harness = fleet();
    await harness.service.start();

    const workerEnd = await harness.joinSilent("wrk_1", "mac-mini-1");
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    // why: The decisive check: a timed-out hello must make the link actually give up and close its
    // end of the socket -- closing either end of an in-memory pair closes both, so this is only
    // true once the gateway's side has been closed. Against the unbounded `connect()` this
    // never happens: nothing ever times out, so nothing ever closes, and this assertion is what
    // tells the two apart (a looser "no view was built" check passes either way, since a
    // permanently-hung connect() also never builds one).
    await vi.waitFor(() => expect(workerEnd.closed).toBe(true));

    expect(eventNames(harness.events)).not.toContain("worker.connected");
    expect(harness.service.workers.view("wrk_1")).toBeUndefined();

    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected"),
    );

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

  it.each(["unauthenticated", "forbidden"] as const)(
    "reports a %s uplink it turned away, without inventing a worker for it",
    async (reason) => {
      const harness = fleet({ authenticate: () => reason });
      await harness.service.start();

      await expect(
        harness.join("wrk_1", new ScriptedWorkerClient(), "mac-mini-1"),
      ).rejects.toMatchObject({
        code: "rejected",
      });

      expect(harness.service.workers.views()).toEqual([]);
      expect(harness.events.at(-1)).toMatchObject({
        event: "worker.rejected",
        payload: { label: "mac-mini-1", reason, workerId: "wrk_1" },
      });

      await harness.service.stop();
    },
  );

  // why: P-2: `GET /v1/uplink` needs no credential to reach `authenticate`, and before this fix every
  // refusal emitted its own `worker.rejected` -- so a flood of refused dials (deliberate, or a
  // misconfigured worker retrying fast) could fill the event bus's ring buffer, bounded by count
  // and not bytes, with nothing but refusals, evicting everything else in it. No test dialed
  // twice before this round. This asserts the coalescing itself: two dials with the same claimed
  // id and reason inside one window produce exactly one event, and the first dial after the
  // window closes reports the closed window's total as `count`.
  it("coalesces a flood of identical refusals into one event per window, with a count only above one (P-2)", async () => {
    const harness = fleet({ authenticate: () => "unauthenticated" });
    await harness.service.start();
    const rejectedEvents = () =>
      harness.events.filter((event) => event.event === "worker.rejected");

    await expect(
      harness.join("wrk_flood", new ScriptedWorkerClient(), "mac-mini-1"),
    ).rejects.toMatchObject({ code: "rejected" });
    await expect(
      harness.join("wrk_flood", new ScriptedWorkerClient(), "mac-mini-1"),
    ).rejects.toMatchObject({ code: "rejected" });

    expect(rejectedEvents()).toHaveLength(1);
    expect(rejectedEvents()[0]?.payload).toMatchObject({ workerId: "wrk_flood" });
    expect(rejectedEvents()[0]?.payload).not.toHaveProperty("count");

    harness.clock.advance(REJECTION_COALESCE_WINDOW_MS);
    await expect(
      harness.join("wrk_flood", new ScriptedWorkerClient(), "mac-mini-1"),
    ).rejects.toMatchObject({ code: "rejected" });

    expect(rejectedEvents()).toHaveLength(2);
    expect(rejectedEvents()[1]?.payload).toMatchObject({ count: 2, workerId: "wrk_flood" });

    await expect(
      harness.join("wrk_other", new ScriptedWorkerClient(), "mac-mini-2"),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(rejectedEvents()).toHaveLength(3);
    expect(rejectedEvents()[2]?.payload).not.toHaveProperty("count");

    // why: both EVENTS.md cuts document `count` as "present only above one", so a lone refusal
    // whose predecessor window absorbed exactly one -- the normal path for a worker redialling
    // on its backoff, which lands outside every window by design -- must not carry `count: 1`.
    // Presence is the flood signal (#677).
    harness.clock.advance(REJECTION_COALESCE_WINDOW_MS);
    await expect(
      harness.join("wrk_other", new ScriptedWorkerClient(), "mac-mini-2"),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(rejectedEvents()).toHaveLength(4);
    expect(rejectedEvents()[3]?.payload).toMatchObject({ workerId: "wrk_other" });
    expect(rejectedEvents()[3]?.payload).not.toHaveProperty("count");

    await harness.service.stop();
  });

  it("closes the uplink when a worker does not grant the gateway admin", async () => {
    const harness = fleet();
    await harness.service.start();
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

  describe("target() / WorkerDispatchTarget (fleet-ports)", () => {
    it("has no client before the handshake completes", async () => {
      const harness = fleet();
      await harness.service.start();

      await harness.joinSilent("wrk_1");
      const target = harness.service.target("wrk_1");

      expect(target).toBeDefined();
      expect(target?.reachable).toBe(true);
      expect(target?.client()).toBeUndefined();

      await harness.service.stop();
    });

    it("has no client once the link has closed", async () => {
      const harness = fleet();
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

      const target = harness.service.target("wrk_1");
      expect(target?.client()).toBeDefined();
      expect(target?.reachable).toBe(true);

      await harness.service.stop();

      expect(target?.reachable).toBe(false);
      expect(target?.client()).toBeUndefined();
    });
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
      daemon: { health: "starting", mode: "worker" },
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
