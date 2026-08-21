import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { FakeClock } from "../ports/index.js";
import { type EventBusLogger, EventBus, type EventMap, type EventName } from "./index.js";

describe("EventBus", () => {
  it("delivers a populated envelope to event and global subscribers", () => {
    const bus = new EventBus(new FakeClock(1_234));
    const eventEnvelopes: unknown[] = [];
    const allEnvelopes: unknown[] = [];

    bus.subscribe("lease.expired", (envelope) => eventEnvelopes.push(envelope));
    bus.subscribeAll((envelope) => allEnvelopes.push(envelope));

    bus.emit("lease.expired", { leaseId: "lease-1", deviceId: "device-1" }, "leases");

    const expectedEnvelope = {
      seq: 1,
      timestamp: 1_234,
      event: "lease.expired",
      payload: { leaseId: "lease-1", deviceId: "device-1" },
      module: "leases",
    };
    expect(eventEnvelopes).toEqual([expectedEnvelope]);
    expect(allEnvelopes).toEqual([expectedEnvelope]);
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

  it("has event names matching the documented catalog exactly", () => {
    expectTypeOf<EventName>().toEqualTypeOf<
      | "lease.requested"
      | "lease.queued"
      | "lease.granted"
      | "lease.renewed"
      | "lease.released"
      | "lease.expired"
      | "lease.rejected"
      | "device.provisioned"
      | "device.ready"
      | "device.reclaimed"
      | "device.purge-failed"
      | "device.crash-detected"
      | "device.recovered"
      | "device.recovery-failed"
      | "device.quarantined"
      | "device.quarantine-recovered"
      | "device.quarantine-abandoned"
      | "device.quarantine-stranded"
      | "device.shutdown"
      | "device.deleted"
      | "device.foreign-state-detected"
      | "device.foreign-provenance-detected"
      | "daemon.started"
      | "daemon.stopping"
      | "disk.pressure-detected"
      | "cleanup.executed"
      | "doctor.reconciled"
    >();
    expectTypeOf<EventMap>().toMatchTypeOf<Record<EventName, object>>();
  });
});
