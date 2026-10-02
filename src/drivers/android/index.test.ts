import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Driver } from "../../core/driver.js";
import {
  ComponentInUseError,
  ComponentNotOwnedError,
  OWNED_ROOT_MARKER_FILE,
  OwnedRootError,
  PassthroughRefusedError,
} from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  type Filesystem,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  NodeProcessSupervisor,
  NodeTcpProbe,
  ScriptedProcessRunner,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
  SystemClock,
} from "../../ports/index.js";
import {
  AdbServerUnavailableError,
  AndroidDriver,
  AndroidLicenseNotAcceptedError,
  SdkMissingError,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";

const sdk = "/android-sdk";
const home = "/home/simlock";
const simlockHome = "/home/simlock/.simlock";
const instanceId = "instance-1";
const adbServerPort = 5038;
const adbServerPid = 4242;
const adbRecordPath = `${simlockHome}/adb-server.json`;
/** The AVD home this driver owns and proves ownership from, not the user's own. */
const avdDirectory = `${simlockHome}/devices/android`;
/** What every invocation the driver makes must be scoped with; see `AndroidDriver#env`. */
const scopedEnv = {
  ANDROID_ADB_SERVER_PORT: String(adbServerPort),
  ANDROID_AVD_HOME: avdDirectory,
  ANDROID_HOME: sdk,
} as const;
const scopedOptions = { env: scopedEnv } as const;
// The emulator outlives the daemon and is never read from, so it is spawned detached.
const emulatorOptions = { env: scopedEnv, stdio: "ignore" } as const;
const binaries = {
  adb: `${sdk}/platform-tools/adb`,
  avdmanager: `${sdk}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${sdk}/emulator/emulator`,
  sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
} as const;
const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;
const twoPixelDevices =
  `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n` +
  `---------\nid: 1 or "pixel_9"\n    Name: Pixel 9\n    OEM : Google\n`;

describe("AndroidDriver", () => {
  it("discovers ANDROID_HOME before the other SDK locations and rejects a missing SDK", async () => {
    const filesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([]);

    await recordRunningAdbServer(filesystem);
    const driver = await AndroidDriver.create({
      clock: new FakeClock(),
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

    const runner = new ScriptedProcessRunner([
      processResult(`${versionedTools}/avdmanager`, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.resolveSpec({ model: "Pixel 8", platform: "android" })).resolves.toEqual({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
  });

  it("resolves the newest installed matching image and prefers the host ABI", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["34", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
        ["35", "google_apis", "x86_64"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.resolveSpec({ model: "Pixel 8", platform: "android" })).resolves.toEqual({
      model: "Pixel 8",
      osVersion: "35",
      platform: "android",
    });
  });

  it("rejects a missing image naming its API level as the component, and starts no sdkmanager", async () => {
    const filesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(
      driver.resolveSpec({ model: "Pixel 8", osVersion: "35", platform: "android" }),
    ).rejects.toMatchObject({ component: "35", downloadable: true, name: "RuntimeMissingError" });
    expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
  });

  describe("image tag", () => {
    /** A driver over `images` whose next `provision` creates `simlock_one`. */
    async function taggedHarness(
      images: readonly (readonly [string, string, string])[],
      hostAbi = "arm64-v8a",
    ) {
      const filesystem = await androidFilesystem({ images });
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, [
          "create",
          "avd",
          "-n",
          "simlock_one",
          "-k",
          /.+/,
          "-d",
          "pixel_8",
        ]),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      const driver = await createDriver(filesystem, runner, { hostAbi, ids: ["one"] });
      return { driver, filesystem, runner };
    }

    /** The system image package `avdmanager create avd -k` was given. */
    function createdFromPackage(runner: ScriptedProcessRunner): string | undefined {
      const create = runner.calls.find(
        (call) => call.command === binaries.avdmanager && call.args[0] === "create",
      );
      return create?.args[create.args.indexOf("-k") + 1];
    }

    it("resolves a request naming an installed tag to a spec with that tag, and creates the device from that image", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
      ]);

      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(spec).toEqual({
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      });
      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;arm64-v8a",
      );
    });

    it("fails a tag that is not installed for the API level as a runtime that cannot be downloaded, naming the tag, and starts no sdkmanager", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["35", "google_apis_playstore", "arm64-v8a"],
      ]);

      const failure = await driver
        .resolveSpec({
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          osVersion: "34",
          platform: "android",
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
      expect((failure as Error).message).toContain("google_apis_playstore");
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
    });

    it("gives a tagged request with no API level the newest API level that has an image of that tag", async () => {
      const { driver } = await taggedHarness([
        ["33", "google_apis_playstore", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["35", "google_apis", "arm64-v8a"],
      ]);

      await expect(
        driver.resolveSpec({
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          platform: "android",
        }),
      ).resolves.toMatchObject({ imageTag: "google_apis_playstore", osVersion: "34" });
    });

    it("resolves a request naming no tag to the same google_apis image as before, with no tag on the spec", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "default", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["34", "google_apis", "arm64-v8a"],
      ]);

      const spec = await driver.resolveSpec({ model: "Pixel 8", platform: "android" });
      await driver.provision(spec);

      expect(spec).toEqual({ model: "Pixel 8", osVersion: "34", platform: "android" });
      expect(createdFromPackage(runner)).toBe("system-images;android-34;google_apis;arm64-v8a");
    });

    it("creates a tagged device from the host ABI's image when the tag is installed for two ABIs", async () => {
      // On an x86_64 host the foreign arm64-v8a image is listed first, so taking the first image
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
        model: "Pixel 8",
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
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      expect(createdFromPackage(runner)).toBe(
        "system-images;android-34;google_apis_playstore;x86_64",
      );
    });

    it("fails a tag installed for no API level, with no API level named, naming the tag and no API level", async () => {
      const { driver } = await taggedHarness([["34", "google_apis", "arm64-v8a"]]);

      const failure = await driver
        .resolveSpec({ imageTag: "google_apis_playstore", model: "Pixel 8", platform: "android" })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        component: undefined,
        downloadable: false,
        message: "No google_apis_playstore system image is installed for any Android API level",
        name: "RuntimeMissingError",
      });
    });

    it("fails provisioning a tagged spec whose image went missing after it resolved, offering no download", async () => {
      const { driver, filesystem, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["34", "google_apis_playstore", "arm64-v8a"],
      ]);
      const spec = await driver.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
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

  it("allocates different even ports for concurrent provisions and skips adb-owned ports", async () => {
    const firstFilesystem = await androidFilesystem();
    const secondFilesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_first",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_second",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
    ]);
    const first = await createDriver(firstFilesystem, runner, { ids: ["first"] });
    const second = await createDriver(secondFilesystem, runner, { ids: ["second"] });
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;
    await Promise.all([first.resolveSpec(spec), second.resolveSpec(spec)]);

    const [firstDevice, secondDevice] = await Promise.all([
      first.provision(spec),
      second.provision(spec),
    ]);

    expect(firstDevice.driverData).toMatchObject({ avdName: "simlock_first", port: 5588 });
    expect(secondDevice.driverData).toMatchObject({ avdName: "simlock_second", port: 5590 });
    // Occupancy is read from Simlock's own server, not the machine's shared one: an
    // unscoped `adb devices` polls 5037, which reports the user's emulators and none of
    // Simlock's, so every console port would read free and collide on the next boot.
    expect(runner.calls.filter((call) => call.args[0] === "devices")).toEqual([
      { args: ["devices"], command: binaries.adb, options: scopedOptions },
      { args: ["devices"], command: binaries.adb, options: scopedOptions },
    ]);
  });

  it("cold boots without loading or automatically saving snapshots", async () => {
    const harness = await provisionedHarness();

    await expect(harness.driver.makeReady(harness.device)).resolves.toMatchObject({
      address: "emulator-5586",
      deviceId: "simlock_one",
    });
    expect(harness.runner.calls).toContainEqual({
      args: ["-avd", "simlock_one", "-port", "5586", "-no-snapshot-save", "-no-snapshot-load"],
      command: binaries.emulator,
      options: emulatorOptions,
    });
  });

  /**
   * The half of the daemon-stop fix that argv cannot show. `stdio: "ignore"` alone does not
   * release the event loop -- the ChildProcess handle does -- so without the `unref` a
   * `daemon stop` logged "Daemon stopped" and then sat there for as long as any emulator ran.
   * An emulator is meant to outlive the daemon (`#reattachRunningEmulators` adopts it after a
   * restart) and is reaped through adb and by pid, never by awaiting its exit.
   */
  it("releases the event loop for the emulator it starts, so a stopped daemon can exit", async () => {
    const harness = await provisionedHarness();

    await harness.driver.makeReady(harness.device);

    // The launches specifically -- `emulator` is also invoked as a short-lived query
    // (`-list-avds` and friends) through `run`, which waits on the child and must stay
    // referenced. Only a boot is detached.
    const launches = harness.runner.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.command === binaries.emulator && call.args.includes("-avd"));
    expect(launches.length, "no emulator was launched").toBeGreaterThan(0);

    for (const { index } of launches) {
      expect(harness.runner.handles[index]?.unreffed, `launch at call ${String(index)}`).toBe(true);
    }
    // ... and nothing else is: every other child is one the driver waits on.
    expect(harness.runner.handles.filter((handle) => handle.unreffed)).toHaveLength(
      launches.length,
    );
  });

  /**
   * #237: a timer the driver leaves armed holds the event loop open, so a daemon that logged
   * "Daemon stopped" stays alive until it fires. Both shutdowns here -- the one `makeReady`
   * does to restart from the new baseline, and the one the test asks for -- see the emulator
   * exit at once, so neither has anything left to wait for.
   */
  it("leaves no timer armed once each shutdown has seen its emulator exit", async () => {
    const harness = await provisionedHarness({
      afterwards: [processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"])],
    });
    await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    expect(running, "no running emulator").toBeDefined();

    const shutdown = harness.driver.shutdown(harness.device);
    // The emulator answers `emu kill` by exiting.
    running?.kill("SIGTERM");
    await shutdown;

    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("kills an emulator that has not exited within the readiness timeout of a shutdown", async () => {
    const harness = await provisionedHarness({
      afterwards: [processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"])],
      readinessTimeoutMs: 2_000,
    });
    await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    if (running === undefined) throw new Error("no running emulator");
    const kill = vi.spyOn(running, "kill");

    // The emulator ignores `emu kill`: only the timeout can end the wait.
    const armedBefore = harness.clock.pendingTimerCount;
    const shutdown = harness.driver.shutdown(harness.device);
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBeGreaterThan(armedBefore));
    expect(kill).not.toHaveBeenCalled();
    harness.clock.advance(2_000);
    await shutdown;

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("leaves no timer armed when waiting for the emulator to exit fails", async () => {
    const harness = await provisionedHarness({
      afterwards: [processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"])],
    });
    await harness.driver.makeReady(harness.device);
    const launch = harness.runner.calls.findLastIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const running = harness.runner.handles[launch];
    if (running === undefined) throw new Error("no running emulator");
    // A child that emits `error` rejects its wait instead of resolving it.
    vi.spyOn(running, "wait").mockRejectedValue(new Error("spawn error"));

    await expect(harness.driver.shutdown(harness.device)).rejects.toThrow("spawn error");

    expect(harness.clock.pendingTimerCount, "timers still armed after shutdown").toBe(0);
  });

  it("validates a new clean baseline by restarting from it before becoming ready", async () => {
    const harness = await provisionedHarness();

    await expect(harness.driver.makeReady(harness.device)).resolves.toMatchObject({
      address: "emulator-5586",
      deviceId: "simlock_one",
    });

    expect(harness.runner.calls).toContainEqual({
      args: [
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-snapshot",
        "simlock_clean_baseline",
      ],
      command: binaries.emulator,
      options: emulatorOptions,
    });
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

    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() =>
      expect(harness.runner.calls).toContainEqual({
        args: ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
        options: scopedOptions,
      }),
    );
    harness.clock.advance(2_000);

    await expect(ready).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(kills).toContain("SIGKILL");
  });

  it("retries adb while the emulator is starting", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 1 });
    const ready = harness.driver.makeReady(harness.device);

    await vi.waitFor(() =>
      expect(harness.runner.calls).toContainEqual({
        args: ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
        options: scopedOptions,
      }),
    );
    harness.clock.advance(2_000);

    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

  it("invalidates stale quickboot snapshots and flags the next boot to wipe data", async () => {
    const harness = await provisionedHarness({ forReclaim: true });
    await harness.filesystem.mkdirp(`${avdDirectory}/simlock_one.avd/snapshots/default_boot`);
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/simlock_one.avd/config.ini`,
      "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a\nhw.ramSize=4096\n",
    );

    await expect(harness.driver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "shutdown",
      strategy: "wipe",
    });
    await harness.driver.makeReady(harness.device);
    await expect(
      harness.filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots`),
    ).resolves.toBe(false);
    await expect(
      harness.filesystem.exists(`${avdDirectory}/simlock_one.avd/simlock-clean-baseline.json`),
    ).resolves.toBe(true);
  });

  it("uses wipe-data and disables snapshot loading after a full reclaim", async () => {
    const harness = await provisionedHarness({ forFullCleanBoot: true });
    await harness.driver.reclaim(harness.device, { clean: "full" });

    await harness.driver.makeReady(harness.device);

    expect(harness.runner.calls).toContainEqual({
      args: [
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-wipe-data",
        "-no-snapshot-load",
      ],
      command: binaries.emulator,
      options: emulatorOptions,
    });
  });

  it("captures, validates, and restores an immutable named clean baseline", async () => {
    const harness = await provisionedHarness({ forBaselineReclaim: true });
    await harness.driver.makeReady(harness.device);

    await expect(harness.driver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "ready",
      strategy: "snapshot",
    });

    expect(harness.runner.calls).toContainEqual({
      args: ["-s", "emulator-5586", "emu", "avd", "snapshot", "load", "simlock_clean_baseline"],
      command: binaries.adb,
      options: scopedOptions,
    });
    const saves = harness.runner.calls.filter((call) => call.args.includes("save"));
    expect(saves).toHaveLength(1);
  });

  it("tags the baseline with the emulator-normalized post-boot configuration", async () => {
    const harness = await provisionedHarness({ forBaselineReclaim: true });
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/simlock_one.avd/config.ini`,
      "hw.ramSize = 2048\n",
    );

    await harness.driver.makeReady(harness.device);
    const reclaimCallStart = harness.runner.calls.length;

    await expect(harness.driver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "ready",
      strategy: "snapshot",
    });
    expect(harness.runner.calls.slice(reclaimCallStart)).not.toContainEqual({
      args: ["-s", "emulator-5586", "emu", "kill"],
      command: binaries.adb,
      options: scopedOptions,
    });
  });

  it("reclaims from persisted baseline metadata after a driver restart", async () => {
    const harness = await provisionedHarness();
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/simlock_one.avd/config.ini`,
      "hw.ramSize = 2048\n",
    );
    await harness.driver.makeReady(harness.device);

    const restartedRunner = new ScriptedProcessRunner([
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5586", "emu", "avd", "snapshot", "load", "simlock_clean_baseline"],
        "OK\n",
      ),
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
      avdPathExpectation("emulator-5586"),
      markWriteExpectation("emulator-5586", "device-0"),
    ]);
    const restartedDriver = await createDriver(harness.filesystem, restartedRunner);

    await expect(restartedDriver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "ready",
      strategy: "snapshot",
    });
  });

  it("boots a shutdown device from its persisted clean baseline after a driver restart", async () => {
    const harness = await provisionedHarness();
    await harness.driver.makeReady(harness.device);

    const restartedRunner = new ScriptedProcessRunner([
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      {
        hangs: true,
        match: {
          args: [
            "-avd",
            "simlock_one",
            "-port",
            "5586",
            "-no-snapshot-save",
            "-snapshot",
            "simlock_clean_baseline",
          ],
          command: binaries.emulator,
        },
      },
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
      avdPathExpectation("emulator-5586"),
      markWriteExpectation("emulator-5586", "device-0"),
    ]);
    const restartedDriver = await createDriver(harness.filesystem, restartedRunner);

    await expect(restartedDriver.makeReady(harness.device)).resolves.toMatchObject({
      address: "emulator-5586",
    });
    expect(restartedRunner.calls[1]).toMatchObject({
      args: [
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-snapshot",
        "simlock_clean_baseline",
      ],
      command: binaries.emulator,
    });
  });

  describe("android.emulator launch options", () => {
    const defaults: AndroidEmulatorLaunchOptions = {
      audio: true,
      bootAnimation: true,
      gpu: "auto",
      headless: false,
    };
    const emulatorLaunches = (runner: ScriptedProcessRunner) =>
      runner.calls
        .filter((call) => call.command === binaries.emulator && call.args.includes("-avd"))
        .map((call) => call.args);

    it("launches with the same arguments as before these options existed under the default config", async () => {
      for (const emulator of [undefined, defaults]) {
        const harness = await provisionedHarness(emulator === undefined ? {} : { emulator });

        await harness.driver.makeReady(harness.device);

        expect(emulatorLaunches(harness.runner)).toEqual([
          ["-avd", "simlock_one", "-port", "5586", "-no-snapshot-save", "-no-snapshot-load"],
          [
            "-avd",
            "simlock_one",
            "-port",
            "5586",
            "-no-snapshot-save",
            "-snapshot",
            "simlock_clean_baseline",
          ],
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

      const launches = emulatorLaunches(harness.runner);
      expect(launches).toHaveLength(2);
      for (const args of launches) {
        expect(args.slice(0, 5 + flags.length)).toEqual([
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...flags,
        ]);
      }
    });

    it("passes a gpu mode as -gpu <mode>, and passes nothing for auto", async () => {
      const harness = await provisionedHarness({
        emulator: { ...defaults, gpu: "swiftshader_indirect" },
        emulatorFlags: ["-gpu", "swiftshader_indirect"],
      });
      await harness.driver.makeReady(harness.device);
      expect(emulatorLaunches(harness.runner)[0]).toEqual([
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-gpu",
        "swiftshader_indirect",
        "-no-snapshot-load",
      ]);

      const auto = await provisionedHarness({ emulator: { ...defaults, gpu: "auto" } });
      await auto.driver.makeReady(auto.device);
      for (const args of emulatorLaunches(auto.runner)) {
        expect(args).not.toContain("-gpu");
      }
    });

    /**
     * A settings change reaches the driver through a daemon restart, so each case captures a
     * baseline under the default launch and then boots the device from a driver constructed with
     * the changed setting, reading the persisted baseline metadata the way a restarted daemon does.
     */
    const bootAfterRestartWith = async (
      emulator: AndroidEmulatorLaunchOptions,
      expectations: (flags: readonly string[]) => ScriptedProcessExpectation[],
      flags: readonly string[],
      capturedUnder: {
        readonly emulator?: AndroidEmulatorLaunchOptions;
        readonly emulatorFlags?: readonly string[];
      } = {},
      purpose?: "prepare" | "recover",
    ) => {
      const harness = await provisionedHarness(capturedUnder);
      await harness.driver.makeReady(harness.device);
      await harness.filesystem.mkdirp(
        `${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`,
      );
      // A recovery boot never reads the baseline hash, so it never asks the emulator's version.
      const runner = new ScriptedProcessRunner([
        ...(purpose === "recover"
          ? []
          : [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")]),
        ...expectations(flags),
        markWriteExpectation("emulator-5586", "device-0"),
      ]);
      const driver = await createDriver(harness.filesystem, runner, { emulator });
      await driver.makeReady(harness.device, purpose === undefined ? undefined : { purpose });
      return { filesystem: harness.filesystem, runner };
    };
    const rebuild = (flags: readonly string[]) =>
      baselineBuildExpectations({
        emulatorFlags: flags,
        launchArgs: ["-wipe-data", "-no-snapshot-load"],
      });
    const restore = (flags: readonly string[]): ScriptedProcessExpectation[] => [
      {
        hangs: true,
        match: {
          args: [
            "-avd",
            "simlock_one",
            "-port",
            "5586",
            "-no-snapshot-save",
            ...flags,
            "-snapshot",
            "simlock_clean_baseline",
          ],
          command: binaries.emulator,
        },
      },
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
      avdPathExpectation("emulator-5586"),
    ];

    it.each([
      ["headless", { ...defaults, headless: true }, ["-no-window"]],
      ["gpu", { ...defaults, gpu: "swiftshader_indirect" }, ["-gpu", "swiftshader_indirect"]],
    ] as const)(
      "rebuilds the clean baseline on the next boot after %s changes",
      async (_key, emulator, flags) => {
        const { filesystem, runner } = await bootAfterRestartWith(emulator, rebuild, flags);

        expect(emulatorLaunches(runner)[0]).toEqual([
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...flags,
          "-wipe-data",
          "-no-snapshot-load",
        ]);
        await expect(
          filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`),
        ).resolves.toBe(false);
        expect(runner.calls.filter((call) => call.args.includes("save"))).toHaveLength(1);
      },
    );

    it.each([
      ["audio", { ...defaults, audio: false }, ["-no-audio"]],
      ["bootAnimation", { ...defaults, bootAnimation: false }, ["-no-boot-anim"]],
    ] as const)(
      "keeps the clean baseline and boots from it after %s changes",
      async (_key, emulator, flags) => {
        const { filesystem, runner } = await bootAfterRestartWith(emulator, restore, flags);

        expect(emulatorLaunches(runner)).toEqual([
          [
            "-avd",
            "simlock_one",
            "-port",
            "5586",
            "-no-snapshot-save",
            ...flags,
            "-snapshot",
            "simlock_clean_baseline",
          ],
        ]);
        await expect(
          filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`),
        ).resolves.toBe(true);
      },
    );

    it("rebuilds the clean baseline on the next boot after gpu changes from one explicit mode to another", async () => {
      const flags = ["-gpu", "swiftshader_indirect"];
      const { filesystem, runner } = await bootAfterRestartWith(
        { ...defaults, gpu: "swiftshader_indirect" },
        rebuild,
        flags,
        { emulator: { ...defaults, gpu: "host" }, emulatorFlags: ["-gpu", "host"] },
      );

      expect(emulatorLaunches(runner)[0]).toEqual([
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        ...flags,
        "-wipe-data",
        "-no-snapshot-load",
      ]);
      await expect(
        filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`),
      ).resolves.toBe(false);
    });

    it("keeps the clean baseline after audio changes while headless stays on", async () => {
      const flags = ["-no-window", "-no-audio"];
      const { filesystem, runner } = await bootAfterRestartWith(
        { ...defaults, audio: false, headless: true },
        restore,
        flags,
        { emulator: { ...defaults, headless: true }, emulatorFlags: ["-no-window"] },
      );

      expect(emulatorLaunches(runner)).toEqual([
        [
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...flags,
          "-snapshot",
          "simlock_clean_baseline",
        ],
      ]);
      await expect(
        filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`),
      ).resolves.toBe(true);
    });

    it("keeps a clean baseline captured before android.emulator existed, so an upgrade does not wipe the device", async () => {
      // The hash the driver wrote for this exact fixture (image, emulator version, config.ini)
      // before `android.emulator` existed. Under the default launch the hash must still be
      // this value; otherwise every device's first boot after the upgrade is a data wipe.
      const hashBeforeLaunchOptionsExisted = "4e9b7a98";
      const harness = await provisionedHarness();
      await harness.driver.makeReady(harness.device);
      const metadataPath = `${avdDirectory}/simlock_one.avd/simlock-clean-baseline.json`;
      const written = JSON.parse(await harness.filesystem.readFile(metadataPath)) as {
        readonly configHash: string;
      };
      expect(written.configHash).toBe(hashBeforeLaunchOptionsExisted);

      await harness.filesystem.mkdirp(
        `${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`,
      );
      const runner = new ScriptedProcessRunner([
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ...restore([]),
        markWriteExpectation("emulator-5586", "device-0"),
      ]);
      const driver = await createDriver(harness.filesystem, runner, { emulator: defaults });
      await driver.makeReady(harness.device);

      expect(emulatorLaunches(runner)[0]).toContain("simlock_clean_baseline");
      expect(emulatorLaunches(runner)[0]).not.toContain("-wipe-data");
    });

    it("recovering a leased device after a restart boots it cold, never wiping it or loading a snapshot, even when headless changed", async () => {
      const flags = ["-no-window"];
      const coldBoot = (launchFlags: readonly string[]): ScriptedProcessExpectation[] => [
        {
          hangs: true,
          match: {
            args: [
              "-avd",
              "simlock_one",
              "-port",
              "5586",
              "-no-snapshot-save",
              ...launchFlags,
              "-no-snapshot-load",
            ],
            command: binaries.emulator,
          },
        },
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
        avdPathExpectation("emulator-5586"),
      ];
      const { filesystem, runner } = await bootAfterRestartWith(
        { ...defaults, headless: true },
        coldBoot,
        flags,
        {},
        "recover",
      );

      expect(emulatorLaunches(runner)).toEqual([
        [
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...flags,
          "-no-snapshot-load",
        ],
      ]);
      await expect(
        filesystem.exists(`${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`),
      ).resolves.toBe(true);
      expect(runner.calls.filter((call) => call.args.includes("save"))).toHaveLength(0);
      // A recovered device is re-marked like any other ready device: the mark is what proves
      // the device is still Simlock's on the next reconcile.
      expect(
        runner.calls.filter((call) => call.args.some((arg) => arg.includes("simlock-mark.json"))),
      ).toHaveLength(1);
    });
  });

  it("shuts down and deletes only the provisioned simlock AVD", async () => {
    const filesystem = await androidFilesystem({ config: "hw.ramSize=2048\n" });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_delete-me",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      {
        match: { args: ["-s", "emulator-5586", "emu", "kill"], command: binaries.adb },
        result: { code: 1, stderr: "connection refused", stdout: "" },
      },
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_delete-me"]),
    ]);
    const driver: Driver = await createDriver(filesystem, runner, { ids: ["delete-me"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    const device = await driver.provision(spec);

    await expect(driver.destroy(device)).resolves.toBeUndefined();
    expect(runner.calls.at(-1)).toMatchObject({
      args: ["delete", "avd", "-n", "simlock_delete-me"],
      command: binaries.avdmanager,
    });
  });

  it("reports conservative cold-boot estimates through the Driver contract", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new ScriptedProcessRunner([]),
    );
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;

    expect(driver.estimate({ operation: "provision" }, spec)).toBe(1_000);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(70_000);
  });

  it("prices reclaim by the strategy the clean level selects", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new ScriptedProcessRunner([]),
    );
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;

    // Both measured on an M3 Pro / Pixel 8 / API 35. The gap is real: a `wipe` reclaim defers
    // the wipe to the next `makeReady`, but the warm-pool disposition runs that boot before the
    // device leaves `reclaiming`, so the window is a cold wipe boot rather than a shutdown.
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, spec)).toBe(6_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, spec)).toBe(32_000);
  });

  it("lists resolvable models and installed API levels, defaulting to the newest", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["34", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
        ["35", "google_apis", "x86_64"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: "35",
      images: [
        { abi: "x86_64", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ],
      modelAliases: { "Pixel 8": ["pixel_8"] },
      modelRuntimes: { "Pixel 8": ["34", "35"] },
      models: ["Pixel 8"],
      runtimes: ["34", "35"],
    });
  });

  it("pairs every model with every installed API level, including one whose only image has a foreign ABI", async () => {
    // The host is arm64-v8a; API 33 is installed only as x86_64.
    const filesystem = await androidFilesystem({
      images: [
        ["33", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9"]);
    expect(catalog.modelRuntimes).toEqual({ "Pixel 8": ["33", "35"], "Pixel 9": ["33", "35"] });
  });

  it("resolves every pair listCatalog lists", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["33", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
      ],
    });
    const runner = new ScriptedProcessRunner(
      Array.from({ length: 5 }, () =>
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ),
    );
    const driver = await createDriver(filesystem, runner);
    const catalog = await driver.listCatalog();
    const pairs = Object.entries(catalog.modelRuntimes).flatMap(([model, runtimes]) =>
      runtimes.map((osVersion) => ({ model, osVersion })),
    );
    expect(pairs).toHaveLength(4);

    for (const { model, osVersion } of pairs) {
      await expect(driver.resolveSpec({ model, osVersion, platform: "android" })).resolves.toEqual({
        model,
        osVersion,
        platform: "android",
      });
    }
  });

  it("reports no default runtime and no installed API levels without system images", async () => {
    const filesystem = await androidFilesystem({ images: [] });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: undefined,
      images: [],
      modelAliases: { "Pixel 8": ["pixel_8"] },
      modelRuntimes: { "Pixel 8": [] },
      models: ["Pixel 8"],
      runtimes: [],
    });
  });

  it("never downloads a system image while listing the catalog", async () => {
    const filesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await driver.listCatalog();

    expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
  });

  it("lists a built-in profile's avdmanager id as another name for its model", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.modelAliases).toEqual({ "Pixel 8": ["pixel_8"], "Pixel 9": ["pixel_9"] });
  });

  it("lists no other name when the id equals the display name ignoring case", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(
        binaries.avdmanager,
        ["list", "device"],
        `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n---------\n` +
          `id: 1 or "Automotive_1024p"\n    Name: automotive_1024p\n`,
      ),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "automotive_1024p"]);
    expect(catalog.modelAliases).toEqual({ "Pixel 8": ["pixel_8"] });
  });

  it("resolves every listed name of every listed model, in upper and lower case, to that model", async () => {
    const filesystem = await androidFilesystem();
    await writeDevicesXml(filesystem, customDeviceXml("My Tablet", 4096));
    const runner = new ScriptedProcessRunner(
      Array.from({ length: 11 }, () =>
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ),
    );
    const driver = await createDriver(filesystem, runner);
    const catalog = await driver.listCatalog();
    const names = catalog.models.flatMap((model) => [
      { model, name: model },
      ...(catalog.modelAliases[model] ?? []).map((name) => ({ model, name })),
    ]);
    expect(names).toHaveLength(5);

    for (const { model, name } of names) {
      for (const spelling of [name.toUpperCase(), name.toLowerCase()]) {
        await expect(driver.resolveSpec({ model: spelling, platform: "android" })).resolves.toEqual(
          { model, osVersion: "34", platform: "android" },
        );
      }
    }
  });

  it("lists the same models as before other names were listed, for the same profiles", async () => {
    // A devices.xml profile named after a built-in id stays listed, and one whose name repeats a
    // built-in name in other letter case does not: both exactly as before this catalog listed
    // other names.
    const filesystem = await androidFilesystem();
    await writeDevicesXml(
      filesystem,
      customDeviceXml("pixel_8", 4096) +
        customDeviceXml("PIXEL 9", 4096) +
        customDeviceXml("My Tablet", 4096),
    );
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9", "pixel_8", "My Tablet"]);
    expect(Object.keys(catalog.modelRuntimes)).toEqual(catalog.models);
  });

  it("marks a model that comes only from devices.xml as custom, and no built-in model", async () => {
    const filesystem = await androidFilesystem();
    await writeDevicesXml(filesystem, customDeviceXml("My Tablet", 4096));
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9", "My Tablet"]);
    expect(catalog.customModels).toEqual(["My Tablet"]);
  });

  it("has no customModels field when there is no custom profile", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9"]);
    expect(catalog).not.toHaveProperty("customModels");
  });

  it("lists the built-in models and no customModels field when devices.xml cannot be parsed", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${home}/.android`);
    await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9"]);
    expect(catalog).not.toHaveProperty("customModels");
  });

  it("lists models with one avdmanager run", async () => {
    // A second answer is scripted, so a second run would be served and counted, not refused.
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual(["Pixel 8", "Pixel 9"]);
    expect(catalog.modelAliases).toEqual({ "Pixel 8": ["pixel_8"], "Pixel 9": ["pixel_9"] });
    expect(runner.calls.filter((call) => call.command === binaries.avdmanager)).toHaveLength(1);
  });

  it("lists every installed system image with its API level, tag, and ABI, a foreign-ABI image included", async () => {
    // The host is arm64-v8a; the API 33 image is x86_64 only.
    const filesystem = await androidFilesystem({
      images: [
        ["35", "google_apis_playstore", "arm64-v8a"],
        ["33", "default", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.images).toEqual([
      { abi: "x86_64", runtime: "33", tag: "default" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis_playstore" },
    ]);
    expect(catalog.runtimes).toEqual(["33", "35"]);
  });

  it("lists images by API level, then tag, then ABI, whatever order the disk returns them in", async () => {
    // Directory listings come back in reverse, so a list read straight off the disk would be in
    // exactly the wrong order at every level.
    const filesystem = await androidFilesystem(
      {
        images: [
          ["9", "google_apis", "x86_64"],
          ["10", "default", "x86_64"],
          ["10", "google_apis", "arm64-v8a"],
          ["10", "google_apis", "x86_64"],
        ],
      },
      new ReversedReaddirFilesystem(),
    );
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.images).toEqual([
      { abi: "x86_64", runtime: "9", tag: "google_apis" },
      { abi: "x86_64", runtime: "10", tag: "default" },
      { abi: "arm64-v8a", runtime: "10", tag: "google_apis" },
      { abi: "x86_64", runtime: "10", tag: "google_apis" },
    ]);
  });

  it("does not list a dot entry under system-images as a tag or an ABI", async () => {
    const filesystem = await androidFilesystem({ images: [["34", "google_apis", "arm64-v8a"]] });
    await filesystem.writeFileAtomic(`${sdk}/system-images/android-34/.DS_Store`, "");
    await filesystem.writeFileAtomic(`${sdk}/system-images/android-34/google_apis/.DS_Store`, "");
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }]);
  });

  it("does not list an image that is not installed, even one sdkmanager offers", async () => {
    // Only API 34 is installed. An API 35 image is one `sdkmanager` run away, and the driver
    // would install it for a lease that allows downloads; the catalog never asks `sdkmanager`
    // and lists the image on disk only. That no download policy reaches `listCatalog` is
    // proved in the dispatcher's tests.
    const filesystem = await androidFilesystem({ images: [["34", "google_apis", "arm64-v8a"]] });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(
        binaries.sdkmanager,
        ["--list"],
        "Available Packages:\n  system-images;android-35;google_apis;arm64-v8a | 1 | Google APIs\n",
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "34", tag: "google_apis" }]);
    expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
  });

  it("joins adb devices with getprop to compute runState per AVD: running, stopped, transitioning", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_running.avd`);
    await filesystem.mkdirp(`${avdDirectory}/simlock_stopped.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; cat /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        "simlock_running\n",
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(
      [...reality.devices]
        .map((device) => ({ deviceId: device.deviceId, runState: device.runState }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
    ).toEqual([
      { deviceId: "simlock_running", runState: "running" },
      { deviceId: "simlock_stopped", runState: "stopped" },
    ]);
    expect(reality.processes).toEqual([expect.objectContaining({ deviceId: "simlock_running" })]);
  });

  it("treats an otherwise-stopped AVD as transitioning when an unattributable transitional serial is present", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(
        binaries.adb,
        ["devices"],
        "List of devices attached\nemulator-5588\toffline\n",
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_idle", runState: "transitioning" }),
    ]);
    // Only settled `device`-state serials are counted as running processes; the
    // unattributable offline serial never appears here regardless of the AVD fallback above.
    expect(reality.processes).toEqual([]);
  });

  it("still resolves a stopped AVD as stopped when adb reports no serials at all", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_idle", runState: "stopped" }),
    ]);
  });

  it("rewrites the mark on makeReady's early-return branch without duplicating the config.ini line", async () => {
    const filesystem = await androidFilesystem({ config: "hw.ramSize=2048\n" });
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_one",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ...baselineBuildExpectations({ launchArgs: ["-no-snapshot-load"] }),
      markWriteExpectation("emulator-5586", "device-2"),
      // Second makeReady call: `state.handle` is still set from the first call, so this takes
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
      avdPathExpectation("emulator-5586"),
      markWriteExpectation("emulator-5586", "device-3"),
    ]);
    const driver = await createDriver(filesystem, runner, { clock, ids: ["one"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    const device = await driver.provision(spec);

    await driver.makeReady(device);
    await driver.makeReady(device);

    const config = await filesystem.readFile(`${avdDirectory}/simlock_one.avd/config.ini`);
    expect(config.split(/\r?\n/).filter((line) => line.startsWith("simlock.mark="))).toEqual([
      "simlock.mark=device-3",
    ]);
    expect(config).toContain("hw.ramSize=2048");
  });

  it("rethrows a non-missing-file config.ini read error from the mark write instead of clobbering it as empty", async () => {
    const configPath = `${avdDirectory}/simlock_one.avd/config.ini`;
    const originalConfig = "hw.ramSize=2048\n";
    const permissionError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const failureFilesystem = new ReadFailureFilesystem(configPath, permissionError);
    const filesystem = await androidFilesystem({ config: originalConfig }, failureFilesystem);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_one",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ...baselineBuildExpectations({ launchArgs: ["-no-snapshot-load"] }),
      markWriteExpectation("emulator-5554", "device-2"),
    ]);
    const driver = await createDriver(filesystem, runner, { ids: ["one"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    const device = await driver.provision(spec);

    await expect(driver.makeReady(device)).rejects.toBe(permissionError);

    failureFilesystem.armed = false;
    await expect(filesystem.readFile(configPath)).resolves.toBe(originalConfig);
  });

  it("rewrites the mark on reclaim's snapshot-restore success path", async () => {
    const harness = await provisionedHarness({ forBaselineReclaim: true });
    await harness.driver.makeReady(harness.device);

    await harness.driver.reclaim(harness.device, { clean: "standard" });

    const config = await harness.filesystem.readFile(`${avdDirectory}/simlock_one.avd/config.ini`);
    expect(config).toContain("simlock.mark=device-3");
    expect(harness.runner.calls).toContainEqual(
      expect.objectContaining({
        args: markWriteExpectation("emulator-5586", "device-3").match.args,
      }),
    );
  });

  it("does not change the config hash when simlock.mark is present in config.ini", async () => {
    const withoutMark = await androidFilesystem({ config: "hw.ramSize=2048\n" });
    const withMark = await androidFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=some-token\n",
    });
    const buildExpectations = (): ScriptedProcessExpectation[] => [
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "simlock_one",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ];
    const driverA = await createDriver(
      withoutMark,
      new ScriptedProcessRunner(buildExpectations()),
      {
        ids: ["one"],
      },
    );
    const driverB = await createDriver(withMark, new ScriptedProcessRunner(buildExpectations()), {
      ids: ["one"],
    });
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;
    await driverA.resolveSpec(spec);
    await driverB.resolveSpec(spec);

    const deviceA = await driverA.provision(spec);
    const deviceB = await driverB.provision(spec);

    expect((deviceA.driverData as { configHash: string }).configHash).toBe(
      (deviceB.driverData as { configHash: string }).configHash,
    );
  });

  it("listManaged reports matching durable and erasable marks for a running device", async () => {
    const filesystem = await androidFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; cat /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        'simlock_one\n{"token":"tok-123"}',
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: "tok-123",
      erasableReadable: true,
    });
  });

  it("listManaged reports an erased running device when the erasable mark file is gone", async () => {
    const filesystem = await androidFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; cat /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        "simlock_one\n",
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: true,
    });
  });

  it("keeps listManaged alive when a serial dies between the scan and the read", async () => {
    const filesystem = await androidFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      {
        match: {
          args: [
            "-s",
            "emulator-5586",
            "shell",
            "getprop ro.boot.qemu.avd_name; cat /data/local/tmp/simlock-mark.json 2>/dev/null || true",
          ],
          command: binaries.adb,
        },
        result: { code: 1, stderr: "device 'emulator-5586' not found", stdout: "" },
      },
    ]);
    const driver = await createDriver(filesystem, runner);

    // An emulator can vanish between `adb devices` and the read. Losing the whole
    // reality view over one dead serial would strand every other managed device.
    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.runState).toBe("transitioning");
    // The durable half is a host file and stays readable; the erasable half genuinely
    // was not read, so it must report unreadable rather than absent -- absent would
    // classify as a foreign erase.
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: false,
    });
  });

  it("listManaged reports erasableReadable: false for a stopped, marked device", async () => {
    const filesystem = await androidFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: false,
    });
  });

  it("listManaged reports no mark for a stopped, pre-existing AVD with no durable key (upgrade path)", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_legacy.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_legacy");
    expect(device?.mark).toBeUndefined();
  });

  describe("device-profile sources", () => {
    it("resolves a devices.xml-only model and applies its properties to config.ini before the config hash is captured", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(filesystem, customDeviceXml("Custom A", 4096));
      // `avdmanager create avd` is scripted (not a real process), so it never creates the AVD
      // directory the way it would for real -- seed it here the same way, since applying
      // hardware properties to config.ini right after create relies on that directory existing.
      await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, [
          "create",
          "avd",
          "-n",
          "simlock_one",
          "-k",
          /.+/,
          "-d",
          "pixel_8",
        ]),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });

      const spec = await driver.resolveSpec({
        model: "Custom A",
        osVersion: "34",
        platform: "android",
      });
      expect(spec).toEqual({ model: "Custom A", osVersion: "34", platform: "android" });

      const device = await driver.provision(spec);

      const config = await filesystem.readFile(`${avdDirectory}/simlock_one.avd/config.ini`);
      expect(config).toContain("hw.device.name=Custom A");
      expect(config).toContain("hw.ramSize=4096");
      // The avdmanager `-d` seed uses a built-in device only to skip the interactive prompt --
      // it must never leak into the resolved spec or the applied hardware properties.
      expect(config).not.toContain("pixel_8");
      expect(device.driverData).toMatchObject({ avdName: "simlock_one" });
    });

    it("captures differing hardware properties in the config hash, proving they land before it is computed", async () => {
      const buildHarness = async (ramMiB: number) => {
        const filesystem = await androidFilesystem();
        await writeDevicesXml(filesystem, customDeviceXml("Custom A", ramMiB));
        await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
        const runner = new ScriptedProcessRunner([
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.avdmanager, [
            "create",
            "avd",
            "-n",
            "simlock_one",
            "-k",
            /.+/,
            "-d",
            "pixel_8",
          ]),
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
          processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ]);
        const driver = await createDriver(filesystem, runner, { ids: ["one"] });
        const spec = await driver.resolveSpec({
          model: "Custom A",
          osVersion: "34",
          platform: "android",
        });
        return driver.provision(spec);
      };

      const lowRam = await buildHarness(2048);
      const highRam = await buildHarness(4096);

      expect((lowRam.driverData as { configHash: string }).configHash).not.toBe(
        (highRam.driverData as { configHash: string }).configHash,
      );
    });

    it("shadows a devices.xml profile with a built-in one of the same name and never applies properties", async () => {
      const filesystem = await androidFilesystem();
      // Same name as the built-in fixture's "Pixel 8" -- the built-in source is registered
      // first, so it must win and the devices.xml properties must never be touched.
      await writeDevicesXml(filesystem, customDeviceXml("Pixel 8", 4096));
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, [
          "create",
          "avd",
          "-n",
          "simlock_one",
          "-k",
          /.+/,
          "-d",
          "pixel_8",
        ]),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });

      const spec = await driver.resolveSpec({
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      // Only one `avdmanager list device` call happened (asserted implicitly by the runner
      // never receiving the unscripted second call a `properties`-profile seed lookup would
      // require), and no properties were merged into config.ini -- it was never even written.
      await expect(filesystem.exists(`${avdDirectory}/simlock_one.avd/config.ini`)).resolves.toBe(
        false,
      );
    });

    it("rejects a hardware-property value with an embedded line break, defense in depth beyond the devices.xml parser", async () => {
      // `UserDeviceProfileSource`/`parseDevicesXml` already reject this at the devices.xml parse
      // boundary (see device-profile-source.test.ts), but `DeviceProfileSource` is a documented
      // extension point (see the interface's own doc comment) -- a future or third-party source
      // could hand the driver a multiline value directly, bypassing that parser entirely. This
      // exercises `#mergeConfigIniLines`'s own independent guard by going around the parser with
      // a custom source, standing in for `<d:manufacturer>Google\ndisk.dataPartition.path=/evil
      // </d:manufacturer>`.
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, [
          "create",
          "avd",
          "-n",
          "simlock_one",
          "-k",
          /.+/,
          "-d",
          "pixel_8",
        ]),
      ]);
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
      await recordRunningAdbServer(filesystem, adbServerPort);
      const driver = await AndroidDriver.create({
        clock: new FakeClock(),
        deviceProfileSources: [maliciousSource],
        driverConfig: {},
        env: { ANDROID_HOME: sdk },
        filesystem,
        homeDirectory: home,
        hostAbi: "arm64-v8a",
        idGenerator: { generate: () => "one" },
        instanceId,
        processRunner: runner,
        // Adopt the recorded server `recordRunningAdbServer` just wrote, exactly as the
        // shared `createDriver` helper does: this test is about hardware properties, and
        // starting a real supervised server is not part of what it exercises. `simlockHome`
        // has to be the real one too -- under `home` the AVD root would not be
        // `avdDirectory`, and the assertion below would pass without proving anything.
        processSupervisor: new FakeProcessSupervisor([adbServerPid]),
        simlockHome,
        tcpProbe: new FakeTcpProbe([adbServerPort]),
      });

      const spec = await driver.resolveSpec({
        model: "Evil Phone",
        osVersion: "34",
        platform: "android",
      });

      await expect(driver.provision(spec)).rejects.toThrow(/line break/);
      // The rejected merge must never have reached the filesystem at all.
      await expect(filesystem.exists(`${avdDirectory}/simlock_one.avd/config.ini`)).resolves.toBe(
        false,
      );
    });

    it("surfaces malformed devices.xml as a diagnostic and falls through to UnknownModelError, never throwing from the parse itself", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${home}/.android`);
      await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(
        driver.resolveSpec({ model: "Nonexistent Model", osVersion: "34", platform: "android" }),
      ).rejects.toMatchObject({ name: "UnknownModelError" });

      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: "device-profile-source-unreadable" }),
      ]);
    });
  });

  describe("Android SDK license handling", () => {
    const licenseNotAcceptedOutput =
      "Warning: License for package Android SDK Platform 35 not accepted.\n\n" +
      "1 package(s) were skipped due to license issues. Please accept the license(s) and try " +
      "again.\nTo resolve, run: sdkmanager --licenses\n";

    it("fails naming downloads.acceptAndroidLicenses when licenses are unaccepted and the flag is off", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await installFor(driver, "35").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AndroidLicenseNotAcceptedError);
      expect((error as Error).message).toContain("downloads.acceptAndroidLicenses");
      expect((error as Error).message).toContain("sdkmanager --licenses");
    });

    it("recognizes the alternate 'licenses have not been accepted' sdkmanager phrasing, not just 'not accepted'", async () => {
      // The two documented sdkmanager phrasings this driver's license detection claims to
      // handle (see the comment on `hasUnacceptedLicense`): a per-package warning ("... not
      // accepted.") and this one, an aggregate summary with "been" between "not" and "accepted".
      const licensesHaveNotBeenAcceptedOutput =
        "1 of 7 SDK package license(s) not accepted.\n" +
        "Review licenses that have not been accepted (see above)\n" +
        "The licenses have not been accepted.\n";
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licensesHaveNotBeenAcceptedOutput },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await installFor(driver, "35").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AndroidLicenseNotAcceptedError);
    });

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
      // Exactly one retry: install, licenses, install again -- never a second acceptance pass.
      expect(runner.calls.filter((call) => call.args[0] === "--install")).toHaveLength(2);
    });

    it("still fails when the install is rejected again after accepting licenses", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
        },
        processResult(binaries.sdkmanager, ["--licenses"], "All licenses accepted.\n"),
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "still refusing", stdout: "" },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: true });

      await expect(installFor(driver, "35")).rejects.toMatchObject({ name: "DriverCrashError" });
    });
  });

  describe("component install", () => {
    const package35 = "system-images;android-35;google_apis;arm64-v8a";

    it("installs the google_apis image for the host ABI with no timeout of its own, and reports it installed with its package, revision and stamp", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [processResult(binaries.sdkmanager, ["--install", package35])],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);

      const result = await installFor(driver, "35");

      expect(result).toEqual({
        outcome: "installed",
        receipt: { package: package35, revision: "1", stamp: expect.stringMatching(/^.+@\d+$/) },
        version: "35",
      });
      expect(runner.calls.find((call) => call.args[0] === "--install")?.options).toEqual({
        lineEnd: "carriage-return-too",
      });
    });

    it("reports already-installed when the image was there before sdkmanager ran", async () => {
      const filesystem = await androidFilesystem({
        images: [["35", "google_apis", "arm64-v8a"]],
      });
      const runner = new ScriptedProcessRunner([
        processResult(binaries.sdkmanager, ["--install", package35]),
      ]);
      const driver = await createDriver(filesystem, runner);

      await expect(installFor(driver, "35")).resolves.toMatchObject({
        outcome: "already-installed",
        version: "35",
      });
    });

    it("gives two installs of one package, with an uninstall between them, different receipts", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.sdkmanager, ["--install", package35]),
          processResult(binaries.sdkmanager, ["--install", package35]),
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);

      const first = await installFor(driver, "35");
      await filesystem.rm(`${sdk}/system-images/android-35`);
      const second = await installFor(driver, "35");

      expect(first.outcome).toBe("installed");
      expect(second.outcome).toBe("installed");
      expect(second.receipt).not.toEqual(first.receipt);
    });

    it("fails when sdkmanager exits 0 but the image is still not installed", async () => {
      const filesystem = await androidFilesystem();
      // A plain ScriptedProcessRunner: sdkmanager claims success, and nothing lands on disk.
      const runner = new ScriptedProcessRunner([
        processResult(binaries.sdkmanager, ["--install", package35]),
      ]);
      const driver = await createDriver(filesystem, runner);

      const error = await installFor(driver, "35").catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        message: expect.stringContaining(`${package35} is still not installed`),
        name: "DriverCrashError",
      });
    });

    it("fails with sdkmanager's own output when the install is rejected outright", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: { args: ["--install", package35], command: binaries.sdkmanager },
          result: { code: 1, stderr: "no network", stdout: "" },
        },
      ]);
      const driver = await createDriver(filesystem, runner);

      await expect(installFor(driver, "35")).rejects.toMatchObject({
        message: expect.stringContaining("no network"),
        name: "DriverCrashError",
      });
    });

    it("reports each percentage sdkmanager prints as progress, and nothing for a line without one", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          {
            ...processResult(binaries.sdkmanager, ["--install", package35]),
            stdoutLines: [
              "[=====      ] 25% Downloading x86_64-35_r09.zip...",
              "Unzipping",
              "[===========] 100% Unzipping...",
            ],
          },
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);
      const progress: unknown[] = [];

      await installFor(driver, "35", { onProgress: (report) => progress.push(report) });

      expect(progress).toEqual([
        { percent: 25, stage: "downloading" },
        { percent: 100, stage: "downloading" },
      ]);
    });

    it.each([
      ["the install", ["--install", package35]],
      ["the license step", ["--licenses"]],
    ] as const)("ends %s when the signal fires, and fails the install", async (_step, hanging) => {
      const filesystem = await androidFilesystem();
      const licenseRefusal = {
        match: { args: ["--install", package35], command: binaries.sdkmanager },
        result: {
          code: 1,
          stderr: "",
          stdout: "Warning: License for package Android SDK Platform 35 not accepted.\n",
        },
      };
      const runner = new ScriptedProcessRunner([
        ...(hanging[0] === "--licenses" ? [licenseRefusal] : []),
        { hangs: true, match: { args: [...hanging], command: binaries.sdkmanager } },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: true });
      const controller = new AbortController();

      let error: unknown;
      void installFor(driver, "35", { signal: controller.signal }).catch((caught: unknown) => {
        error = caught;
      });
      const spawned = hanging[0] === "--licenses" ? 2 : 1;
      for (let tick = 0; tick < 100 && runner.handles.length < spawned; tick += 1) {
        await Promise.resolve();
      }
      expect(runner.handles).toHaveLength(spawned);
      controller.abort();
      for (let tick = 0; tick < 50 && error === undefined; tick += 1) {
        await Promise.resolve();
      }

      // Settled within a few microtasks of the signal: the kill ended it, not a timer.
      expect(error).toMatchObject({
        message: expect.stringContaining("was ended before it finished"),
        name: "DriverCrashError",
      });
    });

    it("finds the image an API level means with its receipt, and nothing for a level that is not installed", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.writeFileAtomic(
        `${sdk}/system-images/android-34/google_apis/arm64-v8a/source.properties`,
        "Pkg.Revision=7\n",
      );
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(filesystem, runner);

      await expect(driver.findComponent("34")).resolves.toEqual({
        receipt: {
          package: "system-images;android-34;google_apis;arm64-v8a",
          revision: "7",
          stamp: expect.stringMatching(/^.+@\d+$/),
        },
        version: "34",
      });
      await expect(driver.findComponent("35")).resolves.toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it("states 2 GiB on the SDK root as the footprint of one install", async () => {
      const filesystem = await androidFilesystem();
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

      expect(driver.componentFootprint).toEqual({ bytes: 2 * 1024 ** 3, path: sdk });
    });
  });
});

describe("AndroidDriver.create", () => {
  it("creates and marks its own AVD home under SIMLOCK_HOME when none exists yet", async () => {
    const filesystem = await androidFilesystem({ withDeviceRoot: false });
    await recordRunningAdbServer(filesystem);

    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

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

    await expect(createDriver(filesystem, new ScriptedProcessRunner([]))).rejects.toMatchObject({
      name: "OwnedRootError",
      reason: "wrong-instance",
    });
  });

  it("refuses a deviceRoot that is not a path at all, costing android and not the daemon", async () => {
    const filesystem = await androidFilesystem({ withDeviceRoot: false });

    const refusal = await createDriver(filesystem, new ScriptedProcessRunner([]), {
      driverConfig: { deviceRoot: true },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(OwnedRootError);
    expect(refusal).toMatchObject({ platform: "android", reason: "not-absolute" });
  });

  it("refuses an adbServerPort that is not a port number", async () => {
    const filesystem = await androidFilesystem();

    const refusal = await createDriver(filesystem, new ScriptedProcessRunner([]), {
      driverConfig: { adbServerPort: "5038" },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AdbServerUnavailableError);
    expect(refusal).toMatchObject({ reason: "invalid-port" });
  });

  it("refuses to attach to a server on its port that it has no record of starting", async () => {
    const filesystem = await androidFilesystem();

    const refusal = await AndroidDriver.create({
      clock: new FakeClock(),
      driverConfig: {},
      env: { ANDROID_HOME: sdk },
      filesystem,
      homeDirectory: home,
      hostAbi: "arm64-v8a",
      instanceId,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome,
      // Listening, but nothing says it is Simlock's -- it could be Android Studio's.
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ port: adbServerPort, reason: "occupied" });
  });

  it("hands a lease holder the adb server port, and scopes its own calls to a configured one", async () => {
    const filesystem = await androidFilesystem();
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner, {
      driverConfig: { adbServerPort: 5199 },
    });

    expect(driver.leaseEnvironment()).toEqual({ ANDROID_ADB_SERVER_PORT: "5199" });
    await driver.resolveSpec({ model: "Pixel 8", platform: "android" });
    expect(runner.calls[0]?.options).toEqual({
      env: { ...scopedEnv, ANDROID_ADB_SERVER_PORT: "5199" },
    });
  });

  it("points an adb passthrough at Simlock's own server, which is the only one that sees it", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(driver.passthrough(["shell", "input", "tap", "100", "200"])).toEqual({
      args: ["-P", String(adbServerPort), "shell", "input", "tap", "100", "200"],
      command: binaries.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(adbServerPort) },
    });
  });

  it("refuses kill-server, which would detach every leased emulator at once", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["kill-server"])).toThrow(PassthroughRefusedError);
    expect(() => driver.passthrough(["kill-server"])).toThrow(/simlock release/);
  });

  it("refuses kill-server behind a global flag, not only in first position", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    // Every other case passes it first, so an `args[0] === "kill-server"` rule would pass
    // them all; this is the one that holds the documented "anywhere in the arguments".
    expect(() => driver.passthrough(["-P", "1", "kill-server"])).toThrow(PassthroughRefusedError);
  });

  it.each([[["emu", "avd", "stop"]], [["-s", "emulator-5586", "emu", "avd", "stop"]]])(
    "refuses an emu avd stop that would stop a device Simlock believes is running: %j",
    async (args) => {
      const filesystem = await androidFilesystem();
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

      expect(() => driver.passthrough(args)).toThrow(PassthroughRefusedError);
      expect(() => driver.passthrough(args)).toThrow(/simlock release/);
    },
  );

  it("refuses to delete the snapshot every later reclaim restores from", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["emu", "avd", "snapshot", "delete", "default_boot"])).toThrow(
      PassthroughRefusedError,
    );
    expect(() => driver.passthrough(["emu", "avd", "snapshot", "delete", "default_boot"])).toThrow(
      /full wipe/,
    );
  });

  it("still proxies the snapshot operations that do not destroy the baseline", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(driver.passthrough(["emu", "avd", "snapshot", "list"]).args).toContain("list");
  });

  it("refuses an emu kill pair even behind the -s serial that targets a device", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["-s", "emulator-5586", "emu", "kill"])).toThrow(
      PassthroughRefusedError,
    );
    expect(() => driver.passthrough(["-s", "emulator-5586", "emu", "kill"])).toThrow(
      /simlock cleanup/,
    );
  });

  it("refuses a caller-supplied server flag in the globals, in every spelling adb accepts, and any global it does not recognize", async () => {
    // `adb` takes the *last* `-P` on the line, so a caller-supplied one silently wins over the
    // one this driver inserts and the command lands on whatever server that names -- the
    // machine's default one included, which is outside Simlock's containment entirely (safety
    // rule 9). Same hole `--set`/`--profiles` closes on the iOS side, same answer.
    //
    // The attached spellings matter most: adb parses `-P` with `strncmp(argv[0], "-P", 2)`, so
    // `-P5037` is a normal way to write it, and a whole-word check would have refused the
    // separated form while passing the one that actually escapes.
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    for (const args of [
      ["-P", "5037", "devices"],
      ["-P5037", "devices"],
      ["-P=5037", "devices"],
      ["--server-port", "5037", "devices"],
      ["-H", "other-host", "devices"],
      ["-Hother-host", "devices"],
      ["-L", "tcp:127.0.0.1:5037", "devices"],
      ["-s", "emulator-5554", "-P5037", "shell", "getprop"],
      // `--reply-fd` is a real, value-taking adb global absent from `adb --help` (confirmed
      // against the adb binary: it errors `--reply-fd requires an argument`, not `unknown
      // command`). A scanner that assumes an unrecognized flag takes no value reads its value
      // (`9`) as the subcommand and never notices the `-H`/`-P` that follow -- the exact
      // bypass this allow-list scan closes by refusing anything it does not recognize.
      ["--reply-fd", "9", "-H", "attacker.example", "-P", "5037", "shell", "id"],
      // Other real adb globals this driver has no reason to allow through, none of which may
      // silently terminate the scan either: an unrecognized flag is refused on sight, not
      // treated as ending the globals region.
      ["-a", "devices"],
      ["--exit-on-write-error", "devices"],
      ["--one-device", "usb:1", "devices"],
      // A wholly invented flag stands in for "the next adb release adds one": this list must
      // refuse what it has never seen, not just what it already knows to refuse.
      ["--not-a-real-adb-flag", "devices"],
    ]) {
      expect(() => driver.passthrough(args), args.join(" ")).toThrow(PassthroughRefusedError);
      expect(() => driver.passthrough(args, { hasTerminal: false }), args.join(" ")).toThrow(
        /supplies the adb server itself/,
      );
    }

    // Past the subcommand every argument is that subcommand's operand, so one that merely
    // looks like a global travels through: refusing `echo -Please` would break a working
    // command to prevent nothing.
    for (const args of [
      ["shell", "echo", "-Please"],
      ["shell", "getprop", "-P5037"],
      ["-s", "emulator-5554", "devices"],
      // `-t` is allowed in both spellings adb accepts: separate, and fused like `-P`/`-H`.
      ["-t", "1", "devices"],
      ["-t1", "devices"],
      ["-d", "devices"],
      ["-e", "devices"],
      // `--version` and `--help` answer on their own before adb ever looks for a subcommand,
      // so this scan treats them as the subcommand rather than as a global with an arity.
      ["--version"],
      ["--help"],
    ]) {
      expect(driver.passthrough(args).args, args.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...args,
      ]);
    }
  });

  it("refuses `--version`/`--help` with a tail, rather than treating them as ending the globals scan unconditionally", async () => {
    // adb answers `--version`/`--help` and exits without ever looking at the rest of the line
    // (confirmed against real adb: it prints the version and exits 0), so this scan has no way
    // to vouch for anything after one -- and must not wave it through on the strength of an
    // action that is safe only alone. Hardening item from round 4: verified ALLOWED before this
    // fix, letting a caller-supplied `-P`/`-H` ride past unchecked behind either flag.
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    for (const args of [
      ["--version", "-P", "5037", "shell", "id"],
      ["--help", "-H", "evil", "shell", "id"],
    ]) {
      expect(() => driver.passthrough(args), args.join(" ")).toThrow(PassthroughRefusedError);
      expect(() => driver.passthrough(args), args.join(" ")).toThrow(
        /supplies the adb server itself/,
      );
    }

    // Alone, either is still the self-answering command it always was.
    expect(driver.passthrough(["--version"]).args).toEqual([
      "-P",
      String(adbServerPort),
      "--version",
    ]);
    expect(driver.passthrough(["--help"]).args).toEqual(["-P", String(adbServerPort), "--help"]);
  });

  it("refuses a bare `adb shell` only where the caller has no terminal, never merely because `shell` is the last word", async () => {
    // ADR 0005 §19c: `device.exec` runs the command on this machine with pipes and no pty, so
    // an interactive shell there is a process reading a pipe nothing will ever write to --
    // it would hang until `exec.timeoutMs` killed it. Locally, where the CLI hands the tool
    // its own tty, it is exactly the command a lease holder wants, so it stays allowed.
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(() => driver.passthrough(["shell"], { hasTerminal: false })).toThrow(
      PassthroughRefusedError,
    );
    expect(() => driver.passthrough(["shell"], { hasTerminal: false })).toThrow(/terminal/);
    expect(() =>
      driver.passthrough(["-s", "emulator-5586", "shell"], { hasTerminal: false }),
    ).toThrow(PassthroughRefusedError);

    // A shell with something to run is not the interactive shell, and neither is anything
    // else -- the refusal is about the missing command, not about `shell`. Round 4, F2: this
    // is the case the naive "does the line end in the word `shell`" check got wrong -- every
    // one of these genuinely ends in `shell`, but as an operand of an earlier subcommand
    // (`shell`, `push`), never as the bare subcommand itself, so none of them is the
    // interactive shell this refusal exists for.
    expect(driver.passthrough(["shell", "getprop"], { hasTerminal: false }).args).toEqual([
      "-P",
      String(adbServerPort),
      "shell",
      "getprop",
    ]);
    expect(driver.passthrough(["devices"], { hasTerminal: false }).args).toContain("devices");
    for (const args of [
      ["shell", "echo", "shell"],
      ["shell", "input", "text", "shell"],
      ["shell", "shell"],
      ["push", "./x", "shell"],
    ]) {
      expect(driver.passthrough(args, { hasTerminal: false }).args, args.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...args,
      ]);
    }

    // And with a terminal (the local `simlock adb shell`, and the default when nothing says
    // otherwise) it is proxied like any other command.
    expect(driver.passthrough(["shell"], { hasTerminal: true }).args).toEqual([
      "-P",
      String(adbServerPort),
      "shell",
    ]);
    expect(driver.passthrough(["shell"]).args).toContain("shell");
  });

  it("proxies the emu subcommands that do not stop a device", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect(driver.passthrough(["emu", "avd", "name"]).args).toEqual([
      "-P",
      String(adbServerPort),
      "emu",
      "avd",
      "name",
    ]);
  });

  it("stops the adb server it adopted when the daemon disposes of it", async () => {
    const filesystem = await androidFilesystem();
    const processSupervisor = new FakeProcessSupervisor([adbServerPid]);
    await recordRunningAdbServer(filesystem);
    const driver = await AndroidDriver.create({
      clock: new FakeClock(),
      driverConfig: {},
      env: { ANDROID_HOME: sdk },
      filesystem,
      homeDirectory: home,
      hostAbi: "arm64-v8a",
      instanceId,
      processRunner: new ScriptedProcessRunner([
        {
          match: { args: ["-o", "args=", "-p", String(adbServerPid)], command: "ps" },
          result: {
            code: 0,
            stderr: "",
            stdout: `${binaries.adb} -P ${adbServerPort} nodaemon server\n`,
          },
        },
      ]),
      processSupervisor,
      simlockHome,
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    });
    processSupervisor.markDead(adbServerPid);

    await driver.dispose();

    // By pid, because `ADB_REJECT_KILL_SERVER=1` means `adb kill-server` refuses Simlock too.
    expect(processSupervisor.signals).toEqual([{ pid: adbServerPid, signal: "SIGTERM" }]);
    await expect(filesystem.exists(adbRecordPath)).resolves.toBe(false);
  });
});

