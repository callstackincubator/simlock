import { describe, expect, it, vi } from "vitest";
import {
  ComponentInUseError,
  ComponentNotOwnedError,
  OWNED_ROOT_MARKER_FILE,
  OwnedRootError,
  type Driver,
} from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from "../../ports/index.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  AndroidLicenseNotAcceptedError,
  SdkMissingError,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";
import { type LibraryDeviceProfile } from "./profiles/index.js";
import {
  ANDROID_SDK_ROOT,
  androidFilesystem,
  avdDirectory,
  binaries,
  type BuildProvisioner,
  createdFromPackage,
  fitHarness as fitHarnessWith,
  libraryHarness as libraryHarnessWith,
  markWriteExpectation,
  seedConfig,
  taggedHarness as taggedHarnessWith,
  EmulatorExitingRunner,
  instanceId,
  seedEmulatorLine,
  simlockHome,
  customDeviceXml,
  customFitXml,
  type FitImage,
  InstallReflectingProcessRunner,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  testLibraryProfile,
  twoPixelDevices,
  userAvd,
  userListing,
  writeDevicesXml,
  adbServerPort,
  adbServerPid,
  adbRecordPath,
  scopedEnv,
  PHYSICAL_DEVICE,
  emulatorLaunchArgs,
  provisionedHarness,
  createDriver,
  recordRunningAdbServer,
  EmulatorHost,
  RecordingRunner,
  consolePortOf,
  ok,
  emptyLines,
  copyPathExpectation,
  WorkingDirectoryFilesystem,
  ANDROID_HOME_DIRECTORY,
} from "./testing.js";

const sdk = ANDROID_SDK_ROOT;
const home = ANDROID_HOME_DIRECTORY;

const scopedOptions = { env: scopedEnv } as const;

const VIRTUAL_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

/** why: the harnesses the seed tests share with `seeds.test.ts` build whatever makes the seed; here it is the whole driver. */
const buildDriver: BuildProvisioner = (filesystem, processRunner, options) =>
  createDriver(filesystem, processRunner, options);

