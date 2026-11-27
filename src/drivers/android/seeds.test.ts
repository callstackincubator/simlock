import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { buildPart, libraryHarness, seedHarness } from "./test-seeds.js";
import {
  ANDROID_SDK_ROOT as sdk,
  avdDirectory,
  binaries,
  createdFromPackage,
  customDeviceXml,
  customFitXml,
  makingTheSeed,
  taggedHarness as taggedHarnessWith,
} from "./testing.js";

const taggedHarness = (
  ...args: Parameters<typeof taggedHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => taggedHarnessWith(buildPart, ...args);

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Seeds` directly over a memory filesystem and a scripted runner, with the real parts it takes.
describe("Seeds", () => {
  it("normalizes dotted API targets before seed boots and preserves them in device copies", async () => {
    for (const [api, generatedTarget, expectedTarget] of [
      ["35", "android-35", "android-35"],
      ["37.0", "android-0", "android-37"],
    ] as const) {
      const { driver, filesystem, runner } = await taggedHarness([
        [api, "google_apis", "arm64-v8a"],
      ]);
      const seedHome = join(avdDirectory, "sources", "seed_two");
      const iniPath = join(seedHome, "simlock.ini");
      const generated = `avd.ini.encoding=UTF-8\npath=${join(seedHome, "simlock.avd")}\ntarget=${generatedTarget}\n`;
      await filesystem.writeFileAtomic(iniPath, generated);
      const bootMetadata: Promise<string>[] = [];
      const spawn = runner.spawn.bind(runner);
      vi.spyOn(runner, "spawn").mockImplementation((command, args, options) => {
        if (command === binaries.emulator && args.includes("-avd")) {
          bootMetadata.push(filesystem.readFile(iniPath));
        }
        return spawn(command, args, options);
      });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: api,
        platform: "android",
      });

      const device = await driver.provision(spec);

      const expected = generated.replace(`target=${generatedTarget}`, `target=${expectedTarget}`);
      expect(await Promise.all(bootMetadata), `seed boot targets for API ${api}`).toEqual([
        expected,
        expected,
      ]);
      const copyHome = join(avdDirectory, device.deviceId);
      expect(await filesystem.readFile(join(copyHome, "simlock.ini"))).toBe(
        expected.replace(/^path=.*$/m, `path=${join(copyHome, "simlock.avd")}`),
      );
      expect(spec.osVersion).toBe(api);
      expect(createdFromPackage(runner)).toBe(`system-images;android-${api};google_apis;arm64-v8a`);
    }
  });

  describe("image tag", () => {
    it("creates a tagged device from the host ABI's image when the tag is installed for two ABIs", async () => {
      // why: On an x86_64 host the foreign arm64-v8a image is listed first, so taking the first image
      // of the tag would pick it.
      const { driver, runner } = await taggedHarness(
        [
          ["34", "google_apis_playstore", "arm64-v8a"],
          ["34", "google_apis_playstore", "x86_64"],
        ],
        "x86_64",
      );

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;x86_64",
      );
    });

    it("creates a tagged device from a foreign ABI's image when that is the only image of the tag", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "x86_64"],
      ]);

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;x86_64",
      );
    });

    it("fails provisioning a tagged spec whose image went missing after it resolved, offering no download", async () => {
      const { driver, filesystem, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
      ]);
      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await filesystem.rm(`${sdk}/system-images/android-34/google_apis_playstore`);

      const failure = await driver.provision(spec).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect((failure as Error).message).toContain("google_apis_playstore");
      expect(createdFromPackage(runner)).toBeUndefined();
    });
  });

  it("does not change the config hash when simlock.mark is present in config.ini", async () => {
    const hashWith = async (config: string) => {
      const harness = await seedHarness(makingTheSeed(), { config });
      const device = await harness.seeds.provision(harness.spec);
      return (device.driverData as { configHash: string }).configHash;
    };

    expect(await hashWith("hw.ramSize=2048\nsimlock.mark=some-token\n")).toBe(
      await hashWith("hw.ramSize=2048\n"),
    );
  });

  describe("device-profile sources", () => {
    it("captures differing hardware properties in the config hash, proving they land before it is computed", async () => {
      const hashWith = async (ramMiB: number) => {
        const harness = await libraryHarness({ devicesXml: customDeviceXml("Custom A", ramMiB) });
        const device = await harness.provision("Custom A");
        return (device.driverData as { configHash: string }).configHash;
      };

      expect(await hashWith(2048)).not.toBe(await hashWith(4096));
    });

    it("shadows a devices.xml profile with a built-in one of the same name and never applies properties", async () => {
      // why: same name as the built-in fixture's "Pixel 5" -- the built-in source is registered
      // first, so it must win and the devices.xml properties must never be touched.
      const harness = await libraryHarness({ devicesXml: customDeviceXml("Pixel 5", 4096) });
      const seeded = await harness.filesystem.readFile(harness.configPath);

      await harness.provision("Pixel 5");

      await expect(harness.filesystem.readFile(harness.configPath)).resolves.toBe(seeded);
    });

    it("rejects a hardware-property value with an embedded line break, defense in depth beyond the devices.xml parser", async () => {
      // why: `UserDeviceProfileSource`/`parseDevicesXml` already reject this at the devices.xml parse
      // boundary (see device-profile-source.test.ts), but `DeviceProfileSource` is a documented
      // extension point (see the interface's own doc comment) -- a future or third-party source
      // could hand the driver a multiline value directly, bypassing that parser entirely. This
      // exercises `#mergeConfigIniLines`'s own independent guard by going around the parser with
      // a custom source, standing in for `<d:manufacturer>Google\ndisk.dataPartition.path=/evil
      // </d:manufacturer>`.
      const maliciousSource = {
        async profiles() {
          return [
            {
              hardwareProperties: {
                "hw.device.manufacturer": "Acme\ndisk.dataPartition.path=/evil",
                "hw.device.name": "Evil Phone",
              },
              kind: "properties" as const,
              name: "Evil Phone",
              names: ["Evil Phone"],
            },
          ];
        },
      };
      const harness = await libraryHarness({ sources: [maliciousSource] });

      await expect(harness.provision("Evil Phone")).rejects.toThrow(/line break/);

      // why: a failed seed make removes its folder, so none of the rejected value stays on disk.
      await expect(harness.filesystem.exists(harness.configPath)).resolves.toBe(false);
    });

    it("writes the same config.ini keys for a rich devices.xml profile as for a plain one", async () => {
      const keysOf = async (xml: string) => {
        const harness = await libraryHarness({
          devicesXml: xml,
          extraImages: [["35", "android-tv", "arm64-v8a"]],
        });
        await harness.provision("Keyed");
        return [...(await harness.config()).keys()].sort();
      };
      const plain = customDeviceXml("Keyed", 4096);
      const rich = customFitXml({
        apiLevel: "31-",
        diagonal: "10.1",
        name: "Keyed",
        playStore: "false",
        tagId: "android-tv",
      }).replace("</d:hardware>", '<d:ram unit="MiB">4096</d:ram></d:hardware>');

      const plainKeys = await keysOf(plain);
      expect(plainKeys).toEqual([
        "PlayStore.enabled",
        "abi.type",
        "avd.ini.encoding",
        "disk.dataPartition.size",
        "hw.cpu.arch",
        "hw.device.name",
        "hw.lcd.density",
        "hw.ramSize",
        "hw.seedOnly",
        "image.sysdir.1",
        "showDeviceFrame",
        "skin.name",
        "skin.path",
        "tag.id",
        "target",
        "vm.heapSize",
      ]);
      expect(await keysOf(rich)).toEqual(plainKeys);
    });
  });
});