describe("AndroidDriver ownership", () => {
  it("manages every AVD in its root, whatever the AVD is called", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/a-name-nobody-prefixed.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.devices.map((device) => device.deviceId)).toEqual(["a-name-nobody-prefixed"]);
  });

  it("ignores a running emulator whose AVD does not live in its root", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_mine.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
        // Named exactly like one of Simlock's, and still not Simlock's: the AVD is not in
        // the root, and ownership is proven from the root rather than from the name or from
        // the fact that Simlock's own server can see it.
        "simlock_impostor\n",
      ),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.processes).toEqual([]);
    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_mine", runState: "stopped" }),
    ]);
  });
});

describe("AndroidDriver readiness on a taken console port", () => {
  it("refuses to ready a device whose serial an emulator of an AVD outside its root answers, and changes nothing on that emulator (#256)", async () => {
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const machine = new PortTakingMachine(host);
    const driver = await createDriver(filesystem, machine.runner(), { ids: ["one"] });
    await driver.resolveSpec(spec);
    // Booted and stopped once, the device has its clean baseline and boots from it next
    // time, as it does for every lease after its first.
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);

    // Another emulator takes the device's console port before its own emulator binds it --
    // whatever freed the port for it (#52, a second Simlock instance, the user's own
    // emulator). Its AVD is named like Simlock's but lives in the user's AVD home: a name
    // proves nothing, root membership does (safety rule 8).
    const otherPath = `${home}/.android/avd/simlock_one.avd`;
    const other = machine.takePortOnNextBoot(otherPath);

    const readied = await driver.makeReady(stopped).then(
      (ready) => machine.avdPathAnswering(ready.address),
      (error: unknown) => driverCrashMessage(error),
    );

    // A DriverCrashError naming both directories: the one that answered, and the device's own.
    const ownPath = `${avdDirectory}/simlock_one.avd`;
    expect({ readied, other: other.observed() }).toEqual({
      readied: {
        refused: expect.stringMatching(
          new RegExp(`"${escapeRegExp(otherPath)}".* ${escapeRegExp(ownPath)}(\\s|$)`),
        ),
      },
      other: { running: true, sentByDriver: [] },
    });
  });

  it.each([
    ["with a trailing slash", `${avdDirectory}/simlock_one.avd/\r\nOK\r\n`],
    // macOS's `/var` -> `/private/var` is the everyday case of this.
    [
      "through a symlinked ancestor of the device root",
      `/private${avdDirectory}/simlock_one.avd\r\nOK\r\n`,
    ],
  ])("readies a device whose emulator reports its AVD directory %s", async (_, answer) => {
    const filesystem = await androidFilesystem();
    filesystem.defineSymlink("/private/home", "/home");
    const host = new EmulatorHost(filesystem);
    const runner = answeringAvdPath(host.runner(), ok(answer));
    const driver = await createDriver(filesystem, runner, { ids: ["one"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });

    const ready = await driver.makeReady(await driver.provision(spec));

    expect(ready.address).toBe("emulator-5586");
  });

  it.each([
    ["a console error", ok("KO: unknown command\r\n")],
    ["a failed adb call", { code: 1, stderr: "error: could not connect to console", stdout: "" }],
    ["a directory that does not exist", ok(`/private/elsewhere/simlock_one.avd\r\nOK\r\n`)],
  ])(
    "refuses to ready a device whose emulator answers the AVD path query with %s, and stops that emulator",
    async (_, answer) => {
      const filesystem = await androidFilesystem();
      const host = new EmulatorHost(filesystem);
      const runner = answeringAvdPath(host.runner(), answer);
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
      });

      const readied = await driver.makeReady(await driver.provision(spec)).then(
        () => "readied",
        (error: unknown) => driverCrashMessage(error),
      );

      expect({ readied, running: host.avdAnswering("emulator-5586") }).toEqual({
        readied: { refused: expect.any(String) },
        running: undefined,
      });
    },
  );
});

