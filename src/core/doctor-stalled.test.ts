import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { Doctor, isStalledTransition } from "./doctor.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { SerializedDecision } from "./serialized-decision.js";
import { StartupRead } from "./startup-read.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import { config, loadRegistry, readyDevice, sequence } from "./test-doctor.js";

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor", () => {
  describe("stalled transitions", () => {
    it("isStalledTransition does not hold for a provisioning device whose platform has no driver", async () => {
      const clock = new FakeClock(10_000);
      const registry = await loadRegistry(clock, new EventBus(clock));
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });

      expect(
        isStalledTransition({
          claims: undefined,
          config: config().stalledTransition,
          device,
          driver: undefined,
          now: 10_000 + 9_001,
        }),
      ).toBe(false);
    });

    it("the doctor's stalled-transition finding is unchanged", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadRegistry(clock, eventBus);
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000, reclaim: 4_000 },
        platform: "ios",
      });
      const provisioning = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      const leased = await readyDevice(registry, "simlock-erasing", "ios");
      const lease = await registry.createLease({
        deviceId: leased.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });
      const stalls = async () =>
        (await doctor.reconcile()).findings.filter(
          (finding) => finding.kind === "stalled-transition",
        );

      clock.advance(9_000);
      expect(await stalls()).toEqual([]);
      clock.advance(1);
      expect(await stalls()).toEqual([
        {
          ageMs: 9_001,
          deviceId: provisioning.id,
          enteredAt: 10_000,
          kind: "stalled-transition",
          platform: "ios",
          state: "provisioning",
          thresholdMs: 9_000,
        },
      ]);
      clock.advance(3_000);
      expect(await stalls()).toEqual([
        expect.objectContaining({ deviceId: provisioning.id }),
        {
          ageMs: 12_001,
          deviceId: leased.id,
          enteredAt: 10_000,
          kind: "stalled-transition",
          platform: "ios",
          state: "reclaiming",
          thresholdMs: 12_000,
        },
      ]);
    });

    it("does not report a stall for a device this daemon holds an operation claim on", async () => {
      // why: A backgrounded reclaim keeps its device in `reclaiming` for a full erase, which can
      // outlast the threshold. The claim, not the clock, says work is in progress; without it a
      // healthy reclaim is reported as a stall and `--fix` quarantines it.
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-claimed" },
        driverDeviceId: "simlock-claimed",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      const claims = new DeviceOperationClaims();
      const claim = claims.tryClaim(device.id, "reclaim");
      clock.advance(9_001);

      const claimed = await new Doctor({
        decisions: new SerializedDecision(),
        claims,
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(claimed.findings.filter((finding) => finding.kind === "stalled-transition")).toEqual(
        [],
      );

      claim?.release();
      const unclaimed = await new Doctor({
        decisions: new SerializedDecision(),
        claims,
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(unclaimed.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
    });

    it("reports a stalled-transition finding for a reclaiming device whose emulator was killed out from under the daemon", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({ clock, estimateMs: { reclaim: 2_000 }, platform: "ios" });
      const device = await readyDevice(registry, "simlock-killed", "ios");
      const lease = await registry.createLease({
        deviceId: device.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      // why: `kill -9` on the emulator leaves it absent from reality altogether, not `stopped`.
      driver.setManagedReality({ devices: [], processes: [] });
      clock.advance(6_001);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          deviceId: device.id,
          kind: "stalled-transition",
          state: "reclaiming",
        }),
      );
    });

    it("holds a reclaiming device to the slower clean level's estimate", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      // why: A record in `reclaiming` does not say which clean level started it, so the threshold
      // has to clear the slower of the two: pricing it at `standard` would call a healthy
      // `full` reclaim a stall.
      const driver = new FakeDriver({
        clock,
        estimateMs: { reclaim: 2_000 },
        fullCleanReclaimEstimateMs: 20_000,
        platform: "ios",
      });
      const device = await readyDevice(registry, "simlock-slow-clean", "ios");
      const lease = await registry.createLease({
        deviceId: device.id,
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 999_999,
      });
      await registry.beginRelease(lease.id);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });

      clock.advance(6_001);
      const early = await doctor.reconcile();
      expect(early.findings.filter((finding) => finding.kind === "stalled-transition")).toEqual([]);

      clock.advance(60_000);
      const late = await doctor.reconcile();
      expect(late.findings).toContainEqual(
        expect.objectContaining({
          deviceId: device.id,
          kind: "stalled-transition",
          state: "reclaiming",
          thresholdMs: 60_000,
        }),
      );
    });

    it("emits device.stalled-transition-detected from the doctor, once, for a stalled device and not for other findings", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      clock.advance(9_001);

      await driver.provision({ physical: false, model: "Phone", osVersion: "1", platform: "ios" });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.some((finding) => finding.kind !== "stalled-transition")).toBe(true);
      expect(
        eventBus.replay().filter((entry) => entry.event === "device.stalled-transition-detected"),
      ).toEqual([
        expect.objectContaining({
          module: "doctor",
          payload: expect.objectContaining({ deviceId: device.id, state: "provisioning" }),
        }),
      ]);
    });

    it("--fix quarantines a stalled provisioning device through QuarantineCoordinator", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({
        clock,
        estimateMs: { boot: 2_000, provision: 1_000 },
        platform: "ios",
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      driver.setManagedReality({
        devices: [
          {
            address: "simlock-stuck-address",
            deviceId: "simlock-stuck",
            driverData: {},
            runState: "stopped",
          },
        ],
        processes: [],
      });
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
      clock.advance(9_001);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        quarantine,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
      expect(registry.snapshot.devices[0]?.state).toBe("quarantined");
      expect(eventBus.replay().map((event) => event.event)).toContain("device.quarantined");
    });

    it("--fix never quarantines a device that (inconsistently) still carries a lease", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const state = await openTestState();
      let registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
        state,
      });
      const device = await registry.registerDevice({
        driverData: { fakeDeviceId: "simlock-stuck" },
        driverDeviceId: "simlock-stuck",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      const first = await registry.createLease({
        deviceId: device.id,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 9_999_999,
        ttlMs: 60_000,
      });
      await registry.beginRelease(first.id);
      // why: the registry never grants a lease on a reclaiming device, so the inconsistent row goes in directly.
      state.database
        .prepare(
          "INSERT INTO leases (id, device_id, requester_id, owner_id, granted_at, ttl_ms, ttl_deadline, last_renewed_at, id_chosen_by_requester) VALUES ('lse_stray', ?, 'agent', 'agent', 1, 60000, 9999999, 1, 0)",
        )
        .run(device.id);
      registry = await loadTestRegistry({ clock, eventBus, idGenerator: sequence(), state });
      clock.advance(100_000);
      const driver = new FakeDriver({ clock, estimateMs: { reclaim: 2_000 }, platform: "ios" });
      const quarantine = { enterFromStalledTransition: vi.fn() };

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        quarantine,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ deviceId: device.id, kind: "stalled-transition" }),
      );
      expect(quarantine.enterFromStalledTransition).not.toHaveBeenCalled();
      expect(registry.snapshot.devices[0]?.state).toBe("reclaiming");
    });
  });

  describe("a startup read", () => {
    async function setup() {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const registered = await registry.registerDevice({
        driverData: { fakeDeviceId: "gone" },
        driverDeviceId: "gone",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(registered.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: registered.id },
      });
      const driver = new FakeDriver({ clock, platform: "ios" });
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      });
      return { doctor, driver, registered };
    }

    it("is reconciled against instead of calling listManaged again", async () => {
      const { doctor, driver, registered } = await setup();
      const read = new StartupRead(new Map([["ios", { devices: [], processes: [] }]]));

      const report = await doctor.reconcile({ read });

      expect(driver.calls.map((call) => call.operation)).not.toContain("listManaged");
      expect(report.findings).toEqual([
        { deviceId: registered.id, kind: "registry-device-missing", platform: "ios" },
      ]);
    });

    it("reports no drift for the devices of a platform it left out, as for one with no driver", async () => {
      const { doctor, driver } = await setup();

      const report = await doctor.reconcile({ read: new StartupRead() });

      expect(driver.calls.map((call) => call.operation)).not.toContain("listManaged");
      expect(report.findings).toEqual([]);
    });
  });
});
