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
});
