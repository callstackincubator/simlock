import { afterEach, describe, expect, it } from "vitest";
import { granted, HOUR, removeUsageRigs, requested, T0, usageRig } from "../history/testing.js";
import type { GatewayDispatcher } from "./dispatcher.js";
import {
  catalogFixture,
  physicalDeviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher: waiting requests", () => {
  const SPEC = { model: "iPhone 17", platform: "ios" as const };

  function onWorker(
    id: string,
    requesterId: string,
    queuePosition?: number,
    reason?: "platform-running-limit",
    workers?: { reason: "drained"; workerId: string }[],
  ) {
    return {
      createdAt: 500,
      id,
      requesterId,
      spec: SPEC,
      ...(queuePosition === undefined
        ? { stage: "starting" as const }
        : { queuePosition, stage: "queued" as const }),
      ...(reason === undefined ? {} : { reason }),
      ...(workers === undefined ? {} : { workers }),
    };
  }

  async function settle(): Promise<void> {
    for (let count = 0; count < 20; count += 1) await Promise.resolve();
  }

  const listRequests = (dispatcher: GatewayDispatcher) =>
    dispatcher.dispatch("list.get", { kind: "requests" }, session());

  it("list.get requests and status.get waiting on a gateway return the fleet queue with each worker's reason in workers, and each worker's waiting requests with their workerId and reason, a workers field a worker sends on its own entry dropped", async () => {
    const { dispatcher, workers } = harness();
    const capacity = statusFixture().capacity;
    for (const [workerId, requestId] of [
      ["wrk_1", "req_w1"],
      ["wrk_2", "req_w2"],
    ] as const) {
      workers.connected(workerId, undefined, "0.3.0");
      workers.refresh(workerId, {
        capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } },
        catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
          .platforms,
        health: "running",
        queueDepth: 0,
        waiting: [
          onWorker(
            requestId,
            `local-${workerId}`,
            1,
            workerId === "wrk_1" ? "platform-running-limit" : undefined,
            workerId === "wrk_2" ? [{ reason: "drained", workerId: "wrk_x" }] : undefined,
          ),
        ],
      });
    }
    void dispatcher.dispatch(
      "lease.request",
      { ...SPEC, idempotencyKey: "key-1", requesterId: "fleet-agent" },
      session({ principal: "fleet-owner", role: "agent" }),
    );
    await settle();

    const listed = await listRequests(dispatcher);

    expect(listed).toEqual([
      {
        createdAt: 1_000,
        id: expect.any(String),
        queuePosition: 1,
        requesterId: "fleet-agent",
        spec: SPEC,
        stage: "queued",
        workers: [
          { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_1" },
          { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_2" },
        ],
      },
      { ...onWorker("req_w1", "local-wrk_1", 1, "platform-running-limit"), workerId: "wrk_1" },
      { ...onWorker("req_w2", "local-wrk_2", 1), workerId: "wrk_2" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("key-1");
    expect(JSON.stringify(listed)).not.toContain("fleet-owner");
    const status = await dispatcher.dispatch("status.get", {}, session());
    expect(status.waiting).toEqual([listed[0]]);
  });

  it("status.get lists and lease.cancel {platform} cancels only the named platform's waiting fleet request, each gated on that request's owner", async () => {
    const { coordinator, dispatcher, workers } = harness();
    const capacity = statusFixture().capacity;
    // why: both platforms are full, so each fleet request waits in the gateway's own queue.
    for (const [workerId, platform, model] of [
      ["wrk_ios", "ios", "iPhone 17"],
      ["wrk_android", "android", "Pixel 9"],
    ] as const) {
      workers.connected(workerId, undefined, "0.3.0");
      workers.refresh(workerId, {
        capacity: {
          ...capacity,
          android: { ...capacity.android, maxRunning: 0 },
          ios: { ...capacity.ios, maxRunning: 0 },
        },
        catalog: catalogFixture([{ models: [model], platform, runtimes: ["26.0"] }]).platforms,
        health: "running",
        queueDepth: 0,
        waiting: [],
      });
    }
    const request = (platform: "ios" | "android", owner: string) =>
      dispatcher.dispatch(
        "lease.request",
        {
          model: platform === "ios" ? "iPhone 17" : "Pixel 9",
          platform,
          requesterId: "fleet-agent",
        },
        session({ principal: owner, role: "agent" }),
      );
    void request("ios", "owner-ios").catch(() => undefined);
    await settle();
    void request("android", "owner-android").catch(() => undefined);
    await settle();
    const waitingPlatforms = () =>
      coordinator
        .waitingRequests()
        .map((waiting) => waiting.spec.platform)
        .sort();
    expect(waitingPlatforms()).toEqual(["android", "ios"]);

    // why: both rows share one requester label, so a status lookup that ignored the platform would list the android row to the iOS owner.
    const listedTo = async (principal: string) =>
      (
        await dispatcher.dispatch("status.get", {}, session({ principal, role: "agent" }))
      ).waiting?.map((waiting) => waiting.spec.platform);
    expect([await listedTo("owner-ios"), await listedTo("owner-android")]).toEqual([
      ["ios"],
      ["android"],
    ]);

    // why: the iOS request is the earliest, so a hook that ignored the platform would name its owner.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { platform: "android", requesterId: "fleet-agent" },
        session({ principal: "owner-ios", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { platform: "android", requesterId: "fleet-agent" },
        session({ principal: "owner-android", role: "agent" }),
      ),
    ).resolves.toEqual({ result: "cancelled" });

    expect(waitingPlatforms()).toEqual(["ios"]);
  });

  it("a fleet request dispatched to a worker is listed once, by the gateway", async () => {
    const { dispatcher, directory, workers } = harness();
    const client = new ScriptedWorkerClient();
    directory.add("wrk_1", client);
    client.requestLeaseQueue.push({ kind: "hang" });
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      capacity: {
        ...statusFixture().capacity,
        ios: { ...statusFixture().capacity.ios, limit: 4, maxRunning: 4 },
      },
      health: "running",
      queueDepth: 0,
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
    });
    void dispatcher.dispatch(
      "lease.request",
      { ...SPEC, requesterId: "fleet-agent" },
      session({ principal: "fleet-owner", role: "agent" }),
    );
    await settle();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toHaveLength(1);
    workers.refresh("wrk_1", {
      waiting: [
        onWorker("req_from_gateway", `${GATEWAY_REQUESTER_PREFIX}fleet-agent`),
        onWorker("req_local", "local-agent", 1),
      ],
    });

    const listed = await listRequests(dispatcher);

    expect(listed).toEqual([
      {
        createdAt: 1_000,
        id: expect.any(String),
        requesterId: "fleet-agent",
        spec: SPEC,
        stage: "starting",
      },
      { ...onWorker("req_local", "local-agent", 1), workerId: "wrk_1" },
    ]);
  });
});

