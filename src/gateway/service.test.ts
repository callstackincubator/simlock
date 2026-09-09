import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  FakeClock,
  MemoryUplinkTransport,
  type Logger,
  type UplinkAuthOutcome,
  type UplinkAuthResult,
} from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { GatewayService, REJECTION_COALESCE_WINDOW_MS } from "./service.js";
import {
  catalogFixture,
  deviceFixture,
  leaseFixture,
  protocolMismatchError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { MAX_CONSECUTIVE_REFRESH_TIMEOUTS, WORKER_CALL_TIMEOUT_MS } from "./worker-link.js";

const RETENTION_MS = 24 * 60 * 60_000;
const REFRESH_MS = 30_000;
/** Matches `core/config.ts`'s own default (ADR 0005 §15's own cap). */
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

/** H4: records every line at `warn` and `error` (the levels a link's own failure paths use), so
 * a test can assert what a failure was actually logged *as* -- not just that something failed. */
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

function fleet(
  options: {
    readonly authenticate?: (
      credential: string | undefined,
    ) => UplinkAuthOutcome | UplinkAuthResult;
    readonly leaseMaxTtlMs?: number;
    readonly logger?: Logger;
    readonly refreshIntervalMs?: number;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const transport = new MemoryUplinkTransport();
  /** The scripted worker each uplink resolves to, keyed by the principal-free order they join. */
  const clients: ScriptedWorkerClient[] = [];
  // C3: set to make the *next* `connect()` -- the `hello` round trip itself -- never resolve,
  // the way a peer that completes the WebSocket upgrade and then falls silent would.
  const connectState = { hangNext: false };
  const service = new GatewayService({
    authenticate: async (credential) => options.authenticate?.(credential) ?? "accept",
    clock,
    connect: async () => {
      if (connectState.hangNext) {
        connectState.hangNext = false;
        return new Promise<never>(() => {});
      }
      const client = clients.at(-1);
      if (client === undefined) throw new Error("no scripted worker was queued for this uplink");
      return client.asClient();
    },
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? DEFAULT_LEASE_MAX_TTL_MS,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    principal: "gw:instance-1",
    refreshIntervalMs: options.refreshIntervalMs ?? REFRESH_MS,
    retentionMs: RETENTION_MS,
    uplinks: transport,
  });
  return {
    clients,
    clock,
    events,
    service,
    transport,
    /** Queues the worker the next uplink resolves to, then dials it. `token` defaults to the
     * fixed secret every other test relies on; C-2's test overrides it per worker so a custom
     * `authenticate` can hand back a distinct `tokenId` for each. */
    join: async (
      workerId: string,
      client: ScriptedWorkerClient,
      label?: string,
      token = "join-secret",
    ) => {
      clients.push(client);
      return transport.connect({
        token,
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
    /** Dials an uplink whose `hello` never answers -- no `ScriptedWorkerClient` is ever built,
     * since C3's whole point is that the handshake itself must not be able to hang forever. */
    joinSilent: async (workerId: string, label?: string) => {
      connectState.hangNext = true;
      return transport.connect({
        token: "join-secret",
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
  };
}

function eventNames(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.event);
}

describe("GatewayService", () => {
  it("builds a view from the four calls ADR 0005 §7 prescribes", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ leases: [leaseFixture("lease_1", "dev_1")], queueDepth: 1 });
    worker.devices = [deviceFixture("dev_1", "leased")];
    worker.catalog = catalogFixture([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);

    await harness.join("wrk_1", worker, "mac-mini-1");
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    expect(worker.calls).toContain("status.get");
    expect(worker.calls).toContain("list.get:devices");
    expect(worker.calls).toContain("catalog.get");
    expect(worker.calls).toContain("events.subscribe");
    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      catalog: [{ models: ["iPhone 17"] }],
      connection: "connected",
      devices: [{ id: "dev_1" }],
      downloads: { policy: "on-request" },
      id: "wrk_1",
      label: "mac-mini-1",
      leases: [{ id: "lease_1" }],
      queueDepth: 1,
      version: "0.3.0",
    });
    expect(eventNames(harness.events)).toContain("worker.connected");

    await harness.service.stop();
  });

  it("narrows a worker's device records: no driver-private data crosses the fleet", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.devices = [
      {
        ...deviceFixture("dev_1"),
        createdAt: 1,
        driverData: { secret: "a driver's private blob" },
        driverDeviceId: "UDID-1",
      },
    ];

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.devices).toHaveLength(1));

    const device = harness.service.workers.view("wrk_1")?.devices[0];
    expect(device).toMatchObject({ id: "dev_1", state: "ready" });
    expect(device).not.toHaveProperty("driverData");
    expect(device).not.toHaveProperty("driverDeviceId");

    await harness.service.stop();
  });

  it("republishes a worker's events with its workerId, into its own ring buffer", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });

    const republished = harness.events.find((event) => event.event === "lease.granted");
    expect(republished).toMatchObject({
      // The name and the emitting module travel unchanged -- the fact happened in that
      // worker's lease engine, and `workerId` is what says which machine.
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", workerId: "wrk_1" },
    });

    await harness.service.stop();
  });

  // Hardening: a worker's event name is taken on faith from its own `events.subscribe` push --
  // `workerId` is merged in last so it cannot be spoofed, but nothing about the protocol proves
  // the *name* is genuinely the worker's own. Without a guard, a worker (or anything speaking
  // its admin protocol) could forge one of the six subjects `docs/EVENTS.md` calls "the
  // gateway's own" -- e.g. `worker.drain-ended` -- straight into the operator's audit trail.
  it("refuses to republish a worker's event under a name reserved for the gateway itself", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));

    worker.pushEvent({
      event: "worker.drain-ended",
      module: "gateway",
      payload: { workerId: "wrk_forged", label: "not-this-worker" },
    });
    // A genuine event from the same worker still goes through -- the guard is on the six names,
    // not on this link entirely.
    worker.pushEvent({
      event: "lease.granted",
      module: "lease-engine",
      payload: { deviceId: "dev_1", leaseId: "lease_1", requester: "agent-1" },
    });
    await vi.waitFor(() =>
      expect(harness.events.some((event) => event.event === "lease.granted")).toBe(true),
    );

    const forged = harness.events.filter((event) => event.event === "worker.drain-ended");
    // Never forwarded, and never with the forged `workerId` a real gateway-authored
    // `worker.drain-ended` for a *different* worker would otherwise be indistinguishable from.
    expect(forged).toEqual([]);

    await harness.service.stop();
  });

  it("refreshes the view on a worker event that changes capacity or leases", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    const callsBefore = worker.calls.length;
    worker.status = statusFixture({ leases: [leaseFixture("lease_9", "dev_9")] });

    worker.pushEvent({ event: "lease.granted" });

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.leases).toEqual([
        expect.objectContaining({ id: "lease_9" }),
      ]),
    );
    expect(worker.calls.length).toBeGreaterThan(callsBefore);

    await harness.service.stop();
  });

  it("does not re-read the fleet for an event that changes neither", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    const callsBefore = worker.calls.length;

    worker.pushEvent({ event: "doctor.reconciled" });
    // Still republished -- every worker fact reaches the gateway's buffer -- just not a reason
    // to re-read anything.
    await vi.waitFor(() => expect(eventNames(harness.events)).toContain("doctor.reconciled"));

    expect(worker.calls).toHaveLength(callsBefore);

    await harness.service.stop();
  });

  it("refreshes every view on the periodic tick, catalog included", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());
    worker.catalog = catalogFixture([
      { models: ["iPhone 17", "iPad Pro"], platform: "ios", runtimes: ["26.0"] },
    ]);

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.catalog[0]?.models).toEqual([
        "iPhone 17",
        "iPad Pro",
      ]),
    );

    await harness.service.stop();
  });

  describe("warning on a worker's lower lease.maxTtlMs (ADR 0005 §15)", () => {
    it("warns once the joining worker's own config.get reports a lower cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker, "mac-mini-1");
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      const warning = logger.warnings.find((entry) => entry.fields?.workerId === "wrk_1");
      expect(warning?.fields).toMatchObject({
        gatewayMaxTtlMs: 3_600_000,
        label: "mac-mini-1",
        workerMaxTtlMs: 1_800_000,
      });

      await harness.service.stop();
    });

    it("does not warn when the joining worker's own cap is at or above the gateway's", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 3_600_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      expect(logger.warnings.some((entry) => entry.fields?.workerId === "wrk_1")).toBe(false);

      await harness.service.stop();
    });

    it("does not repeat the warning on the periodic tick's re-read of an unchanged cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());
      const warningsAfterJoin = logger.warnings.filter(
        (entry) => entry.fields?.workerId === "wrk_1",
      ).length;
      expect(warningsAfterJoin).toBe(1);

      // The periodic backstop tick re-reads config.get alongside the catalog
      // (`#runTick` -> `link.refresh({ includeCatalog: true })`) -- the worker's cap has not
      // moved, so this must not warn again.
      const callsBefore = worker.calls.filter((call) => call === "config.get").length;
      harness.clock.advance(REFRESH_MS);
      await vi.waitFor(() =>
        expect(worker.calls.filter((call) => call === "config.get").length).toBeGreaterThan(
          callsBefore,
        ),
      );

      expect(logger.warnings.filter((entry) => entry.fields?.workerId === "wrk_1").length).toBe(
        warningsAfterJoin,
      );

      await harness.service.stop();
    });
  });

  it("marks a worker incompatible when hello finds no overlapping range, and asks it nothing else", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    // What `connectSimlockAdmin`'s degraded client does after a failed negotiation: every call
    // rejects with the captured error, carrying both ranges.
    worker.failWith = protocolMismatchError({ min: 4, max: 4 });

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);
    // ADR 0005 §31: that uplink authenticated, so it is not a `worker.rejected` -- and there
    // is no `worker.connected` either, because nothing usable connected.
    expect(eventNames(harness.events)).not.toContain("worker.rejected");
    expect(eventNames(harness.events)).not.toContain("worker.connected");

    await harness.service.stop();
  });

  it("flips a view to disconnected the moment its uplink closes -- no polling", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    await workerEnd.close();

    // Not on the next tick: the uplink is the reachability signal (ADR 0005 §6).
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  // D1: `WorkerRegistry` is keyed by worker id, not by link, and a stale link's own close used
  // to call `registry.disconnected` with no check at all -- so a socket the OS had not yet
  // reported dead could mark the *live* successor's view disconnected, permanently (`refresh()`
  // never touches `connection`). Against the code before this fix, no test joined the same
  // worker id twice against a live service; this is that test.
  it("does not let a stale link's late close mark a reconnected worker disconnected (D1)", async () => {
    const harness = fleet();
    await harness.service.start();

    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    const workerEndA = await harness.join("wrk_1", clientA);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected"),
    );

    // A's own close, once the reconnect below triggers it, must never actually complete during
    // this test: a hung `events.unsubscribe` (D2) is exactly what stretches a stale link's close
    // from microseconds to minutes in the wild, and here it lets the test control precisely
    // when A's connection actually goes away.
    clientA.hangUnsubscribe = true;

    // The same worker id redials with a new connection -- a restart, or a new TCP path after a
    // NAT rebind. The service replaces the link; A's old one is asked to close but (per above)
    // never gets there.
    const clientB = new ScriptedWorkerClient("admin", "9.9.9");
    await harness.join("wrk_1", clientB);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));

    // Only now does the OS finally report the stale socket dead. Closing the worker's own end
    // fires the connection's real close event directly, bypassing A's still-stuck `close()`
    // chain -- exactly what a genuinely half-open socket closing on its own would do.
    await workerEndA.close();

    expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9");
    expect(eventNames(harness.events)).not.toContain("worker.disconnected");

    await harness.service.stop();
  });

  // D2: `close()` awaited `events.unsubscribe` -- a real round trip -- with nothing bounding it.
  // On a half-open socket that promise never settled, so `close()` never reached
  // `connection.close()` and the link (and its WebSocket) leaked for the life of the process.
  it("does not hang close() forever behind an events.unsubscribe that never answers (D2)", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(worker.subscribed).toBe(true));
    worker.hangUnsubscribe = true;

    const stopped = harness.service.stop();
    // `stop()` is now blocked inside `link.close()`, awaiting the bounded wrapper around the
    // hung unsubscribe -- wait for that timer to actually be armed before advancing past it.
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await expect(stopped).resolves.toBeUndefined();
    expect(worker.closed).toBe(true);
  });

  // D3: a hung round trip inside `#rebuildView` used to latch `#refreshing` forever, since it
  // was cleared only in a `finally` on a promise that never settled -- freezing the view while
  // it still reported `connected`.
  it("does not latch refreshing forever when a round trip hangs, and recovers past the timeout (D3)", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    worker.hangingCalls.add("status.get");
    worker.status = statusFixture({ leases: [leaseFixture("lease_9", "dev_9")] });
    worker.pushEvent({ event: "lease.granted" });

    // The refresh this event triggered is now stuck inside `#rebuildView`'s bounded wait.
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    // Once the hung refresh times out and un-latches `#refreshing`, a later event must still be
    // able to trigger a real one -- proving the latch did not stay stuck.
    worker.hangingCalls.delete("status.get");
    worker.pushEvent({ event: "lease.granted" });

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.leases).toEqual([
        expect.objectContaining({ id: "lease_9" }),
      ]),
    );

    await harness.service.stop();
  });

  // H2: the same asymmetry D1 fixed in `#handleClosed`, one write later -- `#rebuildView` wrote
  // to `registry.refresh` after its own `await` with no re-check of `#closed` or
  // `isCurrentLink`. A stale link's in-flight refresh, started before a reconnect replaced it,
  // could land after its successor's fresher one and overwrite it with stale data for up to
  // `WORKER_CALL_TIMEOUT_MS`.
  it("does not let a stale link's late-arriving refresh overwrite its successor's fresher view (H2)", async () => {
    const harness = fleet();
    await harness.service.start();

    const clientA = new ScriptedWorkerClient("admin", "0.1.0");
    await harness.join("wrk_1", clientA);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("0.1.0"));

    // A's refresh, triggered by a worker event, is in flight but held open by hand -- long
    // enough for a reconnect to fully replace this link before it ever answers.
    let resolveStatus: ((status: ReturnType<typeof statusFixture>) => void) | undefined;
    clientA.getStatus = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    clientA.pushEvent({ event: "lease.granted" });
    await vi.waitFor(() => expect(resolveStatus).toBeDefined());

    // The same worker id redials with a new connection -- service.ts replaces A's link with B's,
    // which builds its own, current view.
    const clientB = new ScriptedWorkerClient("admin", "9.9.9");
    await harness.join("wrk_1", clientB);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));

    // Only now does A's stale round trip finally answer -- exactly what a slow or half-open path
    // answering late would do, well after B has already built the current view.
    resolveStatus?.(statusFixture());
    // A few real event-loop turns for A's now-resolved promise chain to run to completion (or,
    // with the fix, to stop itself before writing) -- nothing here is clock-scheduled, so there
    // is no fake-clock timer to advance instead.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9");

    await harness.service.stop();
  });

  // H4: a timed-out `events.subscribe` used to be logged exactly like a rejection ("Worker
  // refused an event subscription"), asserting something this code cannot know -- the worker may
  // never have answered at all, or may have subscribed successfully with the reply just arriving
  // too late to matter. The two are worth telling apart in a log an operator reads.
  it("logs a timed-out event subscription as a timeout, not a refusal (H4)", async () => {
    const logger = new RecordingLogger();
    const harness = fleet({ logger });
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    // Never resolves, unlike a real rejection -- the exact shape of a subscribe call that just
    // never gets an answer within `WORKER_CALL_TIMEOUT_MS`. Tracked by hand rather than via
    // `pendingTimerCount` alone: the service's own periodic tick timer is already pending from
    // `service.start()`, so that check alone cannot tell "the subscribe call's own timeout timer
    // is now armed" apart from "some timer, possibly the unrelated tick, exists".
    let subscribeCalled = false;
    worker.subscribeEvents = (): Promise<never> => {
      subscribeCalled = true;
      return new Promise<never>(() => {});
    };

    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(subscribeCalled).toBe(true));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await vi.waitFor(() =>
      expect(logger.warnings.some((entry) => entry.message.includes("did not answer"))).toBe(true),
    );
    expect(logger.warnings.some((entry) => entry.message.includes("refused"))).toBe(false);

    await harness.service.stop();
  });

  // P1: a refresh timeout used to be swallowed into a debug log with nothing acting on it, so a
  // half-open uplink (NAT rebind, cable pull, kernel panic -- no FIN) had `connection` report
  // `connected` forever with a `lastSeenAt` that never moved again. One timeout recovering on
  // the very next attempt (D3, above) must still not disconnect a worker -- that is a real, slow
  // response, not a dead link -- but the same failure MAX_CONSECUTIVE_REFRESH_TIMEOUTS times in a
  // row, with nothing in between, must make the gateway give up and close the uplink.
  it("closes the uplink once refreshes keep timing out, so a half-open worker stops reporting connected (P1)", async () => {
    expect(MAX_CONSECUTIVE_REFRESH_TIMEOUTS).toBeGreaterThan(1);
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.capacity).toBeDefined());

    // Never un-hung, unlike D3's test: this is the half-open case, not a briefly slow one.
    worker.hangingCalls.add("status.get");

    for (let attempt = 1; attempt < MAX_CONSECUTIVE_REFRESH_TIMEOUTS; attempt++) {
      harness.clock.advance(REFRESH_MS);
      await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
      harness.clock.advance(WORKER_CALL_TIMEOUT_MS);
      // Wait for the *next* tick to actually be armed, not just for the (already, trivially
      // true) `connected` check to pass -- that value never changes on a timeout, so checking
      // it alone would resolve before the tick's own promise chain (refresh's catch, then
      // `pruneExpired`, then rescheduling) has actually finished, and the next iteration's
      // `advance(REFRESH_MS)` would fast-forward the clock past a timer that has not been
      // registered yet -- silently skipping a whole tick instead of exercising it.
      await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
      // Below the threshold, the view must still say `connected` -- exactly D3's guarantee,
      // repeated for every attempt short of the last one.
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    }

    // The attempt that crosses the threshold.
    harness.clock.advance(REFRESH_MS);
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("disconnected"),
    );
    expect(eventNames(harness.events)).toContain("worker.disconnected");

    await harness.service.stop();
  });

  // C-1: P1's counter used to be driven by the whole bundled refresh timing out, which conflated
  // a dead transport with a merely busy dispatcher -- on a worker mid-`converge`, `runDispatch`
  // parks every call except `status.get` behind the startup-readiness gate, so `list.get` can
  // legitimately hang for tens of seconds while the socket is completely healthy. Reproduces the
  // reviewer's repro: `status.get` keeps answering, `list.get` never does, for well more than
  // `MAX_CONSECUTIVE_REFRESH_TIMEOUTS` refresh cycles in a row. A gateway that still infers
  // transport death from this would flip the link to `disconnected` long before this loop ends.
  it("does not close the link when status.get keeps answering but the dispatcher is busy (C-1)", async () => {
    // A refreshIntervalMs far outside this test's clock advances: `#runTick` only reschedules
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

    // Unlike P1's test (which hangs `status.get` itself), the worker answers `status.get` on
    // every single call -- only the readiness-gated `list.get` never returns, exactly what a
    // worker stuck in a long `converge` looks like from the gateway's side.
    worker.hangingCalls.add("list.get:devices");

    for (let attempt = 1; attempt <= MAX_CONSECUTIVE_REFRESH_TIMEOUTS + 2; attempt++) {
      const listCallsBefore = worker.calls.filter((call) => call === "list.get:devices").length;
      // A worker event, not the tick, triggers each refresh here -- `#onWorkerEvent` calls
      // `refresh()` directly, with none of the tick's own scheduling drift.
      worker.pushEvent({ event: "lease.granted" });
      // Waits for `list.get` to have actually been called -- proof `status.get`'s real promise
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
      // Real microtask turns for the timeout rejection to propagate through `#rebuildView` and
      // `refresh()`'s catch/finally -- nothing here is clock-scheduled once the timer fires.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // `status.get` answered this round, so liveness holds no matter how many cycles the
      // dispatcher stays busy -- unlike P1's test, this must stay true past the threshold.
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
    }
    expect(eventNames(harness.events)).not.toContain("worker.disconnected");

    await harness.service.stop();
  });

  // C-2, ADR 0005 §8 ("revoking closes the uplink"): a join token was checked once, at upgrade,
  // and nothing ever re-verified a live link -- so revoking a worker's token used to have no
  // observable effect on an already-open uplink at all. `closeLinksForToken` is what
  // `GatewayDispatcher#tokenRevoke` calls after a successful revoke; this exercises it end to
  // end against real `WorkerLink`s, matched by the exact token each authenticated with, so a
  // shared or reused credential (however unlikely) cannot silently take out an unrelated worker.
  it("closes exactly the link a token authorized, and leaves every other link alone (C-2)", async () => {
    const harness = fleet({
      // Mirrors `main.ts`'s real `authenticate`: `accept` names the token id that authorized
      // it, which is the whole plumbing this fix adds.
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
    // B authenticated with a different token entirely -- revoking A's must not touch it.
    expect(harness.service.workers.view("wrk_b")?.connection).toBe("connected");
    expect(eventNames(harness.events)).toEqual(
      expect.arrayContaining(["worker.connected", "worker.connected", "worker.disconnected"]),
    );

    await harness.service.stop();
  });

  // C3: `hello` -- inside `connect()`, the first round trip `start()` makes -- had no timeout
  // at all, unlike every call after it. A peer that completes the WebSocket upgrade with a
  // valid join token and then never answers `hello` (a half-open TCP right after upgrade, or a
  // deliberately silent client) used to hang `start()` forever: the link stayed in `#links`
  // (registered before `start()` even runs), holding an open socket and no view, invisible in
  // `simlock worker list` while consuming a slot -- D2's exact failure mode, one call earlier.
  it("does not hang the handshake forever when hello itself never answers (C3)", async () => {
    const harness = fleet();
    await harness.service.start();

    const workerEnd = await harness.joinSilent("wrk_1", "mac-mini-1");
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
    harness.clock.advance(WORKER_CALL_TIMEOUT_MS);

    // The decisive check: a timed-out hello must make the link actually give up and close its
    // end of the socket -- closing either end of an in-memory pair closes both, so this is only
    // true once the gateway's side has been closed. Against the unbounded `connect()` this
    // never happens: nothing ever times out, so nothing ever closes, and this assertion is what
    // tells the two apart (a looser "no view was built" check passes either way, since a
    // permanently-hung connect() also never builds one).
    await vi.waitFor(() => expect(workerEnd.closed).toBe(true));

    // Timing out must not fabricate a view for a worker the gateway never actually spoke to.
    expect(eventNames(harness.events)).not.toContain("worker.connected");
    expect(harness.service.workers.view("wrk_1")).toBeUndefined();

    // And the slot must actually be freed: the same worker id reconnecting for real (a client
    // that does answer) must build a normal view rather than being shut out by a link that
    // leaked past its timeout.
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected"),
    );

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

  // The two refusals reach the event stream apart, because they point at different fixes:
  // the join token itself, or the role it was minted with (ADR 0005 §4).
  it.each(["unauthenticated", "forbidden"] as const)(
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
      // M3: `workerId`/`label` are whatever the dial *claimed* in its headers -- never verified
      // (a refused peer proves no identity), but still worth an operator's while, and something
      // this event used to always report as `undefined` regardless of what the dial sent.
      expect(harness.events.at(-1)).toMatchObject({
        event: "worker.rejected",
        payload: { label: "mac-mini-1", reason, workerId: "wrk_1" },
      });

      await harness.service.stop();
    },
  );

  // P-2: `GET /v1/uplink` needs no credential to reach `authenticate`, and before this fix every
  // refusal emitted its own `worker.rejected` -- so a flood of refused dials (deliberate, or a
  // misconfigured worker retrying fast) could fill the event bus's ring buffer, bounded by count
  // and not bytes, with nothing but refusals, evicting everything else in it. No test dialed
  // twice before this round. This asserts the coalescing itself: two dials with the same claimed
  // id and reason inside one window produce exactly one event, and the first dial after the
  // window closes reports the closed window's total as `count`.
  it("coalesces a flood of identical refusals into one event per window, with a count (P-2)", async () => {
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

    // Both refusals were real (each dial above genuinely rejected), but only the first became
    // an event -- and it carries no `count` at all, the exact pre-P-2 payload shape.
    expect(rejectedEvents()).toHaveLength(1);
    expect(rejectedEvents()[0]?.payload).toMatchObject({ workerId: "wrk_flood" });
    expect(rejectedEvents()[0]?.payload).not.toHaveProperty("count");

    // Past the window: the next matching refusal is reported on its own, carrying the tally the
    // just-closed window absorbed (both dials above).
    harness.clock.advance(REJECTION_COALESCE_WINDOW_MS);
    await expect(
      harness.join("wrk_flood", new ScriptedWorkerClient(), "mac-mini-1"),
    ).rejects.toMatchObject({ code: "rejected" });

    expect(rejectedEvents()).toHaveLength(2);
    expect(rejectedEvents()[1]?.payload).toMatchObject({ count: 2, workerId: "wrk_flood" });

    // A different claimed id is its own window from the start -- coalescing must not blend
    // unrelated identities together into one gate.
    await expect(
      harness.join("wrk_other", new ScriptedWorkerClient(), "mac-mini-2"),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(rejectedEvents()).toHaveLength(3);
    expect(rejectedEvents()[2]?.payload).not.toHaveProperty("count");

    await harness.service.stop();
  });

  it("closes the uplink when a worker does not grant the gateway admin", async () => {
    const harness = fleet();
    await harness.service.start();
    // A worker older than #117, or one that resolved the session some other way: nothing the
    // gateway asks would be answered, so there is no view worth keeping.
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

  // `./fleet-ports.ts`'s WorkerDispatchTarget#client -- #118's seam. Both halves of the
  // contract: undefined before start() has completed the handshake, and undefined again once
  // the link has closed.
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
