import { describe, expect, it } from "vitest";
import { Nuke, type Platform } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, flush, request } from "./test-create-leasing.js";

describe("a platform nuke", () => {
  async function twoPlatforms() {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({ driver: ios, drivers: [ios, android] });
    const grants = {
      android: await harness.engine.request(androidRequest, { ownerId: "a", requesterId: "a" }),
      ios: await harness.engine.request(request, { ownerId: "i", requesterId: "i" }),
    };
    const nuke = new Nuke({ executor: harness.engine, registry: harness.registry });
    return { grants, harness, ios, nuke };
  }

  it("releases only the platform's leases, ends a physical lease and keeps the device, cancels waiting requests, and deletes only its devices, with a report listing only those", async () => {
    for (const [platform, other] of [
      ["ios", "android"],
      ["android", "ios"],
    ] as const satisfies readonly (readonly [Platform, Platform])[]) {
      const { grants, harness, nuke } = await twoPlatforms();

      const report = await nuke.run({ deleteDevices: true, platform });

      expect(report.releasedLeaseIds, platform).toEqual([grants[platform].lease.id]);
      expect(report.deletedDevices, platform).toEqual([grants[platform].device.id]);
      expect(
        harness.registry.snapshot.leases.map((lease) => lease.id),
        platform,
      ).toEqual([grants[other].lease.id]);
      expect(
        harness.registry.snapshot.devices.find((device) => device.id === grants[other].device.id)
          ?.state,
        platform,
      ).toBe("leased");
    }

    const waiting = await twoPlatforms();
    const queued = waiting.harness.engine.request(androidRequest, {
      ownerId: "next",
      requesterId: "next",
    });
    const cancelled = expect(queued).rejects.toMatchObject({ name: "NukeCancelledError" });
    await flush();
    await waiting.nuke.run({ deleteDevices: false, platform: "ios" });
    await cancelled;

    const physical = await twoPlatforms();
    const phone = await physical.harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "UDID-A",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      platform: "ios",
    });
    physical.ios.setPhysicalPresence("UDID-A", true);
    await physical.harness.engine.release(physical.grants.ios.lease.id, "explicit");
    const physicalGrant = await physical.harness.engine.request(
      { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      { ownerId: "p", requesterId: "p" },
    );
    const report = await physical.nuke.run({ deleteDevices: true, platform: "ios" });
    expect(report.releasedLeaseIds).toEqual([physicalGrant.lease.id]);
    expect(report.deletedDevices).toEqual([]);
    expect(
      physical.harness.registry.snapshot.devices.find((device) => device.id === phone.id)?.state,
    ).not.toBe("deleted");
  });
});
