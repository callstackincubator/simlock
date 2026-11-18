import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { request, createHarness, seedReady, flush } from "./test-lease-acquisition.js";

describe("LeaseAcquisitionCoordinator waiting demand", () => {
  it("lists a request waiting for a device with what a device must satisfy, and drops it once it is granted", async () => {
    const harness = await createHarness();
    const held = await harness.coordinator.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    expect(harness.coordinator.waitingDemand()).toEqual([]);

    const waiting = harness.coordinator.request(request, {
      ownerId: "waiter",
      requesterId: "waiter",
    });
    await flush();

    expect(harness.coordinator.waitingDemand()).toEqual([
      {
        classOf: expect.any(Function),
        inFlight: false,
        mode: "full",
        platform: "ios",
        requirement: {
          imageTag: undefined,
          osVersion: { kind: "exact", version: "26.5" },
          platform: "ios",
          target: { kind: "model", model: "iPhone 16" },
        },
        spec: request,
      },
    ]);

    await harness.registry.beginRelease(held.lease.id);
    await harness.registry.transitionDevice(held.device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: held.device.id, duration: 0, strategy: "wipe" },
    });
    harness.coordinator.kick();
    await waiting;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports the mode a request resolved to, and marks a request whose device work has begun as in flight", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 50 },
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({ drivers: [driver] });
    const pending = harness.coordinator.request(
      { ...request, mode: "slim" },
      { ownerId: "slim", requesterId: "slim" },
    );
    await flush();

    expect(harness.coordinator.waitingDemand()).toMatchObject([{ inFlight: true, mode: "slim" }]);

    clock.advance(50);
    await pending;
    expect(harness.coordinator.waitingDemand()).toEqual([]);
  });

  it("reports maintenance active between beginMaintenance and endMaintenance", async () => {
    const harness = await createHarness();
    expect(harness.coordinator.maintenanceActive).toBe(false);

    await harness.coordinator.beginMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(true);

    await harness.coordinator.endMaintenance();
    expect(harness.coordinator.maintenanceActive).toBe(false);
  });
});

describe("LeaseAcquisitionCoordinator: a request naming a baseline", () => {
  it("plans against the version current at its decision, so a save between the resolve and the plan grants an idle device of the new version", async () => {
    const current = (version: number) => ({
      mode: "full" as const,
      model: request.model,
      name: "checkout",
      osVersion: request.osVersion,
      platform: request.platform,
      sourceId: `source-${version}`,
      version,
    });
    const reads = [current(1)];
    const harness = await createHarness({
      baselines: { current: () => reads.shift() ?? current(2) },
      maxDevices: 2,
    });
    const idleV2 = await seedReady(harness, {
      ...request,
      baseline: { name: "checkout", version: 2 },
    });

    const granted = await harness.coordinator.request(
      { baseline: "checkout", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.id).toBe(idleV2.id);
    expect(granted.device.spec.baseline).toEqual({ name: "checkout", version: 2 });
  });

  it("ends a request whose baseline was removed while it waited as UnknownBaselineError at once, without a retry", async () => {
    const harness = await createHarness({
      baselines: {
        current: () => ({
          mode: "full" as const,
          model: request.model,
          name: "checkout",
          osVersion: request.osVersion,
          platform: request.platform,
          sourceId: "source-1",
          version: 1,
        }),
      },
      maxDevices: 1,
    });

    const outcome = await harness.coordinator
      .request(
        { baseline: "checkout", platform: "ios" },
        { ownerId: "agent", requesterId: "agent" },
      )
      .then(
        () => "granted",
        (error: unknown) => (error as Error).name,
      );

    expect(outcome).toBe("UnknownBaselineError");
  });
});
