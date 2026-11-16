import { describe, expect, it } from "vitest";
import { fromWireError, SimlockError } from "../contract/index.js";
import {
  catalogFixture,
  deviceFixture,
  grantFixture,
  hostFixture,
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
  requestOptions,
} from "./test-fleet.js";

// why: the coordinator's tests, split by subject; they assert the queue's `RequesterAlreadyLeasedError`, which index.ts does not export.
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
    const fleet = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
    const client = new ScriptedWorkerClient();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    workers.refresh("wrk_a", { capabilities: [...available] });

    await coordinator.request(REQUEST, requestOptions({ requires: ["agent-device"] }));

    expect(client.lastRequestLeaseInput).toMatchObject({ requires: ["agent-device"] });
  });

  it("leaves a worker whose own check answers CAPABILITY_MISSING out for this request and tries the next, and gives the caller that error when no worker is left", async () => {
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const made = buildFleet();
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
