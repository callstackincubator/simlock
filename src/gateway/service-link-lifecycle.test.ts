import { describe, expect, it, vi } from "vitest";
import { negotiateProtocolVersion, PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { promiseState } from "../test-support/promise-state.js";
import { REJECTION_COALESCE_WINDOW_MS } from "./service.js";
import {
  deviceFixture,
  hostFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { MAX_CONSECUTIVE_REFRESH_TIMEOUTS, WORKER_CALL_TIMEOUT_MS } from "./worker-link.js";
import { eventNames, fleet, REFRESH_MS, RETENTION_MS } from "./test-service.js";

// why: the 8 MiB the gateway accepts for one unfinished worker reply line, written out so the test pins the number.
const REPLY_LINE_CAP = 8 * 1024 * 1024;

describe("GatewayService", () => {
  it("flips a view to disconnected the moment its uplink closes -- no polling", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    await workerEnd.close();

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  it("does not let a stale link's late close mark a reconnected worker disconnected (D1)", async () => {
    const harness = fleet();
    await harness.service.start();

    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    const workerEndA = await harness.join("wrk_1", clientA);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected"),
    );

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
    // why: A few real event-loop turns for A's now-resolved promise chain to run to completion (or,
    // with the fix, to stop itself before writing) -- nothing here is clock-scheduled, so there
    // is no fake-clock timer to advance instead.
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
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
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

  it("does not hang the handshake forever when hello itself never answers (C3)", async () => {
    const harness = fleet();
    await harness.service.start();

    const workerEnd = await harness.joinSilent("wrk_1", "mac-mini-1");
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

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

  it("closes an uplink whose worker sends an unfinished line past the reply cap, and keeps one at the cap", async () => {
    const harness = fleet({ realConnect: true });
    await harness.service.start();
    const workerEnd = await harness.transport.connect({
      token: "join-secret",
      url: "ws://gateway.test",
      workerId: "wrk_1",
    });
    let helloId: number | string | undefined;
    workerEnd.onData((chunk) => {
      const frame = JSON.parse(chunk.trim().split("\n")[0] ?? "{}") as {
        id?: number | string;
        type?: string;
      };
      if (frame.type === "hello") helloId = frame.id;
    });
    await vi.waitFor(() => expect(helloId).toBeDefined());
    await workerEnd.write(
      `${JSON.stringify({
        id: helloId,
        ok: true,
        payload: {
          daemonProtocolRange: PROTOCOL_VERSION_RANGE,
          principal: "gw:instance-1",
          protocolVersion: negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, PROTOCOL_VERSION_RANGE),
          role: "admin",
          version: "0.3.0",
        },
      })}\n`,
    );
    const chunk = "a".repeat(64 * 1024);
    for (let sent = 0; sent < REPLY_LINE_CAP; sent += chunk.length) {
      await workerEnd.write(chunk);
    }
    expect(workerEnd.closed).toBe(false);
    await workerEnd.write(chunk);
    await vi.waitFor(() => expect(workerEnd.closed).toBe(true));

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

  it.each(["unauthenticated", "forbidden", "worker-mismatch"] as const)(
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

  it("refuses a second worker id on a token pinned to another worker as worker-mismatch, leaving that worker's link alone, while the pinned worker's own redial replaces its link", async () => {
    const pins = new Map<string | undefined, string | undefined>();
    const harness = fleet({
      authenticate: (credential, workerId) => {
        if (!pins.has(credential)) pins.set(credential, workerId);
        return pins.get(credential) === workerId
          ? { outcome: "accept" as const, tokenId: "tok_a" }
          : "worker-mismatch";
      },
    });
    await harness.service.start();
    const workerEndA = await harness.join("wrk_a", new ScriptedWorkerClient("admin", "1.0.0"));
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("connected"),
    );

    await expect(
      harness.join("wrk_b", new ScriptedWorkerClient(), "intruder"),
    ).rejects.toMatchObject({ code: "rejected" });

    expect(harness.events.filter((event) => event.event === "worker.rejected")).toMatchObject([
      { payload: { label: "intruder", reason: "worker-mismatch", workerId: "wrk_b" } },
    ]);
    expect(harness.service.workers.view("wrk_b")).toBeUndefined();
    expect(workerEndA.closed).toBe(false);
    expect(harness.service.workers.view("wrk_a")?.connection).toBe("connected");

    await harness.join("wrk_a", new ScriptedWorkerClient("admin", "2.0.0"));

    await vi.waitFor(() => expect(workerEndA.closed).toBe(true));
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_a")?.version).toBe("2.0.0"));
    expect(harness.service.workers.view("wrk_a")?.connection).toBe("connected");

    await harness.service.stop();
  });

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
