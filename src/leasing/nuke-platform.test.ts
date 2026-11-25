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

describe("a platform nuke with --delete-devices", () => {
  async function seededPlatforms() {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const seed = (id: string) => ({ id, kind: "seed", model: "Phone", osVersion: "1" }) as const;
    ios.setSources([seed("ios-seed"), { ...seed("ios-orphan"), orphan: true }]);
    android.setSources([seed("android-seed")]);
    const harness = await createHarness({ driver: ios, drivers: [ios, android] });
    for (const [name, spec, requesterId] of [
      ["ios-base", request, "i"],
      ["android-base", androidRequest, "a"],
    ] as const) {
      const grant = await harness.engine.request(spec, { ownerId: requesterId, requesterId });
      await harness.engine.core.baselines.save({ leaseId: grant.lease.id, name, requesterId });
    }
    const nuke = new Nuke({ executor: harness.engine, registry: harness.registry });
    const sourcesOf = async (driver: FakeDriver) =>
      (await driver.listSources()).map((source) => source.id);
    const baselineNames = async () =>
      (await harness.engine.core.baselines.list()).map((entry) => entry.name);
    return { android, baselineNames, ios, nuke, sourcesOf };
  }

  it("deletes only that platform's seeds and baselines, never an orphan, and nothing without --delete-devices", async () => {
    const plain = await seededPlatforms();
    const kept = {
      android: await plain.sourcesOf(plain.android),
      ios: await plain.sourcesOf(plain.ios),
    };
    expect(await plain.baselineNames()).toEqual(["android-base", "ios-base"]);
    const none = await plain.nuke.run({ deleteDevices: false, platform: "ios" });
    expect(none.removedBaselines).toEqual([]);
    expect(await plain.sourcesOf(plain.ios)).toEqual(kept.ios);
    expect(await plain.sourcesOf(plain.android)).toEqual(kept.android);
    expect(await plain.baselineNames()).toEqual(["android-base", "ios-base"]);

    const ios = await seededPlatforms();
    const iosReport = await ios.nuke.run({ deleteDevices: true, platform: "ios" });
    expect(iosReport.removedBaselines).toEqual(["ios-base"]);
    expect(await ios.baselineNames()).toEqual(["android-base"]);
    expect(await ios.sourcesOf(ios.ios)).toEqual(["ios-orphan"]);
    expect(await ios.sourcesOf(ios.android)).toEqual(kept.android);

    const android = await seededPlatforms();
    const androidReport = await android.nuke.run({ deleteDevices: true, platform: "android" });
    expect(androidReport.removedBaselines).toEqual(["android-base"]);
    expect(await android.baselineNames()).toEqual(["ios-base"]);
    expect(await android.sourcesOf(android.android)).toEqual([]);
    expect(await android.sourcesOf(android.ios)).toEqual(kept.ios);
  });
});
