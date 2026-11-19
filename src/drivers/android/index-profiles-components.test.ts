import { describe, expect, it } from "vitest";
import { AndroidDriver, AndroidLicenseNotAcceptedError } from "./index.js";
import { type LibraryDeviceProfile } from "./profiles/index.js";
import {
  androidFilesystem,
  binaries,
  fitHarness as fitHarnessWith,
  seedConfig,
  EmulatorExitingRunner,
  customDeviceXml,
  customFitXml,
  type FitImage,
  InstallReflectingProcessRunner,
  pixelDevices,
  processResult,
  testLibraryProfile,
  twoPixelDevices,
  userListing,
  writeDevicesXml,
  provisionedHarness,
  createDriver,
} from "./testing.js";
import { sdk, home, buildDriver, libraryHarness } from "./test-index.js";

const fitHarness = (
  ...args: Parameters<typeof fitHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => fitHarnessWith(buildDriver, ...args);

function installFor(
  driver: AndroidDriver,
  component: string,
  options: { onProgress?: (progress: unknown) => void; signal?: AbortSignal } = {},
) {
  return driver.installComponent(component, {
    onProgress: options.onProgress ?? (() => undefined),
    signal: options.signal ?? new AbortController().signal,
  });
}

describe("AndroidDriver", () => {
  describe("device-profile-hidden advisories", () => {
    const hiddenMessage = (xmlName: string, libraryName: string) =>
      `"${xmlName}" in devices.xml is not used: Simlock's own ${libraryName} profile answers to that name`;

    // why: the fake adb server answers no version, so the physical handler adds its own advisory.
    async function hiddenProfileAdvisories(driver: AndroidDriver) {
      return (await driver.advisories()).filter(
        (advisory) => advisory.code === "device-profile-hidden",
      );
    }

    async function advisoriesFor(devicesXml: string | undefined, listing = pixelDevices) {
      const filesystem = await androidFilesystem();
      if (devicesXml !== undefined) await writeDevicesXml(filesystem, devicesXml);
      const runner = new EmulatorExitingRunner([
        processResult(binaries.avdmanager, ["list", "device"], listing),
      ]);
      const driver = await createDriver(filesystem, runner);
      return { advisories: await hiddenProfileAdvisories(driver), runner };
    }

    it("reports `device-profile-hidden` for a `devices.xml` profile named like a library profile, with the message naming both", async () => {
      const { advisories } = await advisoriesFor(customDeviceXml("Pixel 9", 4096));

      expect(advisories).toEqual([
        { code: "device-profile-hidden", message: hiddenMessage("Pixel 9", "Pixel 9") },
      ]);
    });

    it("reports one matching a library profile's other name, in any letter case, naming the library profile's display name", async () => {
      const { advisories } = await advisoriesFor(
        customDeviceXml("pixel_9", 4096) + customDeviceXml("PIXEL 9", 4096),
      );

      expect(advisories).toEqual([
        { code: "device-profile-hidden", message: hiddenMessage("pixel_9", "Pixel 9") },
        { code: "device-profile-hidden", message: hiddenMessage("PIXEL 9", "Pixel 9") },
      ]);
    });

    it("reports two hidden profiles as two advisories, in `devices.xml` order", async () => {
      const { advisories } = await advisoriesFor(
        customDeviceXml("Pixel 9", 4096) + customDeviceXml("Pixel 8", 4096),
      );

      expect(advisories.map((advisory) => advisory.message)).toEqual([
        hiddenMessage("Pixel 9", "Pixel 9"),
        hiddenMessage("Pixel 8", "Pixel 8"),
      ]);
    });

    it("reports nothing for a `devices.xml` profile no library profile answers to", async () => {
      const { advisories } = await advisoriesFor(customDeviceXml("My Tablet", 4096));

      expect(advisories).toEqual([]);
    });

    it("reports nothing for a library name the SDK also lists", async () => {
      const sdkListing = `Available devices:\nid: 0 or "pixel_9"\n    Name: Pixel 9\n    OEM : Google\n`;

      const { advisories } = await advisoriesFor(undefined, sdkListing);

      expect(advisories).toEqual([]);
    });

    it("reports one advisory per profile when `avdmanager list device` also lists it with `OEM : User`, and runs no `avdmanager`", async () => {
      const userListing = `Available devices:\nid: 0 or "Pixel 9"\n    Name: Pixel 9\n    OEM : User\n`;

      const { advisories, runner } = await advisoriesFor(
        customDeviceXml("Pixel 9", 4096),
        userListing,
      );

      expect(advisories).toEqual([
        { code: "device-profile-hidden", message: hiddenMessage("Pixel 9", "Pixel 9") },
      ]);
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.avdmanager);
    });

    it("reports nothing when `devices.xml` is missing or unreadable", async () => {
      const missing = await advisoriesFor(undefined);
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${home}/.android`);
      await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

      expect(missing.advisories).toEqual([]);
      expect(await hiddenProfileAdvisories(driver)).toEqual([]);
    });

    it("keeps the physical handler's advisories, before the new ones", async () => {
      const base = await androidFilesystem();
      await writeDevicesXml(base, customDeviceXml("Pixel 9", 4096));
      let broken = false;
      const filesystem = new Proxy(base, {
        get(target, property) {
          if (property === "stat" && broken) {
            return async () => {
              throw new Error("EACCES");
            };
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));
      broken = true;

      const advisories = await driver.advisories();

      expect(advisories.map((advisory) => advisory.code)).toEqual([
        "adb-protocol-mismatch",
        "device-profile-hidden",
      ]);
    });

    it("reports no hidden profiles for a driver built with injected `deviceProfileSources`", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(filesystem, customDeviceXml("Pixel 9", 4096));
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]), {
        deviceProfileSources: [],
      });

      expect(await hiddenProfileAdvisories(driver)).toEqual([]);
    });
  });

  describe("default-image-tag-not-installed advisory", () => {
    const missing = (tag: string, installed: string) => ({
      code: "default-image-tag-not-installed",
      message: `android.defaultImageTag is "${tag}", but no installed system image for this machine's CPU (arm64-v8a) has that tag (installed for arm64-v8a: ${installed}). Android leases that name no image tag get the image they would get without it.`,
    });

    async function tagAdvisories(
      images: readonly (readonly [string, string, string])[],
      defaultImageTag: string | undefined,
    ) {
      const filesystem = await androidFilesystem({ images });
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]), {
        deviceProfileSources: [],
        hostAbi: "arm64-v8a",
        ...(defaultImageTag === undefined ? {} : { defaultImageTag }),
      });
      return (await driver.advisories()).filter(
        (advisory) => advisory.code === "default-image-tag-not-installed",
      );
    }

    it("warns when no installed system image for the host CPU has `android.defaultImageTag`, naming the tag, the host CPU and the host CPU's tags sorted and once each", async () => {
      const host = [
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["35", "google_apis", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
      ] as const;
      const cases = [
        { name: "installed for the host CPU", images: host, tag: "google_apis", expected: [] },
        {
          name: "installed only for another CPU",
          images: [...host, ["35", "default", "x86_64"]] as const,
          tag: "default",
          expected: [missing("default", "google_apis, google_apis_playstore")],
        },
        {
          name: "installed nowhere",
          images: host,
          tag: "gogle_apis",
          expected: [missing("gogle_apis", "google_apis, google_apis_playstore")],
        },
        {
          name: "no image for the host CPU",
          images: [["35", "default", "x86_64"]] as const,
          tag: "google_apis",
          expected: [missing("google_apis", "none")],
        },
        { name: "setting unset", images: host, tag: undefined, expected: [] },
      ];

      for (const { name, images, tag, expected } of cases) {
        expect({ name, advisories: await tagAdvisories(images, tag) }).toEqual({
          name,
          advisories: expected,
        });
      }
    });
  });

  describe("device-profile sources", () => {
    it("resolves a devices.xml-only model and applies its properties to config.ini", async () => {
      const harness = await libraryHarness({ devicesXml: customDeviceXml("Custom A", 4096) });

      const spec = await harness.resolve("Custom A");
      expect(spec).toEqual({
        physical: false,
        model: "Custom A",
        osVersion: "35",
        platform: "android",
      });

      const device = await harness.driver.provision(spec);

      const config = await harness.filesystem.readFile(harness.configPath);
      expect(config).toContain("hw.device.name=Custom A");
      expect(config).toContain("hw.ramSize=4096");
      // why: The avdmanager `-d` seed uses a built-in device only to skip the interactive prompt --
      // it must never leak into the resolved spec or the applied hardware properties.
      expect(config).not.toContain("pixel_5");
      expect(device.driverData).toMatchObject({ avdName: "simlock" });
    });
  });

  describe("library device profiles", () => {
    it.each([
      { spelling: "Pixel 9", situation: "avdmanager does not list pixel_9", listing: pixelDevices },
      { spelling: "Pixel 9", situation: "avdmanager lists pixel_9 too", listing: twoPixelDevices },
      {
        spelling: "Pixel 9",
        situation: 'devices.xml defines a "Pixel 9"',
        listing: pixelDevices,
        devicesXml: customDeviceXml("Pixel 9", 4096),
        ramSize: "2G",
      },
      { spelling: "pixel_9", situation: "spelled as its avdmanager id", listing: pixelDevices },
      { spelling: "PIXEL 9", situation: "spelled in upper case", listing: pixelDevices },
    ])(
      'resolves "$spelling" to the library Pixel 9 when $situation',
      async ({ spelling, listing, devicesXml, ramSize }) => {
        const harness = await libraryHarness({ listing, ...(devicesXml ? { devicesXml } : {}) });

        const spec = await harness.resolve(spelling);
        await harness.driver.provision(spec);

        expect(spec).toEqual({
          model: "Pixel 9",
          osVersion: "35",
          physical: false,
          platform: "android",
        });
        const config = await harness.config();
        expect(config.get("hw.lcd.height")).toBe("2424");
        expect(config.get("hw.lcd.density")).toBe("420");
        if (ramSize !== undefined) expect(config.get("hw.ramSize")).toBe(ramSize);
      },
    );

    it("resolves a model the library does not have through the SDK, then devices.xml, as today", async () => {
      const sdkHarness = await libraryHarness({
        devicesXml: customDeviceXml("Custom A", 4096),
        listing: pixelDevices,
      });
      const sdkSpec = await sdkHarness.resolve("Pixel 5");
      await sdkHarness.driver.provision(sdkSpec);

      expect(sdkSpec.model).toBe("Pixel 5");
      expect(sdkHarness.seedDeviceId()).toBe("pixel_5");
      expect((await sdkHarness.config()).has("hw.lcd.height")).toBe(false);

      const userHarness = await libraryHarness({
        devicesXml: customDeviceXml("Custom A", 4096),
        listing: pixelDevices,
      });
      const userSpec = await userHarness.resolve("Custom A");
      await userHarness.driver.provision(userSpec);

      expect(userSpec.model).toBe("Custom A");
      expect((await userHarness.config()).get("hw.ramSize")).toBe("4096");
    });

    it("writes android.emulator.cores into a new seed's config.ini over the profile's own count, from any profile source, and leaves the profile's count when unset", async () => {
      const launch = { audio: true, bootAnimation: true, gpu: "auto", headless: false };
      const cases = [
        { source: "built-in profile", model: "Pixel 9", cores: 2, expected: "2" },
        { source: "SDK profile", model: "Pixel 5", cores: 2, expected: "2" },
        {
          source: "devices.xml profile",
          model: "Custom A",
          cores: 2,
          expected: "2",
          devicesXml: customDeviceXml("Custom A", 4096),
        },
        {
          source: "built-in profile, cores unset",
          model: "Pixel 9",
          cores: undefined,
          expected: "4",
        },
      ];

      for (const { source, model, cores, expected, devicesXml } of cases) {
        const harness = await libraryHarness({
          ...(devicesXml === undefined ? {} : { devicesXml }),
          emulator: { ...launch, ...(cores === undefined ? {} : { cores }) },
          listing: pixelDevices,
        });

        await harness.provision(model);

        expect({ source, ncore: (await harness.config()).get("hw.cpu.ncore") }).toEqual({
          source,
          ncore: expected,
        });
      }
    });

    it("captures the config hash after the library's keys are written", async () => {
      const hashOf = async (profile: LibraryDeviceProfile, seed: string) => {
        const harness = await libraryHarness({ profiles: [profile], seed });
        const device = await harness.provision("Test Phone");
        return (device.driverData as { configHash: string }).configHash;
      };
      const ram = (value: string) =>
        testLibraryProfile({ hardware: { "hw.lcd.height": "100", "hw.ramSize": value } });

      const small = await hashOf(ram("2G"), seedConfig([]));
      const large = await hashOf(ram("4G"), seedConfig([]));
      const largeOverOtherSeed = await hashOf(ram("4G"), seedConfig(["hw.ramSize=512M"]));

      expect(small).not.toBe(large);
      expect(largeOverOtherSeed).toBe(large);
    });

    it("refuses NUL in a `simlock.mark` value, through the one shared check", async () => {
      const markedConfig = (harness: Awaited<ReturnType<typeof provisionedHarness>>) =>
        harness.filesystem.readFile(`${harness.copyHome}/simlock.avd/config.ini`);
      const accepted = await provisionedHarness({
        firstMarkToken: "tok-en",
        ids: ["one", "two", "tok-en"],
      });
      await accepted.driver.makeReady(accepted.device);
      expect(await markedConfig(accepted)).toContain("simlock.mark=tok-en");

      const refused = await provisionedHarness({
        firstMarkToken: "tok\u0000en",
        ids: ["one", "two", "tok\u0000en"],
      });

      await expect(refused.driver.makeReady(refused.device)).rejects.toThrow(/Refusing to merge/);
      expect(await markedConfig(refused)).not.toContain("simlock.mark=");
    });
  });

  describe("Android SDK license handling", () => {
    const licenseNotAcceptedOutput =
      "Warning: License for package Android SDK Platform 35 not accepted.\n\n" +
      "1 package(s) were skipped due to license issues. Please accept the license(s) and try " +
      "again.\nTo resolve, run: sdkmanager --licenses\n";

    it("accepts licenses through piped confirmation and retries the install once when the flag is on", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          {
            match: {
              args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
              command: binaries.sdkmanager,
            },
            result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
          },
          processResult(binaries.sdkmanager, ["--licenses"], "All licenses accepted.\n"),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: true });

      await expect(installFor(driver, "35")).resolves.toMatchObject({
        outcome: "installed",
        version: "35",
      });

      const licensesCall = runner.calls.find(
        (call) => call.command === binaries.sdkmanager && call.args[0] === "--licenses",
      );
      expect(licensesCall?.options.input).toBe("y\n".repeat(100));
      expect(runner.calls.filter((call) => call.args[0] === "--install")).toHaveLength(2);
    });
  });

  describe("component install", () => {
    it("refuses an unaccepted licence with AndroidLicenseNotAcceptedError, and runs no sdkmanager --licenses, when the config does not accept them", async () => {
      const filesystem = await androidFilesystem();
      const runner = new EmulatorExitingRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: {
            code: 1,
            stderr: "",
            stdout: "Warning: License for package Android SDK Platform 35 not accepted.\n",
          },
        },
      ]);
      const driver = await createDriver(filesystem, runner);

      await expect(installFor(driver, "35")).rejects.toBeInstanceOf(AndroidLicenseNotAcceptedError);
      expect(runner.calls.some((call) => call.args[0] === "--licenses")).toBe(false);
    });

    it("reports the revisions of the tool packages under the SDK root it was given", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.writeFileAtomic(
        `${sdk}/emulator/source.properties`,
        "Pkg.Revision=35.4.9\n",
      );
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

      await expect(driver.toolVersions()).resolves.toEqual([
        { name: "emulator", version: "35.4.9" },
      ]);
    });

    it("states 2 GiB on the SDK root as the footprint of one install", async () => {
      const filesystem = await androidFilesystem();
      const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

      expect(driver.componentFootprint).toEqual({ bytes: 2 * 1024 ** 3, path: sdk });
    });
  });
});

