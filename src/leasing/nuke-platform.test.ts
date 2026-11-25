import { describe, expect, it } from "vitest";
import { Nuke } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { androidRequest, createHarness, request } from "./test-create-leasing.js";

describe("a platform nuke", () => {
  async function twoPlatforms() {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({ driver: ios, drivers: [ios, android] });
    const iosGrant = await harness.engine.request(request, { ownerId: "i", requesterId: "i" });
    const androidGrant = await harness.engine.request(androidRequest, {
      ownerId: "a",
      requesterId: "a",
    });
    const nuke = new Nuke({ executor: harness.engine, registry: harness.registry });
    return { androidGrant, harness, iosGrant, nuke };
  }

  it("releases only the platform's leases and deletes only its devices, and the report lists only those", async () => {
    const { androidGrant, harness, iosGrant, nuke } = await twoPlatforms();

    const report = await nuke.run({ deleteDevices: true, platform: "ios" });

    expect(report.releasedLeaseIds).toEqual([iosGrant.lease.id]);
    expect(report.deletedDevices).toEqual([iosGrant.device.id]);
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([
      androidGrant.lease.id,
    ]);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === androidGrant.device.id)
        ?.state,
    ).toBe("leased");
  });
});
