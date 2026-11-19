import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { promiseState } from "../test-support/promise-state.js";
import { grantFixture, ScriptedWorkerClient } from "./test-support.js";
import {
  GATEWAY_PREFIX,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  requestOptions,
} from "./test-fleet.js";

describe("FleetLeaseCoordinator dispatch", () => {
  it("forwards device.exec with the namespaced requesterId reaching the scripted worker client", async () => {
    const { coordinator, directory, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
      const { coordinator, directory, eventBus, workers } = buildFleet();
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
    const { coordinator, directory, workers } = buildFleet();
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
    const { clock, coordinator, directory, workers } = buildFleet();
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
    const { clock, coordinator, directory, workers } = buildFleet({ execTimeoutMs: 5_000 });
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

  it("times out a forwarded device.rotate after gateway.execTimeoutMs when the worker never answers", async () => {
    const { clock, coordinator, directory, workers } = buildFleet({ execTimeoutMs: 5_000 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const grant = await coordinator.request(REQUEST, requestOptions());
    client.hangingCalls.add("device.rotate");

    const rotation = coordinator.rotate(
      { leaseId: grant.lease.id, orientation: "landscape_left" },
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent-1",
        role: "agent",
      },
    );
    const rotationState = promiseState(rotation);
    const rejection = rotation.catch((error: unknown) => error);
    await tick();
    clock.advance(4_999);
    await tick();
    expect(rotationState.state).toBe("pending");

    clock.advance(1);
    await tick();
    expect(rotationState.state).toBe("rejected");
    const error = await rejection;
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe("EXEC_TIMEOUT");
  });

  it("stops relaying a worker's device.exec output once gateway.execTimeoutMs has already rejected the call (H4, round 3 review)", async () => {
    const { clock, coordinator, directory, workers } = buildFleet({ execTimeoutMs: 5_000 });
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
    const { clock, coordinator, directory, workers } = buildFleet({ execTimeoutMs: 5_000 });
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
    const { coordinator, directory, workers } = buildFleet();
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
});