describe("AndroidDriver emulator registration", () => {
  it("sweeps its own console range when it takes over a server, and nobody else's", async () => {
    // A running emulator announced itself exactly once, to a server a previous daemon has
    // since reaped. With `ADB_EMU=0` nothing rediscovers it, so `simlock daemon stop` would
    // otherwise orphan gigabytes of RSS the driver can no longer see, and hand the console
    // port it is sitting on to the next emulator, which then cannot bind.
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    await createDriver(filesystem, new ScriptedProcessRunner([]), { tcpProbe });

    const announced = tcpProbe.sends.map((send) => send.payload);
    expect(announced).toHaveLength(49);
    expect(announced[0]).toBe("0012host:emulator:5587");
    expect(announced.at(-1)).toBe("0012host:emulator:5683");
    // Every send goes to Simlock's own server, and every port is inside Simlock's range:
    // one below 5587 would be adb connecting to an emulator of the user's.
    expect(tcpProbe.sends.every((send) => send.port === adbServerPort)).toBe(true);
  });

  it("finishes the sweep when a port refuses the announcement", async () => {
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    // The whole range is unreachable here; nothing about starting Android depends on it.
    await expect(
      createDriver(filesystem, new ScriptedProcessRunner([]), { tcpProbe }),
    ).resolves.toBeDefined();
    expect(tcpProbe.sends).toHaveLength(49);
  });

  it("re-announces an emulator that stays unreachable, since nothing else will", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 2 });
    // Nothing is announced when an emulator is spawned: adb answers `host:emulator:<port>`
    // by connecting out to that port, and the emulator has not opened it yet.
    const afterSweep = harness.tcpProbe.sends.length;
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(1));
    expect(harness.tcpProbe.sends).toHaveLength(afterSweep);

    // Past the grace period on the second failure: adb's own reconnect queue is drained by
    // the scanner thread, which `ADB_EMU=0` does not run.
    harness.clock.advance(6_000);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(2));
    await vi.waitFor(() =>
      expect(harness.tcpProbe.sends.slice(afterSweep)).toEqual([
        // The adb port is the console port + 1.
        { payload: "0012host:emulator:5587", port: adbServerPort },
      ]),
    );

    harness.clock.advance(2_000);
    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

  it("never fails a boot because a registration failed", async () => {
    const harness = await provisionedHarness();
    harness.tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(harness.driver.makeReady(harness.device)).resolves.toMatchObject({
      deviceId: "simlock_one",
    });
  });
});

