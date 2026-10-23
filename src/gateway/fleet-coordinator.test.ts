import { describe, expect, it } from "vitest";

import { EventBus, type EventMap } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import { QueueTimeoutError } from "../leasing/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { FleetLeaseIndex, type WorkerReportedLease } from "./lease-index.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import { createRoutingPolicy, type RoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  hostFixture,
  leaseFixture,
  noCapacityError,
  physicalDeviceFixture,
  type PhysicalPresenceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const GATEWAY_PREFIX = "gw:instance-1:";

class FakeDirectory implements WorkerDirectory {
  readonly clients = new Map<string, ScriptedWorkerClient>();
  readonly unreachable = new Set<string>();
  /** why: C1 (round 2 review): a worker id in here answers `reachable: true` but `client()`
   * `undefined` -- the real window `WorkerLink#reachable`/`#client` can disagree in, between a
   * reconnecting link's `#closed` clearing and its own handshake finishing (`#client` is not
   * assigned until `start()` completes). Distinct from `unreachable` above, which models
   * `reachable: false` instead -- a different code path in `#attempt`/`#forwardToWorker` that no
   * test previously exercised the *first* of the two ways. */
  readonly reachableButNoClient = new Set<string>();
  readonly refreshCalls: string[] = [];
  readonly catalogRefreshCalls: string[] = [];
  readonly failingRefresh = new Set<string>();

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    const reachable = !this.unreachable.has(workerId);
    const hasClient = reachable && !this.reachableButNoClient.has(workerId);
    return {
      client: () => (hasClient ? client.asClient() : undefined),
      reachable,
      refresh: async (options) => {
        this.refreshCalls.push(workerId);
        if (options?.includeCatalog === true) this.catalogRefreshCalls.push(workerId);
        if (this.failingRefresh.has(workerId)) throw new Error("refresh failed");
      },
      workerId,
    };
  }
}

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

function harness(
  overrides: {
    readonly execTimeoutMs?: number;
    readonly leaseRequestTimeoutMs?: number;
    readonly logger?: Logger;
    readonly maxPerRequester?: number;
    readonly routing?: (workers: WorkerRegistry) => RoutingPolicy;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    leaseMaxTtlMs: 4 * 60 * 60_000,
    retentionMs: 24 * 60 * 60_000,
  });
  const directory = new FakeDirectory();
  const leaseIndex = new FleetLeaseIndex(GATEWAY_PREFIX);
  const coordinator = new FleetLeaseCoordinator({
    clock,
    directory,
    describeFailure: (error) => ({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }),
    leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
    eventBus,
    execTimeoutMs: overrides.execTimeoutMs ?? 11 * 60_000,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    leaseRequestTimeoutMs: overrides.leaseRequestTimeoutMs ?? 5 * 60_000,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    ...(overrides.maxPerRequester === undefined
      ? {}
      : { maxPerRequester: overrides.maxPerRequester }),
    routing: overrides.routing?.(workers) ?? createRoutingPolicy("warm-then-free"),
    views: workers,
  });
  return { clock, coordinator, directory, eventBus, leaseIndex, workers };
}

function connectWorker(
  workers: WorkerRegistry,
  workerId: string,
  overrides: {
    readonly label?: string;
    readonly models?: readonly string[];
    readonly platform?: "ios" | "android";
    readonly capacity?: ReturnType<typeof statusFixture>["capacity"];
    readonly devices?: ReturnType<typeof deviceFixture>[];
    readonly queueDepth?: number;
  } = {},
): void {
  workers.connected(workerId, overrides.label, "0.3.0");
  workers.refresh(workerId, {
    capacity: overrides.capacity ?? statusFixture().capacity,
    catalog: catalogFixture([
      {
        models: [...(overrides.models ?? ["iPhone 17"])],
        platform: overrides.platform ?? "ios",
        runtimes: ["26.0"],
      },
    ]).platforms,
    devices: overrides.devices ?? [],
    downloads: { policy: "on-request" },
    health: "running",
    leases: [],
    queueDepth: overrides.queueDepth ?? 0,
  });
}

async function tick(times = 16): Promise<void> {
  for (let iteration = 0; iteration < times; iteration += 1) await Promise.resolve();
}

const REQUEST = {
  physical: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

function saturatedIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } };
}

function roomierIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 3 } };
}

function requestOptions(overrides: Partial<Parameters<FleetLeaseCoordinator["request"]>[1]> = {}) {
  return {
    allowDownload: false,
    noWait: false,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ...overrides,
  };
}

describe("FleetLeaseCoordinator device mode", () => {
  it.each([
    ["full", "wrk_a_cold", "free-capacity"],
    ["slim", "wrk_z_slim", "warm-hit"],
  ] as const)(
    "routes a %s request to %s by the %s stage when the only warm device is slim and another worker has more room",
    async (mode, expectedWorker, expectedStage) => {
      const { coordinator, directory, eventBus, workers } = harness();
      for (const id of ["wrk_a_cold", "wrk_z_slim"]) {
        const client = new ScriptedWorkerClient();
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        directory.add(id, client);
      }
      connectWorker(workers, "wrk_a_cold", { capacity: roomierIos() });
      connectWorker(workers, "wrk_z_slim", {
        devices: [deviceFixture("dev_slim", "ready", "slim")],
      });
      const dispatched: { workerId: string; stage: string }[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      await coordinator.request({ ...REQUEST, mode }, requestOptions());

      expect(dispatched).toEqual([
        expect.objectContaining({ stage: expectedStage, workerId: expectedWorker }),
      ]);
    },
  );

  it.each([
    ["slim", { mode: "slim" as const }],
    ["full", { mode: "full" as const }],
  ])("forwards a request's mode %s to the worker unchanged", async (_label, mode) => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");

    await coordinator.request({ ...REQUEST, ...mode }, requestOptions());

    expect(client.lastRequestLeaseInput).toMatchObject(mode);
  });

  it("forwards no mode when the request named none, so the worker's default applies", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");

    await coordinator.request(REQUEST, requestOptions());

    expect(client.lastRequestLeaseInput).not.toHaveProperty("mode");
  });
});

describe("FleetLeaseCoordinator stored requests", () => {
  it("answers a repeat under the same key with the first grant, forwarding nothing a second time", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    const keyed = requestOptions({ idempotencyKey: "key-1" });

    const first = await coordinator.request(REQUEST, keyed);
    const repeat = await coordinator.request(REQUEST, keyed);

    expect(repeat.lease.id).toBe(first.lease.id);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("reads a request back through its in-memory book once the fleet grants it, and names it on lease.requested", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    let requestId: string | undefined;

    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ onAdmitted: (id) => (requestId = id) }),
    );
    await tick();

    if (requestId === undefined) throw new Error("expected the request to be admitted");
    expect(coordinator.requests.get(requestId)?.record).toMatchObject({
      grant: { lease: { id: grant.lease.id } },
      state: "granted",
    });
    expect(coordinator.requests.requestIdForLease(grant.lease.id)).toBe(requestId);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.requested")
        .map((event) => event.payload),
    ).toMatchObject([{ requestId }]);
  });
});

