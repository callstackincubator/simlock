import { describe, expect, it } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { leaseFixture } from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const RETENTION_MS = 24 * 60 * 60_000;
/** Matches `core/config.ts`'s own default, so a test that does not care about ADR 0005 §15's
 * warning gets a cap no fixture's `ttlMs` ever comes near. */
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;
/** Matches `service.test.ts`'s `principal: "gw:instance-1"` -- ADR 0005 §14/§27's own-lease
 * prefix is that principal plus a trailing `:`. */
const GATEWAY_REQUESTER_PREFIX = "gw:instance-1:";

/** Records every `warn` call, the same shape `service.test.ts`'s own `RecordingLogger` uses --
 * §15's warning is asserted on directly rather than only on the view it leaves behind. */
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

function registry(
  options: {
    readonly drainStore?: MemoryDrainStore;
    /** Omit to get the default fixture prefix; pass `null` explicitly (H3) to build a registry
     * with no `gatewayRequesterPrefix` at all, the way `dispatcher.test.ts`'s harness does. */
    readonly gatewayRequesterPrefix?: string | null;
    /** ADR 0005 §15's own cap. Defaults to `core/config.ts`'s own default so a test that never
     * reports a worker `lease.maxTtlMs` cannot accidentally trip the new warning. */
    readonly leaseMaxTtlMs?: number;
    readonly logger?: Logger;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const gatewayRequesterPrefix =
    options.gatewayRequesterPrefix === null
      ? undefined
      : (options.gatewayRequesterPrefix ?? GATEWAY_REQUESTER_PREFIX);
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? DEFAULT_LEASE_MAX_TTL_MS,
    retentionMs: RETENTION_MS,
    ...(gatewayRequesterPrefix === undefined ? {} : { gatewayRequesterPrefix }),
    ...(options.drainStore === undefined ? {} : { drainStore: options.drainStore }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { clock, events, workers };
}

/** A gateway-issued lease's `requesterId` (ADR 0005 §14/§27): the fixed prefix `pruneExpired`
 * scopes its retention hold to, so a fixture built with it exercises the real branch rather than
 * one that happens to pass because no scoping exists yet. */
function gatewayLeaseFixture(id: string, deviceId: string) {
  return { ...leaseFixture(id, deviceId), requesterId: `${GATEWAY_REQUESTER_PREFIX}agent-1` };
}

function names(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.event);
}

describe("WorkerRegistry", () => {
  it("builds a view on connect and emits the fact", () => {
    const { events, workers } = registry();

    const view = workers.connected("wrk_1", "mac-mini-1", "0.3.0");

    expect(view).toMatchObject({
      catalog: [],
      connection: "connected",
      devices: [],
      drained: false,
      id: "wrk_1",
      label: "mac-mini-1",
      lastSeenAt: 1_000,
      leases: [],
      version: "0.3.0",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "worker.connected",
      payload: { label: "mac-mini-1", version: "0.3.0", workerId: "wrk_1" },
    });
  });

  it("refreshes what a worker reports and leaves the rest alone", () => {
    const { clock, workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");

    clock.advance(5_000);
    workers.refresh("wrk_1", { health: "running", queueDepth: 2, leases: [] });

    expect(workers.view("wrk_1")).toMatchObject({
      connection: "connected",
      health: "running",
      lastSeenAt: 6_000,
      queueDepth: 2,
    });
  });

  it("keeps an absent key's previous value, so an event-driven refresh does not blank the catalog", () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.refresh("wrk_1", {
      catalog: [{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }],
    });

    workers.refresh("wrk_1", { queueDepth: 1 });

    expect(workers.view("wrk_1")?.catalog).toEqual([
      { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
    ]);
  });

  it("drops a refresh for a view that has been removed", async () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.disconnected("wrk_1");
    await workers.remove("wrk_1");

    workers.refresh("wrk_1", { queueDepth: 9 });

    expect(workers.view("wrk_1")).toBeUndefined();
  });

  describe("warning on a worker's lower lease.maxTtlMs (ADR 0005 §15)", () => {
    it("warns once a worker's own cap is refreshed in below the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", "mac-mini-1", "0.3.0");

      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });

      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).toMatchObject({
        fields: {
          gatewayMaxTtlMs: 3_600_000,
          label: "mac-mini-1",
          workerId: "wrk_1",
          workerMaxTtlMs: 1_800_000,
        },
      });
    });

    it("does not warn when a worker's own cap is at or above the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // Exactly equal, and then strictly above -- neither is "below".
      workers.refresh("wrk_1", { lease: { maxTtlMs: 3_600_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 7_200_000 } });

      expect(logger.warnings).toEqual([]);
    });

    it("does not warn, and does not crash, when a worker reports no cap at all", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // No `lease` key on the snapshot: exactly what an event-driven refresh sends today
      // (`config.get` is only read alongside the catalog), and what an incompatible or
      // config.get-failed worker's view carries forever.
      expect(() => workers.refresh("wrk_1", { queueDepth: 1 })).not.toThrow();

      expect(workers.view("wrk_1")?.lease).toBeUndefined();
      expect(logger.warnings).toEqual([]);
    });

    it("does not repeat the warning on a later refresh reporting the same lower cap", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      // The periodic backstop tick re-reads config.get (and so `lease.maxTtlMs`) on every
      // refresh alongside the catalog (`WorkerLink#rebuildView`) -- an unchanged report must
      // not turn into a warning every `refreshIntervalMs`.
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });

      expect(logger.warnings).toHaveLength(1);
    });

    it("warns again if the cap drops further while already below the gateway's", () => {
      const logger = new RecordingLogger();
      const { workers } = registry({ leaseMaxTtlMs: 3_600_000, logger });
      workers.connected("wrk_1", undefined, "0.3.0");

      workers.refresh("wrk_1", { lease: { maxTtlMs: 1_800_000 } });
      workers.refresh("wrk_1", { lease: { maxTtlMs: 900_000 } });

      expect(logger.warnings).toHaveLength(2);
      expect(logger.warnings[1]?.fields).toMatchObject({ workerMaxTtlMs: 900_000 });
    });
  });

  it("marks a version-mismatched worker incompatible with both ranges, and rejects it", () => {
    const { events, workers } = registry();

    const view = workers.incompatible(
      "wrk_1",
      "old-mac",
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(view).toMatchObject({
      connection: "incompatible",
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      version: "0.2.0",
    });
    // ADR 0005 §31: no event at all. Not `worker.connected`, because nothing usable
    // connected, and not `worker.rejected` either -- that uplink authenticated. The view is
    // the fact.
    expect(events).toEqual([]);
  });

  it("clears the protocol ranges when an upgraded worker reconnects", () => {
    const { workers } = registry();
    workers.incompatible(
      "wrk_1",
      undefined,
      { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    const view = workers.connected("wrk_1", undefined, "0.3.0");

    expect(view.connection).toBe("connected");
    expect(view.protocol).toBeUndefined();
  });

  it.each(["unauthenticated", "forbidden"] as const)(
    "reports a %s uplink without inventing a view for it",
    (reason) => {
      const { events, workers } = registry();

      workers.rejected(reason, undefined, undefined);

      expect(workers.views()).toEqual([]);
      expect(events[0]).toMatchObject({ event: "worker.rejected", payload: { reason } });
    },
  );

  it("keeps a disconnected view with everything it last reported", () => {
    const { clock, events, workers } = registry();
    workers.connected("wrk_1", "mac-mini-1", "0.3.0");
    workers.refresh("wrk_1", { leases: [leaseFixture("lease_1", "dev_1")] });

    clock.advance(1_000);
    workers.disconnected("wrk_1");

    expect(workers.view("wrk_1")).toMatchObject({
      connection: "disconnected",
      lastSeenAt: 2_000,
      leases: [{ id: "lease_1" }],
    });
    expect(events.at(-1)).toMatchObject({
      event: "worker.disconnected",
      payload: { leaseCount: 1, label: "mac-mini-1", workerId: "wrk_1" },
    });
  });

  it("says nothing when a view that is already disconnected disconnects again", () => {
    const { events, workers } = registry();
    workers.connected("wrk_1", undefined, undefined);
    workers.disconnected("wrk_1");
    const before = events.length;

    workers.disconnected("wrk_1");

    expect(events).toHaveLength(before);
  });

  describe("retention", () => {
    it("forgets a disconnected view once the retention window passes", async () => {
      const { clock, events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS - 1);
      await workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeDefined();

      clock.advance(1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "retention", workerId: "wrk_1" },
      });
    });

    it("never forgets a worker whose gateway-issued leases are still live, however long it has been gone", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...gatewayLeaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      // A device is still held on a machine nobody can reach: that is exactly what an operator
      // must be able to see.
      expect(workers.view("wrk_1")).toBeDefined();
    });

    // ADR 0005 §6/§14 (M2): the retention hold is scoped to leases *this gateway* issued. A
    // worker's own local lease -- an agent on that machine, never routed through the gateway --
    // is none of the gateway's business to keep a view alive for.
    // H3: a registry with no `gatewayRequesterPrefix` cannot tell a gateway-issued lease apart
    // from a worker-local one, so per `safety.md`'s fails-closed instinct it must not guess "none
    // of these are mine" and prune anyway. `GatewayService` always supplies the prefix, but the
    // class is exported and `dispatcher.test.ts`'s harness constructs one without it.
    it("holds a view with a live lease when built with no gatewayRequesterPrefix at all", async () => {
      const { clock, workers } = registry({ gatewayRequesterPrefix: null });
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("forgets a worker whose only live lease is a local one, not the gateway's own", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const localLease = { ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [localLease] });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("forgets it once the last lease deadline has passed and retention has elapsed", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", {
        leases: [{ ...gatewayLeaseFixture("lease_1", "dev_1"), ttlDeadline: 2_000 }],
      });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("leaves a connected view alone no matter how long it has been connected", async () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      clock.advance(10 * RETENTION_MS);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();
    });

    // C1: a regression in the M1 fix above -- `pruneExpired` reused `#forget`, which also
    // cleared the drain flag. Retention is not an operator action (ADR 0005 §9: "only `undrain`
    // ends it"; §8a: the drained set is the gateway's own record, kept separate from the
    // observed view precisely so a drain outlives it). An operator who drains a machine for
    // maintenance and leaves it off over a retention window must find it still drained when it
    // reconnects, exactly like the reconnect and restart cases above -- this crosses drain with
    // retention, which neither of those tests do.
    it("keeps the drain flag when retention forgets the view, unlike an operator remove", async () => {
      const store = new MemoryDrainStore();
      const { clock, workers } = registry({ drainStore: store });
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    // Hardening: the C1 test above is correct that retention must not clear a drain flag -- but
    // once a view is gone, neither `setDrained` nor `undrain` can reach that flag either
    // (`UNKNOWN_WORKER`, no view to require). Before this fix, nothing could ever clear it
    // again: `remove` returned early on a missing view before touching `#drained`, leaving
    // `workers.json` growing a permanent `true` for a worker that no longer exists -- M1's
    // "unbounded file" relocated, not closed. `remove` on that same id is the one command
    // already documented as a no-op-but-not-an-error for a forgotten worker; it must also be
    // the one that can still clear a flag stranded behind it.
    it("lets remove() clear a drain flag stranded by retention, with no view to answer removed: true", async () => {
      const store = new MemoryDrainStore();
      const { clock, workers } = registry({ drainStore: store });
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeUndefined();

      // No view left to remove, so this is still "already forgotten" -- but the flag itself
      // must actually clear, and the store must actually persist that.
      await expect(workers.remove("wrk_1")).resolves.toBe(false);
      await expect(store.load()).resolves.not.toContain("wrk_1");

      // The real proof: a later reconnect under the same id is no longer drained.
      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });
  });

  describe("drain", () => {
    it("flags the view and emits the fact, once", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", "mac-mini-1", undefined);

      const view = await workers.setDrained("wrk_1", true);
      expect(view.drained).toBe(true);
      expect(events.at(-1)).toMatchObject({
        event: "worker.drain-started",
        payload: { label: "mac-mini-1", workerId: "wrk_1" },
      });

      // Idempotent: draining again is not an error and is not a second fact.
      const before = events.length;
      await workers.setDrained("wrk_1", true);
      expect(events).toHaveLength(before);
    });

    it("undrains", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);

      await workers.setDrained("wrk_1", false);

      expect(workers.view("wrk_1")?.drained).toBe(false);
      expect(names(events)).toContain("worker.drain-ended");
    });

    it("refuses an id it has no view of", async () => {
      const { workers } = registry();

      await expect(workers.setDrained("wrk_missing", true)).rejects.toMatchObject({
        code: "UNKNOWN_WORKER",
      });
    });

    it("survives a reconnect", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");

      expect(workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    it("survives a gateway restart, which is the point of persisting it", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);

      // A second gateway, with nothing in memory and the same file.
      const second = registry({ drainStore: store });
      await second.workers.load();

      // The worker has not even connected yet, and is already drained when it does.
      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(true);
    });

    it("stops persisting a worker that has been undrained", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);
      await first.workers.setDrained("wrk_1", false);

      const second = registry({ drainStore: store });
      await second.workers.load();

      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });
  });

  describe("remove", () => {
    it("forgets a disconnected view", async () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", "mac-mini-1", undefined);
      workers.disconnected("wrk_1");

      await expect(workers.remove("wrk_1")).resolves.toBe(true);

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "operator", workerId: "wrk_1" },
      });
    });

    it("refuses a connected one", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      await expect(workers.remove("wrk_1")).rejects.toMatchObject({ code: "WORKER_CONNECTED" });
      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("refuses an incompatible one too -- its uplink is open", async () => {
      const { workers } = registry();
      workers.incompatible(
        "wrk_1",
        undefined,
        { gateway: PROTOCOL_VERSION_RANGE, worker: { min: 4, max: 4 } },
        undefined,
      );

      await expect(workers.remove("wrk_1")).rejects.toMatchObject({ code: "WORKER_CONNECTED" });
    });

    it("reports `false` for an id it has never heard of, rather than failing", async () => {
      const { events, workers } = registry();

      await expect(workers.remove("wrk_missing")).resolves.toBe(false);
      expect(names(events)).not.toContain("worker.removed");
    });

    // M1: `#forget` used to delete the view and leave the drain flag standing forever --
    // `workers.json` grew without bound, and a worker whose id was ever seen again would come
    // back silently drained with no way to `undrain` it (there is no view to undrain).
    it("clears a removed worker's drain flag too, and persists that", async () => {
      const store = new MemoryDrainStore();
      const first = registry({ drainStore: store });
      first.workers.connected("wrk_1", undefined, undefined);
      await first.workers.setDrained("wrk_1", true);
      first.workers.disconnected("wrk_1");

      await expect(first.workers.remove("wrk_1")).resolves.toBe(true);

      // Reconnecting the same id, on the same registry, must not come back drained: the flag
      // was cleared in memory...
      expect(first.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
      first.workers.disconnected("wrk_1");
      await first.workers.remove("wrk_1");

      // ...and on disk, so a second gateway reading the same store does not resurrect it either.
      const second = registry({ drainStore: store });
      await second.workers.load();
      expect(second.workers.connected("wrk_1", undefined, undefined).drained).toBe(false);
    });

    it("undrain fails UNKNOWN_WORKER for a worker removed while drained -- there is no view left", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      await workers.setDrained("wrk_1", true);
      workers.disconnected("wrk_1");
      await workers.remove("wrk_1");

      await expect(workers.setDrained("wrk_1", false)).rejects.toMatchObject({
        code: "UNKNOWN_WORKER",
      });
    });
  });

  it("orders views by id, so two reads agree", () => {
    const { workers } = registry();
    workers.connected("wrk_c", undefined, undefined);
    workers.connected("wrk_a", undefined, undefined);
    workers.connected("wrk_b", undefined, undefined);

    expect(workers.views().map((view) => view.id)).toEqual(["wrk_a", "wrk_b", "wrk_c"]);
  });

  // `./fleet-ports.ts`'s `FleetViews#onViewsChanged` -- #118's seam. This registry has no
  // listeners of its own; these tests are the notifier's whole contract.
  describe("onViewsChanged", () => {
    it("fires once per committed change, after the view is committed", () => {
      const { workers } = registry();
      const seen: Array<string | undefined> = [];
      workers.onViewsChanged(() => seen.push(workers.view("wrk_1")?.connection));

      workers.connected("wrk_1", undefined, undefined);

      expect(seen).toEqual(["connected"]);
    });

    it("does not fire for a call that changes nothing", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      let fired = 0;
      workers.onViewsChanged(() => {
        fired += 1;
      });

      // Draining an already-undrained-to-false worker: `setDrained` no-ops.
      await workers.setDrained("wrk_1", false);
      // A refresh for a worker with no view: dropped.
      workers.refresh("wrk_missing", { queueDepth: 1 });
      // Disconnecting an already-disconnected view: no-op.
      workers.disconnected("wrk_1");
      workers.disconnected("wrk_1");

      expect(fired).toBe(1); // only the first `disconnected()` -- the second is the no-op repeat.
    });

    it("stops firing once unsubscribed", () => {
      const { workers } = registry();
      let fired = 0;
      const unsubscribe = workers.onViewsChanged(() => {
        fired += 1;
      });

      workers.connected("wrk_1", undefined, undefined);
      unsubscribe();
      workers.disconnected("wrk_1");

      expect(fired).toBe(1);
    });

    it("does not let a throwing listener break the mutation or starve the other listeners", () => {
      const { workers } = registry();
      let afterFired = 0;
      workers.onViewsChanged(() => {
        throw new Error("a subscriber's own bug");
      });
      workers.onViewsChanged(() => {
        afterFired += 1;
      });

      expect(() => workers.connected("wrk_1", undefined, undefined)).not.toThrow();

      // The mutation itself committed...
      expect(workers.view("wrk_1")?.connection).toBe("connected");
      // ...and the listener registered after the throwing one still ran.
      expect(afterFired).toBe(1);
    });

    it("fires for remove() and pruneExpired(), each forgetting a view through #forget", async () => {
      const { clock, workers } = registry();
      let fired = 0;
      workers.onViewsChanged(() => {
        fired += 1;
      });

      workers.connected("wrk_1", undefined, undefined); // 1
      workers.disconnected("wrk_1"); // 2
      await workers.remove("wrk_1"); // 3

      workers.connected("wrk_2", undefined, undefined); // 4
      workers.disconnected("wrk_2"); // 5
      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired(); // 6

      expect(fired).toBe(6);
      expect(workers.view("wrk_1")).toBeUndefined();
      expect(workers.view("wrk_2")).toBeUndefined();
    });
  });
});