describe("AndroidDriver pre-root devices", () => {
  it("re-proves an intact root by re-running the validation its start was judged by", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

    await expect(driver.revalidateRoot()).resolves.toBeUndefined();
  });

  it("refuses to re-prove a root that has become a symlink since startup", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
    // The case the re-proof exists for: the path was proven at startup and swapped since,
    // so `listManaged` would now answer with the user's own AVDs.
    filesystem.defineSymlink(avdDirectory, `${home}/.android/avd`);

    await expect(driver.revalidateRoot()).rejects.toMatchObject({
      name: "OwnedRootError",
      reason: "symlink",
    });
  });

  it("finds an AVD stranded in the pre-root AVD home", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${home}/.android/avd/simlock_old.avd`);
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(driver.findLegacy("simlock_old")).resolves.toMatchObject({
      device: { deviceId: "simlock_old" },
      path: `${home}/.android/avd/simlock_old.avd`,
    });
    await expect(driver.findLegacy("simlock_never_existed")).resolves.toBeUndefined();
  });

  it("deletes a stranded AVD against the legacy AVD home, not Simlock's root", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${home}/.android/avd/simlock_old.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
    ]);
    const driver = await createDriver(filesystem, runner);
    const legacy = await driver.findLegacy("simlock_old");

    await driver.destroyLegacy(legacy!.device);

    // Pointed at the home the AVD is actually in, and deliberately carrying no
    // `ANDROID_ADB_SERVER_PORT`: a device this old is not on Simlock's server, and the
    // user's is not one Simlock may drive.
    expect(runner.calls.at(-1)?.options?.env).toEqual({
      ANDROID_AVD_HOME: `${home}/.android/avd`,
      ANDROID_HOME: sdk,
    });
  });
});

describe("AndroidDriver listComponents()", () => {
  const userAvdHome = `${home}/.android/avd`;
  const googleApis = `${sdk}/system-images/android-35/google_apis/arm64-v8a`;
  const plain = `${sdk}/system-images/android-35/default/arm64-v8a`;

  /** An AVD the user made with avdmanager: `<name>.ini` pointing at `<name>.avd`. */
  async function userAvd(
    filesystem: MemoryFilesystem,
    name: string,
    sysdir: string,
    options: { readonly avdHome?: string; readonly avdPath?: string } = {},
  ): Promise<void> {
    const avdHome = options.avdHome ?? userAvdHome;
    const avdPath = options.avdPath ?? `${avdHome}/${name}.avd`;
    await filesystem.mkdirp(avdPath);
    await filesystem.writeFileAtomic(
      `${avdHome}/${name}.ini`,
      `avd.ini.encoding=UTF-8\npath=${avdPath}\n`,
    );
    await filesystem.writeFileAtomic(
      `${avdPath}/config.ini`,
      `hw.ramSize=2048\nimage.sysdir.1=${sysdir}\ntag.id=google_apis\n`,
    );
  }

  it("lists two images of one API level as two entries with different variants, each with its directory's size", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["35", "google_apis", "arm64-v8a"],
        ["35", "default", "arm64-v8a"],
      ],
    });
    await filesystem.writeFileAtomic(`${googleApis}/source.properties`, "Pkg.Revision=7\n");
    await filesystem.mkdirp(`${googleApis}/data`);
    await filesystem.writeFileAtomic(`${googleApis}/data/userdata.img`, "0123456789");
    await filesystem.writeFileAtomic(`${plain}/system.img`, "abc");
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const listed = await driver.listComponents();

    expect(listed).toEqual([
      {
        foreignDevices: 0,
        receipt: {
          package: "system-images;android-35;default;arm64-v8a",
          revision: "unknown",
          stamp: "",
        },
        sizeBytes: 3,
        variant: "default/arm64-v8a",
        version: "35",
      },
      {
        foreignDevices: 0,
        receipt: {
          package: "system-images;android-35;google_apis;arm64-v8a",
          revision: "7",
          stamp: expect.stringMatching(/^.+@\d+$/),
        },
        sizeBytes: "Pkg.Revision=7\n".length + 10,
        variant: "google_apis/arm64-v8a",
        version: "35",
      },
    ]);
  });

  it("counts an AVD in the user's AVD home that names the image as foreign, wherever its directory is, and not an AVD in Simlock's root", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["35", "google_apis", "arm64-v8a"],
        ["35", "default", "arm64-v8a"],
      ],
    });
    await userAvd(filesystem, "Pixel_8", "system-images/android-35/google_apis/arm64-v8a/");
    // avdmanager's `-p`: the AVD directory lives elsewhere, and the `.ini` points at it.
    await userAvd(filesystem, "Elsewhere", `${googleApis}/`, { avdPath: "/work/Elsewhere.avd" });
    await userAvd(filesystem, "Other", "system-images/android-34/google_apis/arm64-v8a/");
    // Simlock's own AVD of the same image: one of its devices, counted from the registry.
    await userAvd(filesystem, "simlock_one", "system-images/android-35/google_apis/arm64-v8a/", {
      avdHome: avdDirectory,
    });
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices, variant }) => ({ foreignDevices, variant }))).toEqual([
      { foreignDevices: 0, variant: "default/arm64-v8a" },
      { foreignDevices: 2, variant: "google_apis/arm64-v8a" },
    ]);
  });

  it("counts every AVD in the user's AVD home that names the image, booted before or never (#241)", async () => {
    const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
    const sysdir = "system-images/android-35/google_apis/arm64-v8a/";
    // Never booted: only what avdmanager writes.
    await userAvd(filesystem, "Fresh", sysdir);
    // Booted: the emulator has written its disk image and hardware config beside config.ini.
    await userAvd(filesystem, "Booted", sysdir);
    await filesystem.writeFileAtomic(`${userAvdHome}/Booted.avd/userdata-qemu.img`, "data");
    await filesystem.writeFileAtomic(`${userAvdHome}/Booted.avd/hardware-qemu.ini`, "hw\n");
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([2]);
  });

  it("finds an AVD beside a pointer file with an empty path, counts nothing for an AVD whose directory is gone, and still lists the image", async () => {
    const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
    const sysdir = "system-images/android-35/google_apis/arm64-v8a/";
    await userAvd(filesystem, "Beside", sysdir);
    await filesystem.writeFileAtomic(
      `${userAvdHome}/Beside.ini`,
      "avd.ini.encoding=UTF-8\npath=\n",
    );
    await filesystem.writeFileAtomic(`${userAvdHome}/Gone.ini`, "path=/nowhere/Gone.avd\n");
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices, version }) => ({ foreignDevices, version }))).toEqual([
      { foreignDevices: 1, version: "35" },
    ]);
  });

  it("counts no foreign AVD when the user's AVD home is Simlock's own root, as in a daemon started from a lease's environment", async () => {
    const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
    await userAvd(filesystem, "simlock_one", "system-images/android-35/google_apis/arm64-v8a/", {
      avdHome: avdDirectory,
    });
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]), {
      avdHome: avdDirectory,
    });

    const listed = await driver.listComponents();

    expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([0]);
  });

  it.each([
    ["the user's AVD home", () => userAvdHome],
    ["an AVD's pointer file", () => `${userAvdHome}/Locked.ini`],
    ["an AVD's config.ini", () => `${userAvdHome}/Locked.avd/config.ini`],
  ])(
    "rejects when %s cannot be read, rather than count the AVDs there as using nothing",
    async (_label, unreadable) => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      await userAvd(filesystem, "Locked", "system-images/android-35/google_apis/arm64-v8a/");
      filesystem.defineFailure(unreadable(), "EACCES");
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

      await expect(driver.listComponents()).rejects.toMatchObject({ code: "EACCES" });
    },
  );

  it("leaves sizeBytes out when the image directory cannot be read, and still lists the image", async () => {
    const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
    await filesystem.writeFileAtomic(`${googleApis}/system.img`, "abc");
    filesystem.defineFailure(`${googleApis}/system.img`, "EACCES");
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const listed = await driver.listComponents();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ variant: "google_apis/arm64-v8a", version: "35" });
    expect(listed[0]).not.toHaveProperty("sizeBytes");
  });

  it("lists an image with the receipt installComponent returned for it, and starts no process to list", async () => {
    const filesystem = await androidFilesystem();
    const runner = new InstallReflectingProcessRunner(
      [
        processResult(binaries.sdkmanager, [
          "--install",
          "system-images;android-35;google_apis;arm64-v8a",
        ]),
      ],
      filesystem,
    );
    const driver = await createDriver(filesystem, runner);
    const installed = await installFor(driver, "35");
    const callsBeforeListing = runner.calls.length;

    const listed = await driver.listComponents();

    expect(listed.find((component) => component.version === "35")?.receipt).toEqual(
      installed.receipt,
    );
    expect(runner.calls).toHaveLength(callsBeforeListing);
  });

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
      // The scripted runner fails any call it was not given, so an uninstall would fail this test.
      const runner = new ScriptedProcessRunner([]);
      const driver = await createDriver(filesystem, runner);
      const [target] = await driver.listComponents();

      const error = await driver
        .removeComponent(target?.receipt ?? {}, { signal: signal() })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ComponentInUseError);
      expect(error).toMatchObject({ foreignDevices: 1 });
      expect(runner.calls).toEqual([]);
    });

    it("refuses with ComponentNotOwnedError when no installed image has the receipt, and uninstalls nothing", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const runner = new ScriptedProcessRunner([]);
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
      const runner = new ScriptedProcessRunner([
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
      const runner = new ScriptedProcessRunner([
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
      const runner = new ScriptedProcessRunner([
        {
          // Ignores SIGTERM: only the SIGKILL ten seconds later ends it.
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
 * What a promise settled with, once it has: a promise still open fails a named assertion rather
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

function bootProbes(runner: ScriptedProcessRunner): number {
  return runner.calls.filter((call) => call.args.includes("sys.boot_completed")).length;
}

const live = process.env.SIMLOCK_LIVE_ANDROID === "1" ? it : it.skip;

live(
  "live smoke: provision, quickboot reclaim, re-ready, and destroy",
  async () => {
    const driver = await AndroidDriver.create({
      clock: new SystemClock(),
      driverConfig: {},
      env: process.env,
      filesystem: new NodeFilesystem(),
      homeDirectory: process.env.HOME ?? home,
      hostAbi: "arm64-v8a",
      instanceId: `live-${process.pid}`,
      processRunner: new NodeProcessRunner(),
      processSupervisor: new NodeProcessSupervisor(),
      simlockHome: join(tmpdir(), `simlock-live-android-${process.pid}`),
      tcpProbe: new NodeTcpProbe(),
    });
    const spec = await driver.resolveSpec({
      model: process.env.SIMLOCK_LIVE_ANDROID_MODEL ?? "Pixel 8",
      platform: "android",
      ...(process.env.SIMLOCK_LIVE_ANDROID_API === undefined
        ? {}
        : { osVersion: process.env.SIMLOCK_LIVE_ANDROID_API }),
    });
    const device = await driver.provision(spec);
    const coldStartedAt = Date.now();

    try {
      await driver.makeReady(device);
      const coldBootMs = Date.now() - coldStartedAt;
      await driver.reclaim(device, { clean: "standard" });
      const snapshotStartedAt = Date.now();
      await driver.makeReady(device);
      const snapshotBootMs = Date.now() - snapshotStartedAt;

      expect(snapshotBootMs).toBeLessThan(coldBootMs / 2);
    } finally {
      await driver.destroy(device);
    }
  },
  480_000,
);

async function provisionedHarness(
  options: {
    readonly bootCompleted?: string;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    /** The flags `emulator` is expected to add to every launch. */
    readonly emulatorFlags?: readonly string[];
    readonly forBaselineReclaim?: boolean;
    readonly forFullCleanBoot?: boolean;
    readonly forReclaim?: boolean;
    readonly initialAdbFailures?: number;
    readonly readinessTimeoutMs?: number;
    /** Invocations the test makes after the harness's own, in order. */
    readonly afterwards?: readonly ScriptedProcessExpectation[];
  } = {},
) {
  const filesystem = await androidFilesystem({ config: "hw.ramSize=2048\n" });
  const tcpProbe = new FakeTcpProbe([adbServerPort]);
  const clock = new FakeClock();
  const expectations: ScriptedProcessExpectation[] = [
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    processResult(binaries.avdmanager, [
      "create",
      "avd",
      "-n",
      "simlock_one",
      "-k",
      /.+/,
      "-d",
      "pixel_8",
    ]),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    processResult(binaries.adb, ["devices"], "List of devices attached\n"),
  ];

  // The mock idGenerator's first call is spent on the AVD name above, so `makeReady`'s tail
  // mark write is always the second call, and (when a snapshot-reclaim follows) the third.
  const firstMarkToken = "device-2";
  const secondMarkToken = "device-3";

  if (options.forReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ...baselineBuildExpectations({ launchArgs: ["-wipe-data", "-no-snapshot-load"] }),
      markWriteExpectation("emulator-5586", firstMarkToken),
    );
  } else if (options.forFullCleanBoot === true) {
    expectations.push(
      processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      ...baselineBuildExpectations({ launchArgs: ["-wipe-data", "-no-snapshot-load"] }),
      markWriteExpectation("emulator-5586", firstMarkToken),
    );
  } else {
    expectations.push(
      ...baselineBuildExpectations({
        bootCompleted: options.bootCompleted,
        emulatorFlags: options.emulatorFlags,
        initialAdbFailures: options.initialAdbFailures,
        launchArgs: ["-no-snapshot-load"],
      }),
    );
    if ((options.bootCompleted ?? "1\n").trim() === "1") {
      expectations.push(markWriteExpectation("emulator-5586", firstMarkToken));
    }
  }

  if (options.forBaselineReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5586", "emu", "avd", "snapshot", "load", "simlock_clean_baseline"],
        "OK\n",
      ),
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
      avdPathExpectation("emulator-5586"),
      markWriteExpectation("emulator-5586", secondMarkToken),
    );
  }

  expectations.push(...(options.afterwards ?? []));
  const runner = new ScriptedProcessRunner(expectations);
  const driver = await createDriver(filesystem, runner, {
    clock,
    ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
    ids: ["one"],
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    tcpProbe,
  });
  const spec = await driver.resolveSpec({ model: "Pixel 8", osVersion: "34", platform: "android" });
  const device = await driver.provision(spec);

  return { clock, device, driver, filesystem, runner, tcpProbe };
}

/**
 * A driver whose adb server is already running and recorded, so `create` adopts it: that is
 * the one start-up path that spawns nothing, which keeps the scripted process expectations
 * in every test about the behaviour the test is actually for. The start, reap, and refusal
 * paths are covered against the supervisor itself in `adb-server.test.ts`, and end to end
 * in this file's own `AndroidDriver.create` block.
 */
describe("AndroidDriver toolVersions()", () => {
  it("reports emulator, platform-tools, and command-line tools revisions from each package's source.properties", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.writeFileAtomic(
      `${sdk}/emulator/source.properties`,
      "Pkg.Desc=Android Emulator\nPkg.Revision=35.4.9\n",
    );
    await filesystem.writeFileAtomic(
      `${sdk}/platform-tools/source.properties`,
      "Pkg.Revision=36.0.0\nPkg.Path=platform-tools\n",
    );
    await filesystem.writeFileAtomic(
      `${sdk}/cmdline-tools/latest/source.properties`,
      "Pkg.Revision=19.0\n",
    );
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(driver.toolVersions()).resolves.toEqual([
      { name: "emulator", version: "35.4.9" },
      { name: "platform-tools", version: "36.0.0" },
      { name: "cmdline-tools", version: "19.0" },
    ]);
  });

  it("names the legacy SDK tools package as tools when its sdkmanager is the one in use", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.rm(`${sdk}/cmdline-tools`);
    const legacyTools = `${sdk}/tools/bin`;
    await filesystem.mkdirp(legacyTools);
    await filesystem.writeFileAtomic(`${legacyTools}/avdmanager`, "binary");
    await filesystem.writeFileAtomic(`${legacyTools}/sdkmanager`, "binary");
    await filesystem.writeFileAtomic(`${sdk}/tools/source.properties`, "Pkg.Revision=26.1.1\n");
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(driver.toolVersions()).resolves.toEqual([{ name: "tools", version: "26.1.1" }]);
  });

  it("omits a tool whose source.properties cannot be read", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.writeFileAtomic(`${sdk}/emulator/source.properties`, "Pkg.Revision=35.4.9\n");
    // platform-tools has no source.properties; cmdline-tools has one with an empty revision.
    await filesystem.writeFileAtomic(
      `${sdk}/cmdline-tools/latest/source.properties`,
      "Pkg.Desc=Android SDK Command-line Tools\nPkg.Revision=\n",
    );
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(driver.toolVersions()).resolves.toEqual([{ name: "emulator", version: "35.4.9" }]);
  });
});

async function createDriver(
  filesystem: Filesystem,
  processRunner: ProcessRunner,
  options: {
    readonly acceptAndroidLicenses?: boolean;
    /** `ANDROID_AVD_HOME` in the environment the daemon started with; unset by default. */
    readonly avdHome?: string;
    readonly clock?: FakeClock;
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    /** The ABI this host runs natively; `arm64-v8a` unless a test says otherwise. */
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
    readonly readinessTimeoutMs?: number;
    readonly tcpProbe?: FakeTcpProbe;
  } = {},
) {
  let nextId = 0;
  const driverConfig = options.driverConfig ?? {};
  const configuredPort =
    typeof driverConfig["adbServerPort"] === "number"
      ? driverConfig["adbServerPort"]
      : adbServerPort;
  await recordRunningAdbServer(filesystem, configuredPort);
  return AndroidDriver.create({
    ...onlyProvided(options),
    clock: options.clock ?? new FakeClock(),
    driverConfig,
    env: {
      ANDROID_HOME: sdk,
      ...(options.avdHome === undefined ? {} : { ANDROID_AVD_HOME: options.avdHome }),
    },
    filesystem,
    homeDirectory: home,
    hostAbi: options.hostAbi ?? "arm64-v8a",
    idGenerator: {
      generate: () => options.ids?.[nextId++] ?? `device-${nextId}`,
    },
    instanceId,
    processRunner,
    processSupervisor: new FakeProcessSupervisor([adbServerPid]),
    simlockHome,
    tcpProbe: options.tcpProbe ?? new FakeTcpProbe([configuredPort]),
  });
}

/** The options this helper only forwards when a test actually set one -- `AndroidDriver.create`
 * declares them optional under `exactOptionalPropertyTypes`, so an absent one must be absent
 * rather than `undefined`. Split out of `createDriver` so that the list can keep growing
 * without the helper itself turning into a pile of conditionals. */
function onlyProvided(options: {
  readonly acceptAndroidLicenses?: boolean;
  readonly emulator?: AndroidEmulatorLaunchOptions;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly readinessTimeoutMs?: number;
}) {
  return {
    ...(options.acceptAndroidLicenses === undefined
      ? {}
      : { acceptAndroidLicenses: options.acceptAndroidLicenses }),
    ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
  };
}

/** The `adb-server.json` a previous daemon would have left behind for the adoption above. */
async function recordRunningAdbServer(filesystem: Filesystem, port = adbServerPort): Promise<void> {
  await filesystem.mkdirp(simlockHome);
  await filesystem.writeFileAtomic(
    adbRecordPath,
    JSON.stringify({ pid: adbServerPid, port, startedAt: 1 }),
  );
}

async function writeDevicesXml(filesystem: MemoryFilesystem, deviceBodies: string): Promise<void> {
  await filesystem.mkdirp(`${home}/.android`);
  await filesystem.writeFileAtomic(
    `${home}/.android/devices.xml`,
    `<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">${deviceBodies}</d:devices>`,
  );
}