describe("FleetLeaseCoordinator dispatch", () => {
  it("grants a queued request from whichever worker frees first -- never dispatching to the one routing did not prefer", async () => {
    const { coordinator, directory, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    const noFree = { ...statusFixture().capacity.android, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5, running: 5 } },
    });
    connectWorker(workers, "wrk_b", {
      capacity: { ...statusFixture().capacity, ios: noFree },
    });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_b", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5, running: 0 } },
    });

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("issues exactly one lease.request for a waiter still in flight, even when another worker's view changes mid-flight", async () => {
    const { coordinator, directory, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    clientA.requestLeaseQueue.push({ kind: "hang" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    connectWorker(workers, "wrk_b", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 10 },
      },
    });
    await tick();

    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });

  it("dispatches at most one queued waiter per worker per pass, rather than sending every queued waiter at a single over-reporting worker at once (H6, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const p1 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );
    const p2 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const p3 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-3", requesterId: "agent-3" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(3);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests).toHaveLength(2);
    expect(leaseRequests[1]).toContain("agent-2");

    await expect(p1).resolves.toBeDefined();
    const outcome = await Promise.race([
      Promise.allSettled([p2, p3]).then(() => "settled" as const),
      tick(6).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBe("still-pending");
    expect(coordinator.queueDepth).toBe(2);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);
  });

  it("gives a waiter passed over by the per-pass cap a guaranteed next look once the claiming attempt settles terminally, even when that failure produces no worker-side event at all (C1, round 3 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ kind: "hang" });
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const w1Request = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );
    const w1State = promiseState(w1Request);
    const w1 = w1Request.catch((error: unknown) => error);
    const w2 = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(2);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    clock.advance(5_000);
    await tick();
    expect(w1State.state).toBe("rejected");
    const w1Error = await w1;
    expect(w1Error).toBeInstanceOf(DispatchError);
    expect((w1Error as DispatchError).code).toBe("WORKER_UNREACHABLE");

    const outcome = await Promise.race([
      w2.then(
        () => "resolved" as const,
        () => "resolved" as const,
      ),
      tick(6).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBe("resolved");
    const w2Grant = await w2;
    expect(w2Grant.lease.worker?.id).toBe("wrk_a");
    expect(directory.refreshCalls).toEqual([]);
  });

  it("re-dispatches a waiter whose attempt found a reachable-but-not-yet-connected target, instead of parking it forever", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    directory.reachableButNoClient.add("wrk_a");

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);

    directory.reachableButNoClient.delete("wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {}); // any refresh re-runs dispatch, exactly as a real one would

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("leaves a request queued after NO_CAPACITY, refreshes that worker's view, and tries it once more when a refresh changes its capacity", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(coordinator.queueDepth).toBe(1);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);

    const capacity = statusFixture().capacity;
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 3 } },
    });

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(2);
  });

  it("sends a worker that keeps answering NO_CAPACITY with an unchanged view one lease.request for that request", async () => {
    const { clock, coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    void coordinator.request(REQUEST, requestOptions());
    await tick();
    for (let refresh = 0; refresh < 3; refresh += 1) {
      clock.advance(1_000); // a new lastSeenAt on every refresh, as a real one has
      workers.refresh("wrk_a", { capacity: statusFixture().capacity });
      await tick();
    }

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("tries another eligible worker in the pass that follows a refusal", async () => {
    const { coordinator, directory, workers } = harness();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_a", preferred);
    directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_b");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(other.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);

    workers.refresh("wrk_a", {});

    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(preferred.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it("does not exclude a worker for another request because it refused one", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    void coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );

    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual([
      `lease.request:${GATEWAY_PREFIX}agent-1`,
      `lease.request:${GATEWAY_PREFIX}agent-2`,
    ]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("leaves a request queued when the worker that refused it left the views before the refusal arrived", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const target = directory.target.bind(directory);
    directory.target = (workerId) => {
      const found = target(workerId);
      if (found === undefined) return undefined;
      return {
        ...found,
        client: () => {
          workers.disconnected(workerId);
          void workers.remove(workerId);
          return found.client();
        },
      };
    };

    void coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(workers.views()).toEqual([]);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("sends a queued noWait request refused by one worker to only one other worker in the next walk", async () => {
    const { coordinator, directory, workers } = harness();
    const first = new ScriptedWorkerClient();
    const second = new ScriptedWorkerClient();
    const third = new ScriptedWorkerClient();
    directory.add("wrk_a", first);
    directory.add("wrk_b", second);
    directory.add("wrk_c", third);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 6 } },
    });
    connectWorker(workers, "wrk_b", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_c", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    directory.reachableButNoClient.add("wrk_a");
    second.requestLeaseQueue.push({ kind: "hang" });
    third.requestLeaseQueue.push({ kind: "hang" });

    void coordinator.request(REQUEST, requestOptions({ noWait: true }));
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    directory.reachableButNoClient.delete("wrk_a");
    workers.refresh("wrk_a", {});
    await tick();

    const leaseRequests = (client: ScriptedWorkerClient) =>
      client.calls.filter((call) => call.startsWith("lease.request")).length;
    expect(leaseRequests(first)).toBe(1);
    expect(leaseRequests(second) + leaseRequests(third)).toBe(1);
  });

  it("grants a noWait request refused by one worker from another in the next walk", async () => {
    const { coordinator, directory, workers } = harness();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_a", preferred);
    directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(workers, "wrk_b");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions({ noWait: true }));

    expect(grant.lease.worker?.id).toBe("wrk_b");
    expect(preferred.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });

  it.each([
    { code: "NO_CAPACITY", error: noCapacityError() },
    {
      code: "RUNTIME_MISSING",
      error: new SimlockError("RUNTIME_MISSING", "domain", "no such runtime", {
        downloadable: false,
        osVersion: "26.0",
        platform: "ios",
      }),
    },
  ])(
    "terminally rejects, rather than re-queuing or asking another worker, a $code that arrives after progress already fired (P1, round 2 review)",
    async ({ code, error }) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      const other = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      directory.add("wrk_b", other);
      connectWorker(workers, "wrk_a");
      connectWorker(workers, "wrk_b");
      client.requestLeaseQueue.push({
        error,
        kind: "error",
        progress: [{ etaMs: 5_000, stage: "reclaiming" }],
      });
      other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const dispatched: unknown[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      const rejection = await coordinator
        .request(REQUEST, requestOptions())
        .catch((caught: unknown) => caught);

      expect(dispatched).toHaveLength(1);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect((rejection as DispatchError).code).toBe(code);
      expect(coordinator.queueDepth).toBe(0);
      expect(directory.refreshCalls).toEqual([]);
      expect(other.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
    },
  );

  it("bounds a forwarded lease.request against gateway.leaseRequestTimeoutMs when the worker never answers at all (P2, round 2 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ leaseRequestTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ kind: "hang" });

    const request = coordinator.request(REQUEST, requestOptions());
    const requestState = promiseState(request);
    const rejection = request.catch((error: unknown) => error);
    await tick();
    expect(coordinator.queueDepth).toBe(0);
    expect(directory.refreshCalls).toEqual([]);

    clock.advance(4_999);
    await tick();
    expect(requestState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(requestState.state).toBe("rejected");
    const error = await rejection;

    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(coordinator.queueDepth).toBe(0);
  });

  it("does not emit request.dispatched for a progress push that arrives after gateway.leaseRequestTimeoutMs already rejected the waiter (P4, round 3 review)", async () => {
    const { clock, coordinator, directory, eventBus, workers } = harness({
      leaseRequestTimeoutMs: 5_000,
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ kind: "hang" });
    const events: string[] = [];
    eventBus.subscribe("request.dispatched", () => events.push("request.dispatched"));
    eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));

    const request = coordinator.request(REQUEST, requestOptions());
    const requestState = promiseState(request);
    const rejection = request.catch((error: unknown) => error);
    await tick();

    clock.advance(5_000);
    await tick();
    expect(requestState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(events).toEqual(["lease.rejected"]);

    client.lastRequestLeaseOptions?.onProgress?.({ etaMs: 5_000, stage: "provisioning" });
    await tick();

    expect(events).toEqual(["lease.rejected"]);
  });

  it("passes over a request only a busy worker can serve instead of blocking behind it, and never lets a brand-new admission jump an older, equally-eligible waiter still queued behind it (C2, round 3 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_ios", client);
    directory.add("wrk_android", new ScriptedWorkerClient());
    client.requestLeaseQueue.push({ kind: "hang" });

    const capacity = statusFixture().capacity;
    connectWorker(workers, "wrk_ios", { capacity: saturatedIos() });
    connectWorker(workers, "wrk_android", {
      capacity: { ...capacity, android: { ...capacity.android, maxRunning: 0 } },
      models: ["Pixel 9"],
      platform: "android",
    });
    const androidPromise = coordinator.request(
      { model: "Pixel 9", platform: "android" },
      requestOptions({ ownerId: "agent-android", requesterId: "agent-android" }),
    );
    const oldFirstPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-old-1", requesterId: "agent-old-1" }),
    );
    const oldSecondPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-old-2", requesterId: "agent-old-2" }),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(3);

    workers.refresh("wrk_ios", { capacity: statusFixture().capacity });
    await tick();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    let androidSettled = false;
    void androidPromise.then(
      () => {
        androidSettled = true;
      },
      () => {
        androidSettled = true;
      },
    );
    await tick();
    expect(androidSettled).toBe(false);

    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const newPromise = coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-new", requesterId: "agent-new" }),
    );
    await tick();

    const leaseRequests = client.calls.filter((call) => call.startsWith("lease.request"));
    expect(leaseRequests.length).toBeGreaterThanOrEqual(2);
    expect(leaseRequests[1]).toContain("agent-old-2");

    const oldSecondGrant = await oldSecondPromise;
    expect(oldSecondGrant.lease.worker?.id).toBe("wrk_ios");
    expect(androidSettled).toBe(false);
    void oldFirstPromise;
    void newPromise;
  });

  it("indexes a fresh grant under the ownerId it forwarded, not the worker's own echo of it (H6)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          ownerId: "worker-rewrote-this",
        },
      }),
      kind: "grant",
    });

    const grant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-1", requesterId: "agent-1" }),
    );

    expect(coordinator.ownerId(grant.lease.id)).toBe("agent-1");
    expect(grant.lease.ownerId).toBe("agent-1");
  });

  it("emits request.dispatched on the worker's first progress push even when the request never settles at all (§11, C4 round 2 review)", async () => {
    const { coordinator, eventBus, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      kind: "hang",
      progress: [{ etaMs: 5_000, stage: "provisioning" }],
    });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    let settled = false;
    void coordinator.request(REQUEST, requestOptions()).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();

    expect(settled).toBe(false);
    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
  });

  it("emits request.dispatched exactly once, on the worker's first progress push, not again when the grant lands afterward (§11)", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture(),
      kind: "grant",
      progress: [
        { etaMs: 5_000, stage: "provisioning" },
        { etaMs: 1_000, stage: "booting" },
      ],
    });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const grant = await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
    expect(grant.lease.worker?.id).toBe("wrk_a");
  });

  it.each(["full", "slim"] as const)(
    "request.dispatched carries the requested mode %s",
    async (mode) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({
        grant: grantFixture(),
        kind: "grant",
        progress: [{ etaMs: 5_000, stage: "provisioning" }],
      });
      const dispatched: unknown[] = [];
      eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

      await coordinator.request({ ...REQUEST, mode }, requestOptions());

      expect(dispatched).toEqual([expect.objectContaining({ mode })]);
    },
  );

  it("request.dispatched carries no mode and no physical key for a plain virtual request", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: object[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty("mode");
    expect(dispatched[0]).not.toHaveProperty("physical");
  });

  it("relays a worker's downloading pushes to the requester unchanged", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    const pushed = [
      { component: "26.4", stage: "downloading", waiting: true },
      { component: "26.4", stage: "downloading", waiting: false },
      { component: "26.4", percent: 41, stage: "downloading", waiting: false },
      { etaMs: 5_000, stage: "provisioning" },
    ] as const;
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant", progress: pushed });
    const heard: unknown[] = [];

    await coordinator.request(
      REQUEST,
      requestOptions({ allowDownload: true, onProgress: (progress) => heard.push(progress) }),
    );

    expect(heard).toEqual(pushed);
  });

  it("emits request.dispatched when a grant lands with no progress push at all -- the ADR §11 rule's other half", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: expect.any(Number) as number,
        reason: "free-capacity",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "free-capacity",
        workerId: "wrk_a",
      },
    ]);
  });

  it("reports request.dispatched's reason as warm-hit when routing picked the worker for an unleased ready device, and queuedMs as the real wait (C2, round 2 review)", async () => {
    const { clock, coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    const noFree = { ...statusFixture().capacity.ios, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", { capacity: { ...statusFixture().capacity, ios: noFree } });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    clock.advance(2_500);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    workers.refresh("wrk_a", {
      capacity: { ...statusFixture().capacity, ios: { ...noFree, maxRunning: 5 } },
      devices: [deviceFixture("dev_1", "ready")],
    });

    await grantPromise;

    expect(dispatched).toEqual([
      {
        model: "iPhone 17",
        platform: "ios",
        queuedMs: 2_500,
        reason: "warm-hit",
        requestId: expect.any(String) as string,
        requesterId: "agent-1",
        stage: "warm-hit",
        workerId: "wrk_a",
      },
    ]);
  });

  it("request.dispatched carries the routing decision's stage name and reason", async () => {
    const { coordinator, directory, eventBus, workers } = harness({
      routing: () => ({
        assess: () => ({ kind: "route-or-wait" }),
        explain: () => [],
        select: (_request, views) =>
          views[0] === undefined
            ? undefined
            : { reason: "warm-hit", stage: "test-rank", workerId: views[0].id },
      }),
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await coordinator.request(REQUEST, requestOptions());

    expect(dispatched).toEqual([
      expect.objectContaining({ reason: "warm-hit", stage: "test-rank", workerId: "wrk_a" }),
    ]);
  });

  it("does not emit request.dispatched for a stale-view NO_CAPACITY -- the request stayed queued, never actually dispatched", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    void coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(dispatched).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("handles a worker's DAEMON_UPDATING answer as NO_CAPACITY: the view is read again, the request stays queued and is placed once the view changes", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: new SimlockError("DAEMON_UPDATING", "domain", "The daemon is updating", {}),
      kind: "error",
    });
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const outcome = coordinator.request(REQUEST, requestOptions());
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);
    expect(directory.refreshCalls).toEqual(["wrk_a"]);

    workers.refresh("wrk_a", {
      update: { forced: false, from: "0.3.0", stage: "installing", startedAt: 1, to: "0.4.0" },
    });
    await tick();
    expect(state.state).toBe("pending");

    workers.refresh("wrk_a", { update: null });
    await tick();

    expect((await outcome).lease.worker?.id).toBe("wrk_a");
  });

  it("forwards device.exec with the namespaced requesterId reaching the scripted worker client", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });

    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ exitCode: 0, kind: "ok" });

    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );

    expect(client.calls).toContain(`device.exec:${GATEWAY_PREFIX}agent-1`);
  });

  it("announces started from the worker's own push, before any output (ADR §19a)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({
      exitCode: 0,
      kind: "ok",
      output: [{ chunk: "hi", stream: "stdout" }],
      started: true,
    });

    const order: string[] = [];
    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onOutput: () => {
          order.push("output");
        },
        onStarted: () => {
          order.push("started");
        },
        principal: "agent-1",
        role: "agent",
      },
    );

    expect(order).toEqual(["started", "output"]);
    expect(client.calls).toContain(`device.exec:${GATEWAY_PREFIX}agent-1`);
  });

  it.each([
    ["an empty queue", 0],
    ["another request queued", 1],
  ] as const)(
    "rejects a noWait request refused by its only worker with NO_CAPACITY and lease.rejected no-wait, refreshes that worker's view, and never queues it (no lease.queued, no queued progress), with %s -- the answer does not depend on queue depth (ADR §10, architecture rule 10)",
    async (_queue, queued) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      if (queued > 0) {
        client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        await coordinator.request(REQUEST, requestOptions());
        void coordinator.request(
          REQUEST,
          requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
        );
        await tick();
      }
      expect(coordinator.queueDepth).toBe(queued);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
      const events: string[] = [];
      eventBus.subscribe("lease.queued", () => events.push("lease.queued"));
      eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));
      const progress: string[] = [];
      const refreshesBefore = directory.refreshCalls.length;

      const refused = coordinator.request(
        REQUEST,
        requestOptions({
          noWait: true,
          onProgress: (update) => progress.push(update.stage),
          ownerId: "agent-3",
          requesterId: "agent-3",
        }),
      );
      const refusedState = promiseState(refused);
      await tick();

      expect(refusedState.state).toBe("rejected");
      await expect(refused).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(client.calls).toContain(`lease.request:${GATEWAY_PREFIX}agent-3`);
      expect(rejected).toEqual([expect.objectContaining({ reason: "no-wait" })]);
      expect(events).toEqual(["lease.rejected"]);
      expect(progress).toEqual([]);
      expect(directory.refreshCalls.slice(refreshesBefore)).toEqual(["wrk_a"]);
      expect(coordinator.queueDepth).toBe(queued);
    },
  );

  it("relays the worker's own started push for a silent command that never answers (ADR §19a/§19b/§19e)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang", started: true });

    let started = false;
    void coordinator.exec(
      { args: ["install", "/path/to.app"], leaseId: grant.lease.id, tool: "simctl" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          started = true;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    await tick();

    expect(started).toBe(true);
  });

  it("does not announce started for a command the worker refuses before any process exists -- a pre-process refusal keeps its own real status (ADR §19a′)", async () => {
    const { clock, coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({
      error: new SimlockError("FORBIDDEN", "domain", "Lease belongs to a different requester", {}),
      kind: "error",
    });

    let started = false;
    const rejection = await coordinator
      .exec(
        { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          onStarted: () => {
            started = true;
          },
          principal: "agent-1",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("FORBIDDEN");
    expect(started).toBe(false);

    clock.advance(10_000);
    expect(started).toBe(false);
  });

  it("times out a forwarded device.exec after gateway.execTimeoutMs when the worker never answers at all (P5)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(4_999);
    await tick();
    expect(executionState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");
  });

  it("stops relaying a worker's device.exec output once gateway.execTimeoutMs has already rejected the call (H4, round 3 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "lse_9",
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      }),
      kind: "grant",
    });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    const relayed: Array<{ stream: string; chunk: string }> = [];
    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onOutput: (stream, chunk) => {
          relayed.push({ chunk, stream });
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");

    client.lastExecOptions?.onOutput?.({ chunk: "late output", stream: "stdout" });
    await tick();

    expect(relayed).toEqual([]);
  });

  it("does not announce started from a worker frame that arrives after gateway.execTimeoutMs already rejected the call (H4, round 6 review)", async () => {
    const { clock, coordinator, directory, workers } = harness({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ kind: "hang" });

    let startedCount = 0;
    const execution = coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          startedCount += 1;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    const executionState = promiseState(execution);
    const rejection = execution.catch((error: unknown) => error);
    await tick();
    clock.advance(5_000);
    await tick();
    expect(executionState.state).toBe("rejected");
    const error = await rejection;
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");

    client.lastExecOptions?.onStarted?.();
    await tick();

    expect(startedCount).toBe(0);
  });

  it("announces started once even if the worker sends the frame more than once", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.execQueue.push({ exitCode: 0, kind: "ok", started: true });

    let startedCount = 0;
    await coordinator.exec(
      { args: ["devices"], leaseId: grant.lease.id, tool: "adb" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        onStarted: () => {
          startedCount += 1;
        },
        principal: "agent-1",
        role: "agent",
      },
    );
    client.lastExecOptions?.onStarted?.();
    await tick();

    expect(startedCount).toBe(1);
  });

  it("runs another pass for a view change raised from inside the walk, rather than dropping it (round 4 finding 6, round 6 review)", async () => {
    let selectCalls = 0;
    const { coordinator, directory, workers } = harness({
      routing: (registry) => {
        const real = createRoutingPolicy("warm-then-free");
        return {
          assess: real.assess,
          explain: real.explain,
          select(request, workerViews) {
            selectCalls += 1;
            if (selectCalls === 2) {
              registry.refresh("wrk_a", {});
              return undefined;
            }
            return real.select(request, workerViews);
          },
        };
      },
    });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    const grantPromise = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_a", { capacity: statusFixture().capacity });
    await tick();

    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(selectCalls).toBe(3);
    const grant = await grantPromise;
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(coordinator.queueDepth).toBe(0);
  });

  it.each([
    {
      code: "WORKER_UNREACHABLE",
      details: { workerId: "wrk_a" },
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      row: "a lost connection",
    },
    {
      code: "WORKER_UNREACHABLE",
      details: { workerId: "wrk_a" },
      error: new SimlockError("DAEMON_STOPPING", "transport", "The daemon is stopping", {}),
      row: "a stopping daemon (#514)",
    },
    {
      code: "INTERNAL",
      details: undefined,
      error: new TypeError("boom"),
      row: "a non-SimlockError (H1, round 2 review)",
    },
  ])(
    "maps $row on a forwarded lease.request to $code, never the uplink client's own error code verbatim (P4)",
    async ({ code, details, error }) => {
      const { coordinator, directory, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({ error, kind: "error" });

      const rejection = await coordinator
        .request(REQUEST, requestOptions())
        .catch((caught: unknown) => caught);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect(rejection).toMatchObject({ code, ...(details === undefined ? {} : { details }) });
    },
  );

  it.each([
    {
      code: "WORKER_UNREACHABLE",
      error: new SimlockError(
        "DAEMON_CONNECTION_LOST",
        "transport",
        "Daemon connection is closed",
        {},
      ),
      row: "a transport failure",
    },
    {
      code: "INTERNAL",
      error: new TypeError("boom"),
      row: "a non-SimlockError (H1, round 2 review)",
    },
  ])(
    "maps $row on a forwarded lease.renew to $code, never the other (P4)",
    async ({ code, error }) => {
      const { coordinator, directory, workers, leaseIndex } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      leaseIndex.add({
        gatewayLeaseId: "wrk_a.lse_1",
        grantedAt: 1,
        ownerId: "agent-1",
        requesterId: "agent-1",
        workerId: "wrk_a",
        workerLeaseId: "lse_1",
      });
      client.renewLeaseQueue.push({ error, kind: "error" });

      const rejection = await coordinator
        .renew("wrk_a.lse_1", undefined)
        .catch((caught: unknown) => caught);
      expect(rejection).toBeInstanceOf(DispatchError);
      expect((rejection as DispatchError).code).toBe(code);
    },
  );

  it.each([
    {
      answer: (client: ScriptedWorkerClient, error: SimlockError<"UNKNOWN_LEASE">) =>
        client.releaseLeaseQueue.push({ error, kind: "error" }),
      call: (coordinator: FleetLeaseCoordinator) => coordinator.release("wrk_a.lse_1"),
      verb: "release",
    },
    {
      answer: (client: ScriptedWorkerClient, error: SimlockError<"UNKNOWN_LEASE">) =>
        client.renewLeaseQueue.push({ error, kind: "error" }),
      call: (coordinator: FleetLeaseCoordinator) => coordinator.renew("wrk_a.lse_1", undefined),
      verb: "renew",
    },
  ])(
    "drops its own index entry when the worker answers UNKNOWN_LEASE to a $verb, instead of leaving a zombie behind (C3)",
    async ({ answer, call }) => {
      const { coordinator, directory, workers, leaseIndex } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      leaseIndex.add({
        gatewayLeaseId: "wrk_a.lse_1",
        grantedAt: 1,
        ownerId: "agent-1",
        requesterId: "agent-1",
        workerId: "wrk_a",
        workerLeaseId: "lse_1",
      });
      answer(
        client,
        new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_1", { leaseId: "lse_1" }),
      );

      await expect(call(coordinator)).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });

      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      await expect(coordinator.request(REQUEST, requestOptions())).resolves.toBeDefined();
    },
  );

  it("release-all treats a worker's UNKNOWN_LEASE as already-released rather than a failure that blocks every future call (C3)", async () => {
    const { coordinator, directory, workers, leaseIndex } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lse_zombie",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lse_zombie",
    });
    client.releaseLeaseQueue.push({
      error: new SimlockError("UNKNOWN_LEASE", "domain", "Unknown lease: lse_zombie", {
        leaseId: "lse_zombie",
      }),
      kind: "error",
    });

    await expect(coordinator.releaseAll()).resolves.toEqual(["wrk_a.lse_zombie"]);
    await expect(coordinator.releaseAll()).resolves.toEqual([]);
  });

  it("does not evict a lease on one worker when only a different worker's view changes repeatedly (C1, round 2 review)", async () => {
    const { coordinator, directory, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    clientA.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions());
    expect(grant.lease.worker?.id).toBe("wrk_a");
    expect(workers.view("wrk_a")?.leases).toEqual([]);

    workers.refresh("wrk_b", {});
    workers.refresh("wrk_b", {});

    const retry = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((retry as RequesterAlreadyLeasedError).existingLeaseId).toBe(grant.lease.id);
  });

  it("grants a requester's next lease when a worker view read before its release lands after it (#898)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const first = await coordinator.request(REQUEST, requestOptions());
    client.releaseLeaseQueue.push({ kind: "ok" });
    await coordinator.release(first.lease.id);

    workers.refresh("wrk_a", {
      leases: [{ ...leaseFixture("lse_1", "dev_1"), requesterId: `${GATEWAY_PREFIX}agent-1` }],
    });
    workers.refresh("wrk_a", { leases: [] });

    client.requestLeaseQueue.push({
      grant: grantFixture({ lease: leaseFixture("lse_2", "dev_1") as LeaseRecord }),
      kind: "grant",
    });
    const second = await coordinator
      .request(REQUEST, requestOptions({ noWait: true }))
      .catch((error: unknown) => error);
    expect(second).toMatchObject({ lease: { id: "wrk_a.lse_2" } });
  });

  it.each(["release", "releaseAll"] as const)(
    "grants the next lease when %s's relayed event came before the worker's answer and a stale view follows (#898)",
    async (how) => {
      const { coordinator, directory, workers, leaseIndex } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      connectWorker(workers, "wrk_a");
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      const first = await coordinator.request(REQUEST, requestOptions());
      client.onReleaseLease = (leaseId) => leaseIndex.removeByWorkerLease("wrk_a", leaseId);
      if (how === "release") await coordinator.release(first.lease.id);
      else await coordinator.releaseAll();

      workers.refresh("wrk_a", {
        leases: [{ ...leaseFixture("lse_1", "dev_1"), requesterId: `${GATEWAY_PREFIX}agent-1` }],
      });
      workers.refresh("wrk_a", { leases: [] });

      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: leaseFixture("lse_2", "dev_1") as LeaseRecord }),
        kind: "grant",
      });
      const second = await coordinator
        .request(REQUEST, requestOptions({ noWait: true }))
        .catch((error: unknown) => error);
      expect(second).toMatchObject({ lease: { id: "wrk_a.lse_2" } });
    },
  );

  it("release-all attaches the leases it already released to a later failure's own details (H8)", async () => {
    const { coordinator, directory, workers, leaseIndex } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lse_1",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lse_1",
    });
    leaseIndex.add({
      gatewayLeaseId: "wrk_b.lse_1",
      grantedAt: 1,
      ownerId: "agent-2",
      requesterId: "agent-2",
      workerId: "wrk_b",
      workerLeaseId: "lse_1",
    });
    clientA.releaseLeaseQueue.push({ kind: "ok" });
    directory.unreachable.add("wrk_b");

    const rejection = await coordinator.releaseAll().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect((rejection as DispatchError).details).toMatchObject({
      releasedLeaseIds: ["wrk_a.lse_1"],
    });
    await expect(coordinator.renew("wrk_a.lse_1", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(clientA.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
    await expect(coordinator.renew("wrk_b.lse_1", undefined)).rejects.toMatchObject({
      code: "WORKER_UNREACHABLE",
    });
  });
});

