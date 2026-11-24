import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { FakeClock, MemoryFilesystem, type ScriptedProcessExpectation } from "../../ports/index.js";
import { type AndroidDriverDiagnostic, type AndroidEmulatorLaunchOptions } from "./index.js";
import {
  androidFilesystem,
  avdDirectory,
  binaries,
  bootingAt,
  makingASeedFrom,
  markWriteExpectation,
  EmulatorExitingRunner,
  makingTheSeed,
  seedEmulatorLine,
  writeSeedFiles,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  emulatorLaunchArgs,
  createDriver,
  copyPathExpectation,
} from "./testing.js";
import { avdPathExpectation } from "./test-index-lifecycle.js";
import { sdk } from "./test-index.js";

describe("AndroidDriver image fit", () => {
  describe("seeds and copies", () => {
    const sources = join(avdDirectory, "sources");
    const copyHome = join(avdDirectory, "simlock_one");
    const seedHome = join(sources, "seed_two");
    async function seedHarness(
      expectations: readonly ScriptedProcessExpectation[],
      options: {
        readonly clock?: FakeClock;
        readonly config?: string;
        readonly filesystem?: MemoryFilesystem;
        readonly ids?: readonly string[];
        readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
      } = {},
    ) {
      const filesystem = await androidFilesystem({}, options.filesystem);
      await writeSeedFiles(filesystem, seedHome, options.config);
      const database = await memoryAndroidSourceDatabase();
      const runner = new EmulatorExitingRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        ...expectations,
      ]);
      const driver = await createDriver(filesystem, runner, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        database,
        ids: options.ids ?? ["one", "two", "three"],
      });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      return { database, driver, filesystem, runner, spec };
    }

    /** why: the daemon after a restart: a new driver over the same device folders and the same source table. */
    async function reopened(
      harness: Awaited<ReturnType<typeof seedHarness>>,
      expectations: readonly ScriptedProcessExpectation[],
      options: {
        readonly clock?: FakeClock;
        readonly emulator?: AndroidEmulatorLaunchOptions;
      } = {},
    ) {
      const runner = new EmulatorExitingRunner([...expectations]);
      const driver = await createDriver(harness.filesystem, runner, {
        ...options,
        database: harness.database,
        ids: ["four", "five", "six"],
      });
      return { driver, runner };
    }

    it("quotes a provision at 1 s with a fresh seed and 150 s without one, and a prepare boot at 4 s for a copy and 70 s otherwise", async () => {
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      const spec = { ...harness.spec, physical: false } as const;
      const provision = { operation: "provision" } as const;
      expect(harness.driver.estimate(provision, spec)).toBe(150_000);

      const copy = await harness.driver.provision(harness.spec);

      expect(harness.driver.estimate(provision, spec)).toBe(1_000);
      expect(harness.driver.estimate(provision, { ...spec, model: "Pixel 9" })).toBe(150_000);
      expect(harness.driver.estimate(provision, { ...spec, imageTag: "android-tv" })).toBe(150_000);
      const prepare = { device: copy, operation: "boot", purpose: "prepare" } as const;
      const oldLayout = {
        address: "",
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      };
      expect(
        await Promise.all([
          harness.driver.estimate(prepare, spec),
          harness.driver.estimate({ ...prepare, purpose: "recover" }, spec),
          harness.driver.estimate({ ...prepare, device: oldLayout }, spec),
        ]),
      ).toEqual([4_000, 70_000, 70_000]);
      await expect(
        harness.driver.estimate({ ...prepare, device: { ...copy, deviceId: "other" } }, spec),
        "a device id that does not match its AVD rejects the returned promise: a throw would skip the caller's fallback",
      ).rejects.toThrow("does not match AVD");

      const staled = await reopened(harness, [
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.2.0"),
      ]);
      await staled.driver.listSources();
      expect(staled.driver.estimate(provision, spec)).toBe(150_000);
    });

    it("destroys the seeds made from a system image when it is removed, and a seed it cannot destroy stays listed as stale", async () => {
      const packageName = "system-images;android-34;google_apis;arm64-v8a";
      const imagePath = `${sdk}/system-images/android-34/google_apis/arm64-v8a`;
      const uninstall = processResult(binaries.sdkmanager, ["--uninstall", packageName]);
      const noEmulators = processResult(binaries.adb, ["devices"], "List of devices attached\n");
      const remove = async (
        harness: Awaited<ReturnType<typeof seedHarness>>,
        failingFolder?: string,
        alsoMake?: { readonly home: string; readonly imageTag: string },
      ) => {
        await harness.driver.provision(harness.spec);
        if (alsoMake !== undefined) {
          await harness.filesystem.mkdirp(
            `${sdk}/system-images/android-34/${alsoMake.imageTag}/arm64-v8a`,
          );
          await writeSeedFiles(harness.filesystem, alsoMake.home);
          await harness.driver.provision(
            await harness.driver.resolveSpec({
              imageTag: alsoMake.imageTag,
              model: "Pixel 5",
              osVersion: "34",
              platform: "android",
            }),
          );
        }
        if (failingFolder !== undefined) harness.filesystem.defineFailure(failingFolder, "EACCES");
        const target = (await harness.driver.listComponents()).find(
          (component) => component.variant === "google_apis/arm64-v8a",
        );
        // why: the scripted runner only answers; real sdkmanager also deletes the image's folder.
        const spawn = harness.runner.spawn.bind(harness.runner);
        vi.spyOn(harness.runner, "spawn").mockImplementation((command, args, options) => {
          if (args[0] === "--uninstall") void harness.filesystem.rm(imagePath);
          return spawn(command, args, options);
        });
        await harness.driver.removeComponent(target?.receipt ?? {}, {
          signal: new AbortController().signal,
        });
      };

      const destroyed = await seedHarness([...makingTheSeed(), uninstall, noEmulators]);
      await remove(destroyed);
      expect(await destroyed.filesystem.exists(seedHome)).toBe(false);
      await expect(destroyed.driver.listSources()).resolves.toEqual([]);

      const otherHome = join(sources, "seed_device-4");
      const other = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        ...makingASeedFrom(otherHome),
        uninstall,
        noEmulators,
      ]);
      await remove(other, undefined, { home: otherHome, imageTag: "google_apis_playstore" });
      expect(await other.filesystem.exists(seedHome)).toBe(false);
      expect(await other.filesystem.exists(otherHome)).toBe(true);

      const stuck = await seedHarness([
        ...makingTheSeed(),
        uninstall,
        noEmulators,
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await remove(stuck, seedHome);
      await expect(stuck.driver.listSources()).resolves.toMatchObject([
        { id: "seed_two", staleReason: `system image ${packageName} is not installed` },
      ]);
    });

    it("boots a recovered copy cold from its disk on its recorded port: no snapshot is loaded and nothing is wiped, a second makeReady does not boot again and destroy stops it", async () => {
      const harness = await seedHarness([
        ...bootingAt(copyHome, ["-no-snapshot-load"], true),
        markWriteExpectation("emulator-5586", "one"),
        ...bootingAt(copyHome, [], true).slice(1),
        markWriteExpectation("emulator-5586", "two"),
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ]);
      await writeSeedFiles(harness.filesystem, copyHome);

      const recovered = {
        address: "emulator-5586",
        deviceId: "simlock_one",
        driverData: {
          avdHome: copyHome,
          avdName: "simlock",
          configHash: "hash",
          port: 5586,
          serial: "emulator-5586",
        },
      };
      await harness.driver.makeReady(recovered, { purpose: "recover" });

      const launch = harness.runner.calls.find((call) => call.args.includes("-avd"));
      expect(launch?.args).toContain("-no-snapshot-load");
      expect(launch?.args).not.toContain("-snapshot");
      expect(launch?.args).not.toContain("-wipe-data");
      expect(launch?.options.env).toMatchObject({ ANDROID_AVD_HOME: copyHome });

      await harness.driver.makeReady(recovered);
      await harness.driver.destroy(recovered);
      expect(emulatorLaunchArgs(harness.runner)).toHaveLength(1);
      expect(
        harness.runner.calls.some((call) => call.args.slice(-2).join(" ") === "emu kill"),
        "destroy stops the emulator the recover boot started",
      ).toBe(true);
    });

    it("boots a device made before copies once with a wipe: a second makeReady does not boot again and destroy stops it and deletes it through avdmanager", async () => {
      const serial = "emulator-5586";
      const polls = (name: string) => [
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          "1\n",
        ),
        processResult(binaries.adb, ["-s", serial, "shell", "getprop", "init.svc.bootanim"], ""),
        avdPathExpectation(serial, name),
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "pm", "path", "android"],
          "package:/system/framework/framework-res.apk\n",
        ),
      ];
      const harness = await seedHarness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        {
          hangs: true,
          match: {
            args: ["-avd", "simlock_old", ...seedEmulatorLine, "-wipe-data", "-no-snapshot-load"],
            command: binaries.emulator,
          },
        },
        ...polls("simlock_old"),
        markWriteExpectation(serial, "one"),
        ...polls("simlock_old"),
        markWriteExpectation(serial, "two"),
        avdPathExpectation(serial, "simlock_old"),
        processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
        processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
      ]);
      await harness.filesystem.mkdirp(join(avdDirectory, "simlock_old.avd"));
      await harness.filesystem.writeFileAtomic(
        join(avdDirectory, "simlock_old.avd", "config.ini"),
        "hw.ramSize=2048\n",
      );
      const legacy = {
        address: "",
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      };

      await harness.driver.makeReady(legacy);
      expect(emulatorLaunchArgs(harness.runner)[0]).toEqual(
        expect.arrayContaining(["-wipe-data", "-no-snapshot-load"]),
      );
      await harness.driver.makeReady(legacy);
      await harness.driver.destroy(legacy);

      expect(emulatorLaunchArgs(harness.runner), "the wipe boot happens once").toHaveLength(1);
      expect(
        harness.runner.calls.some((call) => call.args.slice(-2).join(" ") === "emu kill"),
        "destroy stops the emulator the wipe boot started",
      ).toBe(true);
      expect(
        harness.runner.calls.some(
          (call) =>
            call.command === binaries.avdmanager &&
            call.args.join(" ") === "delete avd -n simlock_old",
        ),
        "destroy deletes the device through avdmanager",
      ).toBe(true);
    });

    it("destroys a plain Android device after its ownership check: the emulator is killed and its folder deleted, an unreadable check or a failing delete throws and keeps it, and a folder outside the root is never deleted", async () => {
      const serial = "emulator-5586";
      const attached = `List of devices attached\n${serial}\tdevice\n`;
      const own = {
        address: serial,
        deviceId: "simlock_one",
        driverData: {
          avdHome: copyHome,
          avdName: "simlock",
          configHash: "hash",
          port: 5586,
          serial,
        },
      };
      const harness = async (expectations: readonly ScriptedProcessExpectation[]) => {
        const filesystem = await androidFilesystem();
        for (const home of [copyHome, join(avdDirectory, "simlock_two")]) {
          await filesystem.mkdirp(`${home}/simlock.avd`);
          await filesystem.writeFileAtomic(`${home}/simlock.avd/config.ini`, "hw.ramSize=2048\n");
        }
        const runner = new EmulatorExitingRunner([...expectations]);
        return { driver: await createDriver(filesystem, runner), filesystem, runner };
      };
      const answersWith = (folder: string) =>
        processResult(
          binaries.adb,
          ["-s", serial, "emu", "avd", "path"],
          `${folder}/simlock.avd\r\nOK\r\n`,
        );

      const passes = await harness([
        processResult(binaries.adb, ["devices"], attached),
        answersWith(copyHome),
        processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await passes.driver.destroy(own);
      expect(await passes.filesystem.exists(copyHome)).toBe(false);
      expect(await passes.filesystem.exists(join(avdDirectory, "simlock_two"))).toBe(true);

      const neighbour = await harness([
        processResult(
          binaries.adb,
          ["devices"],
          "List of devices attached\nemulator-5588\tdevice\n",
        ),
        processResult(
          binaries.adb,
          ["-s", "emulator-5588", "emu", "avd", "path"],
          `${avdDirectory}/simlock_two/simlock.avd\r\nOK\r\n`,
        ),
      ]);
      await neighbour.driver.destroy(own);
      expect(await neighbour.filesystem.exists(copyHome)).toBe(false);
      expect(neighbour.runner.calls.flatMap((call) => call.args)).not.toContain("kill");

      const unreadable = await harness([
        processResult(binaries.adb, ["devices"], attached),
        {
          match: { args: ["-s", serial, "emu", "avd", "path"], command: binaries.adb },
          result: { code: 1, stderr: "error", stdout: "" },
        },
      ]);
      await expect(unreadable.driver.destroy(own)).rejects.toThrow(
        `Refusing to delete simlock_one: could not tell which AVD the emulator on ${serial} runs`,
      );
      expect(await unreadable.filesystem.exists(copyHome)).toBe(true);
      expect(unreadable.runner.calls.flatMap((call) => call.args)).not.toContain("kill");

      const failingDelete = await harness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      failingDelete.filesystem.defineFailure(copyHome, "EACCES");
      await expect(failingDelete.driver.destroy(own)).rejects.toMatchObject({ code: "EACCES" });
      expect(await failingDelete.filesystem.exists(join(avdDirectory, "simlock_two"))).toBe(true);

      const outside = await harness([]);
      await outside.filesystem.mkdirp("/elsewhere/simlock_two");
      await expect(
        outside.driver.destroy({
          ...own,
          deviceId: "simlock_two",
          driverData: { ...own.driverData, avdHome: "/elsewhere/simlock_two" },
        }),
      ).rejects.toThrow("Android device simlock_two names a folder outside the root");
      expect(await outside.filesystem.exists("/elsewhere/simlock_two")).toBe(true);
      expect(await outside.filesystem.exists(join(avdDirectory, "simlock_two"))).toBe(true);

      const malformed = await harness([]);
      await expect(
        malformed.driver.destroy({
          ...own,
          driverData: { ...own.driverData, avdHome: 5 },
        }),
      ).rejects.toThrow("Android device simlock_one has invalid driver data");
      expect(await malformed.filesystem.exists(copyHome)).toBe(true);

      const old = await harness([
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
      ]);
      await old.driver.destroy({
        ...own,
        deviceId: "simlock_old",
        driverData: { avdName: "simlock_old", configHash: "hash", port: 0, serial: "" },
      });
      expect(old.runner.calls[1]?.options.env).toMatchObject({ ANDROID_AVD_HOME: avdDirectory });

      await expect(old.driver.reclaim(own, { clean: "standard" })).rejects.toMatchObject({
        message: "virtual devices are not reclaimed",
        name: "DriverCrashError",
      });
    });
  });
});
