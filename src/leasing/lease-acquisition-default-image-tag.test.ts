import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { createHarness } from "./test-lease-acquisition.js";

describe("LeaseAcquisitionCoordinator: a worker's default image tag", () => {
  const tag = "google_apis_playstore";
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  /** why: 36 has a Play Store image and 37 only a plain one, like the reporter's fleet. */
  function fleetDriver(): FakeDriver {
    return new FakeDriver({
      availableOsVersions: ["36", "37"],
      clock: new FakeClock(1_000),
      images: [
        { abi: "arm64-v8a", runtime: "36", tag },
        { abi: "arm64-v8a", runtime: "37", tag: "google_apis" },
      ],
      platform: "android",
    });
  }

  const pixel9 = { model: "Pixel 9", physical: false, platform: "android" } as const;

  it("gives a tagless Android lease the newest level that has the default tag", async () => {
    const harness = await createHarness({
      defaultImageTags: { android: tag },
      drivers: [fleetDriver()],
    });

    const granted = await harness.coordinator.request(pixel9, owner("agent"));

    expect(granted.device.spec).toEqual({ ...pixel9, imageTag: tag, osVersion: "36" });
  });
});
