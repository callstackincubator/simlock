import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { Doctor } from "./doctor.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { type Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { loadTestRegistry } from "./testing.js";
import { config, sequence } from "./test-doctor.js";

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor and physical devices (ADR 0022 §4)", () => {
  async function physicalHarness(states: readonly ("ready" | "leased" | "reclaiming")[]) {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    for (const state of states) {
      const device = await registry.enrollPhysical({
        apps: [],
        class: "phone",
        driverDeviceId: `00008110-${state}`,
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        platform: "ios",
      });
      if (state === "ready") continue;
      const lease = await registry.createLease({
        deviceId: device.id,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 10_000_000,
        ttlMs: 60_000,
      });
      if (state === "reclaiming") await registry.beginRelease(lease.id);
    }
    clock.advance(99_000);
    const driver = new FakeDriver({
      clock,
      estimateMs: { boot: 2_000, provision: 1_000, reclaim: 1_000 },
      platform: "ios",
    });
    driver.setManagedReality({ devices: [], processes: [] });
    return { clock, driver, eventBus, registry };
  }

  it("raises no drift finding for a ready or a leased physical record that no root holds, and --fix leaves both as they are", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["ready", "leased"]);
    const destroy = vi.spyOn(driver, "destroy");
    const shutdown = vi.spyOn(driver, "shutdown");

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(report.findings).toEqual([]);
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["ready", "leased"]);
    expect(destroy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("does not report as an orphan the ID a physical record holds, and a purge destroys only the orphan, as a virtual driver device", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["ready"]);
    driver.setManagedReality({
      devices: [
        {
          address: "a",
          deviceId: "00008110-ready",
          driverData: {},
          runState: "running",
        },
        { address: "b", deviceId: "simlock-orphan", driverData: {}, runState: "running" },
      ],
      processes: [],
    });
    const destroy = vi.spyOn(driver, "destroy");

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    expect(report.findings).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "simlock-orphan", physical: false }),
    );
  });

  it("reports stalled-transition for a reclaiming physical record past its threshold, priced at the physical reclaim estimate, and --fix quarantines it", async () => {
    const { clock, driver, eventBus, registry } = await physicalHarness(["reclaiming"]);
    const quarantine = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus,
      notifyAvailability: () => {},
      registry,
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config({ minimumThresholdMs: 0, thresholdMultiplier: 1 }),
      drivers: [driver],
      eventBus,
      quarantine,
      registry,
    });

    const report = await doctor.reconcile({ fix: true });

    expect(report.findings).toEqual([
      expect.objectContaining({
        deviceId: registry.snapshot.devices[0]?.id,
        kind: "stalled-transition",
        thresholdMs: 90_000,
      }),
    ]);
    expect(registry.snapshot.devices[0]?.state).toBe("quarantined");
    quarantine.dispose();
  });
});

describe("Doctor and a physical reclaim in flight (ADR 0022 §7, §8)", () => {
  async function harness() {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });
    const driver = new FakeDriver({
      clock,
      estimateMs: { boot: 2_000, provision: 1_000, reclaim: 1_000 },
      platform: "ios",
    });
    driver.setManagedReality({ devices: [], processes: [] });
    const claims = new DeviceOperationClaims();
    const quarantine = new QuarantineCoordinator({
      claims,
      clock,
      config: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus,
      notifyAvailability: () => {},
      registry,
    });
    const doctor = new Doctor({
      claims,
      decisions: new SerializedDecision(),
      clock,
      config: config({ minimumThresholdMs: 0, thresholdMultiplier: 1 }),
      drivers: [driver],
      eventBus,
      quarantine,
      registry,
    });
    return { claims, clock, doctor, eventBus, quarantine, registry };
  }

  async function enrollReclaiming(registry: Registry, name: string) {
    const device = await registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: `00008110-${name}`,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 10_000_000,
      ttlMs: 60_000,
    });
    await registry.beginRelease(lease.id);
    return device;
  }

  it("a physical reclaim interrupted by a killed daemon is aged from reclaimingSince by stalled-transition", async () => {
    const { clock, doctor, quarantine, registry } = await harness();
    const oldStart = await enrollReclaiming(registry, "old_start");
    const newStart = await enrollReclaiming(registry, "new_start");
    await registry.transitionDevice(
      newStart.id,
      "absent",
      {
        event: "device.absence-detected",
        payload: { absentReason: "locked", deviceId: newStart.id, previousState: "reclaiming" },
      },
      { absentReason: "locked" },
    );
    clock.advance(98_000);
    await registry.transitionDevice(newStart.id, "reclaiming", {
      event: "device.returned",
      payload: { deviceId: newStart.id, osVersion: "18.4" },
    });
    clock.advance(1_000);

    const report = await doctor.reconcile();

    expect(
      report.findings
        .filter((finding) => finding.kind === "stalled-transition")
        .map((finding) => finding.deviceId),
    ).toEqual([oldStart.id]);
    quarantine.dispose();
  });

  it("doctor --fix on a stalled reclaiming device that is claimed by the time the fix runs writes nothing, emits no device.quarantined and arms no retry", async () => {
    const { claims, clock, doctor, eventBus, quarantine, registry } = await harness();
    const stalled = await enrollReclaiming(registry, "stalled");
    clock.advance(99_000);
    let commits = 0;
    registry.onCommit(() => {
      commits += 1;
    });
    let claimTaken = false;
    eventBus.subscribe("device.stalled-transition-detected", () => {
      claimTaken = claims.tryClaim(stalled.id, "reclaim") !== undefined;
    });

    const report = await doctor.reconcile({ fix: true });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ deviceId: stalled.id, kind: "stalled-transition" }),
    );
    expect(claimTaken).toBe(true);
    expect(registry.snapshot.devices[0]?.state).toBe("reclaiming");
    expect(commits).toBe(0);
    expect(eventBus.replay().filter((event) => event.event === "device.quarantined")).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
    quarantine.dispose();
  });
});
