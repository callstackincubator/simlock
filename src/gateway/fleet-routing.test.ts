import { describe, expect, it } from "vitest";
import type { EventBus } from "../bus/index.js";
import { SimlockError } from "../contract/index.js";
import { QueueTimeoutError } from "../leasing/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import {
  catalogFixture,
  grantFixture,
  hostFixture,
  noCapacityError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";
import {
  buildFleet,
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
    const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    harnessed: ReturnType<typeof buildFleet>,
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
      const fleetHarness = buildFleet();
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
      const fleetHarness = buildFleet();
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
    const fleetHarness = buildFleet();
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
    const { coordinator, eventBus, workers } = buildFleet();
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
      const fleetHarness = buildFleet();
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
    const fleetHarness = buildFleet();
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
      const fleetHarness = buildFleet();
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
      const fleetHarness = buildFleet();
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
    const fleetHarness = buildFleet();
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
      const { coordinator, directory, workers } = buildFleet();
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
    const fleetHarness = buildFleet();
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
