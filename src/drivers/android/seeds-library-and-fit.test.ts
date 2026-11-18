import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { MemoryFilesystem } from "../../ports/index.js";

import type { DeviceProfileSource } from "./device-profile-source.js";
import { LIBRARY_PROFILES, type LibraryDeviceProfile } from "./profiles/index.js";
import { buildPart, libraryHarness } from "./test-seeds.js";
import {
  ANDROID_SDK_ROOT as sdk,
  avdDirectory,
  fitHarness as fitHarnessWith,
  HOST_IMAGES,
  pixelDevices,
  seedConfig,
  testLibraryProfile,
  twoPixelDevices,
} from "./testing.js";

const fitHarness = (
  ...args: Parameters<typeof fitHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => fitHarnessWith(buildPart, ...args);

function libraryPixel9(): LibraryDeviceProfile {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === "pixel_9");
  if (profile === undefined) throw new Error("the library has no profile with id pixel_9");
  return profile;
}

class WriteFailureFilesystem extends MemoryFilesystem {
  armed = false;

  constructor(
    private readonly failingPath: string,
    private readonly error: Error,
  ) {
    super();
  }

  override async writeFileAtomic(
    ...args: Parameters<MemoryFilesystem["writeFileAtomic"]>
  ): Promise<void> {
    if (this.armed && args[0] === this.failingPath) {
      throw this.error;
    }
    return super.writeFileAtomic(...args);
  }
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Seeds` directly over a memory filesystem and a scripted runner, with the real parts it takes.
describe("Seeds", () => {
  describe("library device profiles", () => {
    it("provisions a library device with every `hardware` value of the profile in `config.ini`", async () => {
      const harness = await libraryHarness({ listing: pixelDevices });

      await harness.provision("Pixel 9");

      const config = await harness.config();
      const hardware = Object.entries(libraryPixel9().hardware);
      expect(hardware.length).toBeGreaterThan(100);
      expect(hardware.filter(([key, value]) => config.get(key) !== value)).toEqual([]);
    });

    it("provisions identical `hw.*` and `vm.heapSize` lines whether `avdmanager list device` lists `pixel_9` or not", async () => {
      const without = await libraryHarness({ listing: pixelDevices });
      const withListed = await libraryHarness({
        listing: twoPixelDevices,
        seed: seedConfig(["hw.gpu.mode=host", "hw.lcd.density=480", "hw.ramSize=8G"]),
      });

      await without.provision("Pixel 9");
      await withListed.provision("Pixel 9");

      const hardwareLines = async (harness: typeof without) =>
        (await harness.lines()).filter((line) => /^(hw\.|vm\.heapSize=)/.test(line)).sort();
      const expected = await hardwareLines(without);
      expect(expected.length).toBeGreaterThan(100);
      expect(await hardwareLines(withListed)).toEqual(expected);
    });

    it("removes every `hw.*` (except `hw.cpu.arch`), `vm.heapSize` and `skin.*` line the seed wrote that the profile does not set", async () => {
      const harness = await libraryHarness({
        profiles: [testLibraryProfile({ hardware: { "hw.lcd.height": "100" } })],
        seed: seedConfig(["hw.seedOnly=yes", "skin.dynamic=yes"]),
      });

      await harness.provision("Test Phone");

      const lines = await harness.lines();
      expect(lines.filter((line) => line.startsWith("skin."))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("vm.heapSize"))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("hw.")).sort()).toEqual([
        "hw.cpu.arch=arm64",
        "hw.lcd.height=100",
      ]);
    });

    it("keeps `image.sysdir.1`, `tag.id`, `abi.type`, `target`, `hw.cpu.arch`, `disk.dataPartition.size` and `showDeviceFrame` as `avdmanager` wrote them", async () => {
      const harness = await libraryHarness({ listing: pixelDevices });

      await harness.provision("Pixel 9");

      const config = await harness.config();
      expect(
        [
          "image.sysdir.1",
          "tag.id",
          "abi.type",
          "target",
          "hw.cpu.arch",
          "disk.dataPartition.size",
          "showDeviceFrame",
        ].map((key) => `${key}=${config.get(key)}`),
      ).toEqual([
        "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/",
        "tag.id=google_apis",
        "abi.type=arm64-v8a",
        "target=android-35",
        "hw.cpu.arch=arm64",
        "disk.dataPartition.size=6G",
        "showDeviceFrame=yes",
      ]);
    });

    it("sets `PlayStore.enabled=yes` on a Play Store image when the profile allows Play Store, and `no` on a `google_apis` image", async () => {
      const playStore = { imageTag: "google_apis_playstore" };
      const allowed = await libraryHarness({ ...playStore, listing: pixelDevices });
      await allowed.provision("Pixel 9");
      expect((await allowed.config()).get("PlayStore.enabled")).toBe("yes");

      const googleApis = await libraryHarness({
        listing: pixelDevices,
        seed: seedConfig(["PlayStore.enabled=yes"]),
      });
      await googleApis.provision("Pixel 9");
      expect((await googleApis.config()).get("PlayStore.enabled")).toBe("no");
    });

    it("reads an image's tags from `SystemImage.TagId`, and from the folder name when it has none", async () => {
      const playStoreOf = async (imageTag: string, imageProperties: string) => {
        const harness = await libraryHarness({ imageProperties, imageTag, listing: pixelDevices });
        await harness.provision("Pixel 9");
        return (await harness.config()).get("PlayStore.enabled");
      };

      expect(await playStoreOf("custom-folder", "SystemImage.TagId=google_apis_playstore\n")).toBe(
        "yes",
      );
      expect(await playStoreOf("google_apis_playstore", "")).toBe("yes");
      expect(await playStoreOf("google_apis_playstore", "Pkg.Revision=1\n")).toBe("yes");
      expect(await playStoreOf("google_apis_playstore", "SystemImage.TagId=google_apis\n")).toBe(
        "no",
      );
    });

    it("writes the profile's boot properties to `boot.prop`, and removes a seed's `boot.prop` when the profile has none", async () => {
      const withProperties = await libraryHarness({
        profiles: [
          testLibraryProfile({ bootProperties: { "persist.x": "y", "ro.simlock.test": "1" } }),
        ],
        seedBootProp: "ro.seed=1\n",
      });
      await withProperties.provision("Test Phone");
      const written = await withProperties.filesystem.readFile(withProperties.bootPropPath);
      expect(
        written
          .split("\n")
          .filter((line) => line !== "")
          .sort(),
      ).toEqual(["persist.x=y", "ro.simlock.test=1"]);

      const without = await libraryHarness({ listing: pixelDevices, seedBootProp: "ro.seed=1\n" });
      await expect(without.filesystem.exists(without.bootPropPath)).resolves.toBe(true);
      await without.provision("Pixel 9");
      await expect(without.filesystem.exists(without.bootPropPath)).resolves.toBe(false);
    });

    it.each([
      ["a hardware value", "\r"],
      ["a hardware value", "\n"],
      ["a hardware value", "\u0000"],
      ["a hardware key", "\r"],
      ["a hardware key", "\n"],
      ["a hardware key", "\u0000"],
      ["a boot property value", "\r"],
      ["a boot property value", "\n"],
      ["a boot property value", "\u0000"],
    ] as const)(
      "refuses %s with %j before `avdmanager create avd` runs",
      async (where, character) => {
        const profileWith = (inserted: string) =>
          testLibraryProfile(
            where === "a hardware value"
              ? { hardware: { "hw.ramSize": `2${inserted}G` } }
              : where === "a hardware key"
                ? { hardware: { [`hw.bad${inserted}key`]: "1" } }
                : { bootProperties: { "ro.x": `a${inserted}b` } },
          );
        const accepted = await libraryHarness({ profiles: [profileWith("-")] });
        await accepted.provision("Test Phone");
        expect(accepted.createCalls()).toHaveLength(1);

        const refused = await libraryHarness({ profiles: [profileWith(character)] });

        await expect(refused.provision("Test Phone")).rejects.toThrow();
        expect(refused.createCalls()).toEqual([]);
      },
    );

    it("refuses NUL in a `devices.xml` value, through the one shared check", async () => {
      const profileNamed = (name: string): DeviceProfileSource => ({
        async profiles() {
          return [
            {
              hardwareProperties: { "hw.device.name": name },
              kind: "properties" as const,
              name: "Custom A",
              names: ["Custom A"],
            },
          ];
        },
      });
      const accepted = await libraryHarness({ sources: [profileNamed("Custom A")] });
      await accepted.provision("Custom A");
      expect((await accepted.config()).get("hw.device.name")).toBe("Custom A");

      const refused = await libraryHarness({ sources: [profileNamed("Custom\u0000A")] });

      await expect(refused.provision("Custom A")).rejects.toThrow(/Refusing to merge/);
    });

    it("rethrows and runs no `avdmanager delete` when a write after `avdmanager create avd` fails", async () => {
      const filesystem = new WriteFailureFilesystem(
        join(avdDirectory, "sources", "seed_two", "simlock.avd", "config.ini"),
        new Error("disk full"),
      );
      const harness = await libraryHarness({ filesystem, listing: pixelDevices });
      filesystem.armed = true;

      await expect(harness.provision("Pixel 9")).rejects.toThrow("disk full");

      expect(harness.createCalls()).toHaveLength(1);
      expect(harness.runner.calls.some((call) => call.args.includes("delete"))).toBe(false);
    });

    it("seeds `avdmanager create avd` with the first profile `avdmanager list device` prints, also when it lists `pixel_9`", async () => {
      const listsPixel9 = await libraryHarness({ listing: twoPixelDevices });
      await listsPixel9.provision("Pixel 9");

      const lacksPixel9 = await libraryHarness({ listing: pixelDevices });
      await lacksPixel9.provision("Pixel 9");

      expect(listsPixel9.seedDeviceId()).toBe("pixel_5");
      expect(lacksPixel9.seedDeviceId()).toBe("pixel_5");
    });
  });

  describe("image fit", () => {
    it("creates a phone from the Play Store image at the newest level, and the TV from the android-tv image", async () => {
      const phone = await fitHarness(HOST_IMAGES);
      await phone.driver.provision(await phone.resolve("Pixel 5"));
      const tv = await fitHarness(HOST_IMAGES);
      await tv.driver.provision(await tv.resolve("Television (720p)"));

      expect(phone.createdPackage()).toBe(
        "system-images;android-36;google_apis_playstore;arm64-v8a",
      );
      expect(tv.createdPackage()).toBe("system-images;android-34;android-tv;arm64-v8a");
    });

    it("creates the device from a fitting image, never a misfit one that sorts first", async () => {
      const { createdPackage, driver, resolve } = await fitHarness(
        [
          ["34", "google_apis", "arm64-v8a"],
          ["34", "google-tv", "arm64-v8a"],
          ["34", "android-tv", "x86_64"],
        ],
        { hostAbi: "arm64-v8a" },
      );

      await driver.provision(await resolve("Television (720p)"));

      expect(createdPackage()).toBe("system-images;android-34;google-tv;arm64-v8a");
    });

    it.each([
      [
        "host-native google_apis",
        [
          ["35", "default", "arm64-v8a"],
          ["35", "google_apis", "x86_64"],
          ["35", "google_apis", "arm64-v8a"],
        ] as const,
        "system-images;android-35;google_apis;arm64-v8a",
      ],
      [
        "host-native",
        [
          ["35", "google_apis", "x86_64"],
          ["35", "default", "arm64-v8a"],
        ] as const,
        "system-images;android-35;default;arm64-v8a",
      ],
      [
        "google_apis",
        [
          ["35", "default", "x86_64"],
          ["35", "google_apis", "x86_64"],
        ] as const,
        "system-images;android-35;google_apis;x86_64",
      ],
      ["any", [["35", "default", "x86_64"]] as const, "system-images;android-35;default;x86_64"],
    ])("follows today's order among fitting images: %s first", async (_name, images, expected) => {
      const { createdPackage, driver, resolve } = await fitHarness(images);

      await driver.provision(await resolve("Pixel 5", "35"));

      expect(createdPackage()).toBe(expected);
    });

    it("throws RUNTIME_MISSING when no fitting image is left, and creates nothing from a misfit one", async () => {
      const { driver, filesystem, resolve, runner } = await fitHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "android-tv", "arm64-v8a"],
      ]);
      const spec = await resolve("Television (720p)");
      await filesystem.rm(`${sdk}/system-images/android-34/android-tv`);

      await expect(driver.provision(spec)).rejects.toMatchObject({
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect(runner.calls.some((call) => call.args[0] === "create")).toBe(false);
    });
  });
});
