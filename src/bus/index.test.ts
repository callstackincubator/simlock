import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { FakeClock, type IdGenerator } from "../ports/index.js";
import { type EventBusLogger, EventBus, type EventMap, type EventName } from "./index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every `EventName`, as a value the catalog test can compare: typed `Record<EventName, true>`, so
 * `pnpm typecheck` rejects this list the moment it misses a name `EventMap` gained or keeps one it
 * lost -- the list cannot drift from the type, and the test below holds the docs to the list.
 */
const EVENT_NAMES: Record<EventName, true> = {
  "lease.requested": true,
  "lease.queued": true,
  "capacity.changed": true,
  "queue.changed": true,
  "lease.granted": true,
  "lease.renewed": true,
  "lease.released": true,
  "lease.expired": true,
  "lease.rejected": true,
  "device.provisioned": true,
  "device.ready": true,
  "device.reclaimed": true,
  "device.purge-failed": true,
  "device.crash-detected": true,
  "device.recovered": true,
  "device.recovery-failed": true,
  "device.quarantined": true,
  "device.quarantine-recovered": true,
  "device.quarantine-abandoned": true,
  "device.quarantine-stranded": true,
  "device.shutdown": true,
  "device.deleted": true,
  "device.slimmed": true,
  "component.install-started": true,
  "component.installed": true,
  "component.install-failed": true,
  "component.removed": true,
  "device.foreign-state-detected": true,
  "device.foreign-provenance-detected": true,
  "device.stalled-transition-detected": true,
  "device.orphan-purged": true,
  "daemon.started": true,
  "daemon.stopping": true,
  "disk.pressure-detected": true,
  "cleanup.executed": true,
  "doctor.reconciled": true,
  "driver.root-rejected": true,
  "driver.adb-server-rejected": true,
  "worker.connected": true,
  "worker.rejected": true,
  "worker.disconnected": true,
  "worker.removed": true,
  "worker.drain-started": true,
  "worker.drain-ended": true,
  "request.dispatched": true,
  "request.granted": true,
  "lease.declined": true,
  "warm-pool.target-missed": true,
};

