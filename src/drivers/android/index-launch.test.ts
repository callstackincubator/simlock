import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { type Driver } from "../../core/index.js";
import { MemoryFilesystem } from "../../ports/index.js";
import { type AndroidDriverDiagnostic, type AndroidEmulatorLaunchOptions } from "./index.js";
import {
  androidFilesystem,
  avdDirectory,
  binaries,
  markWriteExpectation,
  EmulatorExitingRunner,
  seedEmulatorLine,
  pixelDevices,
  processResult,
  adbServerPort,
  scopedEnv,
  PHYSICAL_DEVICE,
  emulatorLaunchArgs,
  provisionedHarness,
  createDriver,
  copyPathExpectation,
} from "./testing.js";
import { sdk, home, VIRTUAL_DEVICE, libraryHarness } from "./test-index.js";

const seedLaunch = ["-avd", "simlock", ...seedEmulatorLine];

/**
 * why: Fails every `readFile` of `failingPath` with a non-ENOENT error while `armed`, so a test can
 * assert a caller rethrows it instead of treating it as an absent file -- then disarm to read
 * the path back and confirm nothing overwrote it in the meantime.
 */
class ReadFailureFilesystem extends MemoryFilesystem {
  armed = true;

  constructor(
    private readonly failingPath: string,
    private readonly error: Error,
    freeDiskBytes?: number,
  ) {
    super(freeDiskBytes);
  }

  override async readFile(path: string): Promise<string> {
    if (this.armed && path === this.failingPath) {
      throw this.error;
    }
    return super.readFile(path);
  }
}

