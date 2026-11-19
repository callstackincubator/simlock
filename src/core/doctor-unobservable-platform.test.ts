import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { Doctor } from "./doctor.js";
import { FakeDriver } from "./fake-driver.js";
import { SerializedDecision } from "./serialized-decision.js";
import { config, loadRegistry, readyDevice, readyIosDevice, rootRejection } from "./test-doctor.js";
import { driverDevice, observed } from "./test-doctor-observed.js";

async function legacyDeviceSetup() {
  const clock = new FakeClock(10_000);
  const eventBus = new EventBus(clock);
  const registry = await loadRegistry(clock, eventBus);
  await readyDevice(registry, "stranded", "ios");
  const driver = new FakeDriver({
    clock,
    legacyDevices: {
      stranded: { device: driverDevice("stranded"), path: "/Library/Devices/stranded" },
    },
    platform: "ios",
  });
  driver.setManagedReality({ devices: [], processes: [] });
  return { clock, driver, eventBus, registry };
}

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor with a platform it cannot observe", () => {
  it("never reports a registry device missing because no driver could look for it", async () => {
    const { eventBus, registry } = await readyIosDevice();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock: new FakeClock(10_000),
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    // why: "I could not look" is not "the device is gone". Marking these `deleted` would strand
    // every simulator in the root behind a registry with no record of it -- the permanent
    // multi-gigabyte leak ADR 0001 exists to prevent, reachable with a `chmod`.
    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("stays silent about a platform that simply has no driver on this host", async () => {
    const { eventBus, registry } = await readyIosDevice();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock: new FakeClock(10_000),
      config: config(),
      drivers: [],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(report.findings).toEqual([]);
    expect(registry.snapshot.devices[0]?.state).toBe("ready");
  });

  it("destroys orphans only when the purge is asked for, and reports what it destroyed", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, deviceRoot: "/roots/ios", platform: "ios" });
    driver.setManagedReality({
      devices: [observed("orphan-1", "running")],
      processes: [driverDevice("orphan-1")],
    });
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    });

    const reported = await doctor.reconcile({ fix: true });
    expect(reported.findings.map((finding) => finding.kind)).toEqual([
      "orphan-device",
      "orphan-process",
    ]);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toEqual([]);

    const purged = await doctor.reconcile({ purgeOrphans: true });

    expect(purged.findings).toEqual([]);
    expect(eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.orphan-purged",
        payload: { deviceRoot: "/roots/ios", driverDeviceId: "orphan-1", platform: "ios" },
      }),
    );
  });

  it("re-proves the root before the first destroy of a purge", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({ devices: [observed("orphan-1", "stopped")], processes: [] });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      purgeOrphans: true,
    });

    expect(
      driver.calls.map((call) => call.operation).filter((operation) => operation !== "listSources"),
    ).toEqual(["listManaged", "revalidateRoot", "destroy"]);
  });

  it("destroys nothing at all when a root can no longer be proven", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const iosDriver = new FakeDriver({ clock, platform: "ios" });
    iosDriver.setManagedReality({ devices: [observed("ios-orphan", "stopped")], processes: [] });
    const androidDriver = new FakeDriver({ clock, platform: "android" });
    androidDriver.setManagedReality({
      devices: [observed("android-orphan", "stopped")],
      processes: [],
    });
    androidDriver.failOn("revalidateRoot", 1, new Error("Refusing the android device root"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [iosDriver, androidDriver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    // why: A daemon that cannot prove one of its roots is not one to keep destroying on, and
    // the roots are proven before anything is destroyed -- so this costs a re-run, never a
    // half-purge.
    expect(
      [...iosDriver.calls, ...androidDriver.calls].filter((call) => call.operation === "destroy"),
    ).toEqual([]);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "orphan-device",
      "orphan-device",
    ]);
    expect(eventBus.replay().some((event) => event.event === "device.orphan-purged")).toBe(false);
  });

  it("leaves an orphan it could not destroy standing and purges the rest", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [observed("stubborn", "stopped"), observed("orphan-2", "stopped")],
      processes: [],
    });
    driver.failOn("destroy", 1, new Error("simctl delete failed"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ purgeOrphans: true });

    expect(report.findings).toEqual([
      {
        device: expect.objectContaining({ deviceId: "stubborn" }),
        kind: "orphan-device",
        platform: "ios",
      },
    ]);
    expect(
      eventBus.replay().filter((event) => event.event === "device.orphan-purged"),
    ).toHaveLength(1);
  });

  it("reports a device left in the pre-root location as legacy rather than missing", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile();

    expect(report.findings).toEqual([
      {
        device: expect.objectContaining({ deviceId: "stranded" }),
        deviceId: registry.snapshot.devices[0]?.id,
        kind: "legacy-device",
        path: "/Library/Devices/stranded",
        platform: "ios",
      },
    ]);
  });

  it("destroys a legacy device through its old path and then records it missing", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      fix: true,
    });

    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toHaveLength(1);
    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
  });

  it("never destroys a legacy device that a lease still references", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();
    const device = registry.snapshot.devices[0]!;
    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlMs: 60_000,
      ttlDeadline: 90_000,
    });

    await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({
      fix: true,
    });

    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toEqual([]);
    expect(registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("reports a missing device as missing when the legacy lookup itself fails", async () => {
    const { clock, driver, eventBus, registry } = await legacyDeviceSetup();
    driver.failOn("findLegacy", 1, new Error("simctl list failed"));

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    // why: "I could not look outside the root" is not "it is out there": the conservative
    // finding is the one whose fix only writes to the registry.
    expect(report.findings.map((finding) => finding.kind)).toEqual(["registry-device-missing"]);
    expect(driver.calls.filter((call) => call.operation === "destroyLegacy")).toEqual([]);
  });
});