/** The first-column `` `subject.fact` `` of every catalog table row in an EVENTS.md, sorted. */
function documentedEventNames(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([a-z-]+\.[a-z-]+)` \|/gm)]
    .map((match) => match[1] ?? "")
    .sort();
}

describe("EventBus", () => {
  it("delivers a populated envelope to event and global subscribers", () => {
    const bus = new EventBus(new FakeClock(1_234));
    const eventEnvelopes: unknown[] = [];
    const allEnvelopes: unknown[] = [];

    bus.subscribe("lease.expired", (envelope) => eventEnvelopes.push(envelope));
    bus.subscribeAll((envelope) => allEnvelopes.push(envelope));

    bus.emit(
      "lease.expired",
      { leaseId: "lease-1", deviceId: "device-1", ownerId: "requester-1" },
      "leases",
    );

    const expectedEnvelope = {
      id: expect.stringMatching(/^evt_/),
      seq: 1,
      timestamp: 1_234,
      event: "lease.expired",
      payload: { leaseId: "lease-1", deviceId: "device-1", ownerId: "requester-1" },
      module: "leases",
    };
    expect(eventEnvelopes).toEqual([expectedEnvelope]);
    expect(allEnvelopes).toEqual([expectedEnvelope]);
  });

  it("emit stamps each envelope with evt_ and the id generator's next value", () => {
    let next = 0;
    const idGenerator: IdGenerator = { generate: () => `gen-${++next}` };
    const bus = new EventBus(new FakeClock(1), 10, undefined, idGenerator);

    const first = bus.emit("daemon.stopping", { reason: "a" }, "daemon");
    const second = bus.emit("daemon.stopping", { reason: "b" }, "daemon");

    expect([first.id, second.id]).toEqual(["evt_gen-1", "evt_gen-2"]);
    expect(bus.replay().map((entry) => entry.id)).toEqual(["evt_gen-1", "evt_gen-2"]);
  });

  it("republish keeps the envelope's id and timestamp and mints the next seq", () => {
    const bus = new EventBus(new FakeClock(5_000));
    bus.emit("daemon.stopping", { reason: "own" }, "daemon");

    const republished = (
      bus as unknown as {
        republish(envelope: {
          id: string;
          timestamp: number;
          event: string;
          payload: unknown;
          module: string;
        }): unknown;
      }
    ).republish({
      id: "evt_from-worker",
      timestamp: 123,
      event: "lease.expired",
      payload: { leaseId: "l", deviceId: "d", ownerId: "o" },
      module: "leases",
    });

    expect(republished).toEqual({
      id: "evt_from-worker",
      seq: 2,
      timestamp: 123,
      event: "lease.expired",
      payload: { leaseId: "l", deviceId: "d", ownerId: "o" },
      module: "leases",
    });
  });

  it("a republished event is in the ring and reaches every subscriber", () => {
    const bus = new EventBus(new FakeClock(5_000));
    const named: unknown[] = [];
    const all: unknown[] = [];
    bus.subscribe("lease.expired", (envelope) => named.push(envelope));
    bus.subscribeAll((envelope) => all.push(envelope));

    const republished = (bus as unknown as { republish(envelope: unknown): unknown }).republish({
      id: "evt_from-worker",
      timestamp: 123,
      event: "lease.expired",
      payload: { leaseId: "l", deviceId: "d", ownerId: "o" },
      module: "leases",
    });

    expect(bus.replay()).toEqual([republished]);
    expect(named).toEqual([republished]);
    expect(all).toEqual([republished]);
  });

  it("events.replay returns ring events by timestamp, then seq, whatever order they arrived in", () => {
    const bus = new EventBus(new FakeClock(500));
    const relay = (id: string, timestamp: number) =>
      (bus as unknown as { republish(envelope: unknown): unknown }).republish({
        id,
        timestamp,
        event: "daemon.stopping",
        payload: { reason: id },
        module: "daemon",
      });

    relay("evt_late", 300);
    relay("evt_early", 100);
    relay("evt_tie-first", 200);
    relay("evt_tie-second", 200);

    expect(bus.replay().map((entry) => entry.id)).toEqual([
      "evt_early",
      "evt_tie-first",
      "evt_tie-second",
      "evt_late",
    ]);
  });

  it("isolates a throwing handler and continues dispatching", () => {
    const logger: EventBusLogger = { error: vi.fn() };
    const bus = new EventBus(new FakeClock(), 1_000, logger);
    const delivered: string[] = [];
    const error = new Error("subscriber failed");

    bus.subscribe("daemon.stopping", () => {
      throw error;
    });
    bus.subscribe("daemon.stopping", () => delivered.push("later handler"));
    bus.subscribeAll(() => delivered.push("global handler"));

    expect(() => bus.emit("daemon.stopping", { reason: "shutdown" }, "daemon")).not.toThrow();
    expect(delivered).toEqual(["later handler", "global handler"]);
    expect(logger.error).toHaveBeenCalledWith("Event handler failed", {
      error,
      envelope: expect.objectContaining({ event: "daemon.stopping" }),
    });
  });

  it("does not propagate a logging failure from an isolated handler", () => {
    const logger: EventBusLogger = {
      error: () => {
        throw new Error("logger failed");
      },
    };
    const bus = new EventBus(new FakeClock(), 1_000, logger);
    const delivered: string[] = [];
    bus.subscribe("daemon.stopping", () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe("daemon.stopping", () => delivered.push("later handler"));

    expect(() => bus.emit("daemon.stopping", { reason: "shutdown" }, "daemon")).not.toThrow();
    expect(delivered).toEqual(["later handler"]);
  });

  it("unsubscribes handlers without corrupting the current dispatch", () => {
    const bus = new EventBus(new FakeClock());
    const delivered: string[] = [];
    const unsubscribeFirst = bus.subscribe("daemon.stopping", () => delivered.push("first"));
    let unsubscribeSecond: () => void = () => {};
    bus.subscribe("daemon.stopping", () => {
      delivered.push("remover");
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.subscribe("daemon.stopping", () => delivered.push("second"));

    bus.emit("daemon.stopping", { reason: "first" }, "daemon");
    unsubscribeFirst();
    bus.emit("daemon.stopping", { reason: "second" }, "daemon");

    expect(delivered).toEqual(["first", "remover", "second", "remover"]);
  });

  it("keeps global subscribers scheduled for the current dispatch after unsubscribe", () => {
    const bus = new EventBus(new FakeClock());
    const delivered: string[] = [];
    const unsubscribeGlobal = bus.subscribeAll(() => delivered.push("global"));
    bus.subscribe("daemon.stopping", () => unsubscribeGlobal());

    bus.emit("daemon.stopping", { reason: "first" }, "daemon");
    bus.emit("daemon.stopping", { reason: "second" }, "daemon");

    expect(delivered).toEqual(["global"]);
  });

  it("retains only the ring buffer capacity and replays matching events", () => {
    const clock = new FakeClock(100);
    const bus = new EventBus(clock, 2);

    bus.emit("daemon.stopping", { reason: "one" }, "daemon");
    clock.advance(10);
    bus.emit("daemon.stopping", { reason: "two" }, "daemon");
    clock.advance(10);
    bus.emit("daemon.stopping", { reason: "three" }, "daemon");

    expect(bus.replay()).toMatchObject([
      { seq: 2, event: "daemon.stopping", payload: { reason: "two" } },
      { seq: 3, event: "daemon.stopping", payload: { reason: "three" } },
    ]);
    expect(bus.replay({ sinceSeq: 2 }).map(({ seq }) => seq)).toEqual([3]);
    expect(bus.replay({ sinceSeq: 0 }).map(({ seq }) => seq)).toEqual([2, 3]);
    expect(bus.replay({ sinceTs: 110 }).map(({ seq }) => seq)).toEqual([3]);
  });

  it.each(["docs/internal/EVENTS.md", "docs/EVENTS.md"])(
    "has exactly the event names %s catalogs",
    (doc) => {
      expect(documentedEventNames(readFileSync(join(REPO_ROOT, doc), "utf8"))).toEqual(
        Object.keys(EVENT_NAMES).sort(),
      );
    },
  );

  it("types every event's payload as an object", () => {
    expectTypeOf<EventMap>().toMatchTypeOf<Record<EventName, object>>();
  });
});