describe("drain and unreachable lifecycle (ADR §9/§28/§29, #119)", () => {
  async function excludedWorkerKeepsLeaseButGetsNoNewDispatch(
    exclude: (workers: WorkerRegistry) => unknown,
  ): Promise<void> {
    const { coordinator, directory, leaseIndex, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    const saturated = { ...statusFixture().capacity.ios, maxRunning: 0, running: 0 };
    connectWorker(workers, "wrk_a", { capacity: { ...statusFixture().capacity, ios: saturated } });
    connectWorker(workers, "wrk_b");
    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const firstGrant = await coordinator.request(REQUEST, requestOptions());
    expect(firstGrant.lease.worker?.id).toBe("wrk_b");
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    await exclude(workers);
    expect(leaseIndex.resolve(firstGrant.lease.id)).toBeDefined();

    workers.refresh("wrk_a", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 1 },
      },
    });
    clientA.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    clientB.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const secondGrant = await coordinator.request(
      REQUEST,
      requestOptions({ ownerId: "agent-2", requesterId: "agent-2" }),
    );

    expect(secondGrant.lease.worker?.id).toBe("wrk_a");
    expect(clientA.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    expect(clientB.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  }

  it("keeps a drained worker's existing lease and sends it no new dispatch, while an undrained sibling serves the next request (§9)", async () => {
    await excludedWorkerKeepsLeaseButGetsNoNewDispatch((workers) =>
      workers.setDrained("wrk_b", true),
    );
  });

  it("keeps a disconnected worker's existing lease and sends it no new dispatch, while a connected sibling serves the next request (§6/§28)", async () => {
    await excludedWorkerKeepsLeaseButGetsNoNewDispatch((workers) => workers.disconnected("wrk_b"));
  });

  it("answers WORKER_UNREACHABLE for a forwarded device.exec on a worker the directory reports unreachable, never a success (§28)", async () => {
    const { coordinator, directory, workers, leaseIndex } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    leaseIndex.add({
      gatewayLeaseId: "wrk_a.lse_1",
      grantedAt: 1,
      ownerId: "agent-1",
      requesterId: "agent-1",
      workerId: "wrk_a",
      workerLeaseId: "lse_1",
    });
    directory.unreachable.add("wrk_a");

    const rejection = await coordinator
      .exec(
        { args: ["devices"], leaseId: "wrk_a.lse_1", tool: "adb" },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "agent-1",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(client.calls.filter((call) => call.startsWith("device.exec"))).toEqual([]);
  });

  it("a request dispatched to a worker whose uplink then drops: the client sees WORKER_UNREACHABLE, and the lease is not silently double-granted once the worker's view catches up (§29)", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({
      error: new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Connection lost", {}),
      kind: "error",
    });

    const rejection = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DispatchError);
    expect((rejection as DispatchError).code).toBe("WORKER_UNREACHABLE");
    expect(coordinator.queueDepth).toBe(0);

    workers.refresh("wrk_a", {
      leases: [
        {
          ...leaseFixture("lse_ghost", "dev_ghost"),
          ownerId: "agent-1",
          requesterId: `${GATEWAY_PREFIX}agent-1`,
        },
      ],
    });

    const rebuiltLeaseId = "wrk_a.lse_ghost";

    const retry = await coordinator
      .request(REQUEST, requestOptions())
      .catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((retry as RequesterAlreadyLeasedError).existingLeaseId).toBe(rebuiltLeaseId);
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
  });
});

