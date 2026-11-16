import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { createHarness, seedReady } from "./test-lease-acquisition.js";

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
      knownModels: ["Pixel 6", "Pixel 9"],
      modelClasses: { "Pixel 6": "phone", "Pixel 9": "phone" },
      modelRuntimes: { "Pixel 6": ["36", "37"], "Pixel 9": ["36", "37"] },
      platform: "android",
    });
  }

  const pixel9 = { model: "Pixel 9", physical: false, platform: "android" } as const;
  const tagged = { ...pixel9, imageTag: tag, osVersion: "36" } as const;

  it("gives a tagless Android lease the newest level that has the default tag, and an idle ready device of that spec before a new one", async () => {
    const harness = await createHarness({
      defaultImageTags: { android: tag },
      drivers: [fleetDriver()],
      maxDevices: 6,
      maxRunning: 6,
      preferences: { android: { phone: ["Pixel 9", "Pixel 6"] } },
    });

    const grants = [
      ["no OS", pixel9],
      ["--os 36", { ...pixel9, osVersion: "36" }],
      ["range >=35", { ...pixel9, osVersion: ">=35" }],
      ["class phone", { physical: false, platform: "android", class: "phone" }],
    ] as const;
    for (const [label, input] of grants) {
      const granted = await harness.coordinator.request(input, owner(label));
      expect(granted.device.spec, label).toEqual(tagged);
    }

    const idle = await seedReady(harness, tagged);
    const reused = await harness.coordinator.request(pixel9, owner("reuse"));
    expect(reused.device.id).toBe(idle.id);
  });
});
