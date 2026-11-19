import { describe, expect, it } from "vitest";
import type { LeaseRecord } from "../admin/index.js";
import { SimlockError } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import {
  grantFixture,
  physicalDeviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import {
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  roomierIos,
  requestOptions,
} from "./test-fleet.js";

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
    const fleetHarness = buildFleet();
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
    ["MODE_UNAVAILABLE", "mode-unavailable"],
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
