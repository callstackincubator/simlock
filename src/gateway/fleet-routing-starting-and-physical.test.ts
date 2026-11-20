import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { RequesterAlreadyLeasedError } from "./queue.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  hostFixture,
  noCapacityError,
  physicalDeviceFixture,
  type PhysicalPresenceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
import {
  GATEWAY_PREFIX,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  roomierIos,
  requestOptions,
} from "./test-fleet.js";

// why: the coordinator's tests, split by subject; they assert the queue's `RequesterAlreadyLeasedError`, which index.ts does not export.
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const fleetHarness = buildFleet();
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
    const fleetHarness = buildFleet();
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
      const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { clock, coordinator, directory, eventBus, workers } = buildFleet();
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