function customDeviceXml(name: string, ramMiB: number): string {
  return (
    `<d:device><d:name>${name}</d:name><d:hardware>` +
    `<d:ram unit="MiB">${ramMiB}</d:ram></d:hardware></d:device>`
  );
}

/**
 * Fails every `readFile` of `failingPath` with a non-ENOENT error while `armed`, so a test can
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

/** Returns every directory listing in reverse, standing in for a disk with no listing order. */
class ReversedReaddirFilesystem extends MemoryFilesystem {
  override async readdir(path: string): Promise<string[]> {
    return (await super.readdir(path)).reverse();
  }
}

async function androidFilesystem(
  options: {
    readonly config?: string;
    readonly freeDiskBytes?: number;
    readonly images?: readonly (readonly [string, string, string])[];
    readonly withDeviceRoot?: boolean;
  } = {},
  filesystem: MemoryFilesystem = new MemoryFilesystem(options.freeDiskBytes),
): Promise<MemoryFilesystem> {
  for (const binary of Object.values(binaries)) {
    await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
    await filesystem.writeFileAtomic(binary, "binary");
  }
  // Marked, so `ensureOwnedRoot` adopts it rather than creating one -- a root Simlock
  // created in an earlier run is the ordinary case, and it keeps the id generator's first
  // value available for the AVD name the tests assert on.
  if (options.withDeviceRoot !== false) {
    await filesystem.mkdirp(avdDirectory);
    await filesystem.writeFileAtomic(
      `${avdDirectory}/${OWNED_ROOT_MARKER_FILE}`,
      JSON.stringify({ instanceId, owner: "simlock", platform: "android", schemaVersion: 1 }),
    );
  }
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  if (options.config !== undefined) {
    await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
    await filesystem.writeFileAtomic(`${avdDirectory}/simlock_one.avd/config.ini`, options.config);
  }
  return filesystem;
}