describe("FleetLeaseCoordinator sends a worker only requests its catalog can serve (ADR 0009 §3)", () => {
  function connectWithCatalog(
    workers: WorkerRegistry,
    workerId: string,
    entry: Parameters<typeof catalogFixture>[0][number],
    downloads: "never" | "on-request" | "always" = "on-request",
  ): void {
    workers.connected(workerId, undefined, "0.3.0");
    workers.refresh(workerId, {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([entry]).platforms,
      devices: [],
      downloads: { policy: downloads },
      health: "running",
      leases: [],
      queueDepth: 0,
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  it("dispatches a request in another letter case with the worker's own name for the model", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      models: ["iPhone 16 Pro"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(
      { model: "iphone 16 pro", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(client.lastRequestLeaseInput?.model).toBe("iPhone 16 Pro");
    const requested = eventBus.replay().find((event) => event.event === "lease.requested");
    expect(requested?.payload).toMatchObject({ requestSpec: { model: "iphone 16 pro" } });
  });

  it("dispatches a request by an alias to the worker that lists it", async () => {
    const { coordinator, directory, workers } = harness();
    const other = new ScriptedWorkerClient();
    const lister = new ScriptedWorkerClient();
    directory.add("wrk_a", other);
    directory.add("wrk_b", lister);
    lister.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      models: ["Pixel 7"],
      platform: "android",
      runtimes: ["35"],
    });
    connectWithCatalog(workers, "wrk_b", {
      modelAliases: { "Pixel 7": ["pixel_7"] },
      models: ["Pixel 7"],
      platform: "android",
      runtimes: ["35"],
    });

    await coordinator.request(
      { model: "pixel_7", platform: "android" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(other)).toEqual([]);
    expect(lister.lastRequestLeaseInput?.model).toBe("Pixel 7");
  });

  it("passes over a worker with the model and the runtime unpaired for one that pairs them", async () => {
    const { coordinator, directory, workers } = harness();
    const unpaired = new ScriptedWorkerClient();
    const paired = new ScriptedWorkerClient();
    directory.add("wrk_a", unpaired);
    directory.add("wrk_b", paired);
    paired.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      modelRuntimes: { "iPhone 15": ["26.0"], "iPhone 17": ["18.0"] },
      models: ["iPhone 17", "iPhone 15"],
      platform: "ios",
      runtimes: ["18.0", "26.0"],
    });
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(REQUEST, requestOptions({ noWait: true }));

    expect(leaseRequests(unpaired)).toEqual([]);
    expect(leaseRequests(paired)).toHaveLength(1);
  });

  it("with no runtime named, needs a model with at least one paired runtime", async () => {
    const { coordinator, directory, workers } = harness();
    const unpaired = new ScriptedWorkerClient();
    const paired = new ScriptedWorkerClient();
    directory.add("wrk_a", unpaired);
    directory.add("wrk_b", paired);
    paired.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      modelRuntimes: { "iPhone 17": [] },
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(
      { model: "iPhone 17", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(unpaired)).toEqual([]);
    expect(leaseRequests(paired)).toHaveLength(1);
  });

  it("sends a request naming an image tag to the worker whose catalog lists that tag for the API level, not to one listing the API level with another tag, and forwards the tag", async () => {
    const { coordinator, directory, workers } = harness();
    const otherTag = new ScriptedWorkerClient();
    const lister = new ScriptedWorkerClient();
    directory.add("wrk_a", otherTag);
    directory.add("wrk_b", lister);
    lister.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(workers, "wrk_a", {
      images: [
        { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis_playstore" },
      ],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34", "35"],
    });
    connectWithCatalog(workers, "wrk_b", {
      images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" }],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34"],
    });

    await coordinator.request(
      {
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(otherTag)).toEqual([]);
    expect(lister.lastRequestLeaseInput).toMatchObject({
      imageTag: "google_apis_playstore",
      osVersion: "34",
    });
  });

  it("rejects a request naming an image tag no worker lists with RUNTIME_MISSING at once, sending it to no worker", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWithCatalog(workers, "wrk_a", {
      images: [{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }],
      models: ["Pixel 8"],
      platform: "android",
      runtimes: ["34"],
    });

    const outcome = coordinator.request(
      { imageTag: "google_apis_playstore", model: "Pixel 8", platform: "android" },
      requestOptions(),
    );
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "RUNTIME_MISSING" });
    expect(leaseRequests(client)).toEqual([]);
  });

  it("does not make a worker eligible for allowDownload: true, and forwards allowDownload: false", async () => {
    const { coordinator, directory, workers } = harness();
    const downloader = new ScriptedWorkerClient();
    const installed = new ScriptedWorkerClient();
    directory.add("wrk_a", downloader);
    directory.add("wrk_b", installed);
    installed.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWithCatalog(
      workers,
      "wrk_a",
      { models: ["iPhone 17"], platform: "ios", runtimes: ["18.0"] },
      "always",
    );
    connectWithCatalog(workers, "wrk_b", {
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    });

    await coordinator.request(REQUEST, requestOptions({ allowDownload: true, noWait: true }));

    expect(leaseRequests(downloader)).toEqual([]);
    expect(installed.lastRequestLeaseInput?.allowDownload).toBe(false);
  });
});

describe("FleetLeaseCoordinator fails a request no worker can serve at once (ADR 0009 §4)", () => {
  const capacity = statusFixture().capacity;

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function lease(
    harnessed: ReturnType<typeof harness>,
    request: Parameters<FleetLeaseCoordinator["request"]>[0],
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = harnessed.coordinator.request(request, requestOptions(options));
    return { outcome, state: promiseState(outcome) };
  }

  const ROWS = [
    {
      code: "NO_CAPACITY",
      details: undefined,
      reason: "no-worker",
      request: REQUEST,
      row: "row 1: no worker takes requests",
      setup: async (_workers: WorkerRegistry) => {},
    },
    {
      code: "NO_DRIVER",
      details: { platform: "android" },
      reason: "unresolvable-spec",
      request: { model: "Pixel 8", platform: "android" as const },
      row: "row 2: no known worker has the platform",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "UNKNOWN_MODEL",
      details: { model: "iPhone 99", platform: "ios" },
      reason: "unresolvable-spec",
      request: { ...REQUEST, model: "iPhone 99" },
      row: "row 3: no known worker lists the model",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "99.0", platform: "ios" },
      reason: "unresolvable-spec",
      request: { ...REQUEST, osVersion: "99.0" },
      row: "row 4: no known worker has the runtime",
      setup: async (workers: WorkerRegistry) => connectWorker(workers, "wrk_a"),
    },
    {
      code: "NO_CAPACITY",
      details: undefined,
      reason: "no-worker",
      request: REQUEST,
      row: "row 5: a known worker can serve it and none that takes requests can",
      setup: async (workers: WorkerRegistry) => {
        connectWorker(workers, "wrk_a", { models: ["iPhone 16"] });
        connectWorker(workers, "wrk_b");
        await workers.setDrained("wrk_b", true);
      },
    },
  ] as const;
  const WAITS = [
    { options: {}, wait: "waiting" },
    { options: { noWait: true }, wait: "with --no-wait" },
    { options: { timeoutMs: 60_000 }, wait: "with a timeout" },
    { options: { noWait: true, timeoutMs: 60_000 }, wait: "with --no-wait and a timeout" },
  ] as const;

  it.each(ROWS.flatMap((row) => WAITS.map(({ options, wait }) => ({ ...row, options, wait }))))(
    "$row: answers $code at once and sends it to no worker, $wait",
    async (row) => {
      const { options } = row;
      const fleetHarness = harness();
      const client = new ScriptedWorkerClient();
      fleetHarness.directory.add("wrk_a", client);
      fleetHarness.directory.add("wrk_b", client);
      await row.setup(fleetHarness.workers);
      const rejected: unknown[] = [];
      fleetHarness.eventBus.subscribe("lease.rejected", (envelope) =>
        rejected.push(envelope.payload),
      );

      const { outcome, state } = lease(fleetHarness, row.request, options);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({
        code: row.code,
        ...(row.details === undefined ? {} : { details: row.details }),
      });
      expect(rejected).toEqual([expect.objectContaining({ reason: row.reason })]);
      expect(leaseRequests(client)).toEqual([]);
      expect(fleetHarness.coordinator.queueDepth).toBe(0);
    },
  );

  describe("row 6: a worker that takes requests can serve it but is busy", () => {
    function busyFleet() {
      const fleetHarness = harness();
      const client = new ScriptedWorkerClient();
      fleetHarness.directory.add("wrk_a", client);
      connectWorker(fleetHarness.workers, "wrk_a", { capacity: saturatedIos() });
      return { client, fleetHarness };
    }

    it("queues it, sends it to no worker, waiting", async () => {
      const { client, fleetHarness } = busyFleet();

      const { state } = lease(fleetHarness, REQUEST);
      await tick();

      expect(state.state).toBe("pending");
      expect(fleetHarness.coordinator.queueDepth).toBe(1);
      expect(leaseRequests(client)).toEqual([]);
    });

    it.each([
      { options: { noWait: true }, wait: "--no-wait" },
      { options: { noWait: true, timeoutMs: 60_000 }, wait: "--no-wait and a timeout" },
    ])("answers NO_CAPACITY at once with $wait, and queues nothing", async ({ options }) => {
      const { client, fleetHarness } = busyFleet();

      const { outcome, state } = lease(fleetHarness, REQUEST, options);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(leaseRequests(client)).toEqual([]);
      expect(fleetHarness.coordinator.queueDepth).toBe(0);
    });

    it("queues it with a timeout, and ends it at the deadline rather than at once", async () => {
      const { client, fleetHarness } = busyFleet();

      const { outcome, state } = lease(fleetHarness, REQUEST, { timeoutMs: 60_000 });
      const ended = outcome.catch((error: unknown) => error);
      await tick();
      expect(state.state).toBe("pending");
      expect(fleetHarness.coordinator.queueDepth).toBe(1);

      fleetHarness.clock.advance(60_000);
      await tick();

      expect(state.state).toBe("rejected");
      expect(await ended).toBeInstanceOf(QueueTimeoutError);
      expect(leaseRequests(client)).toEqual([]);
    });
  });

  it("lets a rejected requester make a new request at once", async () => {
    const fleetHarness = harness();
    const { coordinator, directory, workers } = fleetHarness;
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    directory.add("wrk_b", client);
    connectWorker(workers, "wrk_a");
    const unknown = { ...REQUEST, model: "iPhone 99" };

    const first = lease(fleetHarness, unknown);
    await tick();
    expect(first.state.state).toBe("rejected");
    await expect(first.outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

    const second = lease(fleetHarness, unknown);
    await tick();
    expect(second.state.state).toBe("rejected");
    await expect(second.outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_b", { models: ["iPhone 99"] });
    const third = await coordinator.request(unknown, requestOptions());
    expect(third.lease.worker?.id).toBe("wrk_b");
  });

  it("emits no lease.queued and pushes no queued progress for a request it rejects on arrival", async () => {
    const { coordinator, eventBus, workers } = harness();
    connectWorker(workers, "wrk_a");
    const events: string[] = [];
    eventBus.subscribe("lease.queued", () => events.push("lease.queued"));
    eventBus.subscribe("lease.rejected", () => events.push("lease.rejected"));
    const progress: string[] = [];

    const outcome = coordinator.request(
      { ...REQUEST, model: "iPhone 99" },
      requestOptions({ onProgress: (update) => progress.push(update.stage) }),
    );
    const state = promiseState(outcome);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(events).toEqual(["lease.rejected"]);
    expect(progress).toEqual([]);
  });

  it.each([
    ["is drained", (workers: WorkerRegistry) => workers.setDrained("wrk_a", true)],
    ["disconnects", (workers: WorkerRegistry) => workers.disconnected("wrk_a")],
  ] as const)(
    "fails a waiting request with NO_CAPACITY when its only capable worker %s",
    async (_change, change) => {
      const fleetHarness = harness();
      const { coordinator, directory, eventBus, workers } = fleetHarness;
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      directory.add("wrk_b", client);
      connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
      connectWorker(workers, "wrk_b", { models: ["iPhone 16"] });
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      const { outcome, state } = lease(fleetHarness, REQUEST);
      await tick();
      expect(state.state).toBe("pending");
      expect(coordinator.queueDepth).toBe(1);

      await change(workers);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(rejected).toEqual([expect.objectContaining({ reason: "no-worker" })]);
      expect(coordinator.queueDepth).toBe(0);
      expect(leaseRequests(client)).toEqual([]);
    },
  );

  it("Gateway routes a lease while a worker is updating: it skips the worker with reason updating, the request waits, and the worker is picked once the update ends", async () => {
    const fleetHarness = harness();
    const { coordinator, directory, workers } = fleetHarness;
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    workers.refresh("wrk_a", {
      update: {
        forced: false,
        from: "0.3.0",
        stage: "installing",
        startedAt: 1,
        to: "0.4.0",
      },
    });

    const { outcome, state } = lease(fleetHarness, REQUEST);
    await tick();

    expect(state.state).toBe("pending");
    expect(coordinator.waitingRequests()[0]).toMatchObject({
      workers: [{ reason: "updating", workerId: "wrk_a" }],
    });
    expect(leaseRequests(client)).toEqual([]);

    workers.refresh("wrk_a", { update: null });
    await tick();

    expect((await outcome).lease.worker?.id).toBe("wrk_a");
  });

  it.each([
    {
      change: (workers: WorkerRegistry) => workers.disconnected("wrk_a"),
      row: "disconnected",
    },
    {
      change: (workers: WorkerRegistry) => workers.connected("wrk_a", undefined, "0.3.0"),
      row: "reconnecting, its new catalog not yet arrived",
    },
  ])(
    "answers NO_CAPACITY, not UNKNOWN_MODEL, for a request only a worker that is $row lists while another worker takes requests",
    async ({ change }) => {
      const fleetHarness = harness();
      const { workers } = fleetHarness;
      connectWorker(workers, "wrk_a");
      connectWorker(workers, "wrk_b", { models: ["iPhone 16"] });
      change(workers);

      const { outcome, state } = lease(fleetHarness, REQUEST);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
    },
  );

  it.each([
    {
      read: (workers: WorkerRegistry) =>
        workers.refresh("wrk_a", { capacity, devices: [], health: "running", leases: [] }),
      row: "connected for the first time",
    },
    {
      read: (workers: WorkerRegistry) =>
        workers.refresh("wrk_a", { health: "starting", host: hostFixture() }),
      row: "answered starting",
    },
  ])(
    "answers NO_CAPACITY at once, not UNKNOWN_MODEL, and sends it to no worker, while the only worker has $row and its catalog has not arrived",
    async ({ read }) => {
      const fleetHarness = harness();
      const { directory, workers } = fleetHarness;
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      workers.connected("wrk_a", undefined, "0.3.0");
      read(workers);

      const { outcome, state } = lease(fleetHarness, REQUEST);
      await tick();

      expect(state.state).toBe("rejected");
      await expect(outcome).rejects.toMatchObject({ code: "NO_CAPACITY" });
      expect(leaseRequests(client)).toEqual([]);
    },
  );

  it("names osVersion default in RUNTIME_MISSING when the request named no runtime", async () => {
    const fleetHarness = harness();
    const { workers } = fleetHarness;
    workers.connected("wrk_a", undefined, "0.3.0");
    workers.refresh("wrk_a", {
      capacity,
      catalog: catalogFixture([
        {
          modelRuntimes: { "iPhone 17": [] },
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ]).platforms,
      devices: [],
      health: "running",
      leases: [],
    });
    const { osVersion: _named, ...unnamed } = REQUEST;

    const { outcome, state } = lease(fleetHarness, unnamed);
    await tick();

    expect(state.state).toBe("rejected");
    await expect(outcome).rejects.toMatchObject({
      code: "RUNTIME_MISSING",
      details: { downloadable: false, osVersion: "default", platform: "ios" },
    });
  });
});

describe("FleetLeaseCoordinator waits for a worker that is busy, not unable (ADR 0009 §2)", () => {
  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  it.each([
    ["is not healthy", { health: "failed" as const }, { health: "running" as const }],
    [
      "is still starting",
      { health: "starting" as const },
      {
        capacity: statusFixture().capacity,
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        devices: [],
        health: "running" as const,
        leases: [],
        queueDepth: 0,
      },
    ],
    ["has its own waiters queued", { queueDepth: 2 }, { queueDepth: 0 }],
    [
      "is at its running limit",
      { capacity: saturatedIos() },
      { capacity: statusFixture().capacity },
    ],
  ])(
    "queues a request, and does not fail it, when the only capable worker %s, and sends it once the worker is ready",
    async (_label, busy, ready) => {
      const { coordinator, directory, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      connectWorker(workers, "wrk_a");
      workers.refresh("wrk_a", busy);

      const granted = coordinator.request(REQUEST, requestOptions());
      await tick();

      expect(coordinator.queueDepth).toBe(1);
      expect(leaseRequests(client)).toHaveLength(0);

      workers.refresh("wrk_a", ready);
      await expect(granted).resolves.toMatchObject({ lease: { worker: { id: "wrk_a" } } });
      expect(leaseRequests(client)).toHaveLength(1);
      expect(coordinator.queueDepth).toBe(0);
    },
  );
});

describe("FleetLeaseCoordinator retries a worker's cannot-serve refusal on another worker (ADR 0009 §5)", () => {
  function runtimeMissing(): SimlockError<"RUNTIME_MISSING"> {
    return new SimlockError("RUNTIME_MISSING", "domain", "worker a has no such runtime", {
      downloadable: false,
      osVersion: "26.0",
      platform: "ios",
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function twoWorkers(options: { readonly busyB?: boolean } = {}) {
    const fleetHarness = harness();
    const a = new ScriptedWorkerClient();
    const b = new ScriptedWorkerClient();
    fleetHarness.directory.add("wrk_a", a);
    fleetHarness.directory.add("wrk_b", b);
    connectWorker(fleetHarness.workers, "wrk_a");
    connectWorker(
      fleetHarness.workers,
      "wrk_b",
      options.busyB === true ? { capacity: saturatedIos() } : {},
    );
    return { a, b, ...fleetHarness };
  }

  async function start(
    coordinator: FleetLeaseCoordinator,
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = coordinator.request(REQUEST, requestOptions(options));
    const ended = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, state };
  }

  it.each([
    { code: "RUNTIME_MISSING", error: runtimeMissing() },
    {
      code: "UNKNOWN_MODEL",
      error: new SimlockError("UNKNOWN_MODEL", "domain", "no", { platform: "ios" }),
    },
    {
      code: "NO_DRIVER",
      error: new SimlockError("NO_DRIVER", "domain", "no", { platform: "ios" }),
    },
  ])("grants from another worker after one answers $code", async ({ error }) => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({ error, kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect(leaseRequests(a)).toHaveLength(1);
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it("does not ask the refusing worker again for that request", async () => {
    const { a, b, coordinator, workers } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);
    expect(state.state).toBe("pending");
    expect(leaseRequests(a)).toHaveLength(1);
    workers.refresh("wrk_a", { capacity: roomierIos() });
    workers.refresh("wrk_b", { queueDepth: 1 });
    workers.refresh("wrk_b", { capacity: roomierIos(), queueDepth: 0 });
    await tick();

    expect(leaseRequests(a)).toHaveLength(1);
    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it("gives the client the worker's own code and message when no worker is left", async () => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({
      error: new SimlockError("UNKNOWN_MODEL", "domain", "worker b does not know it", {
        model: "iPhone 17",
        platform: "ios",
      }),
      kind: "error",
    });

    const { ended, state } = await start(coordinator);

    expect(state.state).toBe("rejected");
    const rejection = await ended;
    expect(rejection).toBeInstanceOf(DispatchError);
    expect(rejection).toMatchObject({
      code: "UNKNOWN_MODEL",
      message: "worker b does not know it",
    });
    expect(leaseRequests(a)).toHaveLength(1);
    expect(leaseRequests(b)).toHaveLength(1);
  });

  it.each([
    { freed: false, row: "while the next worker stays busy" },
    { freed: true, row: "though the next worker frees during the refused attempt" },
  ])(
    "does not reset the queue deadline when it retries to a queue position, nor send the request to another worker after it passed, $row",
    async ({ freed }) => {
      const { a, b, clock, coordinator, workers } = twoWorkers({ busyB: true });
      a.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
      a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
      b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      let calls = 0;
      const answer = a.requestLease.bind(a);
      a.requestLease = async (input, options) => {
        calls += 1;
        if (calls === 2) {
          clock.advance(60_000);
          if (freed) workers.refresh("wrk_b", { capacity: statusFixture().capacity });
        }
        return answer(input, options);
      };

      const { ended, state } = await start(coordinator, { timeoutMs: 60_000 });
      expect(coordinator.queueDepth).toBe(1);
      expect(state.state).toBe("pending");
      workers.refresh("wrk_a", { capacity: roomierIos() });
      await tick();

      expect(calls).toBe(2);
      expect(state.state).toBe("rejected");
      expect(await ended).toBeInstanceOf(QueueTimeoutError);
      expect(coordinator.queueDepth).toBe(0);
      expect(leaseRequests(b)).toEqual([]);
    },
  );

  it.each([
    "BAD_REQUEST",
    "INSUFFICIENT_DISK_SPACE",
    "LICENSE_NOT_ACCEPTED",
    "REQUESTER_ALREADY_LEASED",
    "INTERNAL",
  ] as const)("keeps %s final instead of trying another worker", async (code) => {
    const { a, b, coordinator } = twoWorkers();
    a.requestLeaseQueue.push({
      error: new SimlockError(code, "domain", "nope", {}),
      kind: "error",
    });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended, state } = await start(coordinator);

    expect(state.state).toBe("rejected");
    expect(await ended).toMatchObject({ code });
    expect(leaseRequests(b)).toEqual([]);
  });

  it("reads the refusing worker's catalog again", async () => {
    const { a, b, coordinator, directory } = twoWorkers();
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    await start(coordinator);

    expect(directory.catalogRefreshCalls).toEqual(["wrk_a"]);
  });

  it("still retries when the refusing worker's catalog refresh fails", async () => {
    const { a, b, coordinator, directory } = twoWorkers();
    directory.failingRefresh.add("wrk_a");
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it("still retries when the refusing worker's link closed right after it refused", async () => {
    const { a, b, coordinator, directory } = twoWorkers();
    const answer = a.requestLease.bind(a);
    a.requestLease = async (input, options) => {
      directory.clients.delete("wrk_a");
      return answer(input, options);
    };
    a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator);

    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  describe("gateway events when no worker is left", () => {
    function recordEvents(eventBus: EventBus) {
      const events: Array<{ name: string; payload: unknown }> = [];
      for (const name of ["lease.queued", "lease.rejected"] as const) {
        eventBus.subscribe(name, (envelope) => events.push({ name, payload: envelope.payload }));
      }
      return events;
    }

    it("emits lease.rejected with reason unresolvable-spec after lease.queued when the request had entered the gateway queue", async () => {
      const { a, b, coordinator, eventBus, workers } = twoWorkers();
      const events = recordEvents(eventBus);
      a.requestLeaseQueue.push({ error: runtimeMissing(), kind: "error" });
      b.requestLeaseQueue.push({ error: noCapacityError(), kind: "error" });
      const { ended, state } = await start(coordinator);
      expect(state.state).toBe("pending");

      workers.disconnected("wrk_b");
      await tick();

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
      expect(events.map((event) => event.name)).toEqual(["lease.queued", "lease.rejected"]);
      expect(events[1]?.payload).toMatchObject({ reason: "unresolvable-spec" });
    });
  });
});

describe("FleetLeaseCoordinator: lease.rejected names its request", () => {
  type Reason = EventMap["lease.rejected"]["reason"];
  type Fleet = ReturnType<typeof harness>;

  interface Outcome {
    readonly fleet: Fleet;
    readonly requester: string;
    readonly requestId?: string | undefined;
  }

  async function ask(
    fleet: Fleet,
    overrides: Parameters<typeof requestOptions>[0] & { readonly request?: typeof REQUEST },
  ): Promise<string | undefined> {
    let requestId: string | undefined;
    const { request = REQUEST, ...options } = overrides;
    void fleet.coordinator
      .request(request, requestOptions({ ...options, onAdmitted: (id) => (requestId = id) }))
      .catch(() => undefined);
    await tick();
    return requestId;
  }

  const holderGrant = () => ({ grant: grantFixture(), kind: "grant" as const });

  async function busyFleet(): Promise<Fleet> {
    const fleet = harness();
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    client.requestLeaseQueue.push(holderGrant());
    await fleet.coordinator.request(REQUEST, requestOptions());
    connectWorker(fleet.workers, "wrk_a", { capacity: saturatedIos() });
    return fleet;
  }

  const cases: Record<Reason, (() => Promise<Outcome>) | "worker"> = {
    timeout: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, {
        ownerId: "agent-2",
        requesterId: "agent-2",
        timeoutMs: 60_000,
      });
      fleet.clock.advance(60_000);
      await tick();
      return { fleet, requestId, requester: "agent-2" };
    },
    "no-wait": async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, {
        noWait: true,
        ownerId: "agent-2",
        requesterId: "agent-2",
      });
      return { fleet, requestId, requester: "agent-2" };
    },
    "unresolvable-spec": async () => {
      const fleet = harness();
      connectWorker(fleet.workers, "wrk_a");
      const requestId = await ask(fleet, {
        request: { ...REQUEST, model: "iPhone 99" },
        requesterId: "agent-9",
      });
      return { fleet, requestId, requester: "agent-9" };
    },
    "no-worker": async () => {
      const fleet = harness();
      const requestId = await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requestId, requester: "agent-9" };
    },
    "already-leased": async () => {
      const fleet = await busyFleet();
      await ask(fleet, { requesterId: "agent-1" });
      return { fleet, requester: "agent-1" };
    },
    "lease-id-taken": async () => {
      const fleet = harness();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: { ...grantFixture().lease, id: "myid" } }),
        kind: "grant",
      });
      await fleet.coordinator.request(REQUEST, requestOptions({ leaseId: "myid" }));
      await ask(fleet, { leaseId: "myid", ownerId: "agent-2", requesterId: "agent-2" });
      return { fleet, requester: "agent-2" };
    },
    cancelled: async () => {
      const fleet = await busyFleet();
      const requestId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });
      await fleet.coordinator.cancelPending("agent-2");
      return { fleet, requestId, requester: "agent-2" };
    },
    "worker-failed": async () => {
      const fleet = harness();
      const client = new ScriptedWorkerClient();
      fleet.directory.add("wrk_a", client);
      connectWorker(fleet.workers, "wrk_a");
      client.requestLeaseQueue.push({
        error: new SimlockError("INTERNAL", "domain", "the worker broke", {}),
        kind: "error",
        progress: [{ etaMs: 1_000, stage: "booting" }],
      });
      const requestId = await ask(fleet, { requesterId: "agent-9" });
      return { fleet, requestId, requester: "agent-9" };
    },
    "boot-timeout": "worker",
    killed: "worker",
    updating: "worker",
    "daemon-restarted": "worker",
  };

  const gatewayReasons = (Object.keys(cases) as Reason[]).filter(
    (reason) => cases[reason] !== "worker",
  );

  it.each(gatewayReasons)(
    "includes the request id and the requester when it rejects with %s",
    async (reason) => {
      const run = cases[reason];
      if (run === "worker") throw new Error(`${reason} is the worker's`);
      const events: Array<EventMap["lease.rejected"]> = [];

      const outcome = await (async () => {
        const result = await run();
        for (const event of result.fleet.eventBus.replay()) {
          if (event.event === "lease.rejected") events.push(event.payload as never);
        }
        return result;
      })();

      const rejections = events.filter((payload) => payload.reason === reason);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        requestId: outcome.requestId ?? expect.stringMatching(/^req_/),
        requester: outcome.requester,
      });
    },
  );

  it("gives a request refused as already-leased the id it would have been stored under, and no lease.requested precedes it", async () => {
    const fleet = await busyFleet();
    const requested: string[] = [];
    fleet.eventBus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    const rejected: Array<EventMap["lease.rejected"]> = [];
    fleet.eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await ask(fleet, { requesterId: "agent-1" });
    const admittedId = await ask(fleet, { ownerId: "agent-2", requesterId: "agent-2" });

    expect(rejected).toEqual([
      expect.objectContaining({ reason: "already-leased", requester: "agent-1" }),
    ]);
    expect(requested).toEqual([admittedId]);
    expect(rejected[0]?.requestId).toMatch(/^req_/);
    expect(rejected[0]?.requestId).not.toBe(admittedId);
    expect(Number(rejected[0]?.requestId.replace("req_", ""))).toBe(
      Number(admittedId?.replace("req_", "")) - 1,
    );
  });
});

describe("FleetLeaseCoordinator: queue.changed", () => {
  function depths(eventBus: EventBus): number[] {
    return eventBus
      .replay()
      .filter((event) => event.event === "queue.changed")
      .map((event) => (event.payload as EventMap["queue.changed"]).depth);
  }

  it("emits queue.changed once when started, with the depth then", () => {
    const { coordinator, eventBus } = harness();
    expect(depths(eventBus)).toEqual([]);

    coordinator.start();

    expect(depths(eventBus)).toEqual([0]);
  });

  it("emits queue.changed for the fleet queue when a request joins it and when it leaves, with the new depth", async () => {
    const { coordinator, directory, eventBus, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    coordinator.start();

    void coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    expect(depths(eventBus)).toEqual([0, 1]);

    await coordinator.cancelPending("agent-1");

    expect(depths(eventBus)).toEqual([0, 1, 0]);
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "queue.changed")
        .map((event) => event.module),
    ).toEqual(["fleet-lease-coordinator", "fleet-lease-coordinator", "fleet-lease-coordinator"]);
  });
});