describe("GatewayDispatcher: the fleet queue's physical line", () => {
  async function settle(): Promise<void> {
    for (let count = 0; count < 20; count += 1) await Promise.resolve();
  }

  function options(requesterId: string) {
    return { allowDownload: false, noWait: false, ownerId: requesterId, requesterId };
  }

  it("with two virtual requests and one physical request in the fleet queue, the gateway's status.get shows queueDepth 2 and physicalQueueDepth 1; the physical request has queuePosition 1 in waiting and in lease.queued; its queue.changed carries physical: true and depth 1", async () => {
    const { coordinator, directory, dispatcher, eventBus, workers } = harness();
    directory.add("wrk_1", new ScriptedWorkerClient());
    const capacity = statusFixture().capacity;
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      capacity: { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } },
      catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
        .platforms,
      devices: [physicalDeviceFixture("dev_p", "leased", { model: "iPhone 17" })],
      health: "running",
      leases: [],
      queueDepth: 0,
    });
    const queued: { requestId: string; queuePosition: number }[] = [];
    eventBus.subscribe("lease.queued", (envelope) => queued.push(envelope.payload));
    const changed: unknown[] = [];
    eventBus.subscribe("queue.changed", (envelope) => changed.push(envelope.payload));
    const virtual = { model: "iPhone 17", platform: "ios" as const };
    const physical = { ...virtual, physical: true as const };

    void coordinator.request(virtual, options("agent-1")).catch(() => undefined);
    await settle();
    void coordinator.request(virtual, options("agent-2")).catch(() => undefined);
    await settle();
    void coordinator.request(physical, options("agent-3")).catch(() => undefined);
    await settle();

    const status = await dispatcher.dispatch("status.get", {}, session());
    expect(status).toMatchObject({ physicalQueueDepth: 1, queueDepth: 2 });
    const waiting = status.waiting?.find((request) => request.requesterId === "agent-3");
    expect(waiting).toMatchObject({ queuePosition: 1, stage: "queued" });
    expect(queued.find((event) => event.requestId === waiting?.id)).toMatchObject({
      queuePosition: 1,
    });
    expect(changed).toContainEqual(expect.objectContaining({ depth: 1, physical: true }));
  });
});