function baselineBuildExpectations(options: {
  readonly bootCompleted?: string | undefined;
  /** What `android.emulator` adds to every launch, right after `-no-snapshot-save`. */
  readonly emulatorFlags?: readonly string[] | undefined;
  readonly initialAdbFailures?: number | undefined;
  readonly launchArgs: readonly string[];
}): ScriptedProcessExpectation[] {
  const bootCompleted = options.bootCompleted ?? "1\n";
  const emulatorFlags = options.emulatorFlags ?? [];
  const expectations: ScriptedProcessExpectation[] = [
    {
      hangs: bootCompleted.trim() !== "1",
      match: {
        args: [
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...emulatorFlags,
          ...options.launchArgs,
        ],
        command: binaries.emulator,
      },
    },
  ];
  for (let failure = 0; failure < (options.initialAdbFailures ?? 0); failure += 1) {
    expectations.push({
      match: {
        args: ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
      },
      result: { code: 1, stderr: "connection refused", stdout: "" },
    });
  }
  expectations.push(
    processResult(
      binaries.adb,
      ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
      bootCompleted,
    ),
  );
  if (bootCompleted.trim() !== "1") {
    return expectations;
  }

  expectations.push(
    processResult(
      binaries.adb,
      ["-s", "emulator-5586", "shell", "getprop", "init.svc.bootanim"],
      "",
    ),
    avdPathExpectation("emulator-5586"),
    processResult(binaries.adb, [
      "-s",
      "emulator-5586",
      "emu",
      "avd",
      "snapshot",
      "save",
      "simlock_clean_baseline",
    ]),
    processResult(
      binaries.adb,
      ["-s", "emulator-5586", "emu", "avd", "snapshot", "list"],
      "simlock_clean_baseline\n",
    ),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
    {
      hangs: true,
      match: {
        args: [
          "-avd",
          "simlock_one",
          "-port",
          "5586",
          "-no-snapshot-save",
          ...emulatorFlags,
          "-snapshot",
          "simlock_clean_baseline",
        ],
        command: binaries.emulator,
      },
    },
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
    avdPathExpectation("emulator-5586"),
  );
  return expectations;
}