describe("FleetLeaseCoordinator routes a class or range request (ADR 0015 §8)", () => {
  const phones = {
    modelClasses: { "iPhone 16": "phone", "iPhone 17": "phone" } as const,
    models: ["iPhone 16", "iPhone 17"],
    platform: "ios" as const,
    runtimes: ["18.0", "26.0"],
  };

  function connectWith(
    workers: WorkerRegistry,
    workerId: string,
    entry: Parameters<typeof catalogFixture>[0][number],
    options: {
      readonly capacity?: ReturnType<typeof statusFixture>["capacity"];
      readonly devices?: ReturnType<WorkerRegistry["views"]>[number]["devices"];
    } = {},
  ): void {
    workers.connected(workerId, undefined, "0.3.0");
    workers.refresh(workerId, {
      capacity: options.capacity ?? statusFixture().capacity,
      catalog: catalogFixture([entry]).platforms,
      devices: options.devices ?? [],
      downloads: { policy: "on-request" },
      health: "running",
      leases: [],
      queueDepth: 0,
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function single() {
    const fleet = harness();
    const client = new ScriptedWorkerClient();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    fleet.directory.add("wrk_a", client);
    connectWith(fleet.workers, "wrk_a", phones);
    return { ...fleet, client };
  }

  it("forwards the class and the range as they arrived, with no model", async () => {
    const { client, coordinator } = single();

    await coordinator.request(
      { class: "phone", osVersion: ">=18 <26", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(client.lastRequestLeaseInput).toMatchObject({
      class: "phone",
      osVersion: ">=18 <26",
      platform: "ios",
    });
    expect(client.lastRequestLeaseInput).not.toHaveProperty("model");
  });

  it("forwards a request naming neither model nor class with neither", async () => {
    const { client, coordinator } = single();

    await coordinator.request({ platform: "ios" }, requestOptions({ noWait: true }));

    expect(client.lastRequestLeaseInput).not.toHaveProperty("model");
    expect(client.lastRequestLeaseInput).not.toHaveProperty("class");
  });

  it("still forwards an exact model under the worker's own name, with no class", async () => {
    const { client, coordinator } = single();

    await coordinator.request(
      { model: "iphone 17", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(client.lastRequestLeaseInput?.model).toBe("iPhone 17");
    expect(client.lastRequestLeaseInput).not.toHaveProperty("class");
  });

  it("emits request.dispatched with class and no model for a class request, and model and no class for an exact one", async () => {
    const byClass = single();
    const dispatchedByClass: object[] = [];
    byClass.eventBus.subscribe("request.dispatched", (envelope) =>
      dispatchedByClass.push(envelope.payload),
    );
    await byClass.coordinator.request(
      { class: "phone", platform: "ios" },
      requestOptions({ noWait: true }),
    );
    const exact = single();
    const dispatchedExact: object[] = [];
    exact.eventBus.subscribe("request.dispatched", (envelope) =>
      dispatchedExact.push(envelope.payload),
    );
    await exact.coordinator.request(
      { model: "iPhone 17", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(dispatchedByClass).toEqual([expect.objectContaining({ class: "phone" })]);
    expect(dispatchedByClass[0]).not.toHaveProperty("model");
    expect(dispatchedExact).toEqual([expect.objectContaining({ model: "iPhone 17" })]);
    expect(dispatchedExact[0]).not.toHaveProperty("class");
  });

  it("sends a request for a class only one worker lists a model of to that worker", async () => {
    const { coordinator, directory, workers } = harness();
    const phonesOnly = new ScriptedWorkerClient();
    const withTablet = new ScriptedWorkerClient();
    directory.add("wrk_a", phonesOnly);
    directory.add("wrk_b", withTablet);
    withTablet.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWith(workers, "wrk_a", phones);
    connectWith(workers, "wrk_b", {
      ...phones,
      modelClasses: { ...phones.modelClasses, "iPad Pro": "tablet" },
      models: [...phones.models, "iPad Pro"],
    });

    await coordinator.request(
      { class: "tablet", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(phonesOnly)).toEqual([]);
    expect(withTablet.lastRequestLeaseInput).toMatchObject({ class: "tablet" });
  });

  it("retries a worker's UNKNOWN_MODEL for a class request, before any progress, on another worker", async () => {
    const { coordinator, directory, workers } = harness();
    const a = new ScriptedWorkerClient();
    const b = new ScriptedWorkerClient();
    directory.add("wrk_a", a);
    directory.add("wrk_b", b);
    connectWith(workers, "wrk_a", phones);
    connectWith(workers, "wrk_b", phones);
    a.requestLeaseQueue.push({
      error: new SimlockError("UNKNOWN_MODEL", "domain", "no model of class phone", {
        class: "phone",
        platform: "ios",
      }),
      kind: "error",
    });
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(
      { class: "phone", platform: "ios" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(a)).toHaveLength(1);
    expect(leaseRequests(b)).toHaveLength(1);
    expect(grant.lease.worker?.id).toBe("wrk_b");
  });

  it("dispatches an Android phone request to the worker with a warm Pixel over one with free capacity", async () => {
    const { coordinator, directory, workers } = harness();
    const free = new ScriptedWorkerClient();
    const warm = new ScriptedWorkerClient();
    directory.add("wrk_a", free);
    directory.add("wrk_b", warm);
    warm.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const pixels = {
      modelClasses: { "Pixel 8": "phone" } as const,
      models: ["Pixel 8"],
      platform: "android" as const,
      runtimes: ["35"],
    };
    const ready = deviceFixture("dev_1", "ready");
    connectWith(workers, "wrk_a", pixels);
    connectWith(workers, "wrk_b", pixels, {
      devices: [
        {
          ...ready,
          spec: {
            physical: false,
            model: "Pixel 8",
            osVersion: "35",
            platform: "android" as const,
          },
        },
      ],
    });

    await coordinator.request(
      { class: "phone", platform: "android" },
      requestOptions({ noWait: true }),
    );

    expect(leaseRequests(warm)).toHaveLength(1);
    expect(leaseRequests(free)).toEqual([]);
  });
});

describe("FleetLeaseCoordinator: requires", () => {
  const available = [{ name: "agent-device", state: "available" }] as const;
  const off = [{ name: "agent-device", state: "off" }] as const;
  const missing = () =>
    fromWireError("CAPABILITY_MISSING", "This worker cannot serve agent-device", {
      capabilities: ["agent-device"],
    });

  it("sends requires to the worker with the request", async () => {
    const { coordinator, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    workers.refresh("wrk_a", { capabilities: [...available] });

    await coordinator.request(REQUEST, requestOptions({ requires: ["agent-device"] }));

    expect(client.lastRequestLeaseInput).toMatchObject({ requires: ["agent-device"] });
  });

  it("leaves a worker whose own check answers CAPABILITY_MISSING out for this request and tries the next, and gives the caller that error when no worker is left", async () => {
    const { coordinator, directory, workers } = harness();
    const stale = new ScriptedWorkerClient();
    const next = new ScriptedWorkerClient();
    stale.requestLeaseQueue.push({ error: missing(), kind: "error" });
    next.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    directory.add("wrk_a", stale);
    directory.add("wrk_b", next);
    for (const id of ["wrk_a", "wrk_b"]) {
      connectWorker(workers, id);
      workers.refresh(id, { capabilities: [...available] });
    }

    await expect(
      coordinator.request(REQUEST, requestOptions({ requires: ["agent-device"] })),
    ).resolves.toMatchObject({ lease: { worker: { id: "wrk_b" } } });
    expect(stale.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);

    stale.requestLeaseQueue.push({ error: missing(), kind: "error" });
    next.requestLeaseQueue.push({ error: missing(), kind: "error" });
    await expect(
      coordinator.request(
        REQUEST,
        requestOptions({ ownerId: "agent-2", requesterId: "agent-2", requires: ["agent-device"] }),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: "This worker cannot serve agent-device",
    });
  });

  it("fails a request waiting only on the capable worker with CAPABILITY_MISSING when that worker's view turns starting", async () => {
    const { coordinator, directory, workers } = harness();
    directory.add("wrk_a", new ScriptedWorkerClient());
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    workers.refresh("wrk_a", { capabilities: [...available] });
    const waiting = coordinator.request(REQUEST, requestOptions({ requires: ["agent-device"] }));
    const outcome = { settled: false };
    waiting.then(
      () => (outcome.settled = true),
      () => (outcome.settled = true),
    );
    await tick();
    expect(coordinator.queueDepth).toBe(1);
    expect(outcome.settled).toBe(false);

    workers.refresh("wrk_a", { health: "starting", host: hostFixture() });
    await tick();

    expect(outcome.settled).toBe(true);
    await expect(waiting).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("keeps a request with requires waiting for a busy capable worker while a free worker lists the capability off", async () => {
    const { coordinator, directory, workers } = harness();
    directory.add("wrk_a", new ScriptedWorkerClient());
    const free = new ScriptedWorkerClient();
    directory.add("wrk_b", free);
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    workers.refresh("wrk_a", { capabilities: [...available] });
    connectWorker(workers, "wrk_b");
    workers.refresh("wrk_b", { capabilities: [...off] });

    void coordinator
      .request(REQUEST, requestOptions({ requires: ["agent-device"] }))
      .catch(() => undefined);
    await tick();

    expect(coordinator.queueDepth).toBe(1);
    expect(free.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });
});

describe("FleetLeaseCoordinator: a worker that is still starting", () => {
  const gatewayLease = {
    deviceId: "dev_1",
    grantedAt: 1,
    id: "lse_1",
    lastRenewedAt: 1,
    idChosenByRequester: false,
    ownerId: "agent-9",
    requesterId: `${GATEWAY_PREFIX}agent-9`,
    ttlDeadline: 900_001,
    ttlMs: 900_000,
  };
  const running = (leases: (typeof gatewayLease)[]) => ({
    capacity: statusFixture().capacity,
    devices: [deviceFixture("dev_1", "leased")],
    health: "running" as const,
    host: hostFixture(),
    leases,
    queueDepth: 0,
  });

  async function requestByAgent9(coordinator: FleetLeaseCoordinator) {
    return coordinator
      .request(
        REQUEST,
        requestOptions({ noWait: true, ownerId: "agent-9", requesterId: "agent-9" }),
      )
      .catch((error: unknown) => error);
  }

  it("gives a starting worker a view with health and host and no devices, leases or capacity, indexes none of its leases, then indexes them once the worker answers running", async () => {
    const { coordinator, directory, workers } = harness();
    const ready = new ScriptedWorkerClient();
    directory.add("wrk_b", ready);
    ready.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_b");
    workers.connected("wrk_a", undefined, "0.3.0");

    workers.refresh("wrk_a", { health: "starting", host: hostFixture() });

    const starting = workers.view("wrk_a");
    expect(starting?.health).toBe("starting");
    expect(starting?.host).toEqual(hostFixture());
    expect(Object.keys(starting ?? {})).not.toContain("devices");
    expect(Object.keys(starting ?? {})).not.toContain("leases");
    expect(Object.keys(starting ?? {})).not.toContain("capacity");
    const granted = await requestByAgent9(coordinator);
    expect(granted).toMatchObject({ lease: { worker: { id: "wrk_b" } } });
    await coordinator.release((granted as { lease: { id: string } }).lease.id);

    workers.refresh("wrk_a", running([gatewayLease]));

    const refusal = await requestByAgent9(coordinator);
    expect(refusal).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((refusal as RequesterAlreadyLeasedError).existingLeaseId).toBe("wrk_a.lse_1");
  });

  it("keeps the leases it indexed for a worker through every answer the worker gives while starting, until it answers running", async () => {
    const { coordinator, workers } = harness();
    workers.connected("wrk_a", undefined, "0.3.0");
    workers.refresh("wrk_a", running([gatewayLease]));
    const refused = async () => {
      const refusal = await requestByAgent9(coordinator);
      expect(refusal).toBeInstanceOf(RequesterAlreadyLeasedError);
      expect((refusal as RequesterAlreadyLeasedError).existingLeaseId).toBe("wrk_a.lse_1");
    };
    await refused();

    for (let answer = 0; answer < 3; answer += 1) {
      workers.refresh("wrk_a", { health: "starting", host: hostFixture() });
      expect(Object.keys(workers.view("wrk_a") ?? {})).not.toContain("leases");
      await refused();
    }

    workers.refresh("wrk_a", running([gatewayLease]));
    await refused();
  });

  it("sends a request to the worker that answered running, never to one that answered starting", async () => {
    const { coordinator, directory, workers } = harness();
    const starting = new ScriptedWorkerClient();
    const ready = new ScriptedWorkerClient();
    directory.add("wrk_a", starting);
    directory.add("wrk_b", ready);
    ready.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    workers.refresh("wrk_a", { health: "starting", host: hostFixture() });

    await expect(coordinator.request(REQUEST, requestOptions())).resolves.toMatchObject({
      lease: { worker: { id: "wrk_b" } },
    });

    expect(starting.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);
  });

  it("keeps dispatching a queued request to a running worker while another, already reconciled, answers starting", async () => {
    const { coordinator, directory, workers } = harness();
    const restarting = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_a", restarting);
    directory.add("wrk_b", other);
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b", { capacity: saturatedIos() });
    workers.refresh("wrk_a", { health: "starting", host: hostFixture() });
    const granted = coordinator.request(REQUEST, requestOptions());
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    workers.refresh("wrk_b", { capacity: statusFixture().capacity });
    await tick();

    expect(coordinator.queueDepth).toBe(0);
    expect(other.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    await expect(granted).resolves.toMatchObject({ lease: { worker: { id: "wrk_b" } } });
  });

  it("queues a request for the only worker that can serve it, which is starting, though another worker takes requests but lists no such model", async () => {
    const { coordinator, directory, workers } = harness();
    const other = new ScriptedWorkerClient();
    const restarting = new ScriptedWorkerClient();
    directory.add("wrk_a", other);
    directory.add("wrk_b", restarting);
    restarting.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    connectWorker(workers, "wrk_a", { models: ["iPad Pro"] });
    connectWorker(workers, "wrk_b");
    workers.refresh("wrk_b", { health: "starting", host: hostFixture() });

    const granted = coordinator.request(REQUEST, requestOptions());
    await tick();

    expect(coordinator.queueDepth).toBe(1);
    expect(restarting.calls.filter((call) => call.startsWith("lease.request"))).toEqual([]);

    workers.refresh("wrk_b", {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      devices: [],
      health: "running",
      leases: [],
      queueDepth: 0,
    });
    await expect(granted).resolves.toMatchObject({ lease: { worker: { id: "wrk_b" } } });
  });
});

describe("FleetLeaseCoordinator caller-chosen lease IDs", () => {
  function chosenGrant(leaseId: string) {
    return grantFixture({
      lease: { ...grantFixture().lease, id: leaseId, idChosenByRequester: true } as LeaseRecord,
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  function forwardedLeaseId(client: ScriptedWorkerClient): unknown {
    return (client.lastRequestLeaseInput as Record<string, unknown> | undefined)?.leaseId;
  }

  function refreshWorker(workers: WorkerRegistry, capacity: ReturnType<typeof roomierIos>): void {
    workers.refresh("wrk_a", {
      capacity,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      devices: [],
      downloads: { policy: "on-request" },
      health: "running",
      leases: [],
      queueDepth: 0,
    });
  }

  function oneWorker(overrides: Parameters<typeof harness>[0] = {}) {
    const fleet = harness(overrides);
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    return { ...fleet, client };
  }

  function chosen(leaseId: string, overrides: Parameters<typeof requestOptions>[0] = {}) {
    return { ...requestOptions(overrides), leaseId } as ReturnType<typeof requestOptions>;
  }

  it("through a gateway, a caller-chosen ID comes back with no worker prefix", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("ad-7f3a"), kind: "grant" });

    const grant = await coordinator.request(REQUEST, chosen("ad-7f3a"));

    expect(forwardedLeaseId(client)).toBe("ad-7f3a");
    expect(grant.lease.id).toBe("ad-7f3a");
  });

  it("through a gateway, a request without leaseId gets <worker>.lse_ as today", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const grant = await coordinator.request(REQUEST, requestOptions());

    expect(client.lastRequestLeaseInput).not.toHaveProperty("leaseId");
    expect(grant.lease.id).toBe("wrk_a.lse_1");
  });

  it("through a gateway, renew and release by a caller-chosen ID reach the right worker", async () => {
    const { coordinator, directory, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b", { capacity: roomierIos() });
    clientB.requestLeaseQueue.push({ grant: chosenGrant("ad-7f3a"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("ad-7f3a"));

    await coordinator.renew("ad-7f3a", undefined);
    await coordinator.release("ad-7f3a");

    expect(clientB.calls).toEqual(
      expect.arrayContaining(["lease.renew:ad-7f3a", "lease.release:ad-7f3a"]),
    );
    expect(clientA.calls.filter((call) => /^lease\.(renew|release)/.test(call))).toEqual([]);
    const callsAfterRelease = clientB.calls.length;
    await expect(coordinator.renew("ad-7f3a", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(clientB.calls).toHaveLength(callsAfterRelease);
  });

  it("when two workers report the same caller-chosen ID on rebuild, renew of that ID reaches the first worker", async () => {
    const { coordinator, directory, leaseIndex, workers } = harness();
    const clientA = new ScriptedWorkerClient();
    const clientB = new ScriptedWorkerClient();
    directory.add("wrk_a", clientA);
    directory.add("wrk_b", clientB);
    connectWorker(workers, "wrk_a");
    connectWorker(workers, "wrk_b");
    const reported = (ownerId: string) => ({
      grantedAt: 1,
      id: "myid",
      idChosenByRequester: true,
      ownerId,
      requesterId: `${GATEWAY_PREFIX}${ownerId}`,
    });

    leaseIndex.rebuildFromWorker("wrk_a", [reported("agent-1")]);
    leaseIndex.rebuildFromWorker("wrk_b", [reported("agent-2")]);
    await coordinator.renew("myid", undefined);

    expect(clientA.calls).toContain("lease.renew:myid");
    expect(clientB.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
  });

  it("through a gateway, a request whose requester already holds a lease fails with REQUESTER_ALREADY_LEASED, not LEASE_ID_TAKEN, when it names that lease's own ID", async () => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("myid"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("myid"));

    const refusal = await coordinator.request(REQUEST, chosen("myid")).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequesterAlreadyLeasedError);
    expect((refusal as RequesterAlreadyLeasedError).existingLeaseId).toBe("myid");
  });

  it("through a gateway, a second request for an ID held by a gateway lease fails with LEASE_ID_TAKEN, emits lease.rejected with reason lease-id-taken, and is not forwarded", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    client.requestLeaseQueue.push({ grant: chosenGrant("myid"), kind: "grant" });
    await coordinator.request(REQUEST, chosen("myid"));
    const rejected: unknown[] = [];
    eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    const second = coordinator.request(
      REQUEST,
      chosen("myid", { ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const secondState = promiseState(second);
    const refusal = second.catch((error: unknown) => error);
    await tick();

    expect(secondState.state).toBe("rejected");
    expect(await refusal).toMatchObject({
      code: "LEASE_ID_TAKEN",
      details: { leaseId: "myid" },
      message: "lease ID myid is already in use",
    });
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "lease-id-taken", requester: "agent-2" }),
    ]);
    expect(leaseRequests(client)).toHaveLength(1);
  });

  it("through a gateway, a second request for an ID held by a waiting gateway request fails with LEASE_ID_TAKEN and is not forwarded", async () => {
    const { client, coordinator, directory, workers } = oneWorker();
    connectWorker(workers, "wrk_a", { capacity: saturatedIos() });
    directory.add("wrk_a", client);
    void coordinator.request(REQUEST, chosen("myid")).catch(() => undefined);
    await tick();
    expect(coordinator.queueDepth).toBe(1);

    const second = coordinator.request(
      REQUEST,
      chosen("myid", { ownerId: "agent-2", requesterId: "agent-2" }),
    );
    const secondState = promiseState(second);
    const refusal = second.catch((error: unknown) => error);
    await tick();

    expect(secondState.state).toBe("rejected");
    expect(await refusal).toMatchObject({ code: "LEASE_ID_TAKEN" });
    expect(leaseRequests(client)).toEqual([]);
    expect(coordinator.queueDepth).toBe(1);
  });

  it("through a gateway, a worker's LEASE_ID_TAKEN is passed to the caller and no other worker is tried", async () => {
    const { client, coordinator, directory, workers } = oneWorker();
    const other = new ScriptedWorkerClient();
    directory.add("wrk_b", other);
    connectWorker(workers, "wrk_b");
    const taken = fromWireError("LEASE_ID_TAKEN", "lease ID myid is already in use", {
      leaseId: "myid",
    });
    for (const scripted of [client, other]) {
      scripted.requestLeaseQueue.push(
        { error: taken, kind: "error" },
        { grant: chosenGrant("myid"), kind: "grant" },
      );
    }

    await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
      code: "LEASE_ID_TAKEN",
      details: { leaseId: "myid" },
    });

    expect(leaseRequests(client).length + leaseRequests(other).length).toBe(1);
  });

  it("a worker grant whose lease ID differs from the forwarded leaseId is released on the worker, never enters the gateway index, and the request is queued again", async () => {
    const logger = new RecordingLogger();
    const { client, coordinator } = oneWorker({ logger });
    client.requestLeaseQueue.push({ grant: chosenGrant("not-what-was-sent"), kind: "grant" });
    const outcome = promiseState(coordinator.request(REQUEST, chosen("myid")));
    await tick();

    expect(client.calls).toContain("lease.release:not-what-was-sent");
    await expect(coordinator.renew("not-what-was-sent", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
    });
    expect(client.calls).not.toContain("lease.renew:not-what-was-sent");
    expect(outcome.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);
    expect(JSON.stringify(logger.warnings)).toContain("wrk_a");
  });

  it("a worker that answered a grant under another ID is not asked again until its view changes, then is, and the right grant settles the request", async () => {
    const { client, coordinator, workers } = oneWorker();
    client.requestLeaseQueue.push(
      { grant: chosenGrant("not-what-was-sent"), kind: "grant" },
      { grant: chosenGrant("myid"), kind: "grant" },
    );
    const request = coordinator.request(REQUEST, chosen("myid"));
    const outcome = promiseState(request);
    await tick();
    expect(leaseRequests(client)).toHaveLength(1);

    refreshWorker(workers, statusFixture().capacity);
    await tick();
    expect(leaseRequests(client)).toHaveLength(1);

    refreshWorker(workers, roomierIos());
    await tick();
    expect(outcome.state).toBe("fulfilled");
    await expect(request).resolves.toMatchObject({ lease: { id: "myid" } });
    expect(leaseRequests(client)).toHaveLength(2);
  });

  it("the gateway answers UNKNOWN_LEASE for a renew of an ID missing from its index", async () => {
    const { coordinator } = oneWorker();

    await expect(coordinator.renew("myid", undefined)).rejects.toMatchObject({
      code: "UNKNOWN_LEASE",
      details: { leaseId: "myid" },
    });
  });

  describe("a grant for a bare ID the index maps to another worker", () => {
    function grantRacingAReport(overrides: Parameters<typeof harness>[0] = {}) {
      const fleet = oneWorker(overrides);
      fleet.client.requestLeaseQueue.push({
        beforeGrant: () => {
          fleet.leaseIndex.rebuildFromWorker("wrk_b", [
            {
              grantedAt: 1,
              id: "myid",
              idChosenByRequester: true,
              ownerId: "agent-9",
              requesterId: `${GATEWAY_PREFIX}agent-9`,
            } as WorkerReportedLease,
          ]);
        },
        grant: chosenGrant("myid"),
        kind: "grant",
      });
      return fleet;
    }

    it("is released on the new worker and answers LEASE_ID_TAKEN, and the first entry stays routed", async () => {
      const { client, coordinator, directory, eventBus } = grantRacingAReport();
      const reported = new ScriptedWorkerClient();
      directory.add("wrk_b", reported);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
        code: "LEASE_ID_TAKEN",
        details: { leaseId: "myid" },
      });

      expect(client.calls).toContain("lease.release:myid");
      await coordinator.renew("myid", undefined);
      expect(reported.calls).toContain("lease.renew:myid");
      expect(client.calls.filter((call) => call.startsWith("lease.renew"))).toEqual([]);
      expect(rejected).toEqual([
        expect.objectContaining({ reason: "lease-id-taken", requester: "agent-1" }),
      ]);
    });

    it("logs a release the worker refuses, naming the worker and the lease, and still answers LEASE_ID_TAKEN", async () => {
      const logger = new RecordingLogger();
      const { client, coordinator } = grantRacingAReport({ logger });
      client.releaseLeaseQueue.push({ error: new Error("worker said no"), kind: "error" });

      await expect(coordinator.request(REQUEST, chosen("myid"))).rejects.toMatchObject({
        code: "LEASE_ID_TAKEN",
      });
      await tick();

      expect(logger.warnings).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ workerId: "wrk_a", workerLeaseId: "myid" }),
          message: "Failed to release a lease the gateway will not route",
        }),
      ]);
    });
  });
});

describe("FleetLeaseCoordinator records every fleet request's outcome (ADR 0021)", () => {
  function oneWorker(overrides: Parameters<typeof harness>[0] = {}) {
    const fleet = harness(overrides);
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    connectWorker(fleet.workers, "wrk_a");
    return { ...fleet, client };
  }

  function record<Name extends keyof EventMap>(
    eventBus: EventBus,
    ...names: Name[]
  ): Array<{ name: Name; payload: EventMap[Name] }> {
    const seen: Array<{ name: Name; payload: EventMap[Name] }> = [];
    for (const name of names) {
      eventBus.subscribe(name, (envelope) =>
        seen.push({ name, payload: envelope.payload as EventMap[Name] }),
      );
    }
    return seen;
  }

  async function start(
    coordinator: FleetLeaseCoordinator,
    overrides: Parameters<typeof requestOptions>[0] = {},
  ) {
    let requestId: string | undefined;
    const outcome = coordinator.request(
      REQUEST,
      requestOptions({ ...overrides, onAdmitted: (id) => (requestId = id) }),
    );
    const ended = outcome.then(
      (grant) => grant as unknown,
      (error: unknown) => error,
    );
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, requestId: () => requestId, state };
  }

  it.each([
    ["a waiting caller", { noWait: false }],
    ["a noWait caller", { noWait: true }],
  ])("sends the gateway's request id as fleetRequestId, for %s", async (_label, caller) => {
    const { client, coordinator } = oneWorker();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { requestId } = await start(coordinator, caller);

    expect(requestId()).toMatch(/^req_/);
    expect(client.lastRequestLeaseInput).toMatchObject({
      fleetRequestId: requestId(),
      noWait: true,
    });
  });

  function twoWorkersAPreferred() {
    const fleet = harness();
    const preferred = new ScriptedWorkerClient();
    const other = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", preferred);
    fleet.directory.add("wrk_b", other);
    const capacity = statusFixture().capacity;
    connectWorker(fleet.workers, "wrk_a", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 4 } },
    });
    connectWorker(fleet.workers, "wrk_b");
    return { ...fleet, other, preferred };
  }

  it("sends the same fleetRequestId to the second worker when the first refuses NO_CAPACITY", async () => {
    const { coordinator, other, preferred } = twoWorkersAPreferred();
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { requestId } = await start(coordinator, { noWait: true });

    expect(
      [preferred, other].map(
        (client) =>
          (client.lastRequestLeaseInput as Record<string, unknown> | undefined)?.fleetRequestId,
      ),
    ).toEqual([requestId(), requestId()]);
  });

  it("emits one lease.rejected worker-failed with the caller's error code for a request whose dispatch fails after a progress push", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "lease.rejected", "request.granted");
    client.requestLeaseQueue.push({
      error: new SimlockError("INTERNAL", "domain", "the worker broke", {}),
      kind: "error",
      progress: [{ etaMs: 1_000, stage: "booting" }],
    });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "INTERNAL" });
    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: {
          code: "INTERNAL",
          reason: "worker-failed",
          requestId: requestId(),
          requestSpec: REQUEST,
          requester: "agent-1",
          worker: "wrk_a",
        },
      },
    ]);
  });

  it.each([
    {
      elapseMs: 0,
      failure: "fails on a lost uplink",
      script: (client: ScriptedWorkerClient) =>
        client.requestLeaseQueue.push({
          error: new SimlockError(
            "DAEMON_CONNECTION_LOST",
            "transport",
            "Daemon connection is closed",
            {},
          ),
          kind: "error",
        }),
    },
    {
      elapseMs: 5_000,
      failure: "times out",
      script: (client: ScriptedWorkerClient) => client.requestLeaseQueue.push({ kind: "hang" }),
    },
  ])(
    "emits one lease.rejected worker-failed with code WORKER_UNREACHABLE, naming the worker, for a dispatch that $failure",
    async ({ elapseMs, script }) => {
      const { clock, client, coordinator, eventBus } = oneWorker({ leaseRequestTimeoutMs: 5_000 });
      const events = record(eventBus, "lease.rejected");
      script(client);

      const { ended } = await start(coordinator);
      clock.advance(elapseMs);
      await tick();

      expect(await ended).toMatchObject({ code: "WORKER_UNREACHABLE" });
      expect(events).toEqual([
        {
          name: "lease.rejected",
          payload: expect.objectContaining({
            code: "WORKER_UNREACHABLE",
            reason: "worker-failed",
            worker: "wrk_a",
          }),
        },
      ]);
    },
  );

  it("carries the failing worker's id, not the one that only refused, as worker on a worker-failed rejection", async () => {
    const { coordinator, eventBus, other } = twoWorkersAPreferred();
    const events = record(eventBus, "lease.rejected");
    other.requestLeaseQueue.push({
      error: new SimlockError("INTERNAL", "domain", "wrk_b broke", {}),
      kind: "error",
      progress: [{ etaMs: 1, stage: "booting" }],
    });

    await start(coordinator, { noWait: true });

    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: expect.objectContaining({ reason: "worker-failed", worker: "wrk_b" }),
      },
    ]);
  });

  it("ends a request never queued on a worker's cannot-serve refusal in one lease.rejected unresolvable-spec", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "lease.rejected", "lease.queued");
    client.requestLeaseQueue.push({
      error: new SimlockError("RUNTIME_MISSING", "domain", "no such runtime", {
        downloadable: false,
        osVersion: "26.0",
        platform: "ios",
      }),
      kind: "error",
    });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(events).toEqual([
      {
        name: "lease.rejected",
        payload: expect.objectContaining({ reason: "unresolvable-spec", requestId: requestId() }),
      },
    ]);
  });

  it("emits no lease.rejected for a request one worker refuses NO_CAPACITY and another grants", async () => {
    const { coordinator, eventBus, other } = twoWorkersAPreferred();
    const events = record(eventBus, "lease.rejected");
    other.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended } = await start(coordinator, { noWait: true });

    expect(await ended).toMatchObject({ lease: { worker: { id: "wrk_b" } } });
    expect(events).toEqual([]);
  });

  it("emits one request.granted with worker and both lease ids, and no workerId in its payload, for a settled grant", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { ended, requestId } = await start(coordinator);

    expect(await ended).toMatchObject({ lease: { id: "wrk_a.lse_1" } });
    expect(events).toEqual([
      {
        name: "request.granted",
        payload: {
          leaseId: "wrk_a.lse_1",
          requestId: requestId(),
          worker: "wrk_a",
          workerLeaseId: "lse_1",
        },
      },
    ]);
    expect(events[0]?.payload).not.toHaveProperty("workerId");
  });

  it("emits lease.rejected lease-id-taken and no request.granted for a grant the lease index refuses", async () => {
    const { client, coordinator, eventBus, leaseIndex } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({
      beforeGrant: () => {
        leaseIndex.rebuildFromWorker("wrk_b", [
          {
            grantedAt: 1,
            id: "myid",
            idChosenByRequester: true,
            ownerId: "agent-9",
            requesterId: `${GATEWAY_PREFIX}agent-9`,
          } as WorkerReportedLease,
        ]);
      },
      grant: grantFixture({
        lease: { ...grantFixture().lease, id: "myid", idChosenByRequester: true } as LeaseRecord,
      }),
      kind: "grant",
    });

    const { ended } = await start(coordinator, { leaseId: "myid" } as never);

    expect(await ended).toMatchObject({ code: "LEASE_ID_TAKEN" });
    expect(events).toEqual([
      { name: "lease.rejected", payload: expect.objectContaining({ reason: "lease-id-taken" }) },
    ]);
  });

  it("emits no request.granted for a grant that lands after dispose()", async () => {
    const { client, coordinator, eventBus } = oneWorker();
    const events = record(eventBus, "request.granted", "lease.rejected");
    client.requestLeaseQueue.push({
      beforeGrant: () => coordinator.dispose(),
      grant: grantFixture(),
      kind: "grant",
    });

    const { ended } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(events).toEqual([]);
  });

  it("emits no request.granted for a grant that lands after the dispatch timed out", async () => {
    const { clock, client, coordinator, eventBus } = oneWorker({ leaseRequestTimeoutMs: 5_000 });
    const events = record(eventBus, "request.granted");
    client.requestLeaseQueue.push({
      beforeGrant: async () => {
        await Promise.resolve();
        clock.advance(5_000);
      },
      grant: grantFixture(),
      kind: "grant",
    });

    const { ended } = await start(coordinator);

    expect(await ended).toMatchObject({ code: "WORKER_UNREACHABLE" });
    expect(events).toEqual([]);
  });

  it("emits no lease.rejected and no request.granted on dispose() with a queued and an in-flight request", async () => {
    const { client, coordinator, directory, eventBus, workers } = oneWorker();
    const events = record(eventBus, "lease.rejected", "request.granted");
    client.requestLeaseQueue.push({ kind: "hang" });
    const inFlight = await start(coordinator);
    const busy = new ScriptedWorkerClient();
    directory.add("wrk_b", busy);
    connectWorker(workers, "wrk_b", { capacity: saturatedIos(), models: ["iPhone 18"] });
    const queued = await start(coordinator, { ownerId: "agent-2", requesterId: "agent-2" });
    expect(inFlight.state.state).toBe("pending");
    expect(coordinator.queueDepth).toBe(1);

    coordinator.dispose();
    await tick();

    expect(await inFlight.ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(await queued.ended).toMatchObject({ code: "DAEMON_STOPPING" });
    expect(events).toEqual([]);
  });

  it("emits no request.granted for a grant given back for a mismatched leaseId, and one for the retried grant", async () => {
    const { client, coordinator, eventBus, workers } = oneWorker();
    const events = record(eventBus, "request.granted");
    const chosen = (leaseId: string) =>
      grantFixture({
        lease: { ...grantFixture().lease, id: leaseId, idChosenByRequester: true } as LeaseRecord,
      });
    client.requestLeaseQueue.push(
      { grant: chosen("not-what-was-sent"), kind: "grant" },
      { grant: chosen("myid"), kind: "grant" },
    );

    const { ended, requestId } = await start(coordinator, { leaseId: "myid" } as never);
    expect(events).toEqual([]);

    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(await ended).toMatchObject({ lease: { id: "myid" } });
    expect(events).toEqual([
      {
        name: "request.granted",
        payload: {
          leaseId: "myid",
          requestId: requestId(),
          worker: "wrk_a",
          workerLeaseId: "myid",
        },
      },
    ]);
  });

  it.each([
    [
      "REQUESTER_ALREADY_LEASED",
      fromWireError("REQUESTER_ALREADY_LEASED", "already holds a lease", { requesterId: "gw" }),
    ],
    [
      "LEASE_ID_TAKEN",
      fromWireError("LEASE_ID_TAKEN", "lease ID myid is already in use", { leaseId: "myid" }),
    ],
  ])(
    "ends a request a worker refuses %s before any progress in lease.rejected worker-failed with that code, not the gateway's own lease-id-taken",
    async (code, error) => {
      const { client, coordinator, eventBus } = oneWorker();
      const events = record(eventBus, "lease.rejected");
      client.requestLeaseQueue.push({ error, kind: "error" });

      const { ended } = await start(coordinator);

      expect(await ended).toMatchObject({ code });
      expect(events).toEqual([
        {
          name: "lease.rejected",
          payload: expect.objectContaining({ code, reason: "worker-failed", worker: "wrk_a" }),
        },
      ]);
    },
  );
});