describe("GatewayDispatcher: usage.get", () => {
  afterEach(removeUsageRigs);

  const window = { from: T0, to: T0 + HOUR };

  async function fleetHistory() {
    const rig = await usageRig({ fleet: true });
    const gate = { open: true };
    const eventHistory = {
      replay: (input?: { readonly sinceTs?: number }) => rig.history.replay(input),
      replayPage: (input: { readonly beforeId?: string; readonly limit: number }) =>
        rig.history.replayPage(input),
      status: () => ({ ...rig.history.status(), opened: gate.open && rig.history.status().opened }),
    };
    return { eventHistory, gate, rig };
  }

  it("the gateway handler answers HISTORY_UNAVAILABLE with the message naming daemon.log while history.status().opened is false, after answering figures while it was true", async () => {
    const { eventHistory, gate, rig } = await fleetHistory();
    rig.emit("lease.requested", requested("G1"));
    const { dispatcher } = harness({ eventHistory, historyPath: rig.historyPath });

    await expect(dispatcher.dispatch("usage.get", window, session())).resolves.toMatchObject({
      totals: { requests: 1 },
    });
    gate.open = false;

    await expect(dispatcher.dispatch("usage.get", window, session())).rejects.toMatchObject({
      code: "HISTORY_UNAVAILABLE",
      message: "The history could not be opened, so no figures can be read; see daemon.log.",
    });
  });

  it("the gateway handler strips its own gw: prefix before the label lookup and leaves another prefix alone, labels nothing when it has no token store, and with includeLedger lists the request rows as entries labelled the same way", async () => {
    const { eventHistory, rig } = await fleetHistory();
    for (const [index, requester] of [
      `${GATEWAY_REQUESTER_PREFIX}tok_a`,
      "gw:other-instance:tok_a",
      "tok_a",
    ].entries()) {
      rig.emit("lease.requested", requested(`R${index}`, { requester }));
    }
    const labelled = harness({
      eventHistory,
      historyPath: rig.historyPath,
      tokenRecords: [{ id: "tok_a", label: "ci-bot" }],
    });
    const unlabelled = harness({
      eventHistory,
      historyPath: rig.historyPath,
      withoutTokens: true,
    });

    const answer = await labelled.dispatcher.dispatch("usage.get", window, session());
    const bare = await unlabelled.dispatcher.dispatch("usage.get", window, session());
    const ledger = await labelled.dispatcher.dispatch(
      "usage.get",
      { ...window, includeLedger: true },
      session(),
    );

    expect(
      Object.fromEntries(answer.requesters.map((requester) => [requester.id, requester.label])),
    ).toEqual({
      "gw:instance-1:tok_a": "ci-bot",
      "gw:other-instance:tok_a": undefined,
      tok_a: "ci-bot",
    });
    expect(bare.requesters).toHaveLength(3);
    expect(bare.requesters.every((requester) => !("label" in requester))).toBe(true);
    expect(
      Object.fromEntries((ledger.requests ?? []).map((entry) => [entry.requestId, entry.label])),
    ).toEqual({ R0: "ci-bot", R1: undefined, R2: "ci-bot" });
    expect(answer).not.toHaveProperty("requests");
  });

  it("the gateway handler lists every registry worker with its label and a worker id the rows name that the registry lacks, and counts a fleet request with no worker in totals and its platform only", async () => {
    const { eventHistory, rig } = await fleetHistory();
    rig.emit("lease.requested", requested("G1"));
    rig.emit("lease.requested", requested("G2"));
    rig.emit("lease.requested", requested("G3"));
    rig.relay("wrk_1", "lease.granted", granted("WL1", "G1"), T0 + 1_000);
    rig.relay("wrk_9", "lease.granted", granted("WL9", "G3"), T0 + 1_000);
    rig.at(T0 + 2_000);
    rig.emit("request.granted", {
      leaseId: "GL1",
      requestId: "G1",
      worker: "wrk_1",
      workerLeaseId: "WL1",
    });
    rig.emit("request.granted", {
      leaseId: "GL3",
      requestId: "G3",
      worker: "wrk_9",
      workerLeaseId: "WL9",
    });
    const { dispatcher, workers } = harness({ eventHistory, historyPath: rig.historyPath });
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.connected("wrk_2", undefined, "0.3.0");

    const answer = await dispatcher.dispatch("usage.get", window, session());

    expect(answer.workers.map((entry) => [entry.id, entry.label, entry.requests])).toEqual([
      ["wrk_1", "mac-mini-1", 1],
      ["wrk_2", undefined, 0],
      ["wrk_9", undefined, 1],
    ]);
    expect(answer.totals.requests).toBe(3);
    expect(answer.platforms.ios.requests).toBe(3);
  });
});
