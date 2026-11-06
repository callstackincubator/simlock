import { describe, expect, it } from "vitest";
import type { EventBus } from "../bus/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import { QueueTimeoutError } from "../leasing/index.js";
import { DispatchError } from "../daemon/dispatch.js";
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
  harness,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  roomierIos,
  requestOptions,
} from "./test-fleet.js";

// why: the coordinator's tests, split by subject; they assert the queue's `RequesterAlreadyLeasedError`, which index.ts does not export.
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

describe("FleetLeaseCoordinator routes an except request by each worker's slim set and default mode (ADR 0066 §5)", () => {
  const every = ["widgets", "store", "mdm", "other"];

  function fleet(
    slims: Readonly<
      Record<
        string,
        {
          categories: string[];
          defaultMode: "slim" | "full";
          baseline?: "slim" | "full";
          busy?: true;
          drained?: true;
          models?: string[];
        }
      >
    >,
  ) {
    const made = harness();
    const clients: Record<string, ScriptedWorkerClient> = {};
    for (const [id, slim] of Object.entries(slims)) {
      const client = new ScriptedWorkerClient();
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      clients[id] = client;
      made.directory.add(id, client);
      connectWorker(made.workers, id, slim.busy === true ? { capacity: saturatedIos() } : {});
      if (slim.drained === true) made.workers.setDrained(id, true);
      made.workers.refresh(id, {
        catalog: catalogFixture([
          {
            defaultMode: slim.defaultMode,
            models: slim.models ?? ["iPhone 17"],
            platform: "ios",
            runtimes: ["26.0"],
            slimCategories: slim.categories,
          },
        ]).platforms,
        ...(slim.baseline === undefined
          ? {}
          : {
              baselines: [
                {
                  mode: slim.baseline,
                  model: "iPhone 17",
                  name: "b",
                  osVersion: "26.0",
                  platform: "ios" as const,
                  savedAt: "2026-11-02T13:10:00Z",
                  version: 1,
                },
              ],
            }),
      });
    }
    return { ...made, clients };
  }

  it("routes an except request by each worker's slim set and default mode, and gives the chosen worker the except list", async () => {
    const cases: {
      label: string;
      request: { baseline?: string; except: string[]; mode?: "slim" | "full" };
      routedTo?: string;
      rejected?: string;
      rejectedCode?: "BAD_REQUEST" | "NO_CAPACITY";
      workers: Parameters<typeof fleet>[0];
    }[] = [
      {
        label: "one worker slims the name",
        request: { except: ["mdm"], mode: "slim" as const },
        routedTo: "wrk_b",
        workers: {
          wrk_a: { categories: ["store"], defaultMode: "full" as const },
          wrk_b: { categories: every, defaultMode: "full" as const },
        },
      },
      {
        label: "two names, one worker slims only the first",
        request: { except: ["store", "mdm"], mode: "slim" as const },
        routedTo: "wrk_b",
        workers: {
          wrk_a: { categories: ["store"], defaultMode: "slim" as const },
          wrk_b: { categories: every, defaultMode: "slim" as const },
        },
      },
      {
        label: "no mode, mixed default modes",
        request: { except: ["store"] },
        routedTo: "wrk_b",
        workers: {
          wrk_a: { categories: every, defaultMode: "full" as const },
          wrk_b: { categories: every, defaultMode: "slim" as const },
        },
      },
      {
        label: "a slim baseline on a worker whose default mode is full",
        request: { baseline: "b", except: ["store"] },
        routedTo: "wrk_a",
        workers: {
          wrk_a: { baseline: "slim" as const, categories: every, defaultMode: "full" as const },
          wrk_b: { categories: every, defaultMode: "slim" as const },
        },
      },
      {
        label: "a full baseline on a worker whose default mode is slim",
        request: { baseline: "b", except: ["store"] },
        rejected: 'no worker can keep slim categories store (baseline "b" is full)',
        workers: {
          wrk_a: { baseline: "full" as const, categories: every, defaultMode: "slim" as const },
        },
      },
      {
        label: "no worker slims the name",
        request: { except: ["other"], mode: "slim" as const },
        rejected: "no worker slims every category in except: other",
        workers: {
          wrk_a: { categories: ["store"], defaultMode: "slim" as const },
          wrk_b: { categories: ["store"], defaultMode: "slim" as const },
        },
      },
      {
        label: "no mode, every worker defaults to full",
        request: { except: ["store"] },
        rejected:
          "no worker can keep slim categories store (default mode is full on every worker that slims them)",
        workers: {
          wrk_a: { categories: every, defaultMode: "full" as const },
          wrk_b: { categories: every, defaultMode: "full" as const },
        },
      },
      {
        label: "the workers that would give a slim device do not serve the model",
        request: { except: ["store"] },
        rejected:
          "no worker can keep slim categories store (no worker that slims them in slim mode serves this model and runtime)",
        workers: {
          wrk_a: { categories: every, defaultMode: "slim" as const, models: ["iPhone 16"] },
          wrk_b: { categories: every, defaultMode: "full" as const },
        },
      },
      {
        label:
          "the one worker that keeps the names is drained, another serves the model without them",
        request: { except: ["mdm"], mode: "slim" as const },
        rejectedCode: "NO_CAPACITY" as const,
        rejected: "No worker in the fleet can currently serve this request",
        workers: {
          wrk_a: { categories: every, defaultMode: "slim" as const, drained: true as const },
          wrk_b: { categories: ["store"], defaultMode: "slim" as const },
        },
      },
      {
        label:
          "the only worker that serves the model is drained and does not keep the names, a taker that keeps them does not serve it",
        request: { except: ["mdm"], mode: "slim" as const },
        rejected:
          "no worker can keep slim categories mdm (no worker that slims them in slim mode serves this model and runtime)",
        workers: {
          wrk_a: { categories: ["store"], defaultMode: "slim" as const, drained: true as const },
          wrk_b: { categories: every, defaultMode: "slim" as const, models: ["iPhone 16"] },
        },
      },
    ];

    for (const { label, request, routedTo, rejected, rejectedCode, workers: slims } of cases) {
      const { clients, coordinator } = fleet(slims);

      if (rejected !== undefined || routedTo === undefined) {
        // why: no `noWait`, so a request the coordinator would only queue shows as "waiting", not as a rejection.
        const outcome = await Promise.race([
          coordinator.request({ ...REQUEST, ...request }, requestOptions()).then(
            () => "granted",
            (error: unknown) => error,
          ),
          tick().then(() => "waiting"),
        ]);
        expect(outcome, label).toMatchObject({
          code: rejectedCode ?? "BAD_REQUEST",
          message: rejected,
        });
        for (const client of Object.values(clients)) {
          expect(client.lastRequestLeaseInput, label).toBeUndefined();
        }
        continue;
      }
      await coordinator.request({ ...REQUEST, ...request }, requestOptions());

      const received = Object.entries(clients)
        .filter(([, client]) => client.lastRequestLeaseInput !== undefined)
        .map(([id]) => id);
      expect(received, label).toEqual([routedTo]);
      expect(clients[routedTo]?.lastRequestLeaseInput, label).toMatchObject({
        except: request.except,
      });
    }

    const waiting = fleet({
      wrk_a: { busy: true, categories: every, defaultMode: "slim" },
      wrk_b: { categories: ["store"], defaultMode: "slim" },
    });
    void waiting.coordinator
      .request({ ...REQUEST, except: ["mdm"] }, requestOptions())
      .catch(() => undefined);
    await tick();

    expect(
      (waiting.coordinator.waitingRequests()[0] as { workers?: unknown } | undefined)?.workers,
    ).toEqual([
      { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_a" },
      { reason: "cannot-keep-except", workerId: "wrk_b" },
    ]);
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