describe("FleetLeaseCoordinator routes a physical request by the enrolled devices in the workers' views (ADR 0022)", () => {
  const PHONE = { platform: "ios" as const, physical: true as const };
  const NOT_PRESENT = { present: false, reason: "not-present" } as const;

  function physicalRequest(
    overrides: {
      readonly model?: string;
      readonly osVersion?: string;
      readonly class?: "phone" | "tablet";
    } = {},
  ) {
    return { ...PHONE, ...overrides };
  }

  function iphone(
    id = "dev_p",
    state: "ready" | "leased" | "absent" = "ready",
    presence?: PhysicalPresenceFixture,
    model?: string,
  ) {
    return physicalDeviceFixture(id, state, {
      ...(presence === undefined ? {} : { presence }),
      ...(model === undefined ? {} : { model }),
    });
  }

  function leaseRequests(client: ScriptedWorkerClient): string[] {
    return client.calls.filter((call) => call.startsWith("lease.request"));
  }

  async function start(
    coordinator: FleetLeaseCoordinator,
    request: Parameters<FleetLeaseCoordinator["request"]>[0],
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = coordinator.request(request, requestOptions(options));
    const ended = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, state };
  }

  const owner = (name: string) => requestOptions({ ownerId: name, requesterId: name });

  function oneWorker(
    devices: ReturnType<typeof deviceFixture>[],
    capacity?: ReturnType<typeof statusFixture>["capacity"],
  ) {
    const fleetHarness = harness();
    const client = new ScriptedWorkerClient();
    fleetHarness.directory.add("wrk_a", client);
    connectWorker(fleetHarness.workers, "wrk_a", {
      devices,
      ...(capacity === undefined ? {} : { capacity }),
    });
    return { client, ...fleetHarness };
  }

  function twoWorkers(
    devicesA: ReturnType<typeof deviceFixture>[] = [iphone()],
    devicesB: ReturnType<typeof deviceFixture>[] = [iphone("dev_q")],
  ) {
    const fleetHarness = harness();
    const a = new ScriptedWorkerClient();
    const b = new ScriptedWorkerClient();
    fleetHarness.directory.add("wrk_a", a);
    fleetHarness.directory.add("wrk_b", b);
    connectWorker(fleetHarness.workers, "wrk_a", { devices: devicesA });
    connectWorker(fleetHarness.workers, "wrk_b", { devices: devicesB });
    return { a, b, ...fleetHarness };
  }

  it.each([
    { model: "iPhone 15 Pro", osVersion: "18.4", row: "exact model and OS" },
    {
      model: "iphone 15 pro",
      osVersion: ">=18 <19",
      row: "model in another letter case and an OS range",
    },
    { model: undefined, osVersion: undefined, row: "neither model nor OS" },
  ])(
    "a physical request with an enrolled match is dispatched with physical: true and its model as typed ($row)",
    async ({ model, osVersion }) => {
      const { client, coordinator } = oneWorker([iphone()]);
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const { state } = await start(
        coordinator,
        physicalRequest({
          ...(model === undefined ? {} : { model }),
          ...(osVersion === undefined ? {} : { osVersion }),
        }),
      );

      expect(state.state).toBe("fulfilled");
      expect(leaseRequests(client)).toHaveLength(1);
      expect(client.lastRequestLeaseInput).toMatchObject({
        ...(model === undefined ? {} : { model }),
        ...(osVersion === undefined ? {} : { osVersion }),
        physical: true,
      });
    },
  );

  it.each([
    { name: "model", request: physicalRequest({ model: "iPhone 99" }), devices: [iphone()] },
    { name: "class", request: physicalRequest({ class: "tablet" }), devices: [iphone()] },
    { name: "OS", request: physicalRequest({ osVersion: ">=17 <18" }), devices: [iphone()] },
    {
      name: "state (deleted)",
      request: physicalRequest(),
      devices: [physicalDeviceFixture("dev_p", "deleted")],
    },
    { name: "enrolled device", request: physicalRequest(), devices: [] },
  ])(
    "a physical request with no enrolled match by $name fails UNKNOWN_MODEL at once, and no worker is asked",
    async ({ request, devices }) => {
      const { client, coordinator, eventBus } = oneWorker(devices);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      const { ended, state } = await start(coordinator, request);

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "UNKNOWN_MODEL" });
      expect(rejected).toEqual([expect.objectContaining({ reason: "unresolvable-spec" })]);
      expect(leaseRequests(client)).toEqual([]);
    },
  );

  it.each([
    {
      code: "NO_CAPACITY",
      reason: "no-worker",
      request: physicalRequest(),
      row: "no worker takes requests",
      setup: (_workers: WorkerRegistry) => {},
    },
    {
      code: "NO_DRIVER",
      reason: "unresolvable-spec",
      request: { ...physicalRequest(), platform: "android" as const },
      row: "no known worker has its platform",
      setup: (workers: WorkerRegistry) => connectWorker(workers, "wrk_a", { devices: [iphone()] }),
    },
  ])(
    "a physical request fails $code $reason when $row",
    async ({ code, reason, request, setup }) => {
      const { coordinator, directory, eventBus, workers } = harness();
      const client = new ScriptedWorkerClient();
      directory.add("wrk_a", client);
      setup(workers);
      const rejected: unknown[] = [];
      eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

      const { ended, state } = await start(coordinator, request);

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code });
      expect(rejected).toEqual([expect.objectContaining({ reason })]);
      expect(leaseRequests(client)).toEqual([]);
    },
  );

  it("a physical request is offered to a worker with no free running slot that holds a ready enrolled match, and request.dispatched carries physical: true with reason and stage warm-hit", async () => {
    const { client, coordinator, eventBus } = oneWorker([iphone()], saturatedIos());
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const dispatched: unknown[] = [];
    eventBus.subscribe("request.dispatched", (envelope) => dispatched.push(envelope.payload));

    await start(coordinator, physicalRequest());

    expect(dispatched).toEqual([
      expect.objectContaining({
        physical: true,
        reason: "warm-hit",
        stage: "warm-hit",
        workerId: "wrk_a",
      }),
    ]);
  });

  it("a physical request is sent to the worker that holds the ready enrolled match, not the one with a warm simulator", async () => {
    const { a, b, coordinator } = twoWorkers(
      [deviceFixture("dev_sim", "ready")],
      [iphone("dev_q")],
    );
    b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const { outcome, state } = await start(coordinator, physicalRequest());

    expect(leaseRequests(a)).toEqual([]);
    expect(state.state).toBe("fulfilled");
    expect((await outcome).lease.worker?.id).toBe("wrk_b");
  });

  it("a physical request whose only enrolled match is on a restarting worker waits, and is not failed UNKNOWN_MODEL", async () => {
    const { client, coordinator, workers } = oneWorker([iphone()]);
    workers.refresh("wrk_a", { health: "starting", host: hostFixture() });

    const waiting = await start(coordinator, physicalRequest());

    expect(waiting.state.state).toBe("pending");
    expect(leaseRequests(client)).toEqual([]);
  });

  it("a physical request waits when its only ready enrolled match was last read not present, and is sent once the view shows it present", async () => {
    const { client, clock, coordinator, workers } = oneWorker([
      iphone("dev_p", "ready", NOT_PRESENT),
    ]);

    const waiting = await start(coordinator, physicalRequest());
    expect(waiting.state.state).toBe("pending");
    expect(leaseRequests(client)).toEqual([]);

    clock.advance(1_000);
    workers.refresh("wrk_a", { devices: [iphone("dev_p", "ready", { present: true })] });
    await tick();

    expect(leaseRequests(client)).toHaveLength(1);
  });

  it("a physical request refused UNKNOWN_MODEL by worker 1 is offered to worker 2, and fails UNKNOWN_MODEL when no other worker has an enrolled match", async () => {
    const unknownModel = (message: string) =>
      new SimlockError("UNKNOWN_MODEL", "domain", message, { platform: "ios" });
    const offered = twoWorkers();
    offered.a.requestLeaseQueue.push({ error: unknownModel("worker a: no"), kind: "error" });
    offered.b.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

    const second = await start(offered.coordinator, physicalRequest());

    expect(second.state.state).toBe("fulfilled");
    expect(leaseRequests(offered.a)).toHaveLength(1);
    expect(leaseRequests(offered.b)).toHaveLength(1);
    expect((await second.outcome).lease.worker?.id).toBe("wrk_b");

    const only = twoWorkers([iphone()], []);
    only.a.requestLeaseQueue.push({ error: unknownModel("worker a: no"), kind: "error" });

    const failed = await start(only.coordinator, physicalRequest());

    expect(failed.state.state).toBe("rejected");
    expect(await failed.ended).toMatchObject({ code: "UNKNOWN_MODEL", message: "worker a: no" });
    expect(leaseRequests(only.a)).toHaveLength(1);
    expect(leaseRequests(only.b)).toEqual([]);
  });

  it("a worker that answers a physical request NO_CAPACITY is not sent it again by a refresh that leaves its view unchanged, and the request waits meanwhile with no reason of its own", async () => {
    const { client, clock, coordinator, workers } = oneWorker([iphone()]);

    const waiting = await start(coordinator, physicalRequest());
    expect(leaseRequests(client)).toHaveLength(1);

    for (let refresh = 0; refresh < 3; refresh += 1) {
      clock.advance(1_000);
      workers.refresh("wrk_a", { devices: [iphone()] });
      await tick();
    }

    expect(waiting.state.state).toBe("pending");
    expect(leaseRequests(client)).toHaveLength(1);
    expect(coordinator.waitingRequests()).toEqual([
      expect.objectContaining({ queuePosition: 1, stage: "queued" }),
    ]);
    expect(coordinator.waitingRequests()[0]).not.toHaveProperty("reason");
  });

  it("after a NO_CAPACITY refusal, a refresh in which the device's presence turns not present sends the request nowhere, and the next refresh in which it turns present sends it to that worker again", async () => {
    const { client, clock, coordinator, workers } = oneWorker([
      iphone("dev_p", "ready", { present: true }),
    ]);
    await start(coordinator, physicalRequest());
    expect(leaseRequests(client)).toHaveLength(1);

    clock.advance(1_000);
    workers.refresh("wrk_a", { devices: [iphone("dev_p", "ready", NOT_PRESENT)] });
    await tick();
    expect(leaseRequests(client)).toHaveLength(1);

    clock.advance(1_000);
    workers.refresh("wrk_a", { devices: [iphone("dev_p", "ready", { present: true })] });
    await tick();

    expect(leaseRequests(client)).toHaveLength(2);
  });

  it("a noWait physical request refused NO_CAPACITY by its only candidate fails NO_CAPACITY and is sent to that worker once", async () => {
    const { client, coordinator } = oneWorker([iphone()]);

    const noWait = await start(coordinator, physicalRequest(), requestOptions({ noWait: true }));

    expect(noWait.state.state).toBe("rejected");
    expect(await noWait.ended).toMatchObject({ code: "NO_CAPACITY" });
    expect(leaseRequests(client)).toHaveLength(1);
  });

  it("a physical request whose only enrolled match is on a disconnected worker fails NO_CAPACITY no-worker, and fails UNKNOWN_MODEL after pruneExpired forgets that worker", async () => {
    const { clock, coordinator, directory, eventBus, workers } = harness();
    directory.add("wrk_a", new ScriptedWorkerClient());
    directory.add("wrk_b", new ScriptedWorkerClient());
    connectWorker(workers, "wrk_a", { devices: [iphone()] });
    connectWorker(workers, "wrk_b");
    workers.disconnected("wrk_a");
    const rejected: { reason: string }[] = [];
    eventBus.subscribe("lease.rejected", (envelope) =>
      rejected.push(envelope.payload as { reason: string }),
    );

    const first = await start(coordinator, physicalRequest(), owner("agent-1"));

    expect(first.state.state).toBe("rejected");
    expect(await first.ended).toMatchObject({ code: "NO_CAPACITY" });
    expect(rejected.map((payload) => payload.reason)).toEqual(["no-worker"]);

    clock.advance(24 * 60 * 60_000);
    await workers.pruneExpired();
    const second = await start(coordinator, physicalRequest(), owner("agent-2"));

    expect(second.state.state).toBe("rejected");
    expect(await second.ended).toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(rejected.map((payload) => payload.reason)).toEqual(["no-worker", "unresolvable-spec"]);
  });

  it("queued physical requests count on their own line: queue.changed names the line and lease.queued reports the position within it", async () => {
    const { coordinator, eventBus } = oneWorker([iphone()], saturatedIos());
    const changed: unknown[] = [];
    const queued: unknown[] = [];
    eventBus.subscribe("queue.changed", (envelope) => changed.push(envelope.payload));
    eventBus.subscribe("lease.queued", (envelope) => queued.push(envelope.payload));

    await start(coordinator, physicalRequest(), owner("agent-1"));
    await start(coordinator, physicalRequest(), owner("agent-2"));
    await start(coordinator, { ...REQUEST, physical: false }, owner("agent-3"));

    expect(changed).toStrictEqual([
      { depth: 1, physical: true },
      { depth: 2, physical: true },
      { depth: 1 },
    ]);
    expect(queued.map((payload) => (payload as { queuePosition: number }).queuePosition)).toEqual([
      1, 2, 1,
    ]);
  });

  it("in one dispatch pass, a waiting virtual request and a waiting physical request are both sent to worker 1, the only worker that can take either", async () => {
    const { client, clock, coordinator, workers } = oneWorker([iphone()], saturatedIos());
    client.requestLeaseQueue.push(
      { error: noCapacityError(), kind: "error" },
      { kind: "hang" },
      { kind: "hang" },
    );
    await start(coordinator, REQUEST, owner("agent-1"));
    await start(coordinator, physicalRequest(), owner("agent-2"));
    const before = leaseRequests(client).length;

    clock.advance(1_000);
    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(leaseRequests(client).slice(before).sort()).toEqual([
      `lease.request:${GATEWAY_PREFIX}agent-1`,
      `lease.request:${GATEWAY_PREFIX}agent-2`,
    ]);
  });

  it("in one dispatch pass, two waiting physical requests for different models, whose ready matches are both on worker 1, are both sent to it", async () => {
    const { client, clock, coordinator, workers } = oneWorker(
      [iphone("dev_p"), iphone("dev_q", "ready", undefined, "iPhone 16 Pro")],
      saturatedIos(),
    );
    client.requestLeaseQueue.push(
      { error: noCapacityError(), kind: "error" },
      { error: noCapacityError(), kind: "error" },
      { kind: "hang" },
      { kind: "hang" },
    );
    await start(coordinator, physicalRequest({ model: "iPhone 15 Pro" }), owner("agent-1"));
    await start(coordinator, physicalRequest({ model: "iPhone 16 Pro" }), owner("agent-2"));
    expect(leaseRequests(client)).toHaveLength(2);

    clock.advance(1_000);
    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();

    expect(leaseRequests(client).slice(2).sort()).toEqual([
      `lease.request:${GATEWAY_PREFIX}agent-1`,
      `lease.request:${GATEWAY_PREFIX}agent-2`,
    ]);
  });

  it("in one dispatch pass, of two waiting physical requests with the same platform, model, class and OS, only the older is sent to worker 1, though it has two ready matches; the newer is sent in the next pass", async () => {
    const { client, clock, coordinator, workers } = oneWorker(
      [iphone("dev_p"), iphone("dev_q")],
      saturatedIos(),
    );
    client.requestLeaseQueue.push(
      { error: noCapacityError(), kind: "error" },
      { error: noCapacityError(), kind: "error" },
      { kind: "hang" },
      { kind: "hang" },
    );
    const request = physicalRequest({ model: "iPhone 15 Pro", osVersion: "18.4" });
    await start(coordinator, request, owner("agent-1"));
    await start(coordinator, request, owner("agent-2"));
    expect(leaseRequests(client)).toHaveLength(2);

    clock.advance(1_000);
    workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();
    expect(leaseRequests(client).slice(2)).toEqual([`lease.request:${GATEWAY_PREFIX}agent-1`]);

    clock.advance(1_000);
    workers.refresh("wrk_a", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, maxRunning: 4 },
      },
    });
    await tick();

    expect(leaseRequests(client).slice(3)).toEqual([`lease.request:${GATEWAY_PREFIX}agent-2`]);
  });
});