/**
 * why: A driver whose adb server is already running and recorded, so `create` adopts it: that is
 * the one start-up path that spawns nothing, which keeps the scripted process expectations
 * in every test about the behaviour the test is actually for. The start, reap, and refusal
 * paths are covered against the supervisor itself in `adb-server.test.ts`, and end to end
 * in this file's own `AndroidDriver.create` block.
 */
describe("AndroidDriver defaultModels", () => {
  it("lists the built-in Android preference list per class, newest first, with phone starting at Pixel 9 and tablet holding Medium Tablet", async () => {
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]));

    expect(driver.defaultModels).toEqual({
      auto: ["Automotive (1080p landscape)", "Automotive (1024p landscape)"],
      desktop: ["Medium Desktop", "Large Desktop"],
      phone: ["Pixel 9", "Pixel 8", "Pixel 7", "Pixel 6", "Medium Phone"],
      tablet: ["Medium Tablet"],
      tv: ["Television (1080p)", "Television (4K)"],
      watch: ["Wear OS Large Round", "Wear OS Small Round"],
    });
  });
});

describe("AndroidDriver custom profile fit from devices.xml", () => {
  it("resolveSpec with --os 30 and provision refuse a custom profile whose api-level is 31-", async () => {
    const images: readonly FitImage[] = [
      ["30", "google_apis", "arm64-v8a"],
      ["31", "google_apis", "arm64-v8a"],
    ];
    const { createdPackage, driver, refusal, resolve } = await fitHarness(images, {
      devicesXml: customFitXml({ apiLevel: "31-", name: "My Phone" }),
      listing: userListing(["My Phone"]),
    });
    await expect(resolve("My Phone", "31")).resolves.toMatchObject({ osVersion: "31" });

    expect(await refusal("My Phone", "30")).toMatchObject({ name: "RuntimeMissingError" });
    await expect(
      driver.provision({
        model: "My Phone",
        osVersion: "30",
        physical: false,
        platform: "android",
      }),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
    expect(createdPackage()).toBeUndefined();
  });
});
