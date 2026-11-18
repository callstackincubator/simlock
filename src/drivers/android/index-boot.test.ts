import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { promiseState } from "../../test-support/promise-state.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "../../ports/index.js";
import { AndroidDriver, SdkMissingError } from "./index.js";
import {
  androidFilesystem,
  avdDirectory,
  binaries,
  createdFromPackage,
  taggedHarness as taggedHarnessWith,
  EmulatorExitingRunner,
  instanceId,
  simlockHome,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  adbServerPort,
  adbServerPid,
  scopedEnv,
  provisionedHarness,
  createDriver,
  recordRunningAdbServer,
  EmulatorHost,
  RecordingRunner,
  consolePortOf,
  copyPathExpectation,
  withWindowsExtension,
} from "./testing.js";
import { sdk, home, buildDriver } from "./test-index.js";

const scopedOptions = { env: scopedEnv } as const;

const taggedHarness = (
  ...args: Parameters<typeof taggedHarnessWith> extends [unknown, ...infer Rest] ? Rest : never
) => taggedHarnessWith(buildDriver, ...args);

/** why: how many times the emulator has been asked whether it finished booting. */
function bootPolls(runner: ScriptedProcessRunner): number {
  return runner.calls.filter((call) => call.args.at(-1) === "sys.boot_completed").length;
}

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
    const versionedAvdmanager = withWindowsExtension(
      `${versionedTools}/avdmanager`,
      process.platform,
      ".bat",
    );
    await filesystem.writeFileAtomic(versionedAvdmanager, "binary");
    await filesystem.writeFileAtomic(
      withWindowsExtension(`${versionedTools}/sdkmanager`, process.platform, ".bat"),
      "binary",
    );

    const legacyTools = `${sdk}/tools/bin`;
    await filesystem.mkdirp(legacyTools);
    await filesystem.writeFileAtomic(
      withWindowsExtension(`${legacyTools}/avdmanager`, process.platform, ".bat"),
      "binary",
    );
    await filesystem.writeFileAtomic(
      withWindowsExtension(`${legacyTools}/sdkmanager`, process.platform, ".bat"),
      "binary",
    );

    const runner = new EmulatorExitingRunner([
      processResult(versionedAvdmanager, ["list", "device"], pixelDevices),
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
  // shared 5037 server.
  it("asks for its children to be killed with the emulator, and for no adb command", async () => {
    const harness = await provisionedHarness();

    await harness.driver.makeReady(harness.device);

    const emulatorCalls = harness.runner.calls.filter(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const adbCalls = harness.runner.calls.filter((call) => call.command === binaries.adb);
    expect(emulatorCalls.length).toBeGreaterThan(0);
    expect(emulatorCalls.filter((call) => call.options.killChildren !== true)).toEqual([]);
    expect(adbCalls.length).toBeGreaterThan(0);
    expect(adbCalls.filter((call) => call.options.killChildren !== undefined)).toEqual([]);
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
      join(avdDirectory, "emu-crash.db"),
      join(avdDirectory, "emu-crash.db"),
      join(avdDirectory, "emu-crash.db"),
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

  // why: emulator 36.1.9's `-help` lists every flag Simlock passes except -crash-report-mode, and it exits at `unknown option: -crash-report-mode` (#1199).
  const usage = [
    "Android Emulator usage: emulator [options] [-qemu args]",
    "  options:",
    "    -avd <name>                  use a specific android virtual device",
    "    -port <port>                 TCP port that will be used for the console",
    "    -no-snapshot-save            do not auto-save to snapshot on exit: abandon changed state",
    "    -no-snapshot-load            do not auto-start from snapshot: perform a full boot",
    "    -snapshot <name>             name of snapshot within storage file for auto-start and auto-save",
    "    -grpc <port>                 TCP ports used for the gRPC bridge",
    "    -grpc-use-token              Use the emulator console token for gRPC authentication.",
    "",
  ].join("\n");

  it.each([
    {
      probe: "-help does not list it",
      help: (): Promise<ProcessResult> => Promise.resolve({ code: 0, stderr: "", stdout: usage }),
    },
    {
      probe: "-help fails or times out",
      help: (): Promise<ProcessResult> => Promise.reject(new Error("emulator -help timed out")),
    },
  ])(
    "starts the seed's boots and the copy's boot without -crash-report-mode when the installed emulator's $probe, keeping every other launch flag (#1297)",
    async ({ help }) => {
      const filesystem = await androidFilesystem();
      const host = new EmulatorHost(filesystem);
      const launches: (readonly string[])[] = [];
      const hostRunner = host.runner();
      const runner: ProcessRunner = {
        ...hostRunner,
        run: (command, args, options) =>
          command === binaries.emulator && args[0] === "-help"
            ? help()
            : hostRunner.run(command, args, options),
        spawn: (command, args, options) => {
          launches.push(args);
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

      expect(
        launches.map((args) => ({
          boot: args.at(-1),
          crashReportMode: args.includes("-crash-report-mode"),
        })),
      ).toEqual([
        { boot: "-no-snapshot-load", crashReportMode: false },
        { boot: "-no-snapshot-load", crashReportMode: false },
        { boot: "simlock_boot", crashReportMode: false },
      ]);
      for (const args of launches) {
        expect(args).toEqual(
          expect.arrayContaining(["-port", "-no-snapshot-save", "-grpc", "-grpc-use-token"]),
        );
      }
    },
  );

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

  it("kills an emulator that has not exited 180 s after a shutdown, whatever the boot timeout is", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        copyPathExpectation("emulator-5586"),
        processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ],
      bootTimeoutMs: 600_000,
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
    harness.clock.advance(180_000);
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

  it("sends the emulator's output to <avd folder>/emulator.log, mode 0600, emptied in place at each start", async () => {
    const harness = await provisionedHarness();
    const logPath = join(avdDirectory, "simlock_one", "simlock.avd", "emulator.log");
    await harness.filesystem.writeFileAtomic(logPath, "left by an earlier start\n", {
      mode: 0o644,
    });
    const earlier = await harness.filesystem.stat(logPath);

    await harness.driver.makeReady(harness.device);

    const launch = harness.runner.calls.findLast(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    expect(launch?.options.stdio).toEqual({ file: logPath });
    await expect(harness.filesystem.readFile(logPath)).resolves.toBe("");
    expect((await harness.filesystem.lstat(logPath)).mode & 0o777).toBe(0o600);
    expect(
      (await harness.filesystem.stat(logPath)).identity,
      "emulator.log was replaced by another file, not emptied",
    ).toBe(earlier.identity);
  });

  it("an Android boot waits android.bootTimeoutMs, then kills the emulator and fails with BootTimeoutError", async () => {
    for (const { key, waitsMs } of [
      { key: undefined, waitsMs: 300_000 },
      { key: 600_000, waitsMs: 600_000 },
    ]) {
      const harness = await provisionedHarness({
        bootCompleted: "0\n",
        ...(key === undefined ? {} : { bootTimeoutMs: key }),
      });
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

      // why: the script answers one poll; a boot that outlasts minutes keeps being told it is not done.
      const scripted = harness.runner.run.bind(harness.runner);
      vi.spyOn(harness.runner, "run").mockImplementation((command, args, options) =>
        args.at(-1) === "sys.boot_completed"
          ? Promise.resolve({ code: 0, stderr: "", stdout: "0\n" })
          : scripted(command, args, options),
      );

      const ready = harness.driver.makeReady(harness.device);
      const state = promiseState(ready);
      const failed = expect(ready).rejects.toMatchObject({ name: "BootTimeoutError" });
      // why: each poll arms the next delay only after the previous one fired, so the clock moves in steps.
      for (let elapsed = 0; elapsed < waitsMs - 1; elapsed += 1_000) {
        await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
        harness.clock.advance(Math.min(1_000, waitsMs - 1 - elapsed));
        for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
      }
      expect(state.state, `still booting just before ${String(waitsMs)} ms`).toBe("pending");
      expect(kills).toEqual([]);

      await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(0));
      harness.clock.advance(1);
      await failed;
      expect(kills).toContain("SIGKILL");
    }
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
});
