import { describe, expect, it, vi } from "vitest";
import { OPERATIONS, SimlockError, type OperationName } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import {
  deviceFixture,
  hostFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { gatewayConfig, GATEWAY_HOST, harness, session } from "./test-dispatcher.js";

const EVERY_OPERATION = (Object.keys(OPERATIONS) as OperationName[]).filter(
  (name) => name !== "daemon.stop",
);

describe("GatewayDispatcher", () => {
  it("answers identity.get from its own caller's session, the same shape", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch(
        "identity.get",
        {},
        session({ principal: "operator-1", role: "admin", via: "socket" }),
      ),
    ).resolves.toEqual({
      name: "operator-1",
      principal: "operator-1",
      role: "admin",
      via: "socket",
    });
    await expect(
      dispatcher.dispatch(
        "identity.get",
        {},
        session({ name: "ci-runner", principal: "tok_9f2c", role: "agent", via: "token" }),
      ),
    ).resolves.toEqual({ name: "ci-runner", principal: "tok_9f2c", role: "agent", via: "token" });
  });

  it("answers status.get from the fleet", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", {
      capacity: statusFixture().capacity,
      devices: [deviceFixture("dev_1", "leased")],
      health: "running",
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 0,
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.daemon.mode).toBe("gateway");
    expect(status.workers).toHaveLength(1);
    expect(status.devices).toEqual([expect.objectContaining({ workerId: "wrk_1" })]);
    expect(status.leases).toEqual([expect.objectContaining({ workerId: "wrk_1" })]);
  });

  it("status.get on a gateway carries a connected worker's warm pool block from its last refresh, none for an incompatible worker, and an empty block of its own", async () => {
    const { dispatcher, workers } = harness();
    const block = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 0,
          count: 1,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "configured" as const,
          osVersion: "27.0",
          platform: "ios" as const,
          ready: 0,
          short: "runtime-missing" as const,
        },
      ],
    };
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", { health: "running", warmPool: block });
    workers.incompatible(
      "wrk_2",
      undefined,
      { gateway: { min: 20, max: 20 }, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.warmPool).toStrictEqual({
      enabled: false,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
    });
    expect(status.workers?.find((worker) => worker.id === "wrk_1")?.warmPool).toEqual(block);
    expect(status.workers?.find((worker) => worker.id === "wrk_2")).not.toHaveProperty("warmPool");
  });

  it("status.get on a gateway whose health is starting returns daemon, history and host and no other field", async () => {
    const { dispatcher, workers } = harness({ health: "starting" });
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", {
      capacity: statusFixture().capacity,
      devices: [deviceFixture("dev_1", "leased")],
      health: "running",
      leases: [leaseFixture("lease_1", "dev_1")],
      queueDepth: 0,
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(Object.keys(status).sort()).toEqual(["daemon", "history", "host"]);
    expect(status.daemon).toEqual({
      consoleUrl: "http://127.0.0.1:4700/",
      health: "starting",
      mode: "gateway",
      version: "0.0.0-test",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect(status.host).toEqual(GATEWAY_HOST);
  });

  it("a gateway's status.get carries the gateway machine's own load, not its workers', on the starting answer and the running one", async () => {
    const own = { ageMs: 3_000, disk: { freeBytes: 10, totalBytes: 100 } };
    const workerLoad = { readAt: 500, disk: { freeBytes: 99, totalBytes: 100 } };
    const askStatus = async (health: "starting" | "running") => {
      const { dispatcher, workers } = harness({ health, load: () => own });
      workers.connected("wrk_1", undefined, "0.3.0");
      workers.refresh("wrk_1", { health: "running", load: workerLoad });
      return dispatcher.dispatch("status.get", {}, session());
    };

    const starting = await askStatus("starting");
    const running = await askStatus("running");

    expect(starting.load).toEqual(own);
    expect(running.load).toEqual(own);
    expect(running.workers?.[0]?.load).toEqual(workerLoad);
  });

  it("status.get carries consoleUrl when HTTP is enabled and omits it when disabled", async () => {
    const enabled = harness({ http: { enabled: true, host: "0.0.0.0", port: 4711 } });
    const disabled = harness({ http: { enabled: false, host: "0.0.0.0", port: 4711 } });

    const on = await enabled.dispatcher.dispatch("status.get", {}, session());
    const off = await disabled.dispatcher.dispatch("status.get", {}, session());

    expect(on.daemon).toEqual({
      consoleUrl: "http://localhost:4711/",
      health: "running",
      mode: "gateway",
      version: "0.0.0-test",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect(off.daemon).toEqual({
      health: "running",
      mode: "gateway",
      version: "0.0.0-test",
      update: null,
      lastUpdateFailure: null,
      latestVersion: null,
    });
    expect("consoleUrl" in off.daemon).toBe(false);
  });

  it("lists each worker's installs on status.get with its workerId, and on its view in worker.list", async () => {
    const { dispatcher, workers } = harness();
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 500,
      state: "downloading" as const,
      waiters: 2,
    };
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.connected("wrk_2", undefined, "0.3.0");
    workers.refresh("wrk_1", { installs: [install] });
    workers.refresh("wrk_2", { installs: [] });

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = await dispatcher.dispatch("worker.list", {}, session());

    expect(status.installs).toEqual([{ ...install, workerId: "wrk_1" }]);
    expect(list.workers.map((worker) => worker.installs)).toEqual([[install], []]);
  });

  it("reports its own host with no tools on status.get, and each worker's on its view", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", { host: hostFixture() });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.host).toEqual({ arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] });
    expect(status.workers?.[0]?.host).toEqual(hostFixture());
  });

  it("reports each worker device's mode on status.get and worker.list", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      capacity: statusFixture().capacity,
      devices: [deviceFixture("dev_slim", "leased", "slim"), deviceFixture("dev_full")],
      health: "running",
      leases: [],
      queueDepth: 0,
    });

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = await dispatcher.dispatch("worker.list", {}, session());

    const expected = [
      { id: "dev_slim", mode: "slim" },
      { id: "dev_full", mode: "full" },
    ];
    expect(status.devices?.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
    expect(status.workers?.[0]?.devices?.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
    expect(list.workers[0]?.devices?.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
  });

  it("a gateway's status.get gives an agent session a worker's quarantined device with kind and no message, in devices and in workers[].devices, and an admin session the message", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, "0.3.0");
    const quarantineCause = { kind: "purge-failed", message: "Error: erase failed" };
    workers.refresh("wrk_1", {
      capacity: statusFixture().capacity,
      devices: [
        Object.assign(deviceFixture("dev_q"), { quarantineCause, state: "quarantined" as const }),
      ],
      health: "running",
      leases: [],
      queueDepth: 0,
    });

    const forAdmin = await dispatcher.dispatch("status.get", {}, session());
    const forAgent = await dispatcher.dispatch("status.get", {}, session({ role: "agent" }));

    expect(forAdmin.devices?.[0]).toMatchObject({ quarantineCause });
    expect(forAdmin.workers?.[0]?.devices?.[0]).toMatchObject({ quarantineCause });
    expect(forAgent.devices?.[0]).toMatchObject({
      id: "dev_q",
      quarantineCause: { kind: "purge-failed" },
      state: "quarantined",
    });
    expect(forAgent.devices?.[0]).not.toHaveProperty("quarantineCause.message");
    expect(forAgent.workers?.[0]?.devices?.[0]).toMatchObject({
      quarantineCause: { kind: "purge-failed" },
    });
    expect(forAgent.workers?.[0]?.devices?.[0]).not.toHaveProperty("quarantineCause.message");
  });

  it("answers catalog.get as the union of the fleet's catalogs", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.refresh("wrk_1", {
      catalog: [
        {
          modelAliases: {},
          classDefaults: {},
          modelClasses: {} as const,
          modelRuntimes: { "iPhone 17": ["26.0"] },
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
        },
      ],
    });

    const catalog = await dispatcher.dispatch("catalog.get", {}, session());

    expect(catalog.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_1"] });
  });

  it("answers config.get with the gateway's own config", async () => {
    const { dispatcher } = harness();

    await expect(dispatcher.dispatch("config.get", {}, session())).resolves.toEqual(gatewayConfig);
  });

  it("lists workers, and drains, undrains and removes one", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");

    await expect(dispatcher.dispatch("worker.list", {}, session())).resolves.toMatchObject({
      workers: [{ connection: "connected", id: "wrk_1", label: "mac-mini-1" }],
    });

    await expect(
      dispatcher.dispatch("worker.drain", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ drained: true, workerId: "wrk_1" });
    expect(workers.view("wrk_1")?.drained).toBe(true);

    await expect(
      dispatcher.dispatch("worker.undrain", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ drained: false, workerId: "wrk_1" });

    workers.disconnected("wrk_1");
    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_1" }, session()),
    ).resolves.toEqual({ removed: true, workerId: "wrk_1" });
  });

  it("Operator calls worker.update on the gateway: connected, disconnected and unknown workers", async () => {
    const { dispatcher, directory, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    const client = new ScriptedWorkerClient();
    directory.add("wrk_1", client);
    const update = {
      forced: false,
      from: "0.3.0",
      leases: 2,
      stage: "waiting",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    client.updateAnswer = { ...client.updateAnswer, latestVersion: "0.4.0", started: true, update };

    const answer = await dispatcher.dispatch(
      "worker.update",
      { version: "0.4.0", workerId: "wrk_1" },
      session(),
    );

    expect(client.updateInputs).toEqual([{ version: "0.4.0" }]);
    expect(answer).toMatchObject({ started: true, update, workerId: "wrk_1" });
    expect(workers.view("wrk_1")).toMatchObject({ latestVersion: "0.4.0", update });
    expect(directory.refreshCalls).toEqual(["wrk_1"]);

    workers.connected("wrk_2", "mac-mini-2", "0.3.0");
    workers.disconnected("wrk_2");
    for (const { code, message, workerId } of [
      { code: "WORKER_NOT_CONNECTED", message: "worker wrk_2 is not connected", workerId: "wrk_2" },
      { code: "UNKNOWN_WORKER", message: "Unknown worker: wrk_ghost", workerId: "wrk_ghost" },
    ]) {
      await expect(
        dispatcher.dispatch("worker.update", { workerId }, session()),
      ).rejects.toMatchObject({ code, details: { workerId }, message });
    }
  });

  it("worker.update gives up on a worker that does not answer within 90 s with WORKER_NOT_CONNECTED", async () => {
    const { clock, dispatcher, directory, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    const client = new ScriptedWorkerClient();
    client.hangingCalls.add("daemon.update");
    directory.add("wrk_1", client);

    let outcome: unknown = "pending";
    void dispatcher.dispatch("worker.update", { workerId: "wrk_1" }, session()).then(
      (answer) => (outcome = answer),
      (error: unknown) => (outcome = error),
    );
    await vi.waitFor(() => expect(client.updateInputs).toHaveLength(1));
    clock.advance(89_999);
    await Promise.resolve();
    expect(outcome).toBe("pending");
    clock.advance(1);

    await vi.waitFor(() => expect(outcome).not.toBe("pending"));
    expect(outcome).toMatchObject({
      code: "WORKER_NOT_CONNECTED",
      details: { workerId: "wrk_1" },
      message: "worker wrk_1 did not answer within 90 s; check simlock worker list",
    });
  });

  it("worker.update answers what the worker refused with its own code, and a link that closes mid-call with WORKER_NOT_CONNECTED", async () => {
    const { dispatcher, directory, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    const client = new ScriptedWorkerClient();
    directory.add("wrk_1", client);

    for (const { code, kind, expected, message } of [
      {
        code: "UPDATE_RESOLVE_FAILED",
        kind: "domain",
        expected: "UPDATE_RESOLVE_FAILED",
        message: "npm view failed",
      },
      {
        code: "UPDATE_UNSUPPORTED_INSTALL",
        kind: "domain",
        expected: "UPDATE_UNSUPPORTED_INSTALL",
        message: "not npm",
      },
      {
        code: "UPDATE_SHARED_INSTALL",
        kind: "domain",
        expected: "UPDATE_SHARED_INSTALL",
        message: "shared",
      },
      {
        code: "DAEMON_CONNECTION_LOST",
        kind: "transport",
        expected: "WORKER_NOT_CONNECTED",
        message: "worker wrk_1 is not connected",
      },
    ] as const) {
      client.updateFailWith = new SimlockError(code, kind, "worker's words", {});
      // why: HTTP maps a rejection through classifyError, which knows DispatchError and not a raw SimlockError.
      const refusal = await dispatcher
        .dispatch("worker.update", { workerId: "wrk_1" }, session())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(DispatchError);
      expect(refusal).toMatchObject({
        code: expected,
        message: expected === code ? "worker's words" : message,
      });
    }
  });

  it("an operator-drained worker stays drained through its update, and a drain during an update leaves the update alone", async () => {
    const { dispatcher, directory, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    const client = new ScriptedWorkerClient();
    directory.add("wrk_1", client);
    const update = {
      forced: false,
      from: "0.3.0",
      stage: "installing",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    await dispatcher.dispatch("worker.drain", { workerId: "wrk_1" }, session());
    client.updateAnswer = { ...client.updateAnswer, started: true, update };

    await dispatcher.dispatch("worker.update", { workerId: "wrk_1" }, session());
    expect(workers.view("wrk_1")).toMatchObject({ drained: true, update });
    workers.refresh("wrk_1", { update: null });
    expect(workers.view("wrk_1")).toMatchObject({ drained: true, update: null });

    await dispatcher.dispatch("worker.undrain", { workerId: "wrk_1" }, session());
    workers.refresh("wrk_1", { update });
    await dispatcher.dispatch("worker.drain", { workerId: "wrk_1" }, session());
    expect(workers.view("wrk_1")).toMatchObject({ drained: true, update });
  });

  it("refuses to remove a connected worker with WORKER_CONNECTED, naming it", async () => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);

    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_1" }, session()),
    ).rejects.toMatchObject({ code: "WORKER_CONNECTED", details: { workerId: "wrk_1" } });
  });

  it("reports removed: false for a worker it has never heard of", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch("worker.remove", { workerId: "wrk_ghost" }, session()),
    ).resolves.toEqual({ removed: false, workerId: "wrk_ghost" });
  });

  it("answers UNKNOWN_WORKER when asked to drain a worker it has no view of", async () => {
    const { dispatcher } = harness();

    await expect(
      dispatcher.dispatch("worker.drain", { workerId: "wrk_ghost" }, session()),
    ).rejects.toMatchObject({ code: "UNKNOWN_WORKER", details: { workerId: "wrk_ghost" } });
  });

  it.each([
    ["worker.list", {}],
    ["worker.drain", { workerId: "wrk_1" }],
    ["worker.undrain", { workerId: "wrk_1" }],
    ["worker.remove", { workerId: "wrk_1" }],
  ] as const)("keeps %s admin-only", async (operation, input) => {
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");

    await expect(
      dispatcher.dispatch(operation, input, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("has an answer for every operation the contract declares", async () => {
    const inputs: Partial<Record<OperationName, unknown>> = {
      "driver.passthrough": { args: [], tool: "adb" },
      "lease.release": { leaseId: "lease_1" },
      "lease.renew": { leaseId: "lease_1" },
      // why: `noWait: true` matters here: with no worker connected, an ordinary "wait" request would
      // sit in the fleet queue forever and hang this test rather than answer promptly.
      "lease.request": { model: "iPhone 17", noWait: true, platform: "ios" },
      "token.create": { role: "agent" },
      "token.revoke": { id: "tok_1" },
      "worker.drain": { workerId: "wrk_1" },
      "worker.remove": { workerId: "wrk_1" },
      "worker.undrain": { workerId: "wrk_1" },
      "worker.update": { workerId: "wrk_1" },
    };
    const { dispatcher, workers } = harness();
    workers.connected("wrk_1", undefined, undefined);
    workers.disconnected("wrk_1");

    for (const operation of EVERY_OPERATION) {
      const outcome = await dispatcher.dispatch(operation, inputs[operation] ?? {}, session()).then(
        () => "answered",
        (error: unknown) => (error as { code?: string }).code ?? "threw",
      );
      expect({ operation, outcome }).not.toEqual({ operation, outcome: "UNKNOWN_REQUEST" });
    }
  });
});