/**
 * A `ScriptedProcessRunner` that also mirrors what real `sdkmanager` does on disk: a
 * successful (`code: 0`, no unaccepted-license text) `--install <package>` call creates the
 * corresponding `system-images/android-<api>/<tag>/<abi>` directory in `filesystem`. The
 * driver's post-install `#installSystemImageOnce` re-scan needs the filesystem to actually
 * reflect the "install" the same way the iOS driver's fixtures script a second `simctl list`
 * response after a download (see `listFixtureAfterDownload` in the iOS driver's test file) --
 * a bare `ScriptedProcessRunner` only scripts the process's own stdout/stderr/exit code, never
 * a filesystem side effect, so a scripted mkdirp-free "success" would fail the re-scan.
 */
class InstallReflectingProcessRunner extends ScriptedProcessRunner {
  readonly #filesystem: MemoryFilesystem;

  constructor(expectations: readonly ScriptedProcessExpectation[], filesystem: MemoryFilesystem) {
    super(expectations);
    this.#filesystem = filesystem;
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    const handle = super.spawn(command, args, options);
    const uninstalled = args[0] === "--uninstall" ? imageDirectory(args[1]) : undefined;
    if (uninstalled !== undefined) {
      void handle.wait().then(async (result) => {
        if (result.code === 0) await this.#filesystem.rm(uninstalled);
      });
    }
    if (args[0] === "--install" && typeof args[1] === "string") {
      const packageName = args[1];
      void handle.wait().then((result) => {
        const combined = `${result.stdout}\n${result.stderr}`;
        const licenseNotAccepted =
          /licen[cs]e/i.test(combined) && /not (?:been )?accepted/i.test(combined);
        if (result.code === 0 && !licenseNotAccepted) {
          const match = /^system-images;android-(.+);(.+);(.+)$/.exec(packageName);
          if (match !== null) {
            const [, api, tag, abi] = match;
            const imagePath = `${sdk}/system-images/android-${api}/${tag}/${abi}`;
            void this.#filesystem
              .mkdirp(imagePath)
              .then(() =>
                this.#filesystem.writeFileAtomic(
                  `${imagePath}/source.properties`,
                  "Pkg.Revision=1\n",
                ),
              );
          }
        }
      });
    }
    return handle;
  }
}

