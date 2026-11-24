import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  NodeProcessSupervisor,
  NodeTcpProbe,
  type ScriptedProcessExpectation,
  SystemClock,
} from "../../ports/index.js";
import {
  AndroidDriver,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";
import {
  androidFilesystem,
  avdDirectory,
  binaries,
  bootingAt,
  markWriteExpectation,
  EmulatorExitingRunner,
  makingTheSeed,
  seedStages,
  writeSeedFiles,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  createDriver,
} from "./testing.js";
import { sdk, home } from "./test-index.js";

/** why: copies work until a test arms the failure, so a device can be provisioned from a seed first. */
class ArmedCopyFailureFilesystem extends MemoryFilesystem {
  armed = false;

  constructor(private readonly message: string) {
    super();
  }

  override copyTree(
    from: string,
    to: string,
    options: { readonly timeoutMs: number },
  ): Promise<void> {
    return this.armed ? Promise.reject(new Error(this.message)) : super.copyTree(from, to, options);
  }
}

/** why: Windows refuses to delete a folder an emulator's child still holds; a failed baseline save must still throw its own error then (#1765). */
class BusyFolderFilesystem extends MemoryFilesystem {
  constructor(private readonly busy: string) {
    super();
  }

  override async rm(path: string): Promise<void> {
    if (path === this.busy) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), {
        code: "EBUSY",
      });
    }
    await super.rm(path);
  }
}

const live = process.env.SIMLOCK_LIVE_ANDROID === "1" ? it : it.skip;

