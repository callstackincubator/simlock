import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { createHarness, seedReady } from "./test-lease-acquisition.js";

describe("LeaseAcquisitionCoordinator: a worker's default image tag", () => {
  const tag = "google_apis_playstore";
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  /** why: 36 has a Play Store image and 37 only a plain one, like the reporter's fleet. */
  function fleetDriver(options: { readonly taggedRefusals?: readonly string[] } = {}): FakeDriver {
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
      ...options,
    });
  }

  const pixel9 = { model: "Pixel 9", physical: false, platform: "android" } as const;
  const tagged = { ...pixel9, imageTag: tag, osVersion: "36" } as const;

  it("gives a tagless Android lease the newest level that has the default tag, and an idle ready device of that spec before a new one", async () => {
    const driver = fleetDriver();
    const harness = await createHarness({
      defaultImageTags: { android: tag },
      drivers: [driver],
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

    // why: the host-CPU rule (ADR 0078 §2) reaches the driver only on the worker's own attempt.
    const firstResolve = driver.calls.find((call) => call.operation === "resolveSpec");
    expect(firstResolve?.arguments[0]).toMatchObject({ defaultTag: true, imageTag: tag });

    const idle = await seedReady(harness, tagged);
    const reused = await harness.coordinator.request(pixel9, owner("reuse"));
    expect(reused.device.id).toBe(idle.id);
  });

  it("falls back to the request as it came when the tagged attempt is refused as a missing runtime, and keeps any other refusal", async () => {
    const untagged = (model: string, osVersion: string) => ({
      model,
      osVersion,
      physical: false,
      platform: "android",
    });
    const cases = [
      {
        expected: untagged("Pixel 9", "37"),
        input: { ...pixel9, osVersion: "37" },
        label: "--os 37, which has no tagged image",
      },
      {
        expected: untagged("Pixel 9", "37"),
        input: { ...pixel9, osVersion: ">=37" },
        label: "range >=37",
      },
      {
        expected: untagged("Pixel 6", "37"),
        input: { ...pixel9, model: "Pixel 6" },
        label: "a model the tagged image does not fit",
      },
      {
        expected: { name: "RuntimeMissingError" },
        input: { ...pixel9, osVersion: "38" },
        label: "a level no image fits",
        resolves: 2,
      },
      {
        allowDownload: true,
        expected: { name: "RuntimeMissingError" },
        input: { ...pixel9, osVersion: "38" },
        installs: ["38"],
        label: "--os 38 --allow-download",
      },
      {
        expected: { name: "UnknownModelError" },
        input: { ...pixel9, model: "Pixel 11" },
        label: "a model nobody lists",
        resolves: 1,
      },
    ] as const;

    for (const { expected, input, label, ...extra } of cases) {
      const installs: string[] = [];
      const driver = fleetDriver({ taggedRefusals: ["Pixel 6"] });
      const harness = await createHarness({
        components: {
          install: async ({ component }) => {
            installs.push(component);
            return { outcome: "installed", version: component };
          },
        },
        defaultImageTags: { android: tag },
        drivers: [driver],
      });

      const outcome = await harness.coordinator
        .request(input, { ...owner("agent"), allowDownload: "allowDownload" in extra })
        .then(
          (granted) => granted.device.spec,
          (error: unknown) => error,
        );

      if ("name" in expected) expect(outcome, label).toMatchObject(expected);
      else expect(outcome, label).toEqual(expected);
      expect(installs, label).toEqual("installs" in extra ? extra.installs : []);
      if ("resolves" in extra) {
        const resolves = driver.calls.filter((call) => call.operation === "resolveSpec");
        expect(resolves, label).toHaveLength(extra.resolves);
      }
    }
  });

  it("leaves a request the setting does not apply to as it was", async () => {
    const iosDriver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const cases = [
      {
        defaultImageTags: { android: tag },
        expected: { ...pixel9, imageTag: "google_apis", osVersion: "37" },
        input: { ...pixel9, imageTag: "google_apis" },
        label: "an explicit tag",
      },
      {
        defaultImageTags: { android: tag },
        expected: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
        input: { model: "iPhone 16", platform: "ios" },
        label: "iOS",
      },
      {
        defaultImageTags: {},
        expected: { ...pixel9, osVersion: "37" },
        input: pixel9,
        label: "the setting unset",
      },
    ] as const;

    for (const { defaultImageTags, expected, input, label } of cases) {
      const android = fleetDriver();
      const harness = await createHarness({
        defaultImageTags,
        drivers: [android, iosDriver],
      });

      const granted = await harness.coordinator.request(input, owner("agent"));

      // why: a fake iOS driver tolerates an image tag the real one refuses, so the request the driver saw is what proves the default stayed off.
      const asked = [...android.calls, ...iosDriver.calls].filter(
        (call) => call.operation === "resolveSpec",
      );
      for (const call of asked) {
        expect(call.arguments[0], label).not.toHaveProperty("defaultTag");
      }
      if (label === "iOS" || label === "the setting unset") {
        for (const call of asked) expect(call.arguments[0], label).not.toHaveProperty("imageTag");
      }

      expect(granted.device.spec, label).toMatchObject(expected);
      expect(granted.device.spec.imageTag, label).toBe(
        "imageTag" in expected ? expected.imageTag : undefined,
      );
    }
  });

  it("gives a baseline request the baseline's own spec, with no default tag asked of the driver", async () => {
    const driver = fleetDriver();
    const baseline = {
      mode: "full" as const,
      model: "Pixel 9",
      name: "checkout",
      osVersion: "37",
      platform: "android" as const,
      sourceId: "source-1",
      version: 1,
    };
    const harness = await createHarness({
      baselines: { current: () => baseline },
      defaultImageTags: { android: tag },
      drivers: [driver],
    });
    await seedReady(harness, {
      ...pixel9,
      baseline: { name: "checkout", version: 1 },
      osVersion: "37",
    });

    const granted = await harness.coordinator.request(
      { baseline: "checkout", platform: "android" },
      owner("agent"),
    );

    expect(granted.device.spec).toMatchObject({ baseline: { name: "checkout", version: 1 } });
    expect(granted.device.spec.imageTag).toBeUndefined();
    const asked = driver.calls.filter((call) => call.operation === "resolveSpec");
    for (const call of asked) expect(call.arguments[0]).not.toHaveProperty("defaultTag");
  });
});
