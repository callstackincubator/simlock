import { describe, expect, it } from "vitest";
import { type CapacityLimits } from "../core/testing.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { gibibyte, request, createHarness, seedReady } from "./test-create-leasing.js";
import { NoCapacityError } from "./index.js";

describe("createLeasing RAM budget by mode", () => {
  const slimRequest = { ...request, mode: "slim" } as const;
  const roomy: CapacityLimits = {
    android: { maxDevices: 4, maxRunning: 4 },
    ios: { maxDevices: 8, maxRunning: 8 },
    maxRunning: 12,
  };
  /** why: With 9 GiB of RAM the budget is 5 GiB: one full iOS device (3 GiB) and two slim ones fit. */
  const ramBudget = {
    androidBytesPerDevice: 4 * gibibyte,
    iosBytesPerDevice: 3 * gibibyte,
    iosSlimBytesPerDevice: gibibyte,
  };

  function operations(driver: FakeDriver, operation: string): number {
    return driver.calls.filter((call) => call.operation === operation).length;
  }

  it("refuses a full spec, which a slim request on a runtime that cannot be slimmed resolves to, before it is provisioned, and counts it full after it boots", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.4", "26.5"],
      clock,
      platform: "ios",
      slimmableOsVersions: ["26.4"],
    });
    const harness = await createHarness({
      driver,
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });

    const unslimmable = await harness.engine.request(slimRequest, {
      ownerId: "unslimmable",
      requesterId: "unslimmable",
    });
    expect(unslimmable.device.mode).toBe("full");
    expect(harness.engine.ramBudget?.usedBytes).toBe(3 * gibibyte);

    // why: 3 GiB used of 5: the next device needs 3 more and is refused before any provision.
    const provisions = operations(driver, "provision");
    await expect(
      harness.engine.request(slimRequest, { noWait: true, ownerId: "next", requesterId: "next" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(operations(driver, "provision")).toBe(provisions);

    // why: Control: had the first device come up slim, 1 GiB would be used and the next would fit.
    const control = await createHarness({
      driver: new FakeDriver({
        availableOsVersions: ["26.4"],
        clock: new FakeClock(1_000),
        platform: "ios",
        slimmableOsVersions: ["26.4"],
      }),
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });
    const slimmable = { ...slimRequest, osVersion: "26.4" };
    await control.engine.request(slimmable, { ownerId: "first", requesterId: "first" });
    await expect(
      control.engine.request(slimmable, { noWait: true, ownerId: "next", requesterId: "next" }),
    ).resolves.toMatchObject({ device: { mode: "slim" } });
  });

  it("counts a slim-spec device quarantined from provisioning at the full size", async () => {
    const harness = await createHarness({ limits: roomy, ramBudget, totalRamBytes: 9 * gibibyte });
    const registered = await harness.registry.registerDevice({
      driverData: { fakeDeviceId: "driver-stalled" },
      driverDeviceId: "driver-stalled",
      provisionDuration: 0,
      spec: { ...slimRequest, physical: false },
    });
    const quarantined = await harness.registry.enterQuarantine(registered.id, 60_000, {
      kind: "purge-failed",
    });

    expect(quarantined.state).toBe("quarantined");
    expect(harness.engine.ramBudget?.usedBytes).toBe(ramBudget.iosBytesPerDevice);
  });

  it("keeps the lease of a device planned as slim whose driver reports full, shuts nothing down, and counts it full", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      mode: "full",
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    const harness = await createHarness({
      driver,
      limits: roomy,
      ramBudget,
      totalRamBytes: 9 * gibibyte,
    });

    const leased = await harness.engine.request(slimRequest, { ownerId: "a", requesterId: "a" });

    expect(leased.device.mode).toBe("full");
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([leased.lease.id]);
    expect(operations(driver, "shutdown")).toBe(0);
    expect(harness.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: false,
      usedBytes: 3 * gibibyte,
    });
  });

  it("over its limit after a restart with larger sizes, creates no device in either mode and boots no shut-down slim device, but grants an idle one; releasing the idle one destroys it and brings it back under", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      knownModels: ["iPhone 16", "iPhone 16 Pro"],
      availableOsVersions: ["26.4", "26.5"],
      clock,
      platform: "ios",
      slimmableOsVersions: ["26.4", "26.5"],
    });
    const small = { ...ramBudget, iosSlimBytesPerDevice: 0.5 * gibibyte };
    const before = await createHarness({
      driver,
      idleShutdownAfterMs: 0,
      limits: roomy,
      ramBudget: small,
      totalRamBytes: 9 * gibibyte,
    });
    const idleSpec = { ...slimRequest, osVersion: "26.4" };
    const held = await before.engine.request(slimRequest, { ownerId: "held", requesterId: "held" });
    // why: a released virtual device is destroyed, so the idle devices are seeded rather than released.
    const toShutDown = await seedReady(before, { ...slimRequest, physical: false }, "slim");
    const idle = await seedReady(before, { ...idleSpec, physical: false }, "slim");
    await before.engine.cleanup.execute({
      action: "shutdown",
      reason: "test",
      rule: "test",
      target: toShutDown.id,
    });
    expect(before.engine.ramBudget?.usedBytes).toBe(1 * gibibyte);

    const after = await createHarness({
      driver,
      state: before.state,
      idleShutdownAfterMs: 0,
      limits: roomy,
      ramBudget: { ...ramBudget, iosSlimBytesPerDevice: 3 * gibibyte },
      totalRamBytes: 9 * gibibyte,
    });
    await after.engine.convergeRunningCapacity();
    expect(after.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: true,
      usedBytes: 6 * gibibyte,
    });

    const provisions = operations(driver, "provision");
    const boots = operations(driver, "makeReady");
    for (const [owner, wanted] of [
      ["new-full", request],
      ["new-slim", { ...slimRequest, model: "iPhone 16 Pro" }],
      ["boot-slim", slimRequest],
    ] as const) {
      await expect(
        after.engine.request(wanted, { noWait: true, ownerId: owner, requesterId: owner }),
      ).rejects.toBeInstanceOf(NoCapacityError);
    }
    expect(operations(driver, "provision")).toBe(provisions);
    expect(operations(driver, "makeReady")).toBe(boots);
    expect(after.registry.snapshot.devices.find((d) => d.id === toShutDown.id)?.state).toBe(
      "shutdown",
    );

    const reused = await after.engine.request(idleSpec, {
      noWait: true,
      ownerId: "reuse",
      requesterId: "reuse",
    });
    expect(reused.device.id).toBe(idle.id);
    expect(after.registry.snapshot.leases.map((lease) => lease.deviceId)).toContain(held.device.id);
    expect(after.engine.ramBudget?.overLimit).toBe(true);

    await after.engine.release(reused.lease.id, "explicit");
    await after.engine.settle();
    await after.engine.cleanup.execute({
      action: "destroy",
      reason: "test",
      rule: "test",
      target: toShutDown.id,
    });
    await after.engine.settle();
    expect(operations(driver, "makeReady")).toBe(boots);
    expect(after.engine.ramBudget).toEqual({
      limitBytes: 5 * gibibyte,
      overLimit: false,
      usedBytes: 3 * gibibyte,
    });
  });
});