const fitHarness = (
  ...args: Parameters<typeof fitHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => fitHarnessWith(buildDriver, ...args);

const libraryHarness = (options?: Parameters<typeof libraryHarnessWith>[1]) =>
  libraryHarnessWith(buildDriver, options);

const taggedHarness = (
  ...args: Parameters<typeof taggedHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => taggedHarnessWith(buildDriver, ...args);

describe("AndroidDriver", () => {
  it("discovers ANDROID_HOME before the other SDK locations and rejects a missing SDK", async () => {
    const filesystem = await androidFilesystem();
    const runner = new EmulatorExitingRunner([]);

    await recordRunningAdbServer(filesystem);
    const driver = await AndroidDriver.create({
      clock: new FakeClock(),
      database: await memoryAndroidSourceDatabase(),
      driverConfig: {},
      env: {
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: "/ignored-sdk",
      },
      filesystem,
      homeDirectory: home,
      hostAbi: "arm64-v8a",
      instanceId,
      processRunner: runner,
      processSupervisor: new FakeProcessSupervisor([adbServerPid]),
      simlockHome,
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    });

    expect(driver.sdkPath).toBe(sdk);
    expect(driver.deviceRoot).toBe(avdDirectory);
    await expect(
      AndroidDriver.create({
        clock: new FakeClock(),
        database: await memoryAndroidSourceDatabase(),
        driverConfig: {},
        env: {},
        filesystem: new MemoryFilesystem(),
        homeDirectory: home,
        hostAbi: "arm64-v8a",
        instanceId,
        processRunner: runner,
        processSupervisor: new FakeProcessSupervisor(),
        simlockHome,
        tcpProbe: new FakeTcpProbe(),
      }),
    ).rejects.toBeInstanceOf(SdkMissingError);
  });

  it("discovers versioned command-line tools before obsolete legacy tools", async () => {
    const filesystem = await androidFilesystem();
    const versionedTools = `${sdk}/cmdline-tools/19.0/bin`;
    await filesystem.rm(`${sdk}/cmdline-tools/latest`);
    await filesystem.mkdirp(versionedTools);
    await filesystem.writeFileAtomic(`${versionedTools}/avdmanager`, "binary");
    await filesystem.writeFileAtomic(`${versionedTools}/sdkmanager`, "binary");

    const legacyTools = `${sdk}/tools/bin`;
    await filesystem.mkdirp(legacyTools);
    await filesystem.writeFileAtomic(`${legacyTools}/avdmanager`, "binary");
    await filesystem.writeFileAtomic(`${legacyTools}/sdkmanager`, "binary");

    const runner = new EmulatorExitingRunner([
      processResult(`${versionedTools}/avdmanager`, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.resolveSpec({ model: "Pixel 5", platform: "android" })).resolves.toEqual({
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    });
  });

  describe("image tag", () => {
    it("resolves a request naming an installed tag to a spec with that tag, and creates the device from that image", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
      ]);

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(spec).toEqual({
        physical: false,
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;arm64-v8a",
      );
    });

    it("resolves a request naming no tag to the same google_apis image as before, with no tag on the spec", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "default", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["34", "google_apis", "arm64-v8a"],
      ]);

      const spec = await driver.resolveSpec({ model: "Pixel 5", platform: "android" });
      await driver.provision(spec);

      expect(spec).toEqual({
        physical: false,
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      expect(createdFromPackage(runner)).toBe("system-images;android-34;google_apis;arm64-v8a");
    });
  });

  it("boots concurrent devices on different even ports and skips ports adb shows taken", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    // why: Another process's emulator holds the first port in the range. This daemon reserved
    // nothing for it, so only `adb devices` can show that it is taken.
    const elsewhere = await createDriver(filesystem, host.runner(), { ids: ["zero"] });
    await elsewhere.resolveSpec(spec);
    const taken = await elsewhere.makeReady(await elsewhere.provision(spec));
    const runner = new RecordingRunner(host.runner());
    const first = await createDriver(filesystem, runner, { ids: ["first"] });
    const second = await createDriver(filesystem, runner, { ids: ["second"] });
    await Promise.all([first.resolveSpec(spec), second.resolveSpec(spec)]);
    const [firstDevice, secondDevice] = await Promise.all([
      first.provision(spec),
      second.provision(spec),
    ]);

    const [firstReady, secondReady] = await Promise.all([
      first.makeReady(firstDevice),
      second.makeReady(secondDevice),
    ]);

    expect({
      first: host.avdAnswering(firstReady.address),
      second: host.avdAnswering(secondReady.address),
      taken: host.avdAnswering(taken.address),
    }).toEqual({ first: "simlock_first", second: "simlock_second", taken: "simlock_zero" });
    expect(
      [taken, firstReady, secondReady].map((device) => consolePortOf(device.address) % 2),
    ).toEqual([0, 0, 0]);
    // why: Occupancy is read from Simlock's own server, not the machine's shared one: an
    // unscoped `adb devices` polls 5037, which reports the user's emulators and none of
    // Simlock's, so every console port would read free and collide on the next boot.
    const occupancyReads = runner.calls.filter((call) => call.args[0] === "devices");
    expect(occupancyReads.length).toBeGreaterThan(0);
    for (const read of occupancyReads) {
      expect(read).toEqual({ args: ["devices"], command: binaries.adb, options: scopedOptions });
    }
  });

  // why: Another Simlock instance's emulator is announced only to that instance's adb server, so
  // its own `adb devices` lists nothing here; only the machine's TCP ports show it (#257).
  it.each([
    ["its console port", 5586],
    ["the adb port above its console port", 5587],
    ["its gRPC port", 8586],
  ])(
    "skips a console port when something listens on %s that its own adb server does not list",
    async (_, listeningPort) => {
      const filesystem = await androidFilesystem();
      const host = new EmulatorHost(filesystem);
      const driver = await createDriver(filesystem, host.runner(), {
        ids: ["one"],
        tcpProbe: new FakeTcpProbe([adbServerPort, listeningPort]),
      });
      const spec = {
        physical: false,
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      } as const;
      await driver.resolveSpec(spec);

      const device = await driver.makeReady(await driver.provision(spec));

      expect(device.driverData).toMatchObject({ avdName: "simlock", port: 5588 });
    },
  );

  // why: On Windows a kill ends the child alone, and `emulator.exe`'s qemu child would keep its
  // RAM; but an `adb` client can start the adb server as its child, and for a phone that is the
  // shared 5037 server, which a tree kill would take down.
  it("asks for a tree kill when it starts the emulator, and for no adb command", async () => {
    const harness = await provisionedHarness();

    await harness.driver.makeReady(harness.device);

    const emulatorCalls = harness.runner.calls.filter(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const adbCalls = harness.runner.calls.filter((call) => call.command === binaries.adb);
    expect(emulatorCalls.length).toBeGreaterThan(0);
    expect(emulatorCalls.filter((call) => call.options.killTree !== true)).toEqual([]);
    expect(adbCalls.length).toBeGreaterThan(0);
    expect(adbCalls.filter((call) => call.options.killTree !== undefined)).toEqual([]);
  });

  // why: The gRPC port follows the reserved console port, so two parallel leases never share one.
  it("puts the gRPC endpoint at the reserved console port plus 3000", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const launches: (readonly string[])[] = [];
    const hostRunner = host.runner();
    const runner: ProcessRunner = {
      ...hostRunner,
      spawn: (command, args, options) => {
        launches.push(args);
        return hostRunner.spawn(command, args, options);
      },
    };
    const driver = await createDriver(filesystem, runner, {
      ids: ["one"],
      tcpProbe: new FakeTcpProbe([adbServerPort, 5586]),
    });
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    await driver.resolveSpec(spec);

    await driver.makeReady(await driver.provision(spec));

    expect(launches[0]).toEqual(
      expect.arrayContaining(["-port", "5588", "-grpc", "8588", "-grpc-use-token"]),
    );
  });

  it("starts the seed's boots and the copy's boot with -crash-report-mode never and a crash database under the Simlock root, so a stale crash dump asks no one and the user's shared database is never read", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const launches: (readonly string[])[] = [];
    const crashDatabases: (string | undefined)[] = [];
    const hostRunner = host.runner();
    const runner: ProcessRunner = {
      ...hostRunner,
      spawn: (command, args, options) => {
        launches.push(args);
        crashDatabases.push(options?.env?.ANDROID_EMU_CRASH_REPORTING_DATABASE);
        return hostRunner.spawn(command, args, options);
      },
    };
    const driver = await createDriver(filesystem, runner, {
      ids: ["one"],
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    });
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    await driver.resolveSpec(spec);

    await driver.makeReady(await driver.provision(spec));

    expect(crashDatabases).toEqual([
      `${avdDirectory}/emu-crash.db`,
      `${avdDirectory}/emu-crash.db`,
      `${avdDirectory}/emu-crash.db`,
    ]);
    const crashReportMode = (args: readonly string[]) => {
      const flag = args.indexOf("-crash-report-mode");
      return flag === -1 ? undefined : args[flag + 1];
    };
    expect(
      launches.map((args) => ({ boot: args.at(-1), crashReportMode: crashReportMode(args) })),
    ).toEqual([
      { boot: "-no-snapshot-load", crashReportMode: "never" },
      { boot: "-no-snapshot-load", crashReportMode: "never" },
      { boot: "simlock_boot", crashReportMode: "never" },
    ]);
  });

  /**
   * why: The half of the daemon-stop fix that argv cannot show. `stdio: "ignore"` alone does not
   * release the event loop -- the ChildProcess handle does -- so without the `unref` a
   * `daemon stop` logged "Daemon stopped" and then sat there for as long as any emulator ran.
   * An emulator is meant to outlive the daemon (`DeviceTable#reattachRunningEmulators` adopts it after a
   * restart) and is reaped through adb and by pid, never by awaiting its exit.
   */
  it("releases the event loop for the emulator it starts, so a stopped daemon can exit", async () => {
    const harness = await provisionedHarness();

    await harness.driver.makeReady(harness.device);

    // why: The launches specifically -- `emulator` is also invoked as a short-lived query
    // (`-list-avds` and friends) through `run`, which waits on the child and must stay
    // referenced. Only a boot is detached.
    const launches = harness.runner.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.command === binaries.emulator && call.args.includes("-avd"));
    expect(launches.length, "no emulator was launched").toBeGreaterThan(0);

    for (const { index } of launches) {
      expect(harness.runner.handles[index]?.unreffed, `launch at call ${String(index)}`).toBe(true);
    }
    expect(harness.runner.handles.filter((handle) => handle.unreffed)).toHaveLength(
      launches.length,
    );
  });

  /**
   * why: #237: a timer the driver leaves armed holds the event loop open, so a daemon that logged
   * "Daemon stopped" stays alive until it fires. The shutdown the test asks for sees the
   * emulator exit, so it has nothing left to wait for.
   */
  it("leaves no timer armed once the shutdown has seen its emulator exit", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ],
    });
    const ready = await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    expect(running, "no running emulator").toBeDefined();

    const shutdown = harness.driver.shutdown(ready);
    running?.kill("SIGTERM");
    await shutdown;

    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("kills an emulator that has not exited within the readiness timeout of a shutdown", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ],
      readinessTimeoutMs: 2_000,
    });
    const ready = await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    if (running === undefined) throw new Error("no running emulator");
    const kill = vi.spyOn(running, "kill");

    // why: The emulator ignores `emu kill`: only the timeout can end the wait.
    harness.runner.ignoresEmuKill = true;
    const armedBefore = harness.clock.pendingTimerCount;
    const shutdown = harness.driver.shutdown(ready);
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(armedBefore));
    expect(kill).not.toHaveBeenCalled();
    harness.clock.advance(2_000);
    await shutdown;

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("leaves no timer armed when waiting for the emulator to exit fails", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ],
    });
    const ready = await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    if (running === undefined) throw new Error("no running emulator");
    vi.spyOn(running, "wait").mockRejectedValue(new Error("spawn error"));

    await expect(harness.driver.shutdown(ready)).rejects.toThrow("spawn error");

    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("fails the boot as soon as the emulator exits, naming the emulator's own error line", async () => {
    const harness = await provisionedHarness({ bootCompleted: "0\n" });
    // why: Emulator 36.1.9's real output for a flag it does not know (#1199); it then exits 1.
    const output = [
      "INFO         | Android emulator version 36.1.9.0 (build_id 13823996) (CL:N/A)",
      "unknown option: -crash-report-mode",
      "please use -help for a list of valid options",
    ];
    const originalSpawn = harness.runner.spawn.bind(harness.runner);
    vi.spyOn(harness.runner, "spawn").mockImplementation((command, args, options) => {
      const handle = originalSpawn(command, args, options);
      if (command !== binaries.emulator || !args.includes("-avd")) return handle;
      handle.kill("SIGKILL");
      // why: whichever way the driver keeps the emulator's output (a log file or a pipe), it gets these lines.
      const written =
        typeof options?.stdio === "object"
          ? harness.filesystem.writeFileAtomic(options.stdio.file, `${output.join("\n")}\n`)
          : Promise.resolve();
      async function* lines(): AsyncGenerator<string> {
        yield* output;
      }
      return {
        pid: handle.pid,
        stderr: lines(),
        stdout: lines(),
        kill: () => undefined,
        unref: () => undefined,
        wait: async () => {
          await written;
          return { code: 1, stderr: "", stdout: `${output.join("\n")}\n` };
        },
      };
    });
    const armedBefore = harness.clock.pendingTimerCount;

    let outcome: unknown;
    harness.driver.makeReady(harness.device).then(
      () => (outcome = "ready"),
      (error: unknown) => (outcome = error),
    );
    // why: the clock never moves, so a driver that is still waiting for adb has armed its poll timer.
    await vi.waitFor(() =>
      expect(outcome !== undefined || harness.clock.pendingTimerCount > armedBefore).toBe(true),
    );

    expect(outcome, "still waiting for the boot after the emulator exited").toMatchObject({
      message: expect.stringContaining("unknown option: -crash-report-mode"),
    });
  });

  it("sends the emulator's output to <avd folder>/emulator.log, mode 0600, truncated at each start", async () => {
    const harness = await provisionedHarness();
    const logPath = `${avdDirectory}/simlock_one/simlock.avd/emulator.log`;
    await harness.filesystem.writeFileAtomic(logPath, "left by an earlier start\n", {
      mode: 0o644,
    });

    await harness.driver.makeReady(harness.device);

    const launch = harness.runner.calls.findLast(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    expect(launch?.options.stdio).toEqual({ file: logPath });
    await expect(harness.filesystem.readFile(logPath)).resolves.toBe("");
    expect((await harness.filesystem.lstat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("times out readiness and kills the emulator process", async () => {
    const harness = await provisionedHarness({ bootCompleted: "0\n", readinessTimeoutMs: 2_000 });
    const kills: string[] = [];
    const originalSpawn = harness.runner.spawn.bind(harness.runner);
    vi.spyOn(harness.runner, "spawn").mockImplementation((command, args, options) => {
      const handle = originalSpawn(command, args, options);
      const kill = handle.kill.bind(handle);
      return {
        pid: handle.pid,
        stderr: handle.stderr,
        stdout: handle.stdout,
        kill(signal) {
          kills.push(signal ?? "SIGTERM");
          kill(signal);
        },
        unref: () => handle.unref(),
        wait: () => handle.wait(),
      };
    });

    const polledBefore = bootPolls(harness.runner);
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootPolls(harness.runner)).toBeGreaterThan(polledBefore));
    harness.clock.advance(2_000);

    await expect(ready).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(kills).toContain("SIGKILL");
  });

  it("retries adb while the emulator is starting", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 1 });
    const polledBefore = bootPolls(harness.runner);
    const ready = harness.driver.makeReady(harness.device);

    await vi.waitFor(() => expect(bootPolls(harness.runner)).toBeGreaterThan(polledBefore));
    harness.clock.advance(2_000);

    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

  it("is not ready until `pm path android` exits 0 and prints a package", async () => {
    const harness = await provisionedHarness({
      unsettledPmAnswers: [
        { code: 1, stderr: "cmd: Can't find service: package", stdout: "" },
        { code: 0, stderr: "", stdout: "Error: could not access the Package Manager\n" },
        { code: 1, stderr: "", stdout: "package:/system/framework/framework-res.apk\n" },
      ],
    });
    const pmCallsBefore = harness.runner.calls.filter((call) => call.args.includes("pm")).length;
    const ready = harness.driver.makeReady(harness.device);
    const settled = vi.fn();
    void ready.then(settled, settled);
    const pmCalls = () =>
      harness.runner.calls.filter((call) => call.args.includes("pm")).length - pmCallsBefore;

    for (const asked of [1, 2, 3]) {
      await vi.waitFor(() => expect(pmCalls()).toBe(asked));
      expect(settled, `ready after ${asked} unanswered pm`).not.toHaveBeenCalled();
      harness.clock.advance(2_000);
    }

    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

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
        expect(args.slice(0, 10 + flags.length)).toEqual([...seedLaunch, ...flags]);
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
    const configPath = `${avdDirectory}/simlock_one/simlock.avd/config.ini`;
    const permissionError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const failureFilesystem = new ReadFailureFilesystem(configPath, permissionError);
    const harness = await provisionedHarness({ filesystem: failureFilesystem });

    await expect(harness.driver.makeReady(harness.device)).rejects.toBe(permissionError);

    failureFilesystem.armed = false;
    await expect(harness.filesystem.readFile(configPath)).resolves.toBe("hw.ramSize=2048\n");
  });

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

describe("AndroidDriver screen capture", () => {
  const serverPath = "/simlock/vendor/scrcpy-server-v5.0.1";
  const running = {
    address: "emulator-5586",
    deviceId: "simlock_one",
    driverData: { avdName: "simlock_one", configHash: "h", port: 5586, serial: "emulator-5586" },
    physical: false,
  } as const;
  const settings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };

  it("is offered, with the device input, only when both the server path and a TCP stream connector are given", async () => {
    const both = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(both.screenCapture).toBeDefined();
    expect(both.input).toBeDefined();
    const noPath = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]), {
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(noPath.screenCapture).toBeUndefined();
    expect(noPath.input).toBeUndefined();
    const noConnector = await createDriver(
      await androidFilesystem(),
      new EmulatorExitingRunner([]),
      {
        scrcpyServerPath: serverPath,
      },
    );
    expect(noConnector.screenCapture).toBeUndefined();
    expect(noConnector.input).toBeUndefined();
  });

  it("pushes the server with this driver's adb, its scoped environment and the device's serial", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const runner = new EmulatorExitingRunner([
      {
        match: {
          args: ["-s", "emulator-5586", "push", serverPath, /simlock-scrcpy-/],
          command: binaries.adb,
        },
        result: { code: 1, stderr: "error: closed", stdout: "" },
      },
      {
        match: {
          args: ["-s", "emulator-5586", "shell", "rm", "-f", /simlock-scrcpy-/],
          command: binaries.adb,
        },
      },
    ]);
    const driver = await createDriver(filesystem, runner, {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    await expect(
      driver.screenCapture?.open(running, settings, new AbortController().signal),
    ).rejects.toThrow(/error: closed/);
    expect(runner.calls[0]?.options.env).toEqual(scopedEnv);
    expect(runner.calls[1]?.options.env).toEqual(scopedEnv);
  });

  it("refuses an emulator that is not running, before running anything", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const runner = new EmulatorExitingRunner([]);
    const driver = await createDriver(filesystem, runner, {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    const stopped = { ...running, driverData: { ...running.driverData, port: 0, serial: "" } };
    await expect(
      driver.screenCapture?.open(stopped, settings, new AbortController().signal),
    ).rejects.toThrow(/not running/);
    expect(runner.calls).toEqual([]);
  });

  it("routes each device's capture to its own adb server: a phone's commands run adb -P 5037 and its socket connects to 5037, an emulator's use Simlock's port", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const phone = {
      address: "R58M123ABC",
      deviceId: "R58M123ABC",
      driverData: {},
      enrolledApps: [],
      physical: true,
    } as const;
    const clock = new FakeClock(1_000);
    // why: the shared server answers the version check with Simlock's own protocol, so the phone's
    // target is open and its commands are expected to go out.
    const probe = new FakeTcpProbe([5038, 5037]);
    probe.replyWith("OKAY00040029");
    const runner = new CaptureRoutingRunner();
    const tcp = new FakeTcpStreamConnector();
    const driver = await createDriver(filesystem, runner, {
      clock,
      scrcpyServerPath: serverPath,
      tcpProbe: probe,
      tcpStreamConnector: tcp,
    });

    // why: each open is stopped while it waits on its socket's first reply — which is exactly the
    // moment this test owns: every command has gone out through the device's own server, the socket
    // has been aimed at the device, and a stop runs nothing further.
    const phoneStop = new AbortController();
    const phoneOpening = driver.screenCapture?.open(phone, settings, phoneStop.signal);
    if (phoneOpening === undefined) throw new Error("the driver offers no screen capture");
    // why: the rejection is asserted below; marking it handled here keeps a rejection that arrives
    // while this test is still reading the socket from being reported as unhandled.
    phoneOpening.catch(() => undefined);
    await waitForSocket(clock, tcp, 1);
    expect(tcp.connections[0]?.port).toBe(5037);
    expect(tcp.connections[0]?.peer.writtenText()).toContain("host:transport:R58M123ABC");
    phoneStop.abort();
    await expect(driveOpen(clock, phoneOpening)).rejects.toThrow(/closed the connection/);

    const emulatorStop = new AbortController();
    const emulatorOpening = driver.screenCapture?.open(running, settings, emulatorStop.signal);
    if (emulatorOpening === undefined) throw new Error("the driver offers no screen capture");
    emulatorOpening.catch(() => undefined);
    await waitForSocket(clock, tcp, 2);
    expect(tcp.connections[1]?.port).toBe(adbServerPort);
    expect(tcp.connections[1]?.peer.writtenText()).toContain("host:transport:emulator-5586");
    emulatorStop.abort();
    await expect(driveOpen(clock, emulatorOpening)).rejects.toThrow(/closed the connection/);

    // why: every command the phone's session ran aims at the shared server — `adb -P 5037` with
    // that server's env, Simlock's port in it and the three keys that could aim adb elsewhere
    // removed — and every command the emulator's session ran carries this driver's scoped env,
    // which points at Simlock's own port. Which commands a phone's session runs (its screen read
    // included) is the capture's and the handler's own claim, proved in their own files.
    const commands = runner.calls.filter((call) => call.args[0] !== "version");
    const phoneCommands = commands.filter((call) => call.args[0] === "-P");
    const emulatorCommands = commands.filter((call) => call.args[0] === "-s");
    expect(phoneCommands.length).toBeGreaterThanOrEqual(3);
    for (const call of phoneCommands) {
      expect(call.args.slice(0, 3)).toEqual(["-P", "5037", "-s"]);
      expect(call.args[3]).toBe("R58M123ABC");
      expect(call.options.env).toEqual({
        ANDROID_ADB_SERVER_PORT: "5037",
        ANDROID_HOME: sdk,
      });
    }
    expect(
      phoneCommands.map((call) =>
        call.args[4] === "push"
          ? "push"
          : call.args[5] === "rm"
            ? "rm"
            : call.args[5]?.startsWith("CLASSPATH=")
              ? "server"
              : String(call.args[4]),
      ),
    ).toEqual(expect.arrayContaining(["push", "server", "rm"]));
    expect(emulatorCommands.map((call) => call.args.slice(0, 3))).toEqual([
      ["-s", "emulator-5586", "push"],
      ["-s", "emulator-5586", "shell"],
      ["-s", "emulator-5586", "shell"],
    ]);
    for (const call of emulatorCommands) {
      expect(call.options.env).toEqual(scopedEnv);
    }
  });
});

// why: flushes work until the n-th raw connection has been made, advancing the fake clock so the
// capture's own bounds cannot strand it; an open that died first fails on a named assertion.
async function waitForSocket(
  clock: FakeClock,
  tcp: FakeTcpStreamConnector,
  count: number,
): Promise<void> {
  for (let spent = 0; spent < 60_000 && tcp.connections.length < count; spent += 50) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  expect(tcp.connections.length, "the capture reached its socket").toBe(count);
}

// why: awaits an open with the fake clock turning, so its own 15 s bound can fire while the test waits.
async function driveOpen(clock: FakeClock, opening: Promise<unknown>): Promise<unknown> {
  let done = false;
  void opening.then(
    () => (done = true),
    () => (done = true),
  );
  for (let spent = 0; spent < 60_000 && !done; spent += 50) {
    for (let flush = 0; flush < 10; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
    clock.advance(50);
  }
  return await opening;
}

/**
 * why: answers every adb call a capture makes by what it is rather than by its place in a queue, so
 * the routing this test reads is proven the same way whether or not the capture reads the phone's
 * screen state first -- the server's shell hangs until the capture's own close kills it, as a live
 * scrcpy server does.
 */
class CaptureRoutingRunner implements ProcessRunner {
  readonly calls: { readonly args: readonly string[]; readonly options: ProcessRunOptions }[] = [];
  #nextPid = 1;

  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    return this.spawn(command, args, options).wait();
  }

  spawn(_command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    this.calls.push({ args, options });
    const rest = args[0] === "-P" ? args.slice(2) : [...args];
    const line = rest.join(" ");
    if (line === "version") {
      return endedHandle(this.#nextPid++, "Android Debug Bridge version 1.0.41\nVersion 35.0.2\n");
    }
    if (line.includes("dumpsys power")) {
      return endedHandle(this.#nextPid++, "  mWakefulness=Awake\n");
    }
    if (/shell CLASSPATH=\S*app_process/.test(line)) {
      return hangingHandle(this.#nextPid++);
    }
    return endedHandle(this.#nextPid++, "");
  }

  spawnStreaming(..._args: Parameters<ProcessRunner["spawnStreaming"]>): never {
    throw new Error("a screen capture spawns no streaming process");
  }
}

function endedHandle(pid: number, stdout: string): ProcessHandle {
  return {
    kill: () => undefined,
    pid,
    stderr: emptyLines(),
    stdout: emptyLines(),
    unref: () => undefined,
    wait: async () => ({ code: 0, stderr: "", stdout }),
  };
}

function hangingHandle(pid: number): ProcessHandle {
  let settle: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => (settle = resolve));
  return {
    kill: () => settle?.(),
    pid,
    stderr: emptyLines(),
    stdout: emptyLines(),
    unref: () => undefined,
    wait: async () => {
      await ended;
      return { code: null, stderr: "", stdout: "" };
    },
  };
}

describe("AndroidDriver.create", () => {
  it("creates and marks its own AVD home under SIMLOCK_HOME when none exists yet", async () => {
    const filesystem = await androidFilesystem({ withDeviceRoot: false });
    await recordRunningAdbServer(filesystem);

    const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

    expect(driver.deviceRoot).toBe(avdDirectory);
    await expect(
      filesystem.readFile(`${avdDirectory}/${OWNED_ROOT_MARKER_FILE}`),
    ).resolves.toContain('"platform": "android"');
  });

  it("refuses a root that carries another instance's marker rather than using the user's AVDs", async () => {
    const filesystem = await androidFilesystem({ withDeviceRoot: false });
    await filesystem.mkdirp(avdDirectory);
    await filesystem.writeFileAtomic(
      `${avdDirectory}/${OWNED_ROOT_MARKER_FILE}`,
      JSON.stringify({
        instanceId: "someone-else",
        owner: "simlock",
        platform: "android",
        schemaVersion: 1,
      }),
    );

    await expect(createDriver(filesystem, new EmulatorExitingRunner([]))).rejects.toMatchObject({
      name: "OwnedRootError",
      reason: "wrong-instance",
    });
  });

  it("refuses a deviceRoot that is not a path at all, costing android and not the daemon", async () => {
    const filesystem = await androidFilesystem({ withDeviceRoot: false });

    const refusal = await createDriver(filesystem, new EmulatorExitingRunner([]), {
      driverConfig: { deviceRoot: true },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(OwnedRootError);
    expect(refusal).toMatchObject({ platform: "android", reason: "not-absolute" });
  });

  it("refuses an adbServerPort that is not a port number", async () => {
    const filesystem = await androidFilesystem();

    const refusal = await createDriver(filesystem, new EmulatorExitingRunner([]), {
      driverConfig: { adbServerPort: "5038" },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AdbServerUnavailableError);
    expect(refusal).toMatchObject({ reason: "invalid-port" });
  });

  it("refuses to attach to a server on its port that it has no record of starting", async () => {
    const filesystem = await androidFilesystem();

    const refusal = await AndroidDriver.create({
      clock: new FakeClock(),
      database: await memoryAndroidSourceDatabase(),
      driverConfig: {},
      env: { ANDROID_HOME: sdk },
      filesystem,
      homeDirectory: home,
      hostAbi: "arm64-v8a",
      instanceId,
      processRunner: new EmulatorExitingRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome,
      // why: Listening, but nothing says it is Simlock's -- it could be Android Studio's.
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ port: adbServerPort, reason: "occupied" });
  });

  it("hands a lease holder the adb server port, and scopes its own calls to a configured one", async () => {
    const filesystem = await androidFilesystem();
    const runner = new EmulatorExitingRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner, {
      driverConfig: { adbServerPort: 5199 },
    });

    expect(driver.leaseEnvironment(VIRTUAL_DEVICE)).toEqual({ ANDROID_ADB_SERVER_PORT: "5199" });
    await driver.resolveSpec({ model: "Pixel 5", platform: "android" });
    expect(runner.calls[0]?.options.env).toEqual({
      ...scopedEnv,
      ANDROID_ADB_SERVER_PORT: "5199",
    });
  });

  it("points an adb passthrough at Simlock's own server, which is the only one that sees it", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

    const args = ["shell", "input", "tap", "100", "200"];
    const expected = {
      args: ["-P", String(adbServerPort), ...args],
      command: binaries.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(adbServerPort) },
    };

    expect(await passthroughOf(driver, args)).toEqual(expected);
    expect(await passthroughOf(driver, args, undefined, VIRTUAL_DEVICE)).toEqual(expected);
  });

  it("claims only the adb passthrough tool", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));

    expect((driver as unknown as { passthroughTools: unknown }).passthroughTools).toEqual(["adb"]);
  });

  it.each([
    {
      attached: "no emulator is attached",
      devices: "List of devices attached\n",
      signals: [{ pid: adbServerPid, signal: "SIGTERM" }],
      recordKept: false,
    },
    {
      // why: an emulator that outlives the daemon starts its own `fork-server` on the port once the server is gone, and the next daemon refuses that one as occupied.
      attached: "an emulator is still attached",
      devices: "List of devices attached\nemulator-5586\tdevice\n",
      signals: [],
      recordKept: true,
    },
  ])(
    "when the daemon disposes of the adb server it adopted and $attached, the server gets $signals and the record is kept: $recordKept",
    async ({ devices, recordKept, signals }) => {
      const filesystem = await androidFilesystem();
      const processSupervisor = new FakeProcessSupervisor([adbServerPid]);
      processSupervisor.answerCommandLine(
        adbServerPid,
        `${binaries.adb} -P ${adbServerPort} nodaemon server`,
      );
      await recordRunningAdbServer(filesystem);
      const runner = new EmulatorExitingRunner([processResult(binaries.adb, ["devices"], devices)]);
      const driver = await AndroidDriver.create({
        clock: new FakeClock(),
        database: await memoryAndroidSourceDatabase(),
        driverConfig: {},
        env: { ANDROID_HOME: sdk },
        filesystem,
        homeDirectory: home,
        hostAbi: "arm64-v8a",
        instanceId,
        processRunner: runner,
        processSupervisor,
        simlockHome,
        tcpProbe: new FakeTcpProbe([adbServerPort]),
      });
      processSupervisor.markDead(adbServerPid);

      await driver.dispose();

      // why: By pid, because `ADB_REJECT_KILL_SERVER=1` means `adb kill-server` refuses Simlock too.
      expect(processSupervisor.signals).toEqual(signals);
      await expect(filesystem.exists(adbRecordPath)).resolves.toBe(recordKept);
    },
  );
});

describe("AndroidDriver ownership", () => {
  it.each([
    {
      reported: "a trailing slash",
      answer: ok(`${avdDirectory}/simlock_one.avd/\r\nOK\r\n`),
      runState: "running",
    },
    {
      reported: "a canonical alias",
      answer: ok(`/private${avdDirectory}/simlock_one.avd\r\nOK\r\n`),
      runState: "running",
    },
    { reported: "a blank path", answer: ok("\r\nOK\r\n"), runState: "stopped" },
    { reported: "a console error", answer: ok("KO: unknown command\r\n"), runState: "stopped" },
    { reported: "a relative path", answer: ok("simlock_one.avd\r\nOK\r\n"), runState: "stopped" },
    {
      reported: "a missing directory",
      answer: ok("/missing/simlock_one.avd\r\nOK\r\n"),
      runState: "stopped",
    },
    {
      reported: "an unreadable alias",
      answer: ok(`/unreadable/simlock_one.avd\r\nOK\r\n`),
      runState: "stopped",
    },
    {
      reported: "a sibling AVD",
      answer: ok(`${avdDirectory}/simlock_two.avd\r\nOK\r\n`),
      runState: "stopped",
    },
    {
      reported: "a vanished serial",
      answer: { code: 1, stderr: "device 'emulator-5586' not found", stdout: "" },
      runState: "transitioning",
    },
  ])(
    "gates running state, processes and erasable marks on path proof while retaining durable marks: $reported",
    async ({ answer, runState }) => {
      const filesystem = await androidFilesystem(
        { config: "simlock.mark=tok-123\n" },
        new WorkingDirectoryFilesystem(avdDirectory),
      );
      filesystem.defineSymlink("/private/home", "/home");
      filesystem.defineSymlink("/unreadable", avdDirectory);
      filesystem.defineFailure("/unreadable/simlock_one.avd", "EACCES");
      await filesystem.mkdirp(`${avdDirectory}/simlock_two.avd`);

      for (const result of [ok(`${avdDirectory}/simlock_one.avd\r\nOK\r\n`), answer]) {
        const runner = new EmulatorExitingRunner([
          processResult(
            binaries.adb,
            ["devices"],
            "List of devices attached\nemulator-5586\tdevice\n",
          ),
          processResult(
            binaries.adb,
            ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
            'simlock_one\n{"token":"tok-123"}',
          ),
          {
            match: { command: binaries.adb, args: ["-s", "emulator-5586", "emu", "avd", "path"] },
            result,
          },
        ]);
        const driver = await createDriver(filesystem, runner);
        const reality = await driver.listManaged();
        const expectedState = result === answer ? runState : "running";
        const running = expectedState === "running";

        expect(reality.processes).toEqual(
          running
            ? [expect.objectContaining({ address: "emulator-5586", deviceId: "simlock_one" })]
            : [],
        );
        expect(reality.devices.find((device) => device.deviceId === "simlock_one")).toMatchObject({
          runState: expectedState,
          mark: {
            durable: "tok-123",
            erasable: running ? "tok-123" : undefined,
            erasableReadable: running,
          },
        });
        expect(
          runner.calls.find((call) => call.args.slice(2).join(" ") === "emu avd path")?.options,
        ).toEqual({ env: scopedEnv, timeoutMs: 5_000 });
      }
    },
  );

  it("tells two running copies of one seed apart by each one's own AVD folder, still attributes an old-layout AVD, and lists no seed folder nor attributes its emulator", async () => {
    const filesystem = await androidFilesystem();
    for (const folder of [
      `${avdDirectory}/simlock_a/simlock.avd`,
      `${avdDirectory}/simlock_b/simlock.avd`,
      `${avdDirectory}/simlock_old.avd`,
      `${avdDirectory}/sources/seed_x/simlock.avd`,
    ]) {
      await filesystem.mkdirp(folder);
    }
    const running = [
      ["emulator-5554", "simlock", `${avdDirectory}/simlock_b/simlock.avd`],
      ["emulator-5556", "simlock", `${avdDirectory}/simlock_a/simlock.avd`],
      ["emulator-5558", "simlock_old", `${avdDirectory}/simlock_old.avd`],
      ["emulator-5560", "simlock", `${avdDirectory}/sources/seed_x/simlock.avd`],
    ] as const;
    const runner = new EmulatorExitingRunner([
      processResult(
        binaries.adb,
        ["devices"],
        `List of devices attached\n${running.map(([serial]) => `${serial}\tdevice`).join("\n")}\n`,
      ),
      ...running.flatMap(([serial, name, path]) => [
        processResult(
          binaries.adb,
          ["-s", serial, "shell", /getprop ro\.boot\.qemu\.avd_name/],
          `${name}\n`,
        ),
        processResult(binaries.adb, ["-s", serial, "emu", "avd", "path"], `${path}\r\nOK\r\n`),
      ]),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.devices.map((device) => [device.deviceId, device.runState]).sort()).toEqual([
      ["simlock_a", "running"],
      ["simlock_b", "running"],
      ["simlock_old", "running"],
    ]);
    expect(reality.processes.map((process) => [process.deviceId, process.address]).sort()).toEqual([
      ["simlock_a", "emulator-5556"],
      ["simlock_b", "emulator-5554"],
      ["simlock_old", "emulator-5558"],
    ]);
  });
});

describe("AndroidDriver pre-root devices", () => {
  it("accepts an intact root on revalidation", async () => {
    const driver = await createDriver(await androidFilesystem(), new EmulatorExitingRunner([]));

    await expect(driver.revalidateRoot()).resolves.toBeUndefined();
  });

  it("refuses to re-prove a root that has become a symlink since startup", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new EmulatorExitingRunner([]));
    // why: The case the re-proof exists for: the path was proven at startup and swapped since,
    // so `listManaged` would now answer with the user's own AVDs.
    filesystem.defineSymlink(avdDirectory, `${home}/.android/avd`);

    await expect(driver.revalidateRoot()).rejects.toMatchObject({
      name: "OwnedRootError",
      reason: "symlink",
    });
  });

  it("hands the device table its device root, its legacy AVD home, its environment and its avdmanager", async () => {
    const legacyHome = "/legacy/avd";
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_new.avd`);
    await filesystem.mkdirp(`${legacyHome}/simlock_old.avd`);
    const runner = new EmulatorExitingRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
    ]);
    const driver = await createDriver(filesystem, runner, {
      avdHome: legacyHome,
      extraEnv: { SIMLOCK_MARKER: "kept" },
    });

    const reality = await driver.listManaged();
    const legacy = await driver.findLegacy("simlock_old");
    await driver.destroyLegacy(legacy!.device);

    expect(reality.devices.map((device) => device.deviceId)).toEqual(["simlock_new"]);
    expect(legacy?.path).toBe(`${legacyHome}/simlock_old.avd`);
    expect(runner.calls.at(-1)).toMatchObject({
      command: binaries.avdmanager,
      options: {
        env: { ANDROID_AVD_HOME: legacyHome, ANDROID_HOME: sdk, SIMLOCK_MARKER: "kept" },
      },
    });
  });
});

describe("AndroidDriver listComponents()", () => {
  const googleApis = `${sdk}/system-images/android-35/google_apis/arm64-v8a`;

  describe("removeComponent()", () => {
    const packageName = "system-images;android-35;google_apis;arm64-v8a";
    const signal = () => new AbortController().signal;

    it("removes the image the receipt names with sdkmanager --uninstall and its package, and verifies it is gone", async () => {
      const filesystem = await androidFilesystem({
        images: [
          ["35", "google_apis", "arm64-v8a"],
          ["35", "default", "arm64-v8a"],
        ],
      });
      await filesystem.writeFileAtomic(`${googleApis}/system.img`, "0123456789");
      const runner = new InstallReflectingProcessRunner(
        [processResult(binaries.sdkmanager, ["--uninstall", packageName])],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);
      const target = (await driver.listComponents()).find(
        (component) => component.variant === "google_apis/arm64-v8a",
      );

      await expect(
        driver.removeComponent(target?.receipt ?? {}, { signal: signal() }),
      ).resolves.toEqual({ sizeBytes: 10 });

      expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
        [binaries.sdkmanager, "--uninstall", packageName],
      ]);
      expect((await driver.listComponents()).map(({ variant }) => variant)).toEqual([
        "default/arm64-v8a",
      ]);
    });

    it("refuses with ComponentInUseError when an AVD in the user's AVD home names the image, and uninstalls nothing", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      await userAvd(filesystem, "Pixel_8", "system-images/android-35/google_apis/arm64-v8a/");
      // why: The scripted runner fails any call it was not given, so an uninstall would fail this test.
      const runner = new EmulatorExitingRunner([]);
      const driver = await createDriver(filesystem, runner);
      const [target] = await driver.listComponents();

      const error = await driver
        .removeComponent(target?.receipt ?? {}, { signal: signal() })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ComponentInUseError);
      expect(error).toMatchObject({ foreignDevices: 1 });
      expect(runner.calls).toEqual([]);

      // why: An AVD home that is the driver's own root holds Simlock's AVDs, never the user's, so
      // none of them is counted; this proves the driver hands its own device root to the part.
      await userAvd(filesystem, "Pixel_8", "system-images/android-35/google_apis/arm64-v8a/", {
        avdHome: avdDirectory,
      });
      const ownRoot = await createDriver(filesystem, new EmulatorExitingRunner([]), {
        avdHome: avdDirectory,
      });
      expect((await ownRoot.listComponents())[0]?.foreignDevices).toBe(0);
    });

    it("refuses with ComponentNotOwnedError when no installed image has the receipt, and uninstalls nothing", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const runner = new EmulatorExitingRunner([]);
      const driver = await createDriver(filesystem, runner);

      await expect(
        driver.removeComponent(
          { package: packageName, revision: "1", stamp: "elsewhere@0" },
          { signal: signal() },
        ),
      ).rejects.toBeInstanceOf(ComponentNotOwnedError);
      expect(runner.calls).toEqual([]);
    });

    it("fails with sdkmanager's output when the uninstall exits non-zero", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const runner = new EmulatorExitingRunner([
        {
          match: { args: ["--uninstall", packageName], command: binaries.sdkmanager },
          result: { code: 1, stderr: "Failed to find package", stdout: "" },
        },
      ]);
      const driver = await createDriver(filesystem, runner);
      const [target] = await driver.listComponents();

      await expect(
        driver.removeComponent(target?.receipt ?? {}, { signal: signal() }),
      ).rejects.toThrow("Failed to find package");
    });

    it("ends sdkmanager --uninstall when its signal fires", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const runner = new EmulatorExitingRunner([
        {
          hangs: true,
          match: { args: ["--uninstall", packageName], command: binaries.sdkmanager },
        },
      ]);
      const driver = await createDriver(filesystem, runner);
      const [target] = await driver.listComponents();
      const abort = new AbortController();

      const removal = driver
        .removeComponent(target?.receipt ?? {}, { signal: abort.signal })
        .catch((caught: unknown) => caught);
      await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
      abort.abort();

      expect(await settledValue(removal)).toMatchObject({
        message: expect.stringMatching(/was ended before it finished/),
      });
    });

    it("ends sdkmanager --uninstall after five minutes, SIGTERM then SIGKILL, and answers only once it has exited", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const clock = new FakeClock();
      const runner = new EmulatorExitingRunner([
        {
          hangs: true,
          ignoresSigterm: true,
          match: { args: ["--uninstall", packageName], command: binaries.sdkmanager },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { clock });
      const [target] = await driver.listComponents();

      let settled = false;
      const removal = driver
        .removeComponent(target?.receipt ?? {}, { signal: signal() })
        .catch((caught: unknown) => caught)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
      clock.advance(5 * 60_000);
      for (let count = 0; count < 100; count += 1) await Promise.resolve();
      expect(settled).toBe(false);
      clock.advance(10_000);

      expect(await settledValue(removal)).toMatchObject({
        message: expect.stringMatching(/timed out after 300000ms/),
      });
    });
  });
});

/**
 * why: What a promise settled with, once it has: a promise still open fails a named assertion rather
 * than the test's own timeout, so a deadline that never ends anything reads as that.
 */
async function settledValue(promise: Promise<unknown>): Promise<unknown> {
  const state: { done: boolean; value: unknown } = { done: false, value: undefined };
  const settle = (value: unknown): void => {
    state.done = true;
    state.value = value;
  };
  void promise.then(settle, settle);
  await vi.waitFor(() => expect(state.done).toBe(true));
  return state.value;
}

const seedLaunch = ["-avd", "simlock", ...seedEmulatorLine];

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

/** why: every case below asks for the `adb` tool, so this one place names it and leaves the device and context optional. */
async function passthroughOf(
  driver: object,
  args: readonly string[],
  context?: { readonly hasTerminal: boolean; readonly platform?: string },
  device?: unknown,
): Promise<{ readonly args: readonly string[]; readonly command: string; readonly env: object }> {
  const routed = driver as {
    passthrough(
      tool: string,
      device: unknown,
      args: readonly string[],
      context?: { readonly hasTerminal: boolean; readonly platform?: string },
    ): Promise<{
      readonly args: readonly string[];
      readonly command: string;
      readonly env: object;
    }>;
  };
  return routed.passthrough("adb", device, args, context);
}

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

/** why: how many times the emulator has been asked whether it finished booting. */
function bootPolls(runner: ScriptedProcessRunner): number {
  return runner.calls.filter((call) => call.args.at(-1) === "sys.boot_completed").length;
}

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