describe("AndroidDriver", () => {
  describe("android.emulator launch options", () => {
    const defaults: AndroidEmulatorLaunchOptions = {
      audio: true,
      bootAnimation: true,
      gpu: "auto",
      headless: false,
    };
    it("launches with the same arguments as before these options existed under the default config", async () => {
      for (const emulator of [undefined, defaults]) {
        const harness = await provisionedHarness(emulator === undefined ? {} : { emulator });

        await harness.driver.makeReady(harness.device);

        expect(emulatorLaunchArgs(harness.runner)).toEqual([
          [...seedLaunch, "-no-snapshot-load"],
          [...seedLaunch, "-no-snapshot-load"],
          [...seedLaunch, "-snapshot", "simlock_boot"],
        ]);
      }
    });

    it("adds -no-window for headless, -no-audio for audio: false, and -no-boot-anim for bootAnimation: false", async () => {
      const flags = ["-no-window", "-no-audio", "-no-boot-anim"];
      const harness = await provisionedHarness({
        emulator: { ...defaults, audio: false, bootAnimation: false, headless: true },
        emulatorFlags: flags,
      });

      await harness.driver.makeReady(harness.device);

      const launches = emulatorLaunchArgs(harness.runner);
      expect(launches).toHaveLength(3);
      for (const args of launches) {
        expect(args.slice(0, seedLaunch.length + flags.length)).toEqual([...seedLaunch, ...flags]);
      }
    });

    it("passes a gpu mode as -gpu <mode>, and passes nothing for auto", async () => {
      const harness = await provisionedHarness({
        emulator: { ...defaults, gpu: "swiftshader_indirect" },
        emulatorFlags: ["-gpu", "swiftshader_indirect"],
      });
      await harness.driver.makeReady(harness.device);
      expect(emulatorLaunchArgs(harness.runner)[0]).toEqual([
        ...seedLaunch,
        "-gpu",
        "swiftshader_indirect",
        "-no-snapshot-load",
      ]);

      const auto = await provisionedHarness({ emulator: { ...defaults, gpu: "auto" } });
      await auto.driver.makeReady(auto.device);
      for (const args of emulatorLaunchArgs(auto.runner)) {
        expect(args).not.toContain("-gpu");
      }
    });
  });

  it("deletes only the copy's folder, keeps the seed it came from, and stops nothing for a copy that never booted", async () => {
    const harness = await provisionedHarness();
    const callsBefore = harness.runner.calls.length;

    await expect(harness.driver.destroy(harness.device)).resolves.toBeUndefined();

    expect(harness.runner.calls.slice(callsBefore)).toEqual([]);
    expect(await harness.filesystem.exists(harness.copyHome)).toBe(false);
    expect(await harness.filesystem.exists(`${harness.seedHome}/simlock.avd`)).toBe(true);
  });

  it("reports conservative cold-boot estimates through the Driver contract", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new EmulatorExitingRunner([]),
    );
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;

    expect(driver.estimate({ operation: "provision" }, spec)).toBe(150_000);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(70_000);
  });

  it("prices reclaim by the strategy the clean level selects", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new EmulatorExitingRunner([]),
    );
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;

    // why: Both measured on an M3 Pro / Pixel 8 / API 35. The gap is real: a `wipe` reclaim defers
    // the wipe to the next `makeReady`; a reclaim that also boots the device back to warm
    // spends a cold wipe boot in `reclaiming` rather than a shutdown.
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(6_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, spec)).toBe(32_000);
  });

  describe("avdmanager list device reads", () => {
    it("seeds a library provision from the `avdmanager list device` read the catalog made", async () => {
      const harness = await libraryHarness({ listing: pixelDevices });

      await harness.driver.listCatalog();
      await harness.provision("Pixel 9");

      expect(harness.seedDeviceId()).toBe("pixel_5");
      expect(
        harness.runner.calls.filter((call) => call.args.join(" ") === "list device"),
      ).toHaveLength(1);
    });

    it.each([
      {
        env: { ANDROID_USER_HOME: "/user-home" },
        path: "/user-home/devices.xml",
        situation: "ANDROID_USER_HOME",
      },
      { env: {}, path: `${home}/.android/devices.xml`, situation: "its home directory" },
    ])(
      "hands the catalog its scoped environment, its SDK root, its diagnostics callback and the devices.xml under $situation",
      async ({ env, path }) => {
        const addOnDevicesXml = `${sdk}/add-ons/addon-acme/devices.xml`;
        const filesystem = await androidFilesystem();
        await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
        await filesystem.writeFileAtomic(path, "not xml at all {{{");
        await filesystem.mkdirp(`${sdk}/add-ons/addon-acme`);
        await filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices/>");
        const runner = new EmulatorExitingRunner([
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        ]);
        const diagnostics: AndroidDriverDiagnostic[] = [];
        const driver = await createDriver(filesystem, runner, {
          extraEnv: env,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });

        await driver.listCatalog();
        await filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices></d:devices>");
        await driver.listCatalog();

        const listRuns = runner.calls.filter((call) => call.args.join(" ") === "list device");
        expect(listRuns.map((call) => call.options.env)).toEqual([
          { ...scopedEnv, ...env },
          { ...scopedEnv, ...env },
        ]);
        expect(diagnostics).toContainEqual(
          expect.objectContaining({ kind: "device-profile-source-unreadable", path }),
        );
      },
    );
  });

  it("answers virtualLeaseEnvironment with simlock's adb port, and leaseEnvironment for a virtual device equals it", async () => {
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]));

    expect(driver.virtualLeaseEnvironment()).toEqual({
      ANDROID_ADB_SERVER_PORT: String(adbServerPort),
    });
    expect(driver.leaseEnvironment(VIRTUAL_DEVICE)).toEqual(driver.virtualLeaseEnvironment());
  });

  it("hands a lease holder of a physical device its serial and the default adb server", async () => {
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]));

    expect(driver.leaseEnvironment(PHYSICAL_DEVICE)).toEqual({
      ANDROID_ADB_SERVER_PORT: "5037",
      ANDROID_SERIAL: "R58M123ABC",
    });
  });

  it("answers uninstall for the reclaim strategy of a physical device, and refuses one for an emulator, which is never reclaimed", async () => {
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]));

    expect(() => driver.reclaimStrategy(VIRTUAL_DEVICE, { clean: "standard" })).toThrow(
      "virtual devices are not reclaimed",
    );
    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "standard" })).toBe("uninstall");
    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "full" })).toBe("uninstall");
  });

  it("rewrites the mark on makeReady's early-return branch without duplicating the config.ini line", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        // why: Second makeReady call: `state.handle` is still set from the first call, so this takes
        // the early-return branch -- it must still wait for readiness and rewrite the mark.
        processResult(
          binaries.adb,
          ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
          "1\n",
        ),
        processResult(
          binaries.adb,
          ["-s", "emulator-5586", "shell", "getprop", "init.svc.bootanim"],
          "",
        ),
        copyPathExpectation("emulator-5586"),
        processResult(
          binaries.adb,
          ["-s", "emulator-5586", "shell", "pm", "path", "android"],
          "package:/system/framework/framework-res.apk\n",
        ),
        markWriteExpectation("emulator-5586", "device-4"),
      ],
    });

    await harness.driver.makeReady(harness.device);
    await harness.driver.makeReady(harness.device);

    const config = await harness.filesystem.readFile(`${harness.copyHome}/simlock.avd/config.ini`);
    expect(config.split(/\r?\n/).filter((line) => line.startsWith("simlock.mark="))).toEqual([
      "simlock.mark=device-4",
    ]);
    expect(config).toContain("hw.ramSize=2048");
  });

  it("rethrows a non-missing-file config.ini read error from the mark write instead of clobbering it as empty", async () => {
    const configPath = join(avdDirectory, "simlock_one", "simlock.avd", "config.ini");
    const permissionError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const failureFilesystem = new ReadFailureFilesystem(configPath, permissionError);
    const harness = await provisionedHarness({ filesystem: failureFilesystem });

    await expect(harness.driver.makeReady(harness.device)).rejects.toBe(permissionError);

    failureFilesystem.armed = false;
    await expect(harness.filesystem.readFile(configPath)).resolves.toBe("hw.ramSize=2048\n");
  });
});
