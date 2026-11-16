import { describe, expect, it, vi } from "vitest";
import { DriverCrashError } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock, JsonLinesLogger, type Logger, MemoryLogSink } from "../ports/index.js";
import { createLeasing, NoCapacityError, LeaseHealthMonitor } from "./index.js";
import { request, config, createHarness, seedReady, flush } from "./test-create-leasing.js";

describe("createLeasing logger wiring", () => {
  function debugLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
    const sink = new MemoryLogSink();
    return { logger: new JsonLinesLogger({ clock: new FakeClock(0), level: "debug", sink }), sink };
  }

  it("createCore hands its logger to the quarantine coordinator: a failed retry is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    driver.failOn("destroy", 2, new DriverCrashError("retry exploded"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver, logger });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");

    harness.clock.advance(config().warmPool.quarantine.retryBackoffMs);
    await flush();

    expect(
      sink.records.filter((record) => record.message === "quarantine delete retry failed"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.quarantine-coordinator",
        fields: {
          attempts: 1,
          deviceId: first.device.id,
          error: "DriverCrashError: retry exploded",
          step: "delete",
        },
      },
    ]);
  });

  it("createLeasing hands its logger to the acquisition coordinator: a failed eviction is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop victim"));
    const { logger, sink } = debugLogger();
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      logger,
    });
    const victim = await seedReady(harness);

    await expect(
      harness.engine.request(
        { ...request, model: "iPhone SE" },
        { noWait: true, ownerId: "new-spec", requesterId: "new-spec" },
      ),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(
      sink.records.filter((record) => record.message === "shutting down an eviction target failed"),
    ).toMatchObject([
      {
        level: "warn",
        module: "daemon.lease-acquisition-coordinator",
        fields: { deviceId: victim.id, requesterId: "new-spec", step: "shutdown" },
      },
    ]);
  });

  it("createLeasing hands its logger to the lease release coordinator: a background reclaim that cannot commit is logged", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { reclaim: 20 },
      platform: "ios",
    });
    const { logger, sink } = debugLogger();
    const harness = await createHarness({ driver, logger });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    await harness.engine.release(first.lease.id, "explicit");
    // why: The release has committed and the erase is still running. A disk that refuses the write
    // makes the reclaim's own commit throw, with no caller left to reject to.
    vi.spyOn(harness.state, "transaction").mockImplementation(() => {
      throw new Error("EIO");
    });

    clock.advance(20);
    await harness.engine.settle();

    expect(
      sink.records.filter((record) => record.message === "background reclaim failed"),
    ).toMatchObject([
      {
        level: "error",
        module: "daemon.lease-release-coordinator",
        fields: { deviceId: first.device.id, leaseId: first.lease.id },
      },
    ]);
  });
});

describe("createLeasing wiring", () => {
  const components = {
    claimProvision: () => () => undefined,
    install: async () => ({ outcome: "installed" as const, version: "26.5" }),
  };

  it("wires the leased-device health monitor, and leaves it out when told to", async () => {
    const harness = await createHarness();
    const without = createLeasing({
      clock: harness.clock,
      components,
      config: config(),
      core: harness.engine.core,
      eventBus: harness.bus,
      healthMonitor: false,
      idGenerator: { generate: () => "1" },
    });

    expect(harness.engine.leasing.healthMonitor).toBeInstanceOf(LeaseHealthMonitor);
    expect(without.healthMonitor).toBeUndefined();
  });

  it("hands core a leaseExpirer that expires through leasing: doctor --fix ends a lease past its deadline", async () => {
    const harness = await createHarness();
    const grant = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    // why: No timer may expire it first: only doctor's finding does.
    harness.engine.dispose();
    harness.clock.advance(10 * 60_000 * 60);

    await harness.engine.core.doctor.reconcile({ fix: true });

    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).not.toContain(grant.lease.id);
    expect(harness.bus.replay().map((event) => event.event)).toContain("lease.expired");
  });

  it("disposes the physical device watcher with leasing: no presence read happens after dispose", async () => {
    const harness = await createHarness();
    await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-A",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    harness.driver.setPhysicalPresence("UDID-A", true);
    harness.engine.leasing.physicalDeviceWatcher.start();
    harness.engine.dispose();

    harness.clock.advance(120_000);
    await harness.engine.settle();

    expect(harness.driver.calls.filter((call) => call.operation === "listPresentPhysical")).toEqual(
      [],
    );
  });

  it("does not connect core itself when a second leasing is built", async () => {
    const harness = await createHarness();
    const connect = vi.spyOn(harness.engine.core, "connect");

    createLeasing({
      clock: harness.clock,
      components,
      config: config(),
      core: harness.engine.core,
      eventBus: harness.bus,
      idGenerator: { generate: () => "1" },
    });

    expect(connect).not.toHaveBeenCalled();
  });
});
