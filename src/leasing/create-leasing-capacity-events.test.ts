import { describe, expect, it } from "vitest";
import { buildCapacityFigures } from "../core/index.js";
import { capacityChangedPayload } from "../core/testing.js";
import { type EventMap } from "../bus/index.js";
import { request, createHarness, seedReady, flush } from "./test-create-leasing.js";

describe("createLeasing: capacity.changed and queue.changed", () => {
  type CapacityEvent = EventMap["capacity.changed"];

  function capacityEvents(harness: Awaited<ReturnType<typeof createHarness>>): CapacityEvent[] {
    return harness.bus
      .replay()
      .filter((event) => event.event === "capacity.changed")
      .map((event) => event.payload as CapacityEvent);
  }

  function queueEvents(harness: Awaited<ReturnType<typeof createHarness>>): number[] {
    return harness.bus
      .replay()
      .filter((event) => event.event === "queue.changed")
      .map((event) => (event.payload as EventMap["queue.changed"]).depth);
  }

  function currentFigures(harness: Awaited<ReturnType<typeof createHarness>>): CapacityEvent {
    return capacityChangedPayload(
      buildCapacityFigures(harness.registry.snapshot.virtualDevices, harness.engine),
    );
  }

  it("emits capacity.changed and queue.changed once when the daemon has started, and none before", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    expect([capacityEvents(harness), queueEvents(harness)]).toEqual([[], []]);

    await harness.engine.convergeRunningCapacity();

    expect(capacityEvents(harness)).toEqual([currentFigures(harness)]);
    expect(capacityEvents(harness)[0]).toMatchObject({ global: { warm: 1 }, ios: { warm: 1 } });
    expect(queueEvents(harness)).toEqual([0]);
  });

  it("emits capacity.changed after a provision commits, with the figures status.get reports at that moment", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const before = capacityEvents(harness).length;
    const seen: Array<{ event: CapacityEvent; figures: CapacityEvent }> = [];
    harness.bus.subscribe("capacity.changed", (envelope) =>
      seen.push({ event: envelope.payload, figures: currentFigures(harness) }),
    );

    await harness.registry.registerDevice({
      driverData: { fakeDeviceId: "sim-1" },
      driverDeviceId: "sim-1",
      provisionDuration: 0,
      spec: { ...request, physical: false },
    });

    expect(capacityEvents(harness)).toHaveLength(before + 1);
    expect(seen).toEqual([{ event: currentFigures(harness), figures: currentFigures(harness) }]);
    expect(seen[0]?.event.ramBudget?.usedBytes).toBeGreaterThan(0);
  });

  it("emits capacity.changed when a provisioning reservation is taken, before any registry commit, and when it is released", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const seen: Array<{ reserved: number; devices: number }> = [];
    harness.bus.subscribe("capacity.changed", (envelope) =>
      seen.push({
        devices: harness.registry.snapshot.devices.length,
        reserved: envelope.payload.ios.reserved,
      }),
    );
    harness.driver.hangMakeReady();

    const pending = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await flush();
    expect(seen[0]).toEqual({ devices: 0, reserved: 1 });
    harness.driver.releaseMakeReady();
    await pending;
    await flush();

    expect(seen.at(-1)?.reserved).toBe(0);
    expect(capacityEvents(harness).at(-1)).toEqual(currentFigures(harness));
  });

  it("emits capacity.changed after a device is deleted and after a lease release destroys its device", async () => {
    const harness = await createHarness();
    const grant = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await harness.engine.convergeRunningCapacity();
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 0, running: 1 } });

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 0, running: 0 } });

    const warm = await seedReady(harness);
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 1, running: 1 } });

    await harness.registry.markDeviceMissing(warm.id, "test");
    expect(capacityEvents(harness).at(-1)).toMatchObject({ ios: { warm: 0, running: 0 } });
    expect(capacityEvents(harness).at(-1)).toEqual(currentFigures(harness));
  });

  it("emits no capacity.changed when a commit leaves the capacity figures unchanged", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    await harness.engine.convergeRunningCapacity();
    const before = capacityEvents(harness).length;

    await harness.registry.createLeaseRequest({
      ownerId: "a",
      request,
      requesterId: "a",
    });
    await harness.registry.markForeignStateDetected(harness.registry.snapshot.devices[0]!.id, 1);

    expect(capacityEvents(harness)).toHaveLength(before);
  });

  it("never emits two consecutive capacity.changed events with equal figures across a whole lease", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    const grant = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();

    const events = capacityEvents(harness);
    expect(events.length).toBeGreaterThan(3);
    events.slice(1).forEach((event, index) => expect(event).not.toEqual(events[index]));
  });

  it("carries ramBudget under the resource strategy and omits it under the fixed strategy", async () => {
    const resource = await createHarness();
    await resource.engine.convergeRunningCapacity();
    const fixed = await createHarness({
      capacity: { strategy: "fixed", config: { maxRunning: 2 } },
    });
    await fixed.engine.convergeRunningCapacity();

    expect(capacityEvents(resource)[0]?.ramBudget).toEqual({
      limitBytes: expect.any(Number),
      usedBytes: 0,
    });
    expect(capacityEvents(fixed)).toHaveLength(1);
    expect(capacityEvents(fixed)[0]).not.toHaveProperty("ramBudget");
  });
});