live(
  "live smoke: provision, boot from the boot snapshot, restart, and destroy",
  async () => {
    const driver = await AndroidDriver.create({
      clock: new SystemClock(),
      database: await memoryAndroidSourceDatabase(),
      driverConfig: {},
      env: process.env,
      filesystem: new NodeFilesystem(),
      homeDirectory: process.env.HOME ?? home,
      hostAbi: "arm64-v8a",
      instanceId: `live-${process.pid}`,
      processRunner: new NodeProcessRunner(),
      processSupervisor: new NodeProcessSupervisor({
        platform: process.platform,
        processRunner: new NodeProcessRunner(),
      }),
      simlockHome: join(tmpdir(), `simlock-live-android-${process.pid}`),
      tcpProbe: new NodeTcpProbe(),
    });
    const spec = await driver.resolveSpec({
      model: process.env.SIMLOCK_LIVE_ANDROID_MODEL ?? "Pixel 5",
      platform: "android",
      ...(process.env.SIMLOCK_LIVE_ANDROID_API === undefined
        ? {}
        : { osVersion: process.env.SIMLOCK_LIVE_ANDROID_API }),
    });
    const device = await driver.provision(spec);

    try {
      const ready = await driver.makeReady(device);
      await driver.shutdown(ready);
      const restarted = await driver.makeReady(ready);

      expect(restarted.address).toMatch(/^emulator-\d+$/);
    } finally {
      await driver.destroy(device);
    }
  },
  480_000,
);

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
        readonly emulator?: AndroidEmulatorLaunchOptions;
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
        ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
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

    it("hands the seeds part its clock, its source table, its device root and its id generator", async () => {
      const clock = new FakeClock(5_000);
      const harness = await seedHarness(makingTheSeed(), { clock });

      await harness.driver.provision(harness.spec);

      expect(
        harness.database
          .prepare("SELECT source_id, folder, created_at FROM android_source_data")
          .all(),
      ).toEqual([{ created_at: 5_000, folder: seedHome, source_id: "seed_two" }]);
    });

    it("hands the avd config the emulator launch settings, so a seed made under the same ones is current and one made under other ones is stale", async () => {
      const harness = await seedHarness(makingTheSeed());
      await harness.driver.provision(harness.spec);

      const unchanged = await reopened(harness, [
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      const [current] = await unchanged.driver.listSources();
      expect(current).toMatchObject({ id: "seed_two" });
      expect(current?.staleReason).toBeUndefined();

      const restarted = await reopened(
        harness,
        [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")],
        { emulator: { audio: true, bootAnimation: true, gpu: "auto", headless: true } },
      );

      await expect(restarted.driver.listSources()).resolves.toMatchObject([
        { id: "seed_two", staleReason: "android.emulator launch settings changed" },
      ]);
    });

    it("judges a seed made under another android.emulator.cores stale, and one made under the same, or with cores unset on both sides, not", async () => {
      const launch = { audio: true, bootAnimation: true, gpu: "auto", headless: false };
      const cases = [
        { made: undefined, now: undefined, stale: false },
        { made: { headless: true }, now: { headless: true }, stale: false },
        { made: undefined, now: { cores: 2 }, stale: true },
        { made: { cores: 2 }, now: { cores: 2 }, stale: false },
        { made: { cores: 2 }, now: { cores: 3 }, stale: true },
        { made: { cores: 2 }, now: undefined, stale: true },
      ];

      for (const { made, now, stale } of cases) {
        const harness = await seedHarness(
          makingTheSeed(
            seedHome,
            "Android emulator version 36.1.9",
            made?.headless === true ? ["-no-window"] : [],
          ),
          { emulator: { ...launch, ...made } },
        );
        await harness.driver.provision(harness.spec);

        const restarted = await reopened(
          harness,
          [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")],
          { emulator: { ...launch, ...now } },
        );

        expect({
          made,
          now,
          staleReason: (await restarted.driver.listSources())[0]?.staleReason,
        }).toEqual({
          made,
          now,
          staleReason: stale ? "android.emulator launch settings changed" : undefined,
        });
      }
    });

    it.each([
      { name: "the default launch", emulator: undefined, flags: [], inputs: [] },
      {
        name: "a non-default launch",
        emulator: { audio: true, bootAnimation: true, gpu: "auto", headless: true },
        flags: ["-no-window"],
        inputs: ["headless=true", "gpu=auto"],
      },
    ] as const)(
      "judges a seed made before the per-emulator Wi-Fi flag stale under $name (#1586)",
      async ({ emulator, flags, inputs }) => {
        const launch = emulator === undefined ? {} : { emulator };
        const harness = await seedHarness(
          makingTheSeed(seedHome, "Android emulator version 36.1.9", flags),
          launch,
        );
        await harness.driver.provision(harness.spec);
        const row = harness.database
          .prepare("SELECT image_identity, emulator_version FROM android_source_data")
          .get() as { image_identity: string; emulator_version: string };
        // why: the hash a driver before the flag stored, rebuilt here with the same FNV-1a over the same parts minus the Wi-Fi entry, because no public surface writes an old hash.
        let hash = 0x811c9dc5;
        for (const character of [
          row.image_identity,
          row.emulator_version,
          "hw.ramSize=2048",
          ...inputs,
        ].join("\u0000")) {
          hash ^= character.charCodeAt(0);
          hash = Math.imul(hash, 0x01000193);
        }
        harness.database
          .prepare("UPDATE android_source_data SET config_hash = ?")
          .run((hash >>> 0).toString(16).padStart(8, "0"));

        const restarted = await reopened(
          harness,
          [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")],
          launch,
        );

        await expect(restarted.driver.listSources()).resolves.toMatchObject([
          { id: "seed_two", staleReason: "android.emulator launch settings changed" },
        ]);
      },
    );

    it("leases a plain Android device from a copy of the kind's seed, made first when there is none, booted from the boot snapshot", async () => {
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true),
        markWriteExpectation("emulator-5586", "three"),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);

      const device = await harness.driver.provision(harness.spec);
      const ready = await harness.driver.makeReady(device);

      const create = harness.runner.calls.find((call) => call.args[0] === "create");
      expect(create?.options.env).toMatchObject({ ANDROID_AVD_HOME: seedHome });
      expect(device).toMatchObject({
        deviceId: "simlock_one",
        driverData: { avdHome: copyHome, avdName: "simlock" },
      });
      await expect(
        harness.filesystem.readFile(join(copyHome, "simlock.avd", "config.ini")),
      ).resolves.toBe("hw.ramSize=2048\nsimlock.mark=three\n");
      await expect(harness.filesystem.readFile(join(copyHome, "simlock.ini"))).resolves.toBe(
        `avd.ini.encoding=UTF-8\npath=${join(copyHome, "simlock.avd")}\ntarget=android-34\n`,
      );
      await expect(harness.driver.listSources()).resolves.toMatchObject([
        {
          id: "seed_two",
          imageTag: "google_apis",
          kind: "seed",
          model: "Pixel 5",
          osVersion: "34",
        },
      ]);
      const launches = harness.runner.calls.filter((call) => call.args.includes("-avd"));
      expect(launches.map((call) => call.options.env?.["ANDROID_AVD_HOME"])).toEqual([
        seedHome,
        seedHome,
        copyHome,
      ]);
      expect(launches.flatMap((call) => call.args)).not.toContain("-wipe-data");
      const shellRuns = harness.runner.calls.filter(
        (call) => call.args.includes("sync") || call.args.includes("-p"),
      );
      expect(
        shellRuns.map((call) => [call.args.at(-1), call.options.timeoutMs]),
        "the seed's sync and power-off are each bounded, so a wedged adbd cannot hold the make",
      ).toEqual([
        ["sync", 60_000],
        ["-p", 60_000],
      ]);
      expect(ready.address).toBe("emulator-5586");
    });

    it("reports a copy whose boot snapshot does not load by its device id, only when it took over 12 s, and never wipes it", async () => {
      for (const { readyAfterMs, reported } of [
        { readyAfterMs: 12_000, reported: false },
        { readyAfterMs: 12_001, reported: true },
      ]) {
        const clock = new FakeClock();
        const diagnostics: AndroidDriverDiagnostic[] = [];
        const harness = await seedHarness(
          [
            ...makingTheSeed(),
            processResult(binaries.adb, ["devices"], "List of devices attached\n"),
            ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true, 1),
            markWriteExpectation("emulator-5586", "three"),
          ],
          { clock, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
        );
        const device = await harness.driver.provision(harness.spec);

        const ready = harness.driver.makeReady(device);
        await vi.waitFor(() =>
          expect(
            harness.runner.calls.filter((call) => call.args.includes("sys.boot_completed")),
          ).toHaveLength(3),
        );
        clock.advance(readyAfterMs);
        await ready;

        expect(diagnostics).toEqual(
          reported ? [{ deviceId: "simlock_one", kind: "snapshot-cold-boot", readyAfterMs }] : [],
        );
        expect(harness.runner.calls.flatMap((call) => call.args)).not.toContain("-wipe-data");
      }
    });

    describe("saveSource", () => {
      const savedHome = join(sources, "baseline_four");
      const serial = "emulator-5586";
      const config =
        "hw.device.name=pixel_5\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize=2048\n";
      const ids = ["one", "two", "three", "four"];
      const adbShell = (command: string) =>
        processResult(binaries.adb, ["-s", serial, "shell", command]);
      const sourceBoot = () => {
        const stage = seedStages(savedHome);
        return [
          stage.devices,
          ...stage.secondBoot,
          stage.save,
          stage.list,
          stage.probe,
          stage.kill,
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ];
      };
      const leasing = (hangs: boolean) => [
        ...makingTheSeed(),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], hangs),
        markWriteExpectation(serial, "three"),
      ];
      const probe = processResult(
        binaries.adb,
        ["-s", serial, "emu", "avd", "path"],
        `${join(copyHome, "simlock.avd")}\r\nOK\r\n`,
      );
      const savingSteps = [
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        probe,
        adbShell("sync"),
        processResult(binaries.adb, ["-s", serial, "shell", "reboot", "-p"]),
      ];

      it("provisions a device named after a baseline source as a copy of that source's folder with no seed made and only the emulator's version read, and refuses a source whose system image is gone", async () => {
        const version = () =>
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9");
        const harness = await seedHarness(
          [...leasing(true), ...savingSteps, ...sourceBoot(), version(), version()],
          {
            config,
            ids: [...ids, "five", "six"],
          },
        );
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));
        await harness.driver.saveSource({ ...ready, physical: false as const });
        await harness.filesystem.writeFileAtomic(
          join(savedHome, "simlock.avd", "marker.txt"),
          "saved",
        );
        const callsBefore = harness.runner.calls.length;

        const copy = await harness.driver.provision(harness.spec, { source: "baseline_four" });

        expect(copy.deviceId).toBe("simlock_five");
        await expect(
          harness.filesystem.readFile(
            join(avdDirectory, "simlock_five", "simlock.avd", "marker.txt"),
          ),
        ).resolves.toBe("saved");
        expect(harness.runner.calls).toHaveLength(callsBefore + 1);

        const coresChanged = await reopened(harness, [version(), version()], {
          emulator: { audio: true, bootAnimation: true, gpu: "auto", headless: false, cores: 2 },
        });
        const listed = await coresChanged.driver.listSources();
        expect(listed.find((source) => source.id === "baseline_four")?.staleReason).toBe(
          "android.emulator launch settings changed",
        );
        await expect(
          coresChanged.driver.provision(harness.spec, { source: "baseline_four" }),
        ).rejects.toThrow(
          "source baseline_four is stale: android.emulator launch settings changed",
        );

        await harness.filesystem.rm(`${sdk}/system-images/android-34/google_apis/arm64-v8a`);
        await expect(
          harness.driver.provision(harness.spec, { source: "baseline_four" }),
        ).rejects.toThrow(
          "source baseline_four is stale: system image system-images;android-34;google_apis;arm64-v8a is not installed",
        );
        expect(await harness.filesystem.exists(join(avdDirectory, "simlock_six"))).toBe(false);
      });

      it("keeps a baseline saved before the per-emulator Wi-Fi flag usable, since only a seed's launch settings hold the Wi-Fi entry (#1586)", async () => {
        const harness = await seedHarness([...leasing(true), ...savingSteps, ...sourceBoot()], {
          config,
          ids,
        });
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));
        await harness.driver.saveSource({ ...ready, physical: false as const });
        const row = harness.database
          .prepare(
            "SELECT image_identity, emulator_version FROM android_source_data WHERE kind = 'baseline'",
          )
          .get() as { image_identity: string; emulator_version: string };
        const saved = await harness.filesystem.readFile(`${savedHome}/simlock.avd/config.ini`);
        // why: the hash a driver before the flag stored, rebuilt here with the same FNV-1a over the same parts, because no public surface writes an old hash.
        let hash = 0x811c9dc5;
        for (const character of [
          row.image_identity,
          row.emulator_version,
          saved
            .split(/\r?\n/)
            .filter((line) => /^(image\.sysdir\.1|hw\.|disk\.dataPartition\.)/.test(line))
            .filter((line) => !line.startsWith("hw.device.hash2="))
            .sort()
            .join("\n"),
        ].join("\u0000")) {
          hash ^= character.charCodeAt(0);
          hash = Math.imul(hash, 0x01000193);
        }
        harness.database
          .prepare("UPDATE android_source_data SET config_hash = ? WHERE kind = 'baseline'")
          .run((hash >>> 0).toString(16).padStart(8, "0"));

        const restarted = await reopened(harness, [
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ]);

        const listed = await restarted.driver.listSources();
        expect(listed.find((source) => source.id === "baseline_four")).not.toHaveProperty(
          "staleReason",
        );
      });

      it("keeps a powered-off copy of the device as a ready baseline source with one boot snapshot, powering the emulator off first, or killing it when it will not leave in 60 s, or polling adb with no process handle", async () => {
        const kept = async (harness: Awaited<ReturnType<typeof seedHarness>>) => {
          expect(
            await harness.filesystem.exists(join(savedHome, "simlock.avd", "config.ini")),
          ).toBe(true);
          await expect(
            harness.filesystem.readFile(join(savedHome, "simlock.ini")),
          ).resolves.toContain(`path=${join(savedHome, "simlock.avd")}`);
          expect(await harness.filesystem.exists(copyHome)).toBe(true);
          const listed = await harness.driver.listSources();
          expect(listed.find((source) => source.id === "baseline_four")).toMatchObject({
            imageTag: "google_apis",
            kind: "baseline",
            model: "pixel_5",
            osVersion: "34",
          });
          expect(
            harness.database
              .prepare("SELECT state FROM android_source_data WHERE source_id = 'baseline_four'")
              .all(),
          ).toEqual([{ state: "ready" }]);
        };
        const sent = (harness: Awaited<ReturnType<typeof seedHarness>>): string[] =>
          harness.runner.calls
            .filter((call) => call.command === binaries.adb && call.args[0] === "-s")
            .map((call) => call.args.slice(2).join(" "));
        const saveLaunch = (harness: Awaited<ReturnType<typeof seedHarness>>) =>
          harness.runner.calls
            .filter((call) => call.args.includes("-avd"))
            .map((call) => [call.options.env?.["ANDROID_AVD_HOME"], call.args.at(-1)]);

        const powered = await seedHarness([...leasing(true), ...savingSteps, ...sourceBoot()], {
          config,
          ids,
        });
        const poweredReady = await powered.driver.makeReady(
          await powered.driver.provision(powered.spec),
        );
        const poweredSaved = await powered.driver.saveSource({
          ...poweredReady,
          physical: false as const,
        });
        expect(poweredSaved).toEqual({
          imageTag: "google_apis",
          sizeBytes: 121,
          sourceId: "baseline_four",
        });
        await kept(powered);
        expect(sent(powered)).toEqual(
          expect.arrayContaining([
            "shell sync",
            "shell reboot -p",
            "emu avd snapshot save simlock_boot",
          ]),
        );
        expect(sent(powered).indexOf("shell reboot -p")).toBeLessThan(
          sent(powered).lastIndexOf("emu avd snapshot save simlock_boot"),
        );
        expect(saveLaunch(powered).at(-1)).toEqual([savedHome, "-no-snapshot-load"]);

        const clock = new FakeClock();
        const stuck = await seedHarness(
          [
            ...leasing(true),
            ...savingSteps,
            processResult(
              binaries.adb,
              ["-s", serial, "emu", "avd", "path"],
              `${join(copyHome, "simlock.avd")}\r\nOK\r\n`,
            ),
            processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
            ...sourceBoot(),
          ],
          { clock, config, ids },
        );
        const stuckReady = await stuck.driver.makeReady(await stuck.driver.provision(stuck.spec));
        // why: the stuck emulator ignores `reboot -p` and `emu kill`; only the deadlines and a SIGKILL end it.
        stuck.runner.ignoresEmuKill = true;
        const stuckSaving = stuck.driver.saveSource({ ...stuckReady, physical: false as const });
        await vi.waitFor(() =>
          expect(stuck.runner.calls.filter((call) => call.args.includes("reboot"))).toHaveLength(2),
        );
        clock.advance(60_000);
        await vi.waitFor(() =>
          expect(stuck.runner.calls.filter((call) => call.args.includes("kill"))).toHaveLength(2),
        );
        stuck.runner.ignoresEmuKill = false;
        let stuckDone = false;
        void stuckSaving.then(
          () => (stuckDone = true),
          () => (stuckDone = true),
        );
        await vi.waitFor(() => {
          clock.advance(60_000);
          expect(stuckDone).toBe(true);
        });
        await expect(stuckSaving).resolves.toMatchObject({ sourceId: "baseline_four" });
        await kept(stuck);
        expect(sent(stuck).slice(sent(stuck).indexOf("shell reboot -p"))).toEqual(
          expect.arrayContaining(["emu avd path", "emu kill"]),
        );

        const restarted = await seedHarness(leasing(true), { config, ids });
        const restartedReady = await restarted.driver.makeReady(
          await restarted.driver.provision(restarted.spec),
        );
        const clockAfter = new FakeClock();
        const adopted = await reopened(
          restarted,
          [
            ...savingSteps,
            processResult(
              binaries.adb,
              ["devices"],
              `List of devices attached\n${serial}\tdevice\n`,
            ),
            processResult(binaries.adb, ["devices"], "List of devices attached\n"),
            ...sourceBoot(),
          ],
          { clock: clockAfter },
        );
        const adoptedSaving = adopted.driver.saveSource({
          ...restartedReady,
          physical: false as const,
        });
        await vi.waitFor(() =>
          expect(adopted.runner.calls.filter((call) => call.args[0] === "devices")).toHaveLength(1),
        );
        clockAfter.advance(1_000);
        await expect(adoptedSaving).resolves.toMatchObject({ sourceId: "baseline_four" });
        await kept({ ...restarted, driver: adopted.driver });
      });

      it("writes the current android.emulator.cores into a saved baseline's config.ini before its snapshot boot, whatever count the device was made at, and does not read the baseline as stale", async () => {
        const launch = { audio: true, bootAnimation: true, gpu: "auto", headless: false };
        const cases = [
          { made: undefined, saved: 2, expected: "2" },
          { made: 2, saved: 2, expected: "2" },
          { made: 2, saved: undefined, expected: "2" },
        ];

        for (const { made, saved, expected } of cases) {
          const harness = await seedHarness([...leasing(true)], {
            config: `${config}hw.cpu.ncore=4\n`,
            emulator: { ...launch, ...(made === undefined ? {} : { cores: made }) },
            ids,
          });
          const ready = await harness.driver.makeReady(
            await harness.driver.provision(harness.spec),
          );
          const clock = new FakeClock();
          const restarted = await reopened(
            harness,
            [
              ...savingSteps,
              processResult(
                binaries.adb,
                ["devices"],
                `List of devices attached\n${serial}\tdevice\n`,
              ),
              processResult(binaries.adb, ["devices"], "List of devices attached\n"),
              ...sourceBoot(),
              processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
            ],
            {
              clock,
              emulator: { ...launch, ...(saved === undefined ? {} : { cores: saved }) },
            },
          );

          const saving = restarted.driver.saveSource({ ...ready, physical: false as const });
          await vi.waitFor(() =>
            expect(
              restarted.runner.calls.filter((call) => call.args[0] === "devices"),
            ).toHaveLength(1),
          );
          clock.advance(1_000);
          await saving;

          const listed = await restarted.driver.listSources();
          expect({
            made,
            saved,
            ncore: (await harness.filesystem.readFile(`${savedHome}/simlock.avd/config.ini`))
              .split("\n")
              .find((line) => line.startsWith("hw.cpu.ncore=")),
            stale: listed.find((source) => source.id === "baseline_four")?.staleReason,
          }).toEqual({ made, saved, ncore: `hw.cpu.ncore=${expected}`, stale: undefined });
        }
      });

      it("saves a device whose config.ini has spaces around `=`, as avdmanager writes it, with the model and image it names", async () => {
        const spaced =
          "hw.device.name = pixel_6\nimage.sysdir.1 = system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize = 2048\n";
        const harness = await seedHarness([...leasing(true), ...savingSteps, ...sourceBoot()], {
          config: spaced,
          ids,
        });
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));

        await expect(
          harness.driver.saveSource({ ...ready, physical: false as const }),
        ).resolves.toMatchObject({ imageTag: "google_apis", sourceId: "baseline_four" });

        expect(
          (await harness.driver.listSources()).find((source) => source.id === "baseline_four"),
        ).toMatchObject({
          imageTag: "google_apis",
          kind: "baseline",
          model: "pixel_6",
          osVersion: "34",
        });
      });
    });

    describe("saveSource failures", () => {
      const savedHome = join(sources, "baseline_four");
      const serial = "emulator-5586";
      const config =
        "hw.device.name=pixel_5\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\nhw.ramSize=2048\n";
      const version = processResult(
        binaries.emulator,
        ["-version"],
        "Android emulator version 36.1.9",
      );
      const probe = (path = join(copyHome, "simlock.avd")) =>
        processResult(binaries.adb, ["-s", serial, "emu", "avd", "path"], `${path}\r\nOK\r\n`);
      const poweredOff = [
        version,
        probe(),
        processResult(binaries.adb, ["-s", serial, "shell", "sync"]),
        processResult(binaries.adb, ["-s", serial, "shell", "reboot", "-p"]),
      ];
      const stage = seedStages(savedHome);

      it("deletes the source's folder and row and throws when the ownership check fails, the copy fails or the boot snapshot is not saved, leaving the device as it was", async () => {
        const cases = [
          {
            expectations: [version, probe(join(avdDirectory, "other.avd"))],
            message: "emulator-5586 is not its emulator",
            sent: false,
          },
          {
            copyFails: true,
            expectations: poweredOff,
            message: "copying Android device simlock_one to source baseline_four failed: no space",
          },
          {
            expectations: [
              ...poweredOff,
              stage.devices,
              ...stage.secondBoot,
              { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
            ],
            message: "Android seed baseline_four: boot snapshot simlock_boot was not saved",
          },
        ] as const;

        for (const failing of cases) {
          const filesystem = new ArmedCopyFailureFilesystem("no space");
          const harness = await seedHarness(
            [
              ...makingTheSeed(),
              processResult(binaries.adb, ["devices"], "List of devices attached\n"),
              ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true),
              markWriteExpectation(serial, "three"),
              ...failing.expectations,
            ],
            { config, filesystem, ids: ["one", "two", "three", "four"] },
          );
          const ready = await harness.driver.makeReady(
            await harness.driver.provision(harness.spec),
          );
          filesystem.armed = "copyFails" in failing;
          const before = harness.runner.calls.length;

          await expect(
            harness.driver.saveSource({ ...ready, physical: false as const }),
          ).rejects.toThrow(failing.message);

          const sentToDevice = harness.runner.calls
            .slice(before)
            .filter((call) => call.args.includes("sync") || call.args.includes("reboot"));
          expect(sentToDevice.length > 0, failing.message).toBe(!("sent" in failing));
          expect(await harness.filesystem.exists(savedHome), failing.message).toBe(false);
          expect(await harness.filesystem.exists(copyHome), failing.message).toBe(true);
          expect(
            harness.database
              .prepare("SELECT source_id FROM android_source_data WHERE kind = 'baseline'")
              .all(),
            failing.message,
          ).toEqual([]);
          const emulators = harness.runner.calls.flatMap((call, index) =>
            call.args.includes("-avd") ? [index] : [],
          );
          // why: the first two launches make the seed and the third is the device's own, which a failure before `reboot -p` leaves running; what follows is the source's boot.
          for (const emulator of emulators.slice(3)) {
            let exited = false;
            void harness.runner.handles[emulator]?.wait().then(() => {
              exited = true;
            });
            await vi.waitFor(() => expect(exited, "the source's emulator was stopped").toBe(true));
          }
        }
      });

      it("throws the save's own error and keeps the source's `making` row when its folder cannot be removed", async () => {
        const filesystem = new BusyFolderFilesystem(savedHome);
        const harness = await seedHarness(
          [
            ...makingTheSeed(),
            processResult(binaries.adb, ["devices"], "List of devices attached\n"),
            ...bootingAt(copyHome, ["-snapshot", "simlock_boot"], true),
            markWriteExpectation(serial, "three"),
            ...poweredOff,
            stage.devices,
            ...stage.secondBoot,
            { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
          ],
          { config, filesystem, ids: ["one", "two", "three", "four"] },
        );
        const ready = await harness.driver.makeReady(await harness.driver.provision(harness.spec));

        await expect(
          harness.driver.saveSource({ ...ready, physical: false as const }),
        ).rejects.toThrow("Android seed baseline_four: boot snapshot simlock_boot was not saved");

        expect(await harness.filesystem.exists(savedHome)).toBe(true);
        expect(
          harness.database
            .prepare("SELECT state FROM android_source_data WHERE source_id = 'baseline_four'")
            .all(),
        ).toEqual([{ state: "making" }]);
      });
    });
  });
});
