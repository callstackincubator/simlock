import { describe, expect, it } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { leaseFixture } from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

const RETENTION_MS = 24 * 60 * 60_000;

function registry(options: { readonly drainStore?: MemoryDrainStore } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    retentionMs: RETENTION_MS,
    ...(options.drainStore === undefined ? {} : { drainStore: options.drainStore }),
  });
  return { clock, events, workers };
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

  it("drops a refresh for a view that has been removed", () => {
    const { workers } = registry();
    workers.connected("wrk_1", undefined, "0.3.0");
    workers.disconnected("wrk_1");
    workers.remove("wrk_1");

    workers.refresh("wrk_1", { queueDepth: 9 });

    expect(workers.view("wrk_1")).toBeUndefined();
  });

  it("marks a version-mismatched worker incompatible with both ranges, and rejects it", () => {
    const { events, workers } = registry();

    const view = workers.incompatible(
      "wrk_1",
      "old-mac",
      { gateway: { min: 5, max: 5 }, worker: { min: 4, max: 4 } },
      "0.2.0",
    );

    expect(view).toMatchObject({
      connection: "incompatible",
      protocol: { gateway: { min: 5, max: 5 }, worker: { min: 4, max: 4 } },
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
      { gateway: { min: 5, max: 5 }, worker: { min: 4, max: 4 } },
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
    it("forgets a disconnected view once the retention window passes", () => {
      const { clock, events, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS - 1);
      workers.pruneExpired();
      expect(workers.view("wrk_1")).toBeDefined();

      clock.advance(1);
      workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "retention", workerId: "wrk_1" },
      });
    });

    it("never forgets a worker whose leases are still live, however long it has been gone", () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      const lease = { ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 10 * RETENTION_MS };
      workers.refresh("wrk_1", { leases: [lease] });
      workers.disconnected("wrk_1");

      clock.advance(5 * RETENTION_MS);
      workers.pruneExpired();

      // A device is still held on a machine nobody can reach: that is exactly what an operator
      // must be able to see.
      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("forgets it once the last lease deadline has passed and retention has elapsed", () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      workers.refresh("wrk_1", {
        leases: [{ ...leaseFixture("lease_1", "dev_1"), ttlDeadline: 2_000 }],
      });
      workers.disconnected("wrk_1");

      clock.advance(RETENTION_MS);
      workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeUndefined();
    });

    it("leaves a connected view alone no matter how long it has been connected", () => {
      const { clock, workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      clock.advance(10 * RETENTION_MS);
      workers.pruneExpired();

      expect(workers.view("wrk_1")).toBeDefined();
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
    it("forgets a disconnected view", () => {
      const { events, workers } = registry();
      workers.connected("wrk_1", "mac-mini-1", undefined);
      workers.disconnected("wrk_1");

      expect(workers.remove("wrk_1")).toBe(true);

      expect(workers.view("wrk_1")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        event: "worker.removed",
        payload: { reason: "operator", workerId: "wrk_1" },
      });
    });

    it("refuses a connected one", () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);

      expect(() => workers.remove("wrk_1")).toThrowError(
        expect.objectContaining({ code: "WORKER_CONNECTED" }),
      );
      expect(workers.view("wrk_1")).toBeDefined();
    });

    it("refuses an incompatible one too -- its uplink is open", () => {
      const { workers } = registry();
      workers.incompatible(
        "wrk_1",
        undefined,
        { gateway: { min: 5, max: 5 }, worker: { min: 4, max: 4 } },
        undefined,
      );

      expect(() => workers.remove("wrk_1")).toThrowError(
        expect.objectContaining({ code: "WORKER_CONNECTED" }),
      );
    });

    it("reports `false` for an id it has never heard of, rather than failing", () => {
      const { events, workers } = registry();

      expect(workers.remove("wrk_missing")).toBe(false);
      expect(names(events)).not.toContain("worker.removed");
    });
  });

  it("orders views by id, so two reads agree", () => {
    const { workers } = registry();
    workers.connected("wrk_c", undefined, undefined);
    workers.connected("wrk_a", undefined, undefined);
    workers.connected("wrk_b", undefined, undefined);

    expect(workers.views().map((view) => view.id)).toEqual(["wrk_a", "wrk_b", "wrk_c"]);
  });
});