/**
 * The emulators on one machine, which outlive any one daemon: as much of `avdmanager`,
 * `emulator` and `adb` as provisioning, booting, capturing a baseline and stopping use. Each
 * `runner()` is one daemon process's view of it -- the driver keeps its port reservations per
 * runner, as a real daemon keeps them per process.
 *
 * Two behaviours are the real tools', not Simlock's. An emulator told to take a console port
 * another one holds exits at once: `emulator -help` (36.1.9) says that "if any of these ports
 * is already used, the emulator will fail to start". And a serial is answered by whichever
 * emulator is listening on its port.
 */
class EmulatorHost {
  /** Console port -> the AVD whose emulator is listening on it. */
  readonly #listening = new Map<number, string>();
  readonly #exits = new Map<number, () => void>();
  #nextPid = 1;

  constructor(private readonly filesystem: MemoryFilesystem) {}

  /** The AVD whose emulator answers `serial`, or `undefined` when nothing does. */
  avdAnswering(serial: string | undefined): string | undefined {
    return this.#listening.get(consolePortOf(serial));
  }

  runner(): ProcessRunner {
    return {
      run: (command, args) => this.#run(command, args),
      spawn: (command, args) => this.#spawn(command, args),
      spawnStreaming: (command, args) => {
        throw new Error(`Unexpected streaming invocation: ${command} ${args.join(" ")}`);
      },
    };
  }

  async #run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const result =
      command === binaries.avdmanager
        ? await this.#avdmanager(args)
        : command === binaries.adb
          ? this.#adb(args)
          : command === binaries.emulator && args[0] === "-version"
            ? ok("Android emulator version 36.1.9")
            : undefined;
    if (result === undefined) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }
    return result;
  }

  async #avdmanager(args: readonly string[]): Promise<ProcessResult | undefined> {
    if (args[0] === "list") return ok(pixelDevices);
    if (args[0] !== "create") return undefined;
    const avdName = args[args.indexOf("-n") + 1] ?? "";
    await this.filesystem.mkdirp(`${avdDirectory}/${avdName}.avd`);
    await this.filesystem.writeFileAtomic(
      `${avdDirectory}/${avdName}.avd/config.ini`,
      "hw.ramSize=2048\n",
    );
    return ok();
  }

  #adb(args: readonly string[]): ProcessResult | undefined {
    if (args[0] === "devices") {
      const lines = [...this.#listening.keys()].map((port) => `emulator-${port}\tdevice\n`);
      return ok(`List of devices attached\n${lines.join("")}`);
    }
    if (args[0] !== "-s") return undefined;
    const port = consolePortOf(args[1]);
    if (!this.#listening.has(port)) {
      return { code: 1, stderr: `adb: device '${args[1]}' not found`, stdout: "" };
    }
    const rest = args.slice(2).join(" ");
    if (rest === "emu kill") {
      this.#exit(port);
      return ok("OK: killing emulator, bye bye\n");
    }
    if (rest.startsWith("shell echo ")) return ok();
    const answer = ADB_ANSWERS.get(rest);
    return answer === undefined ? undefined : ok(answer);
  }

  #spawn(command: string, args: readonly string[]): ProcessHandle {
    if (command !== binaries.emulator || args[0] !== "-avd") {
      throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
    }
    const avdName = args[1] ?? "";
    const port = Number(args[args.indexOf("-port") + 1]);
    let exit!: (result: ProcessResult) => void;
    const exited = new Promise<ProcessResult>((resolve) => {
      exit = resolve;
    });
    const bound = !this.#listening.has(port);
    if (bound) {
      this.#listening.set(port, avdName);
      this.#exits.set(port, () => exit({ code: 0, stderr: "", stdout: "" }));
    } else {
      exit({ code: 1, stderr: `console port ${port} is already used`, stdout: "" });
    }
    return {
      // Killing an emulator that never bound must not stop the one that did.
      kill: () => {
        if (bound && this.#listening.get(port) === avdName) this.#exit(port);
      },
      pid: this.#nextPid++,
      stderr: emptyLines(),
      stdout: emptyLines(),
      unref: () => undefined,
      wait: () => exited,
    };
  }

  #exit(port: number): void {
    this.#listening.delete(port);
    this.#exits.get(port)?.();
    this.#exits.delete(port);
  }
}

/** What a booted emulator answers to the `adb -s <serial>` commands a boot and a baseline capture send. */
const ADB_ANSWERS = new Map([
  ["shell getprop sys.boot_completed", "1\n"],
  ["shell getprop init.svc.bootanim", "stopped\n"],
  ["emu avd snapshot save simlock_clean_baseline", "OK\n"],
  ["emu avd snapshot list", "simlock_clean_baseline\n"],
]);

function consolePortOf(serial: string | undefined): number {
  return Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
}

function ok(stdout = ""): ProcessResult {
  return { code: 0, stderr: "", stdout };
}

async function* emptyLines(): AsyncIterable<string> {
  // An emulator Simlock spawns is never read from.
}

/** `installComponent` with a no-op progress callback and a signal that never fires. */
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

/** Where sdkmanager puts a `system-images;android-<api>;<tag>;<abi>` package. */
function imageDirectory(packageName: string | undefined): string | undefined {
  const match = /^system-images;android-(.+);(.+);(.+)$/.exec(packageName ?? "");
  if (match === null) return undefined;
  const [, api, tag, abi] = match;
  return `${sdk}/system-images/android-${api ?? ""}/${tag ?? ""}/${abi ?? ""}`;
}

function processResult(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return {
    match: { args, command },
    result: { code: 0, stderr: "", stdout },
  };
}

/**
 * The `emu avd path` query every readiness wait ends with, answered by the emulator of
 * `avdName` in Simlock's device root -- with the console's own CRLF line endings and its
 * closing `OK` line.
 */
function avdPathExpectation(serial: string, avdName = "simlock_one"): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${avdName}.avd\r\nOK\r\n`,
  );
}

/** The adb shell call `#writeErasableMark` makes as the second half of every mark write. */
function markWriteExpectation(serial: string, token: string): ScriptedProcessExpectation {
  return processResult(binaries.adb, [
    "-s",
    serial,
    "shell",
    `echo '${JSON.stringify({ token })}' > /data/local/tmp/simlock-mark.json`,
  ]);
}

/**
 * An `EmulatorHost` on which another emulator takes a device's console port just before the
 * device's own emulator is spawned on it, and which answers the queries that tell emulators
 * apart: `emu avd path`, `emu avd name` and `getprop ro.boot.qemu.avd_name`.
 *
 * The device's emulator cannot bind the taken port and exits -- but not before the other
 * emulator has answered the readiness poll, as it does on a real machine, where the other
 * emulator answers at once and the spawned one checks its ports only once it has started.
 * So in this fake its exit is seen only once it is killed: a driver that waited for that
 * exit would already have readied the device.
 */
class PortTakingMachine {
  readonly #inner: ProcessRunner;
  /** Console port -> the path of the AVD the other emulator runs. */
  readonly #otherPaths = new Map<number, string>();
  #takeOnNextBoot: ((port: number) => void) | undefined;

  constructor(private readonly host: EmulatorHost) {
    this.#inner = host.runner();
  }

  /** The AVD path whose emulator answers `serial`, or `undefined` when nothing does. */
  avdPathAnswering(serial: string | undefined): string | undefined {
    const name = this.host.avdAnswering(serial);
    if (name === undefined) return undefined;
    return this.#otherPaths.get(consolePortOf(serial)) ?? `${avdDirectory}/${name}.avd`;
  }

  /**
   * On the next emulator spawn, first starts another emulator, of the AVD at `avdPath`, on
   * the port that spawn names. Returns what became of that other emulator.
   */
  takePortOnNextBoot(avdPath: string): {
    observed(): { running: boolean; sentByDriver: string[] };
  } {
    let running = false;
    let port = Number.NaN;
    const sent: string[] = [];
    this.#takeOnNextBoot = (taken) => {
      port = taken;
      const avdName = /([^/]+)\.avd$/.exec(avdPath)?.[1] ?? "";
      const handle = this.#inner.spawn(
        binaries.emulator,
        ["-avd", avdName, "-port", String(taken)],
        emulatorOptions,
      );
      running = true;
      void handle.wait().then(() => {
        running = false;
      });
      this.#otherPaths.set(taken, avdPath);
    };
    this.#sentTo = (serial, command) => {
      if (consolePortOf(serial) === port && running && !QUERIES.test(command)) sent.push(command);
    };
    return { observed: () => ({ running, sentByDriver: sent }) };
  }

  #sentTo: (serial: string, command: string) => void = () => undefined;

  runner(): ProcessRunner {
    return {
      run: async (command, args, options) => {
        if (command === binaries.adb && args[0] === "-s") {
          const serial = args[1] ?? "";
          const rest = args.slice(2).join(" ");
          this.#sentTo(serial, rest);
          const answer = this.#identity(serial, rest);
          if (answer !== undefined) return answer;
        }
        return this.#inner.run(command, args, options);
      },
      spawn: (command, args, options) => {
        const take = this.#takeOnNextBoot;
        if (take === undefined || command !== binaries.emulator) {
          return this.#inner.spawn(command, args, options);
        }
        this.#takeOnNextBoot = undefined;
        take(Number(args[args.indexOf("-port") + 1]));
        const handle = this.#inner.spawn(command, args, options);
        let killed!: () => void;
        const exitSeen = new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          ...handle,
          kill: (signal) => {
            handle.kill(signal);
            killed();
          },
          wait: async () => {
            await exitSeen;
            return handle.wait();
          },
        };
      },
      spawnStreaming: (command, args, options) =>
        this.#inner.spawnStreaming(command, args, options),
    };
  }

  #identity(serial: string, command: string): ProcessResult | undefined {
    const path = this.avdPathAnswering(serial);
    if (path === undefined) return undefined;
    const name = /([^/]+)\.avd$/.exec(path)?.[1] ?? "";
    if (command === "emu avd path") return ok(`${path}\nOK\n`);
    if (command === "emu avd name") return ok(`${name}\nOK\n`);
    if (command === "shell getprop ro.boot.qemu.avd_name") return ok(`${name}\n`);
    return undefined;
  }
}

/** `inner`, with every `adb -s <serial> emu avd path` answered by `answer`. */
function answeringAvdPath(inner: ProcessRunner, answer: ProcessResult): ProcessRunner {
  return {
    run: async (command, args, options) =>
      command === binaries.adb && args[0] === "-s" && args.slice(2).join(" ") === "emu avd path"
        ? answer
        : inner.run(command, args, options),
    spawn: (command, args, options) => inner.spawn(command, args, options),
    spawnStreaming: (command, args, options) => inner.spawnStreaming(command, args, options),
  };
}

/** Commands that only read an emulator's state. */
const QUERIES = /^(shell getprop \S+|emu avd (name|path|id|status|discoverypath))$/;

/**
 * The message of the driver's `DriverCrashError`; anything else -- a boot timeout, the fake's
 * own complaint about an unscripted call -- is rethrown, so it fails the test as itself.
 */
function driverCrashMessage(error: unknown): { readonly refused: string } {
  if (error instanceof Error && error.name === "DriverCrashError") {
    return { refused: error.message };
  }
  throw error;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