describe("FleetLeaseCoordinator: a requester may hold up to lease.maxPerRequester fleet leases (ADR 0023)", () => {
  const held = (id: string, grantedAt: number, requester = "agent-1") => ({
    grantedAt,
    id,
    ownerId: requester,
    requesterId: `${GATEWAY_PREFIX}${requester}`,
  });
  const atLimit = (held: number, limit: number, leaseId: string) =>
    `Requester agent-1 already holds ${String(held)} leases and lease.maxPerRequester is ${String(limit)}; release one (\`simlock release ${leaseId}\`) before requesting another device`;
  const waitingMessage =
    "Requester agent-1 already has a waiting request; wait for it to be granted or cancel it before requesting another device";

  async function withWaitingRequest(maxPerRequester?: number) {
    const built = harness(maxPerRequester === undefined ? {} : { maxPerRequester });
    connectWorker(built.workers, "wrk_a", { capacity: saturatedIos() });
    built.directory.add("wrk_a", new ScriptedWorkerClient());
    void built.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    expect(built.coordinator.queueDepth).toBe(1);
    return built;
  }

  it("with no limit set, a requester holding a fleet lease is refused with today's message, naming that lease", async () => {
    const { coordinator, leaseIndex } = harness();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding two fleet leases is refused, naming the earlier-granted one", async () => {
    const { coordinator, leaseIndex } = harness({ maxPerRequester: 2 });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_9", 10), held("lse_1", 20)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_9",
      message: atLimit(2, 2, "wrk_a.lse_9"),
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding one fleet lease is not refused", async () => {
    const { coordinator, directory, leaseIndex, workers } = harness({ maxPerRequester: 2 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    await expect(coordinator.request(REQUEST, requestOptions())).resolves.toMatchObject({
      lease: expect.anything(),
    });
  });

  it("with limit 2, a requester with a waiting fleet request is refused with the waiting-request message", async () => {
    const { coordinator } = await withWaitingRequest(2);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester with a waiting fleet request that also holds two fleet leases gets the waiting-request message", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest(2);
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1), held("lse_2", 2)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with no limit set, a requester that holds a fleet lease and has a waiting request gets today's message naming that lease", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
    });
  });
});

describe("FleetLeaseCoordinator lists why each worker cannot take a waiting request (#637)", () => {
  type Reasons = readonly { workerId: string; reason: string; capacityReason?: string }[];

  // why: holds a `lease.request` until `release` runs, so a test can change the fleet while the gateway's probe is in flight.
  class GatedClient extends ScriptedWorkerClient {
    release: () => void = () => {};
    readonly #gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });

    override async requestLease(
      input: Parameters<ScriptedWorkerClient["requestLease"]>[0],
      options?: Parameters<ScriptedWorkerClient["requestLease"]>[1],
    ) {
      await this.#gate;
      return super.requestLease(input, options);
    }
  }

  function atRamBudget(): ReturnType<typeof statusFixture>["capacity"] {
    const capacity = statusFixture().capacity;
    return { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };
  }

  function noCapacity(details?: unknown) {
    return {
      error: new SimlockError("NO_CAPACITY", "domain", "full", details as never),
      kind: "error" as const,
    };
  }

  function fleet(
    ids: readonly string[],
    setup: (id: string) => Parameters<typeof connectWorker>[2] = () => ({}),
    gated: readonly string[] = [],
  ) {
    const fleetHarness = harness();
    const clients: Record<string, ScriptedWorkerClient> = {};
    for (const id of ids) {
      const client = gated.includes(id) ? new GatedClient() : new ScriptedWorkerClient();
      clients[id] = client;
      fleetHarness.directory.add(id, client);
      connectWorker(fleetHarness.workers, id, setup(id));
    }
    return { clients, ...fleetHarness };
  }

  async function ask(
    coordinator: FleetLeaseCoordinator,
    request: Parameters<FleetLeaseCoordinator["request"]>[0] = REQUEST,
    options: Parameters<typeof requestOptions>[0] = {},
  ) {
    const outcome = coordinator.request(request, requestOptions(options));
    const ended = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await tick();
    return { ended, outcome, state };
  }

  const listed = (coordinator: FleetLeaseCoordinator, index = 0): Reasons | undefined =>
    (coordinator.waitingRequests()[index] as { workers?: Reasons } | undefined)?.workers;

  const saturatedExcept = (free: string) => (id: string) =>
    id === free ? {} : { capacity: saturatedIos() };

  it("lists, in worker id order, drained for a drained worker and full with platform-running-limit for one with no free iOS slot, also when it has no free global slot either", async () => {
    const capacity = statusFixture().capacity;
    const bothFull = {
      ...saturatedIos(),
      global: { ...capacity.global, maxRunning: 0 },
    };
    const { coordinator, workers } = fleet(["wrk_c", "wrk_b", "wrk_a"], (id) =>
      id === "wrk_b" ? { capacity: saturatedIos() } : id === "wrk_c" ? { capacity: bothFull } : {},
    );
    await workers.setDrained("wrk_a", true);

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { reason: "drained", workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_c" },
    ]);
  });

  it("lists full with global-running-limit for a worker with a free iOS slot and no free global slot", async () => {
    const capacity = statusFixture().capacity;
    const { coordinator } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a"
        ? { capacity: { ...capacity, global: { ...capacity.global, maxRunning: 0 } } }
        : { capacity: saturatedIos() },
    );

    await ask(coordinator);

    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "global-running-limit",
      reason: "full",
      workerId: "wrk_a",
    });
  });

  it("lists one entry for every known view, a disconnected and an incompatible one included, and none for a worker removed", async () => {
    const { coordinator, workers } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a" ? { capacity: saturatedIos() } : {},
    );
    workers.incompatible(
      "wrk_c",
      undefined,
      { gateway: { max: 20, min: 20 }, worker: { max: 4, min: 4 } },
      "0.2.0",
    );
    workers.disconnected("wrk_b");

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_a" },
      { reason: "disconnected", workerId: "wrk_b" },
      { reason: "incompatible", workerId: "wrk_c" },
    ]);

    await workers.remove("wrk_b");
    await tick();

    expect(listed(coordinator)?.map((entry) => entry.workerId)).toEqual(["wrk_a", "wrk_c"]);
  });

  it.each([
    [
      "platform-running-limit",
      { capacityReason: "platform-running-limit" },
      "platform-running-limit",
    ],
    ["none", {}, undefined],
    ["bogus", { capacityReason: "bogus" }, undefined],
    ["a number", { capacityReason: 42 }, undefined],
  ])(
    "lists a worker that answered NO_CAPACITY with capacityReason %s as full, with the reason only when it is one of the four",
    async (_label, details, expected) => {
      const { clients, coordinator } = fleet(["wrk_a"]);
      clients["wrk_a"]?.requestLeaseQueue.push(noCapacity(details));

      await ask(coordinator);

      expect(listed(coordinator)).toEqual([
        {
          reason: "full",
          workerId: "wrk_a",
          ...(expected === undefined ? {} : { capacityReason: expected }),
        },
      ]);
    },
  );

  it.each([
    ["UNKNOWN_MODEL", "unknown-model"],
    ["RUNTIME_MISSING", "runtime-missing"],
    ["NO_DRIVER", "no-driver"],
    ["CAPABILITY_MISSING", "capability-missing"],
  ] as const)("lists a worker that answered %s before progress as %s", async (code, reason) => {
    const { clients, coordinator } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"));
    clients["wrk_a"]?.requestLeaseQueue.push({
      error: new SimlockError(code, "domain", "cannot serve", {} as never),
      kind: "error",
    });

    await ask(coordinator);

    expect(listed(coordinator)).toEqual([
      { reason, workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
    ]);
  });

  it("lists a worker that granted another lease id than the one asked for as plain full", async () => {
    const { clients, coordinator } = fleet(["wrk_a"]);
    clients["wrk_a"]?.requestLeaseQueue.push({
      grant: grantFixture({
        lease: {
          ...grantFixture().lease,
          id: "not-what-was-sent",
          idChosenByRequester: true,
        } as LeaseRecord,
      }),
      kind: "grant",
    });

    await ask(coordinator, REQUEST, { leaseId: "myid" } as never);

    expect(listed(coordinator)).toEqual([{ reason: "full", workerId: "wrk_a" }]);
  });

  it("after a NO_CAPACITY re-queue and before any view change, recomputes every entry: the refused worker is full with its reason, one drained meanwhile is drained, one that lost to it is not-chosen", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b", "wrk_c"], () => ({}), [
      "wrk_a",
    ]);
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "device-limit" }));

    await ask(coordinator);
    expect(coordinator.waitingRequests()[0]).toMatchObject({ stage: "starting" });
    await workers.setDrained("wrk_b", true);
    (clients["wrk_a"] as GatedClient).release();
    await tick();

    expect(coordinator.waitingRequests()[0]).toMatchObject({ stage: "queued" });
    expect(listed(coordinator)).toEqual([
      { capacityReason: "device-limit", reason: "full", workerId: "wrk_a" },
      { reason: "drained", workerId: "wrk_b" },
      { reason: "not-chosen", workerId: "wrk_c" },
    ]);
  });

  it("follows the latest walk: a worker drained lists drained, and once undrained and refused with no detail at its RAM budget it lists full with ram-budget", async () => {
    const { coordinator, workers } = fleet(["wrk_a", "wrk_b"], (id) =>
      id === "wrk_a" ? { capacity: atRamBudget() } : { capacity: saturatedIos() },
    );
    await workers.setDrained("wrk_a", true);

    await ask(coordinator);
    expect(listed(coordinator)?.[0]).toEqual({ reason: "drained", workerId: "wrk_a" });

    await workers.setDrained("wrk_a", false);
    await tick();

    expect(listed(coordinator)).toEqual([
      { capacityReason: "ram-budget", reason: "full", workerId: "wrk_a" },
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
    ]);
  });

  it("lists no workers for a starting request", async () => {
    const { clients, coordinator } = fleet(["wrk_a"]);
    clients["wrk_a"]?.requestLeaseQueue.push({ kind: "hang" });

    await ask(coordinator);

    expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "starting" })]);
    expect(coordinator.waitingRequests()[0]).not.toHaveProperty("workers");
  });

  it("lists a worker drained after it refused the request as drained, not as its remembered refusal", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"));
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "ram-budget" }));
    await ask(coordinator);
    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "ram-budget",
      reason: "full",
      workerId: "wrk_a",
    });

    await workers.setDrained("wrk_a", true);
    await tick();

    expect(listed(coordinator)?.[0]).toEqual({ reason: "drained", workerId: "wrk_a" });
  });

  it("lists a refused worker whose view lost its free platform slot while the probe was in flight as full with platform-running-limit, not the reason it refused with", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"], saturatedExcept("wrk_a"), [
      "wrk_a",
    ]);
    clients["wrk_a"]?.requestLeaseQueue.push(noCapacity({ capacityReason: "ram-budget" }));
    await ask(coordinator);
    workers.refresh("wrk_a", { capacity: saturatedIos() });

    (clients["wrk_a"] as GatedClient).release();
    await tick();

    expect(listed(coordinator)?.[0]).toEqual({
      capacityReason: "platform-running-limit",
      reason: "full",
      workerId: "wrk_a",
    });
  });

  it("lists a worker claimed by an earlier request in the same walk as not-chosen for the later one, even at its RAM budget", async () => {
    const { clients, coordinator, workers } = fleet(["wrk_a"], () => ({
      capacity: saturatedIos(),
    }));
    clients["wrk_a"]?.requestLeaseQueue.push({ kind: "hang" });
    await ask(coordinator, REQUEST, { ownerId: "agent-1", requesterId: "agent-1" });
    await ask(coordinator, REQUEST, { ownerId: "agent-2", requesterId: "agent-2" });

    workers.refresh("wrk_a", { capacity: atRamBudgetRoomy() });
    await tick();

    expect(coordinator.waitingRequests().map((entry) => entry.stage)).toEqual([
      "starting",
      "queued",
    ]);
    expect(listed(coordinator, 1)).toEqual([{ reason: "not-chosen", workerId: "wrk_a" }]);

    function atRamBudgetRoomy() {
      const capacity = roomierIos();
      return { ...capacity, ios: { ...capacity.ios, atRamBudget: true } };
    }
  });

  it("lists no-free-physical for each worker of a physical request whose matching devices are not present, one entry per worker", async () => {
    const notPresent = (id: string) =>
      physicalDeviceFixture(id, "ready", { presence: { present: false, reason: "not-present" } });
    const { coordinator } = fleet(["wrk_a", "wrk_b"], (id) => ({
      devices: [notPresent(id === "wrk_a" ? "dev_p" : "dev_q")],
    }));

    await ask(coordinator, { physical: true, platform: "ios" });

    expect(listed(coordinator)).toEqual([
      { reason: "no-free-physical", workerId: "wrk_a" },
      { reason: "no-free-physical", workerId: "wrk_b" },
    ]);
  });

  it("lists disconnected for a target found unreachable at the attempt, after the request is queued again", async () => {
    const { coordinator, directory } = fleet(["wrk_a"]);
    directory.unreachable.add("wrk_a");

    await ask(coordinator);

    expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    expect(listed(coordinator)).toEqual([{ reason: "disconnected", workerId: "wrk_a" }]);
  });

  describe("a worker that answers PROVISION_FAILED", () => {
    const provisionFailed = (message: string) => ({
      error: new SimlockError("PROVISION_FAILED", "domain", message, {}),
      kind: "error" as const,
    });

    it("is walked past: the next worker is asked and its grant settles the request", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

      const { outcome, state } = await ask(coordinator);

      expect(state.state).toBe("fulfilled");
      expect((await outcome).lease.worker?.id).toBe("wrk_b");
    });

    it("rejects the request with PROVISION_FAILED and the last worker's message, and lists nothing, when every worker that could take it answered so", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push(provisionFailed("worker b: boom"));

      const { ended, state } = await ask(coordinator);

      expect(state.state).toBe("rejected");
      expect(await ended).toMatchObject({ code: "PROVISION_FAILED", message: "worker b: boom" });
      expect(coordinator.waitingRequests()).toEqual([]);
      expect(coordinator.queueDepth).toBe(0);
    });

    it("leaves the request queued when the other worker is only full", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      clients["wrk_b"]?.requestLeaseQueue.push(noCapacity());

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
      expect(listed(coordinator)).toEqual([
        { reason: "not-chosen", workerId: "wrk_a" },
        { reason: "full", workerId: "wrk_b" },
      ]);
    });

    it.each([
      {
        build: () => {
          const built = fleet(["wrk_a"]);
          built.workers.connected("wrk_b", undefined, "0.3.0");
          return built;
        },
        row: "not ready, having read no capacity or catalog yet",
      },
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.refresh("wrk_b", { health: "starting" });
          return built;
        },
        row: "unhealthy, still starting",
      },
      {
        build: () => fleet(["wrk_a", "wrk_b"], (id) => (id === "wrk_b" ? { queueDepth: 1 } : {})),
        row: "busy with a queue of its own",
      },
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.refresh("wrk_b", {
            update: {
              forced: false,
              from: "0.3.0",
              stage: "installing",
              startedAt: 1,
              to: "0.4.0",
            },
          });
          return built;
        },
        row: "updating",
      },
    ])("leaves the request queued when the other worker is $row", async ({ build }) => {
      const { clients, coordinator } = build();
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    });

    it.each([
      {
        build: () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          built.workers.disconnected("wrk_b");
          return built;
        },
        row: "disconnected",
      },
      {
        build: async () => {
          const built = fleet(["wrk_a", "wrk_b"]);
          await built.workers.setDrained("wrk_b", true);
          return built;
        },
        row: "drained",
      },
    ])(
      "rejects the request when the other worker is $row, which cannot take it",
      async ({ build }) => {
        const { clients, coordinator } = await build();
        clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));

        const { ended, state } = await ask(coordinator);

        expect(state.state).toBe("rejected");
        expect(await ended).toMatchObject({ code: "PROVISION_FAILED", message: "worker a: boom" });
      },
    );

    it("leaves the request queued when the other worker is full in its view, so the gateway never asks it", async () => {
      const { clients, coordinator } = fleet(["wrk_a", "wrk_b"], (id) =>
        id === "wrk_b" ? { capacity: saturatedIos() } : {},
      );
      clients["wrk_a"]?.requestLeaseQueue.push(provisionFailed("worker a: boom"));
      const untouched = noCapacity();
      clients["wrk_b"]?.requestLeaseQueue.push(untouched);

      const { state } = await ask(coordinator);

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
      expect(clients["wrk_b"]?.requestLeaseQueue).toEqual([untouched]);
    });

    it("leaves the request queued when the worker that is only full refused first and the one asked after a view change failed to provision", async () => {
      const { clients, coordinator, workers } = fleet(["wrk_a", "wrk_b"]);
      clients["wrk_a"]?.requestLeaseQueue.push(noCapacity());
      clients["wrk_b"]?.requestLeaseQueue.push(provisionFailed("worker b: boom"));
      const { state } = await ask(coordinator);

      workers.refresh("wrk_b", { capacity: roomierIos() });
      await tick();

      expect(state.state).toBe("pending");
      expect(coordinator.waitingRequests()).toEqual([expect.objectContaining({ stage: "queued" })]);
    });
  });
});
