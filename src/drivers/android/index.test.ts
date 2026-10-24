import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ComponentInUseError,
  ComponentNotOwnedError,
  OWNED_ROOT_MARKER_FILE,
  OwnedRootError,
  PassthroughRefusedError,
  type Driver,
} from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  FakeTcpStreamConnector,
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
import type { DeviceProfileSource } from "./device-profile-source.js";
import { LIBRARY_PROFILES, type LibraryDeviceProfile } from "./profiles/index.js";

const sdk = "/android-sdk";
const home = "/home/simlock";
const simlockHome = "/home/simlock/.simlock";
const instanceId = "instance-1";
const adbServerPort = 5038;
const adbServerPid = 4242;
const adbRecordPath = `${simlockHome}/adb-server.json`;
const avdDirectory = `${simlockHome}/devices/android`;
const scopedEnv = {
  ANDROID_ADB_SERVER_PORT: String(adbServerPort),
  ANDROID_AVD_HOME: avdDirectory,
  ANDROID_HOME: sdk,
} as const;
const scopedOptions = { env: scopedEnv } as const;
// why: The emulator outlives the daemon and is never read from, so it is spawned detached.
const emulatorOptions = { env: scopedEnv, stdio: "ignore" } as const;
const binaries = {
  adb: `${sdk}/platform-tools/adb`,
  avdmanager: `${sdk}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${sdk}/emulator/emulator`,
  sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
} as const;
const libraryModels = LIBRARY_PROFILES.map((profile) => profile.name);

function libraryAliases(extra: Record<string, string[]>): Record<string, string[]> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, [p.id]])), ...extra };
}

function libraryClasses(extra: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, p.deviceClass])), ...extra };
}

const withoutNonPhoneImages: Record<string, string[]> = {
  "Automotive (1024p landscape)": [],
  "Automotive (1080p landscape)": [],
  "Medium Desktop": [],
  "Large Desktop": [],
  "Television (1080p)": [],
  "Television (4K)": [],
  "Wear OS Large Round": [],
  "Wear OS Small Round": [],
};

function libraryRuntimes(
  runtimes: string[],
  extra: Record<string, string[]>,
): Record<string, string[]> {
  return { ...Object.fromEntries(LIBRARY_PROFILES.map((p) => [p.name, runtimes])), ...extra };
}

const pixelDevices = `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n`;
const twoPixelDevices =
  `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n` +
  `---------\nid: 1 or "pixel_9"\n    Name: Pixel 9\n    OEM : Google\n`;

const VIRTUAL_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

const PHYSICAL_DEVICE = {
  address: "R58M123ABC",
  deviceId: "R58M123ABC",
  driverData: {},
  enrolledApps: ["com.example.kept"],
  physical: true,
} as const;

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

    await expect(driver.resolveSpec({ model: "Pixel 5", platform: "android" })).resolves.toEqual({
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    });
  });

  it("resolves the newest installed matching image", async () => {
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

    await expect(driver.resolveSpec({ model: "Pixel 5", platform: "android" })).resolves.toEqual({
      physical: false,
      model: "Pixel 5",
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
      driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "35",
        platform: "android",
      }),
    ).rejects.toMatchObject({ component: "35", downloadable: true, name: "RuntimeMissingError" });
    expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
  });

  describe("image tag", () => {
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
          "pixel_5",
        ]),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      const driver = await createDriver(filesystem, runner, { hostAbi, ids: ["one"] });
      return { driver, filesystem, runner };
    }

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

    it("fails a tag that is not installed for the API level as a runtime that cannot be downloaded, naming the tag, and starts no sdkmanager", async () => {
      const { driver, runner } = await taggedHarness([
        ["34", "google_apis", "arm64-v8a"],
        ["35", "google_apis_playstore", "arm64-v8a"],
      ]);

      const failure = await driver
        .resolveSpec({
          imageTag: "google_apis_playstore",
          model: "Pixel 5",
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
          model: "Pixel 5",
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

    it("fails a tag installed for no API level, with no API level named, naming the tag and no API level", async () => {
      const { driver } = await taggedHarness([["34", "google_apis", "arm64-v8a"]]);

      const failure = await driver
        .resolveSpec({ imageTag: "google_apis_playstore", model: "Pixel 5", platform: "android" })
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

      expect(device.driverData).toMatchObject({ avdName: "simlock_one", port: 5588 });
    },
  );

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
   * why: The half of the daemon-stop fix that argv cannot show. `stdio: "ignore"` alone does not
   * release the event loop -- the ChildProcess handle does -- so without the `unref` a
   * `daemon stop` logged "Daemon stopped" and then sat there for as long as any emulator ran.
   * An emulator is meant to outlive the daemon (`#reattachRunningEmulators` adopts it after a
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
   * "Daemon stopped" stays alive until it fires. Both shutdowns here -- the one `makeReady`
   * does to restart from the new baseline, and the one the test asks for -- see the emulator
   * exit at once, so neither has anything left to wait for.
   */
  it("leaves no timer armed once each shutdown has seen its emulator exit", async () => {
    const harness = await provisionedHarness({
      afterwards: [
        avdPathExpectation("emulator-5586"),
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
        avdPathExpectation("emulator-5586"),
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
        avdPathExpectation("emulator-5586"),
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

  it("captures a named clean baseline once and restores it on a standard reclaim", async () => {
    const harness = await provisionedHarness({ forBaselineReclaim: true });
    const ready = await harness.driver.makeReady(harness.device);

    await expect(harness.driver.reclaim(ready, { clean: "standard" })).resolves.toEqual({
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

    const ready = await harness.driver.makeReady(harness.device);
    const reclaimCallStart = harness.runner.calls.length;

    await expect(harness.driver.reclaim(ready, { clean: "standard" })).resolves.toEqual({
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
    const ready = await harness.driver.makeReady(harness.device);

    const restartedRunner = new ScriptedProcessRunner([
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      avdPathExpectation("emulator-5586"),
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

    await expect(restartedDriver.reclaim(ready, { clean: "standard" })).resolves.toEqual({
      state: "ready",
      strategy: "snapshot",
    });
  });

  it("boots a shutdown device from its persisted clean baseline after a driver restart", async () => {
    const harness = await provisionedHarness();
    const booted = await harness.driver.makeReady(harness.device);

    const restartedRunner = new ScriptedProcessRunner([
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
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

    await expect(restartedDriver.makeReady(booted)).resolves.toMatchObject({
      address: "emulator-5586",
    });
    expect(restartedRunner.calls[2]).toMatchObject({
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
     * why: A settings change reaches the driver through a daemon restart, so each case captures a
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
      const ready = await harness.driver.makeReady(harness.device);
      await harness.filesystem.mkdirp(
        `${avdDirectory}/simlock_one.avd/snapshots/simlock_clean_baseline`,
      );
      // why: A recovery boot never reads the baseline hash, so it never asks the emulator's version.
      const runner = new ScriptedProcessRunner([
        ...(purpose === "recover"
          ? []
          : [processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9")]),
        ...expectations(flags),
        markWriteExpectation("emulator-5586", "device-0"),
      ]);
      const driver = await createDriver(harness.filesystem, runner, { emulator });
      await driver.makeReady(ready, purpose === undefined ? undefined : { purpose });
      return { filesystem: harness.filesystem, runner };
    };
    const rebuild = (flags: readonly string[]) =>
      baselineBuildExpectations({
        emulatorFlags: flags,
        launchArgs: ["-wipe-data", "-no-snapshot-load"],
      });
    const restore = (flags: readonly string[]): ScriptedProcessExpectation[] => [
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
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
      // why: The hash the driver wrote for this exact fixture (image, emulator version, config.ini)
      // before `android.emulator` existed. Under the default launch the hash must still be
      // this value; otherwise every device's first boot after the upgrade is a data wipe.
      const hashBeforeLaunchOptionsExisted = "4e9b7a98";
      const harness = await provisionedHarness();
      const ready = await harness.driver.makeReady(harness.device);
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
      await driver.makeReady(ready);

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
      // why: A recovered device is re-marked like any other ready device: the mark is what proves
      // the device is still Simlock's on the next reconcile.
      expect(
        runner.calls.filter((call) => call.args.some((arg) => arg.includes("simlock-mark.json"))),
      ).toHaveLength(1);
    });
  });

  it("deletes only the provisioned simlock AVD, and stops nothing for one that never booted", async () => {
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
        "pixel_5",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_delete-me"]),
    ]);
    const driver: Driver = await createDriver(filesystem, runner, { ids: ["delete-me"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    });
    const device = await driver.provision(spec);

    await expect(driver.destroy({ ...device, physical: false })).resolves.toBeUndefined();
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
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;

    expect(driver.estimate({ operation: "provision" }, spec)).toBe(1_000);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(70_000);
  });

  it("prices reclaim by the strategy the clean level selects", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new ScriptedProcessRunner([]),
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

    // why: Strict: with no custom device profile there is no `customModels` key at all, not one
    // present as undefined.
    await expect(driver.listCatalog()).resolves.toStrictEqual({
      defaultRuntime: "35",
      images: [
        { abi: "x86_64", runtime: "34", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "x86_64", runtime: "35", tag: "google_apis" },
      ],
      modelAliases: libraryAliases({ "Pixel 5": ["pixel_5"] }),
      modelClasses: libraryClasses({ "Pixel 5": "phone" }),
      modelRuntimes: libraryRuntimes(["34", "35"], {
        ...withoutNonPhoneImages,
        "Pixel 5": ["34", "35"],
        "Pixel 9": ["35"],
        "Pixel 9 Pro XL": ["35"],
      }),
      models: [...libraryModels, "Pixel 5"],
      runtimes: ["34", "35"],
    });
  });

  it("pairs a model with an installed API level whose only image has a foreign ABI, when the image fits", async () => {
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

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog.modelRuntimes).toEqual(
      libraryRuntimes(["33", "35"], {
        ...withoutNonPhoneImages,
        "Pixel 5": ["33", "35"],
        "Pixel 8": ["35"],
        "Pixel 9": ["35"],
        "Pixel 9 Pro XL": ["35"],
      }),
    );
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
      modelAliases: libraryAliases({ "Pixel 5": ["pixel_5"] }),
      modelClasses: libraryClasses({ "Pixel 5": "phone" }),
      modelRuntimes: libraryRuntimes([], { "Pixel 5": [] }),
      models: [...libraryModels, "Pixel 5"],
      runtimes: [],
    });
  });

  it("lists a built-in profile's avdmanager id as another name for its model", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
  });

  it("lists no other name when the id equals the display name ignoring case", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(
        binaries.avdmanager,
        ["list", "device"],
        `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n---------\n` +
          `id: 1 or "Automotive_1024p"\n    Name: automotive_1024p\n`,
      ),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "automotive_1024p"]);
    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
  });

  it("resolves every listed name of every listed model, in upper and lower case, to that model", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["36", "google_apis", "arm64-v8a"],
        ["36", "android-tv", "arm64-v8a"],
        ["36", "android-wear", "arm64-v8a"],
        ["36", "android-automotive", "arm64-v8a"],
        ["36", "android-automotive-playstore", "arm64-v8a"],
        ["36", "android-desktop", "arm64-v8a"],
      ],
    });
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
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContainEqual({ model: "Pixel 5", name: "pixel_5" });
    expect(names).toContainEqual({ model: "Pixel 5", name: "Pixel 5" });
    expect(names).toContainEqual({ model: "My Tablet", name: "My Tablet" });

    for (const { model, name } of names) {
      for (const spelling of [name.toUpperCase(), name.toLowerCase()]) {
        await expect(driver.resolveSpec({ model: spelling, platform: "android" })).resolves.toEqual(
          { physical: false, model, osVersion: "36", platform: "android" },
        );
      }
    }
  });

  it("lists the same models as before other names were listed, for the same profiles", async () => {
    // why: A devices.xml profile named after a built-in id stays listed, and one whose name repeats a
    // built-in name in other letter case does not: both exactly as before this catalog listed
    // other names.
    const filesystem = await androidFilesystem();
    await writeDevicesXml(
      filesystem,
      customDeviceXml("pixel_5", 4096) +
        customDeviceXml("PIXEL 9", 4096) +
        customDeviceXml("My Tablet", 4096),
    );
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "pixel_5", "My Tablet"]);
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

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5", "My Tablet"]);
    expect(catalog.customModels).toEqual(["My Tablet"]);
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

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog).not.toHaveProperty("customModels");
  });

  it("lists models with one avdmanager run", async () => {
    // why: A second answer is scripted, so a second run would be served and counted, not refused.
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.models).toEqual([...libraryModels, "Pixel 5"]);
    expect(catalog.modelAliases).toEqual(libraryAliases({ "Pixel 5": ["pixel_5"] }));
    expect(runner.calls.filter((call) => call.command === binaries.avdmanager)).toHaveLength(1);
  });

  it("lists every installed system image with its API level, tag, and ABI, a foreign-ABI image included", async () => {
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
    // why: Directory listings come back in reverse, so a list read straight off the disk would be in
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
    // why: Only API 34 is installed. An API 35 image is one `sdkmanager` run away, and the driver
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

  it("reports one running root AVD, one stopped root AVD and the running AVD's process", async () => {
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
      avdPathExpectation("emulator-5586", "simlock_running"),
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

  it("answers virtualLeaseEnvironment with simlock's adb port, and leaseEnvironment for a virtual device equals it", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

    expect(driver.virtualLeaseEnvironment()).toEqual({
      ANDROID_ADB_SERVER_PORT: String(adbServerPort),
    });
    expect(driver.leaseEnvironment(VIRTUAL_DEVICE)).toEqual(driver.virtualLeaseEnvironment());
  });

  it("hands a lease holder of a physical device its serial and the default adb server", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

    expect(driver.leaseEnvironment(PHYSICAL_DEVICE)).toEqual({
      ANDROID_ADB_SERVER_PORT: "5037",
      ANDROID_SERIAL: "R58M123ABC",
    });
  });

  it("answers uninstall for the reclaim strategy of a physical device, and snapshot for an emulator's", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

    expect(driver.reclaimStrategy(VIRTUAL_DEVICE, { clean: "standard" })).toBe("snapshot");
    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "standard" })).toBe("uninstall");
    expect(driver.reclaimStrategy(PHYSICAL_DEVICE, { clean: "full" })).toBe("uninstall");
  });

  it("listManaged passes a 30-second timeout to adb devices", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    await driver.listManaged();

    const listing = runner.calls.find((call) => call.args[0] === "devices");
    expect(listing?.options.timeoutMs).toBe(30_000);
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
    // why: Only settled `device`-state serials are counted as running processes; the
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
        "pixel_5",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ...baselineBuildExpectations({ launchArgs: ["-no-snapshot-load"] }),
      markWriteExpectation("emulator-5586", "device-2"),
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
      avdPathExpectation("emulator-5586"),
      markWriteExpectation("emulator-5586", "device-3"),
    ]);
    const driver = await createDriver(filesystem, runner, { clock, ids: ["one"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 5",
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
        "pixel_5",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ...baselineBuildExpectations({ launchArgs: ["-no-snapshot-load"] }),
      markWriteExpectation("emulator-5554", "device-2"),
    ]);
    const driver = await createDriver(filesystem, runner, { ids: ["one"] });
    const spec = await driver.resolveSpec({
      model: "Pixel 5",
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
    const ready = await harness.driver.makeReady(harness.device);

    await harness.driver.reclaim(ready, { clean: "standard" });

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
        "pixel_5",
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
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
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
      avdPathExpectation("emulator-5586"),
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
      avdPathExpectation("emulator-5586"),
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

    // why: An emulator can vanish between `adb devices` and the read. Losing the whole
    // reality view over one dead serial would strand every other managed device.
    const reality = await driver.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.runState).toBe("transitioning");
    // why: The durable half is a host file and stays readable; the erasable half genuinely
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
      const runner = new ScriptedProcessRunner([
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
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

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
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
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
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]), {
        deviceProfileSources: [],
      });

      expect(await hiddenProfileAdvisories(driver)).toEqual([]);
    });
  });

  describe("device-profile sources", () => {
    it("resolves a devices.xml-only model and applies its properties to config.ini", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(filesystem, customDeviceXml("Custom A", 4096));
      // why: `avdmanager create avd` is scripted (not a real process), so it never creates the AVD
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
          "pixel_5",
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
      expect(spec).toEqual({
        physical: false,
        model: "Custom A",
        osVersion: "34",
        platform: "android",
      });

      const device = await driver.provision(spec);

      const config = await filesystem.readFile(`${avdDirectory}/simlock_one.avd/config.ini`);
      expect(config).toContain("hw.device.name=Custom A");
      expect(config).toContain("hw.ramSize=4096");
      // why: The avdmanager `-d` seed uses a built-in device only to skip the interactive prompt --
      // it must never leak into the resolved spec or the applied hardware properties.
      expect(config).not.toContain("pixel_5");
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
            "pixel_5",
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
      // why: same name as the built-in fixture's "Pixel 5" -- the built-in source is registered
      // first, so it must win and the devices.xml properties must never be touched.
      await writeDevicesXml(filesystem, customDeviceXml("Pixel 5", 4096));
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
          "pixel_5",
        ]),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });

      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      await driver.provision(spec);

      // why: Only one `avdmanager list device` call happened (asserted implicitly by the runner
      // never receiving the unscripted second call a `properties`-profile seed lookup would
      // require), and no properties were merged into config.ini -- it was never even written.
      await expect(filesystem.exists(`${avdDirectory}/simlock_one.avd/config.ini`)).resolves.toBe(
        false,
      );
    });

    it("rejects a hardware-property value with an embedded line break, defense in depth beyond the devices.xml parser", async () => {
      // why: `UserDeviceProfileSource`/`parseDevicesXml` already reject this at the devices.xml parse
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
          "pixel_5",
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
        // why: Adopt the recorded server `recordRunningAdbServer` just wrote, exactly as the
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
        driver.resolveSpec({
          model: "Nonexistent Model",
          osVersion: "34",
          platform: "android",
        }),
      ).rejects.toMatchObject({ name: "UnknownModelError" });

      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: "device-profile-source-unreadable" }),
      ]);
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
        secondList: true,
      });
      const userSpec = await userHarness.resolve("Custom A");
      await userHarness.driver.provision(userSpec);

      expect(userSpec.model).toBe("Custom A");
      expect((await userHarness.config()).get("hw.ramSize")).toBe("4096");
    });

    it("lists Pixel 9 first in the catalog, once, as `phone`, not custom, with `pixel_9` as its other name", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(
        filesystem,
        customDeviceXml("pixel_9", 4096) + customDeviceXml("PIXEL 9", 4096),
      );
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ]);
      const driver = await createDriver(filesystem, runner);

      const catalog = await driver.listCatalog();

      expect(catalog.models[0]).toBe("Pixel 9");
      expect(catalog.models.filter((model) => model.toLocaleLowerCase() === "pixel 9")).toEqual([
        "Pixel 9",
      ]);
      expect(catalog.modelClasses["Pixel 9"]).toBe("phone");
      expect(catalog.customModels ?? []).not.toContain("Pixel 9");
      expect(catalog.modelAliases["Pixel 9"]).toEqual(["pixel_9"]);
    });

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

    it("refuses NUL in a `simlock.mark` value, through the one shared check", async () => {
      const accepted = await provisionedHarness({
        firstMarkToken: "tok-en",
        ids: ["one", "tok-en"],
      });
      await accepted.driver.makeReady(accepted.device);
      const acceptedConfig = await accepted.filesystem.readFile(
        `${avdDirectory}/simlock_one.avd/config.ini`,
      );
      expect(acceptedConfig).toContain("simlock.mark=tok-en");

      const refused = await provisionedHarness({
        firstMarkToken: "tok\u0000en",
        ids: ["one", "tok\u0000en"],
      });

      await expect(refused.driver.makeReady(refused.device)).rejects.toThrow(/Refusing to merge/);
      const refusedConfig = await refused.filesystem.readFile(
        `${avdDirectory}/simlock_one.avd/config.ini`,
      );
      expect(refusedConfig).not.toContain("simlock.mark=");
    });

    it("rethrows and deletes nothing when a write after `avdmanager create avd` fails", async () => {
      const filesystem = new WriteFailureFilesystem(
        `${avdDirectory}/simlock_one.avd/config.ini`,
        new Error("disk full"),
      );
      const harness = await libraryHarness({ filesystem, listing: pixelDevices });
      const seeded = await filesystem.readFile(harness.configPath);
      filesystem.armed = true;

      await expect(harness.provision("Pixel 9")).rejects.toThrow("disk full");

      filesystem.armed = false;
      expect(harness.createCalls()).toHaveLength(1);
      expect(harness.runner.calls.some((call) => call.args.includes("delete"))).toBe(false);
      await expect(filesystem.readFile(harness.configPath)).resolves.toBe(seeded);
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
      // why: The two documented sdkmanager phrasings this driver's license detection claims to
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

      // why: Settled within a few microtasks of the signal: the kill ended it, not a timer.
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

describe("AndroidDriver screen capture", () => {
  const serverPath = "/simlock/vendor/scrcpy-server-v5.0.1";
  const running = {
    address: "emulator-5586",
    deviceId: "simlock_one",
    driverData: { avdName: "simlock_one", configHash: "h", port: 5586, serial: "emulator-5586" },
    physical: false,
  } as const;
  const settings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };

  it("is offered only when both the server path and a TCP stream connector are given", async () => {
    const both = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]), {
      scrcpyServerPath: serverPath,
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(both.screenCapture).toBeDefined();
    const noPath = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]), {
      tcpStreamConnector: new FakeTcpStreamConnector(),
    });
    expect(noPath.screenCapture).toBeUndefined();
    const noConnector = await createDriver(
      await androidFilesystem(),
      new ScriptedProcessRunner([]),
      {
        scrcpyServerPath: serverPath,
      },
    );
    expect(noConnector.screenCapture).toBeUndefined();
  });

  it("pushes the server with this driver's adb, its scoped environment and the device's serial", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp("/simlock/vendor");
    await filesystem.writeFileAtomic(serverPath, "jar");
    const runner = new ScriptedProcessRunner([
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
    const runner = new ScriptedProcessRunner([]);
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
      // why: Listening, but nothing says it is Simlock's -- it could be Android Studio's.
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

    expect(driver.leaseEnvironment(VIRTUAL_DEVICE)).toEqual({ ANDROID_ADB_SERVER_PORT: "5199" });
    await driver.resolveSpec({ model: "Pixel 5", platform: "android" });
    expect(runner.calls[0]?.options).toEqual({
      env: { ...scopedEnv, ANDROID_ADB_SERVER_PORT: "5199" },
    });
  });

  it("points an adb passthrough at Simlock's own server, which is the only one that sees it", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    const args = ["shell", "input", "tap", "100", "200"];
    const expected = {
      args: ["-P", String(adbServerPort), ...args],
      command: binaries.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(adbServerPort) },
    };

    expect(await passthroughOf(driver, args)).toEqual(expected);
    expect(await passthroughOf(driver, args, undefined, VIRTUAL_DEVICE)).toEqual(expected);
  });

  it("fills an emulator's serial into an adb command that names no device", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
    const emulator = {
      address: "emulator-5554",
      deviceId: "device",
      driverData: {},
      physical: false,
    } as const;
    const scoped = ["-P", String(adbServerPort)];
    const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
      [
        ["shell", "getprop"],
        ["-s", "emulator-5554", "shell", "getprop"],
      ],
      [
        ["install", "app.apk"],
        ["-s", "emulator-5554", "install", "app.apk"],
      ],
      [
        ["reverse", "--list"],
        ["-s", "emulator-5554", "reverse", "--list"],
      ],
      [
        ["-s", "emulator-5554", "shell", "getprop"],
        ["-s", "emulator-5554", "shell", "getprop"],
      ],
      [["devices"], ["devices"]],
      [["version"], ["version"]],
      [["--version"], ["--version"]],
      [
        ["forward", "--list"],
        ["forward", "--list"],
      ],
      [
        ["reconnect", "offline"],
        ["reconnect", "offline"],
      ],
    ];

    for (const [args, expected] of cases) {
      expect((await passthroughOf(driver, args, { hasTerminal: false }, emulator)).args).toEqual([
        ...scoped,
        ...expected,
      ]);
    }
  });

  it("refuses an emulator adb command that names another device, or that runs on another platform", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
    const emulator = {
      address: "emulator-5554",
      deviceId: "device",
      driverData: {},
      physical: false,
    } as const;
    const context = { hasTerminal: false, platform: "android" };
    const refusal = (command: string, named: string) =>
      `Refusing \`adb ${command}\`: it names device ${named}, and this lease holds emulator-5554. Leave the device out; Simlock fills it in.`;
    const cases: readonly (readonly [readonly string[], string])[] = [
      [
        ["-s", "emulator-5556", "shell", "getprop"],
        refusal("-s emulator-5556 shell getprop", "-s emulator-5556"),
      ],
      [["-e", "shell", "getprop"], refusal("-e shell getprop", "-e")],
      [["-d", "shell", "getprop"], refusal("-d shell getprop", "-d")],
      [["-t", "3", "shell", "getprop"], refusal("-t 3 shell getprop", "-t 3")],
      [["-t3", "shell", "getprop"], refusal("-t3 shell getprop", "-t3")],
      [
        ["-t", "emulator-5554", "shell", "getprop"],
        refusal("-t emulator-5554 shell getprop", "-t emulator-5554"),
      ],
    ];

    for (const [args, message] of cases) {
      await expect(passthroughOf(driver, args, context, emulator)).rejects.toMatchObject({
        message,
        tool: "adb",
      });
    }
    await expect(
      passthroughOf(
        driver,
        ["shell", "getprop"],
        { hasTerminal: false, platform: "ios" },
        emulator,
      ),
    ).rejects.toMatchObject({
      message:
        "Refusing `adb`: it only serves an Android device, and this lease is on the ios platform.",
      tool: "adb",
    });
  });

  it("claims only the adb passthrough tool", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    expect((driver as unknown as { passthroughTools: unknown }).passthroughTools).toEqual(["adb"]);
  });

  it("rejects a refusal with PassthroughRefusedError naming adb, never throwing it synchronously", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
    const routed = driver as unknown as {
      passthrough(tool: string, device: unknown, args: readonly string[]): unknown;
    };

    const returned = routed.passthrough("adb", undefined, ["kill-server"]);

    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toMatchObject({ tool: "adb" });
    await expect(returned).rejects.toBeInstanceOf(PassthroughRefusedError);
  });

  it("refuses kill-server, which would detach every leased emulator at once", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(passthroughOf(driver, ["kill-server"])).rejects.toThrow(PassthroughRefusedError);
    await expect(passthroughOf(driver, ["kill-server"])).rejects.toThrow(/simlock release/);
  });

  it("refuses kill-server behind a global flag, not only in first position", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    // why: Every other case passes it first, so an `args[0] === "kill-server"` rule would pass
    // them all; this is the one that holds the documented "anywhere in the arguments".
    await expect(passthroughOf(driver, ["-P", "1", "kill-server"])).rejects.toThrow(
      PassthroughRefusedError,
    );
  });

  it.each([[["emu", "avd", "stop"]], [["-s", "emulator-5586", "emu", "avd", "stop"]]])(
    "refuses an emu avd stop that would stop a device Simlock believes is running: %j",
    async (args) => {
      const filesystem = await androidFilesystem();
      const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

      await expect(passthroughOf(driver, args)).rejects.toThrow(PassthroughRefusedError);
      await expect(passthroughOf(driver, args)).rejects.toThrow(/simlock release/);
    },
  );

  it("refuses to delete the snapshot every later reclaim restores from", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(
      passthroughOf(driver, ["emu", "avd", "snapshot", "delete", "default_boot"]),
    ).rejects.toThrow(PassthroughRefusedError);
    await expect(
      passthroughOf(driver, ["emu", "avd", "snapshot", "delete", "default_boot"]),
    ).rejects.toThrow(/full wipe/);
  });

  it("refuses an emu kill pair even behind the -s serial that targets a device", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(passthroughOf(driver, ["-s", "emulator-5586", "emu", "kill"])).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(passthroughOf(driver, ["-s", "emulator-5586", "emu", "kill"])).rejects.toThrow(
      /simlock cleanup/,
    );
  });

  it("refuses a caller-supplied server flag in the globals, in every spelling adb accepts, and any global it does not recognize", async () => {
    // why: `adb` takes the *last* `-P` on the line, so a caller-supplied one silently wins over the
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
      // why: `--reply-fd` is a real, value-taking adb global absent from `adb --help` (confirmed
      // against the adb binary: it errors `--reply-fd requires an argument`, not `unknown
      // command`). A scanner that assumes an unrecognized flag takes no value reads its value
      // (`9`) as the subcommand and never notices the `-H`/`-P` that follow -- the exact
      // bypass this allow-list scan closes by refusing anything it does not recognize.
      ["--reply-fd", "9", "-H", "attacker.example", "-P", "5037", "shell", "id"],
      // why: Other real adb globals this driver has no reason to allow through, none of which may
      // silently terminate the scan either: an unrecognized flag is refused on sight, not
      // treated as ending the globals region.
      ["-a", "devices"],
      ["--exit-on-write-error", "devices"],
      ["--one-device", "usb:1", "devices"],
      // why: A wholly invented flag stands in for "the next adb release adds one": this list must
      // refuse what it has never seen, not just what it already knows to refuse.
      ["--not-a-real-adb-flag", "devices"],
      // why: adb answers `--version`/`--help` and exits without looking at the rest of the line, so
      // this scan cannot vouch for anything after one and must not wave a caller-supplied
      // `-P`/`-H` through behind either flag; they are safe only alone (allowed below).
      ["--version", "-P", "5037", "shell", "id"],
      ["--help", "-H", "evil", "shell", "id"],
    ]) {
      await expect(passthroughOf(driver, args), args.join(" ")).rejects.toThrow(
        PassthroughRefusedError,
      );
      await expect(
        passthroughOf(driver, args, { hasTerminal: false }),
        args.join(" "),
      ).rejects.toThrow(/supplies the adb server itself/);
    }

    // why: Past the subcommand every argument is that subcommand's operand, so one that merely
    // looks like a global travels through: refusing `echo -Please` would break a working
    // command to prevent nothing.
    for (const args of [
      ["shell", "echo", "-Please"],
      ["shell", "getprop", "-P5037"],
      ["-s", "emulator-5554", "devices"],
      ["-t", "1", "devices"],
      ["-t1", "devices"],
      ["-d", "devices"],
      ["-e", "devices"],
      // why: `--version` and `--help` answer on their own before adb ever looks for a subcommand,
      // so this scan treats them as the subcommand rather than as a global with an arity.
      ["--version"],
      ["--help"],
    ]) {
      expect((await passthroughOf(driver, args)).args, args.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...args,
      ]);
    }
  });

  it("refuses a bare `adb shell` only where the caller has no terminal, never merely because `shell` is the last word", async () => {
    // why: ADR 0005 §19c: `device.exec` runs the command on this machine with pipes and no pty, so
    // an interactive shell there is a process reading a pipe nothing will ever write to --
    // it would hang until `exec.timeoutMs` killed it. Locally, where the CLI hands the tool
    // its own tty, it is exactly the command a lease holder wants, so it stays allowed.
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(passthroughOf(driver, ["shell"], { hasTerminal: false })).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(passthroughOf(driver, ["shell"], { hasTerminal: false })).rejects.toThrow(
      /terminal/,
    );
    await expect(
      passthroughOf(driver, ["-s", "emulator-5586", "shell"], { hasTerminal: false }),
    ).rejects.toThrow(PassthroughRefusedError);

    // why: A shell with something to run is not the interactive shell, and neither is anything
    // else -- the refusal is about the missing command, not about `shell`. Round 4, F2: this
    // is the case the naive "does the line end in the word `shell`" check got wrong -- every
    // one of these genuinely ends in `shell`, but as an operand of an earlier subcommand
    // (`shell`, `push`), never as the bare subcommand itself, so none of them is the
    // interactive shell this refusal exists for.
    expect(
      (await passthroughOf(driver, ["shell", "getprop"], { hasTerminal: false })).args,
    ).toEqual(["-P", String(adbServerPort), "shell", "getprop"]);
    expect((await passthroughOf(driver, ["devices"], { hasTerminal: false })).args).toContain(
      "devices",
    );
    for (const args of [
      ["shell", "echo", "shell"],
      ["shell", "input", "text", "shell"],
      ["shell", "shell"],
      ["push", "./x", "shell"],
    ]) {
      expect(
        (await passthroughOf(driver, args, { hasTerminal: false })).args,
        args.join(" "),
      ).toEqual(["-P", String(adbServerPort), ...args]);
    }

    expect((await passthroughOf(driver, ["shell"], { hasTerminal: true })).args).toEqual([
      "-P",
      String(adbServerPort),
      "shell",
    ]);
    expect((await passthroughOf(driver, ["shell"])).args).toContain("shell");
  });

  it("proxies the emu subcommands that do not stop a device", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    for (const subcommand of [
      ["emu", "avd", "name"],
      ["emu", "avd", "snapshot", "list"],
    ]) {
      expect((await passthroughOf(driver, subcommand)).args, subcommand.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...subcommand,
      ]);
    }
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

    // why: By pid, because `ADB_REJECT_KILL_SERVER=1` means `adb kill-server` refuses Simlock too.
    expect(processSupervisor.signals).toEqual([{ pid: adbServerPid, signal: "SIGTERM" }]);
    await expect(filesystem.exists(adbRecordPath)).resolves.toBe(false);
  });
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
        const runner = new ScriptedProcessRunner([
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

  it("does not attribute an outside-root emulator to a root AVD with the same name (#261)", async () => {
    const filesystem = await androidFilesystem();
    const ownedPath = `${avdDirectory}/simlock_mine.avd`;
    const foreignPath = `${home}/.android/avd/simlock_mine.avd`;
    await filesystem.mkdirp(ownedPath);
    await filesystem.writeFileAtomic(`${ownedPath}/config.ini`, "simlock.mark=owned-token\n");
    await filesystem.mkdirp(foreignPath);

    for (const path of [ownedPath, foreignPath]) {
      const runner = answeringAvdPath(
        new ScriptedProcessRunner([
          processResult(
            binaries.adb,
            ["devices"],
            "List of devices attached\nemulator-5586\tdevice\n",
          ),
          processResult(
            binaries.adb,
            ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
            'simlock_mine\n{"token":"owned-token"}',
          ),
        ]),
        ok(`${path}\r\nOK\r\n`),
      );
      const driver = await createDriver(filesystem, runner);

      const reality = await driver.listManaged();

      expect
        .soft(reality.processes, path)
        .toEqual(
          path === ownedPath
            ? [expect.objectContaining({ address: "emulator-5586", deviceId: "simlock_mine" })]
            : [],
        );
      expect.soft(reality.devices, path).toEqual([
        expect.objectContaining({
          deviceId: "simlock_mine",
          runState: path === ownedPath ? "running" : "stopped",
          mark: {
            durable: "owned-token",
            erasable: path === ownedPath ? "owned-token" : undefined,
            erasableReadable: path === ownedPath,
          },
        }),
      ]);
    }
  });

  it("manages every AVD in its root, whatever the AVD is called", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/a-name-nobody-prefixed.avd`);
    await filesystem.mkdirp(`${avdDirectory}/Odd.Name_3.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const driver = await createDriver(filesystem, runner);

    const reality = await driver.listManaged();

    expect(reality.devices.map((device) => device.deviceId).sort()).toEqual([
      "Odd.Name_3",
      "a-name-nobody-prefixed",
    ]);
  });

  it("ignores a running emulator whose AVD does not live in its root", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_mine.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
        // why: Named exactly like one of Simlock's, and still not Simlock's: the AVD is not in
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
  it("refuses to ready a device whose serial an emulator of an AVD outside its root answers, and changes nothing on that emulator, even when the device is then shut down (#256)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const machine = new PortTakingMachine(host);
    const driver = await createDriver(filesystem, machine.runner(), { ids: ["one"] });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);

    // why: Another emulator takes the device's console port before its own emulator binds it --
    // whatever freed the port for it (#52, a second Simlock instance, the user's own
    // emulator). Its AVD is named like Simlock's but lives in the user's AVD home: a name
    // proves nothing, root membership does (safety rule 8).
    const otherPath = `${home}/.android/avd/simlock_one.avd`;
    const other = machine.takePortOnNextBoot(otherPath);

    const readied = await driver.makeReady(stopped).then(
      (ready) => machine.avdPathAnswering(ready.address),
      (error: unknown) => driverCrashMessage(error),
    );
    // why: What the core does with a device whose boot failed: it destroys it, and destroying a
    // device starts by shutting it down.
    await driver.shutdown(stopped);

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

  it.each<{
    readonly reported: string;
    readonly answer: string;
    readonly filesystem?: () => MemoryFilesystem;
  }>([
    { answer: `${avdDirectory}/simlock_one.avd\r\nOK\r\n`, reported: "exactly" },
    { answer: `${avdDirectory}/simlock_one.avd/\r\nOK\r\n`, reported: "with a trailing slash" },
    {
      answer: `/private${avdDirectory}/simlock_one.avd\r\nOK\r\n`,
      reported: "through a link to the device root's directory",
    },
    // why: `/home` is a link to `/private/home`, as macOS's `/var` is to `/private/var`: the link
    // is on the device root's side, and the emulator answers with the resolved path.
    {
      answer: `/private${avdDirectory}/simlock_one.avd\r\nOK\r\n`,
      filesystem: () => new LinkedHomeFilesystem(),
      reported: "resolved, when the device root's own path runs through a link",
    },
  ])(
    "readies a device whose emulator reports its AVD directory $reported",
    async ({ answer, filesystem: createFilesystem, reported }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (createFilesystem === undefined) filesystem.defineSymlink("/private/home", "/home");
      const host = new EmulatorHost(filesystem);
      const runner = answeringAvdPath(host.runner(), ok(answer));
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      const device = await driver.provision(spec);
      if (reported === "exactly") {
        // why: An exact answer needs nothing from the filesystem: a directory that cannot be
        // resolved this moment does not fail the boot.
        filesystem.defineFailure(`${avdDirectory}/simlock_one.avd`, "EACCES");
      }

      const ready = await driver.makeReady(device);

      expect(ready.address).toBe("emulator-5586");
    },
  );

  it.each<{
    readonly answered: string;
    readonly answer: ProcessResult;
    readonly filesystem?: () => MemoryFilesystem;
    readonly existing?: string;
  }>([
    { answer: ok("KO: unknown command\r\n"), answered: "a console error" },
    {
      answer: { code: 1, stderr: "error: could not connect to console", stdout: "" },
      answered: "a failed adb call",
    },
    {
      answer: ok(`/private/elsewhere/simlock_one.avd\r\nOK\r\n`),
      answered: "a directory that does not exist",
    },
    {
      answer: ok(`${avdDirectory}/simlock_two.avd\r\nOK\r\n`),
      answered: "another device's directory in the same root",
      existing: `${avdDirectory}/simlock_two.avd`,
    },
    {
      answer: ok(`${home}/.android/avd/simlock_one.avd\r\nOK\r\n`),
      answered: "a directory of the same name outside the root",
      existing: `${home}/.android/avd/simlock_one.avd`,
    },
    {
      answer: ok(`\r\n${avdDirectory}/simlock_one.avd\r\nOK\r\n`),
      answered: "its own directory below a blank first line",
    },
    {
      // why: Resolved against the daemon's working directory, which here is the device root, a
      // relative answer would name the device's own directory -- by accident.
      answer: ok("simlock_one.avd\r\nOK\r\n"),
      answered: "a relative path",
      filesystem: () => new WorkingDirectoryFilesystem(avdDirectory),
    },
  ])(
    "refuses to ready a device whose emulator answers the AVD path query with $answered, and stops that emulator",
    async ({ answer, existing, filesystem: createFilesystem }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (existing !== undefined) await filesystem.mkdirp(existing);
      const host = new EmulatorHost(filesystem);
      const runner = answeringAvdPath(host.runner(), answer);
      const driver = await createDriver(filesystem, runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
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
    // why: A running emulator announced itself exactly once, to a server a previous daemon has
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
    // why: Every send goes to Simlock's own server, and every port is inside Simlock's range:
    // one below 5587 would be adb connecting to an emulator of the user's.
    expect(tcpProbe.sends.every((send) => send.port === adbServerPort)).toBe(true);
  });

  it("finishes the sweep when a port refuses the announcement", async () => {
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(
      createDriver(filesystem, new ScriptedProcessRunner([]), { tcpProbe }),
    ).resolves.toBeDefined();
    expect(tcpProbe.sends).toHaveLength(49);
  });

  it("re-announces an emulator that stays unreachable, since nothing else will", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 2 });
    // why: Nothing is announced when an emulator is spawned: adb answers `host:emulator:<port>`
    // by connecting out to that port, and the emulator has not opened it yet.
    const afterSweep = harness.tcpProbe.sends.length;
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(1));
    expect(harness.tcpProbe.sends).toHaveLength(afterSweep);

    // why: Past the grace period on the second failure: adb's own reconnect queue is drained by
    // the scanner thread, which `ADB_EMU=0` does not run.
    harness.clock.advance(6_000);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(2));
    await vi.waitFor(() =>
      expect(harness.tcpProbe.sends.slice(afterSweep)).toEqual([
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

function recordKillTimeout(
  into: (number | undefined)[],
  command: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): void {
  if (command === binaries.adb && args.slice(2).join(" ") === "emu kill") into.push(timeoutMs);
}

describe("AndroidDriver console ports across a restart", () => {
  it("stops a discovered running emulator before deleting its AVD after a restart", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runningAtDeletion: (string | undefined)[] = [];
    const killTimeouts: (number | undefined)[] = [];
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        recordKillTimeout(killTimeouts, command, args, options?.timeoutMs);
        if (
          command === binaries.adb &&
          args[2] === "shell" &&
          args[3] ===
            "getprop ro.boot.qemu.avd_name; cat /data/local/tmp/simlock-mark.json 2>/dev/null || true"
        ) {
          return ok(`${host.avdAnswering(args[1]) ?? ""}\n`);
        }
        if (command === binaries.avdmanager && args[0] === "delete") {
          runningAtDeletion.push(host.avdAnswering(running.address));
        }
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner, { readinessTimeoutMs: 0 });
    const reality = await after.listManaged();
    const orphan = reality.devices[0]!;
    expect(orphan).toMatchObject({ deviceId: running.deviceId, runState: "running" });
    expect(host.avdAnswering(running.address)).toBe(running.deviceId);

    await after.destroy(orphan);

    expect(runningAtDeletion, "the emulator must have exited before AVD deletion").toEqual([
      undefined,
    ]);
    expect(killTimeouts, "the kill must be bounded").toEqual([5_000]);
    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}.avd`)).toBe(false);
  });

  it("refuses to delete the AVD of a discovered emulator that does not exit", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) =>
        args.includes("kill") ? ok() : inner.run(command, args, options),
    };
    const after = await createDriver(filesystem, runner, { readinessTimeoutMs: 0 });
    const orphan = (await after.listManaged()).devices[0]!;

    await expect(after.destroy(orphan)).rejects.toThrow("did not exit");

    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}.avd`)).toBe(true);
  });

  it("refuses to delete the AVD when an attached emulator cannot say which AVD it runs", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const inner = answeringAvdPath(host.runner(), { code: 1, stderr: "error", stdout: "" });
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (command === binaries.adb) calls.push({ args, timeoutMs: options?.timeoutMs });
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner, { readinessTimeoutMs: 0 });
    const orphan = (await after.listManaged()).devices[0]!;

    await expect(after.destroy(orphan)).rejects.toThrow("could not tell which AVD");

    expect({
      kills: calls.filter((call) => call.args.includes("kill")).length,
      probeTimeoutMs: calls.find((call) => call.args.includes("path"))?.timeoutMs,
      kept: await filesystem.exists(`${avdDirectory}/${running.deviceId}.avd`),
      running: host.avdAnswering(running.address),
    }).toEqual({ kills: 0, probeTimeoutMs: 5_000, kept: true, running: running.deviceId });
  });

  it("never kills an emulator that runs a different AVD when deleting a discovered one", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const kills: string[] = [];
    const inner = answeringAvdPath(host.runner(), ok(`${avdDirectory}/simlock_other.avd\nOK\n`));
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (args.includes("kill")) kills.push(args.join(" "));
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner, { readinessTimeoutMs: 0 });
    const orphan = (await after.listManaged()).devices[0]!;

    await after.destroy(orphan);

    expect({ kills, running: host.avdAnswering(running.address) }).toEqual({
      kills: [],
      running: running.deviceId,
    });
  });

  it.each(["shutdown", "full reclaim", "standard reclaim"] as const)(
    "%s after a restart sends neither kill nor snapshot load to another device on the stored serial (#284)",
    async (operation) => {
      const spec = {
        physical: false,
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      } as const;
      const filesystem = await androidFilesystem();
      const host = new EmulatorHost(filesystem);
      const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
      await before.resolveSpec(spec);
      const stopped = await before.makeReady(await before.provision(spec));
      await before.shutdown(stopped);

      const runner = new RecordingRunner(host.runner());
      const after = await createDriver(filesystem, runner, { ids: ["two"] });
      await after.resolveSpec(spec);
      const running = await after.makeReady(await after.provision(spec));
      expect(running.address).toBe(stopped.address);
      expect(host.avdAnswering(running.address)).toBe("simlock_two");
      const callStart = runner.calls.length;

      const action =
        operation === "shutdown"
          ? after.shutdown(stopped)
          : after.reclaim(stopped, {
              clean: operation === "full reclaim" ? "full" : "standard",
            });
      await action.then(() => undefined, driverCrashMessage);

      expect({
        running: host.avdAnswering(running.address),
        mutations: runner.calls
          .slice(callStart)
          .filter(
            (call) =>
              call.command === binaries.adb &&
              call.args[1] === running.address &&
              (call.args.slice(2).join(" ") === "emu kill" ||
                call.args.slice(2, 6).join(" ") === "emu avd snapshot load"),
          )
          .map((call) => call.args),
      }).toEqual({ running: "simlock_two", mutations: [] });
    },
  );

  it("sends no kill when the stored serial's identity cannot be read, and gives the probe a timeout (#284)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const inner = host.runner();
    let unreachable = false;
    const runner = new RecordingRunner({
      run: async (command, args, options) =>
        unreachable && command === binaries.adb && args.slice(2).join(" ") === "emu avd path"
          ? { code: 1, stderr: "unreachable", stdout: "" }
          : await inner.run(command, args, options),
      spawn: (...args) => inner.spawn(...args),
      spawnStreaming: (...args) => inner.spawnStreaming(...args),
    });
    const after = await createDriver(filesystem, runner, { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    unreachable = true;
    const callStart = runner.calls.length;

    await after.shutdown(stopped).catch(() => undefined);

    const calls = runner.calls.slice(callStart);
    expect(calls.filter((call) => call.args.slice(2).join(" ") === "emu kill")).toEqual([]);
    expect(host.avdAnswering(running.address)).toBe("simlock_two");
    expect(
      calls.find((call) => call.args.slice(2).join(" ") === "emu avd path")?.options.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it("readies a stopped device and one provisioned after a restart each at an address its own emulator answers (#52)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);

    // why: The first daemon: provision, boot and stop a device. Stopped, it holds its console
    // port only in its driver data -- nothing is listening there any more. Each call gets
    // the device as the last one returned it, which is what the registry commits.
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const provisioned = await after.provision(spec);
    const readyProvisioned = await after.makeReady(provisioned);
    const readyStopped = await after.makeReady(stopped);

    expect({
      provisioned: host.avdAnswering(readyProvisioned.address),
      stopped: host.avdAnswering(readyStopped.address),
    }).toEqual({ provisioned: "simlock_two", stopped: "simlock_one" });
  });
});

describe("AndroidDriver console port reservations", () => {
  const spec = { physical: false, model: "Pixel 5", osVersion: "34", platform: "android" } as const;

  it("keeps a device's console port across its stops, so a call on its stopped record reaches no other device", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    // why: Each boot's mark write takes the id after its device's.
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "mark-1", "two", "mark-2", "mark-3"],
    });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.reclaim(stopped, { clean: "full" });
    const running = await driver.makeReady(await driver.provision(spec));

    await driver.reclaim(stopped, { clean: "full" });

    expect({
      rebooted: (await driver.makeReady(stopped)).address,
      running: host.avdAnswering(running.address),
    }).toEqual({ rebooted: stopped.address, running: "simlock_two" });
  });

  it("gives a deleted device's console port back to the next boot", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "mark-1", "two", "mark-2"],
    });
    await driver.resolveSpec(spec);
    const deleted = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(deleted);
    await driver.destroy(deleted);

    const next = await driver.makeReady(await driver.provision(spec));

    expect(next.address).toBe(deleted.address);
  });

  it("never stops the emulator now on a stopped device's old console port when deleting that device after a restart", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);
    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    // why: Nothing reserves a stopped device's port after a restart, so the next boot took it.
    expect(running.address).toBe(stopped.address);

    await after.destroy(stopped);

    expect(host.avdAnswering(running.address)).toBe("simlock_two");
  });

  it("stops the emulator a failed makeReady left running when its device is deleted", async () => {
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
        "pixel_5",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      {
        hangs: true,
        match: {
          args: ["-avd", "simlock_one", "-port", "5586", "-no-snapshot-save", "-no-snapshot-load"],
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
      processResult(binaries.adb, [
        "-s",
        "emulator-5586",
        "emu",
        "avd",
        "snapshot",
        "save",
        "simlock_clean_baseline",
      ]),
      processResult(binaries.adb, ["-s", "emulator-5586", "emu", "avd", "snapshot", "list"], ""),
      avdPathExpectation("emulator-5586"),
      processResult(binaries.adb, ["-s", "emulator-5586", "emu", "kill"]),
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_one"]),
    ]);
    const driver = await createDriver(
      await androidFilesystem({ config: "hw.ramSize=2048\n" }),
      runner,
      {
        ids: ["one"],
      },
    );
    const spec = await driver.resolveSpec({
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    });
    const provisioned = await driver.provision(spec);
    await expect(driver.makeReady(provisioned)).rejects.toThrow("was not validated");
    const launch = runner.calls.findIndex(
      (call) => call.command === binaries.emulator && call.args.includes("-avd"),
    );
    const before = runner.calls.length;

    const destroyed = driver.destroy(provisioned);
    // why: Exits as it would on `emu kill`, which a scripted emulator cannot hear.
    runner.handles[launch]?.kill("SIGTERM");
    await destroyed.catch(() => undefined);

    expect(runner.calls.slice(before).map((call) => call.args)).toEqual([
      ["-s", "emulator-5586", "emu", "avd", "path"],
      ["-s", "emulator-5586", "emu", "kill"],
      ["delete", "avd", "-n", "simlock_one"],
    ]);
  });
});

describe("AndroidDriver pre-root devices", () => {
  it("accepts an intact root on revalidation", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

    await expect(driver.revalidateRoot()).resolves.toBeUndefined();
  });

  it("refuses to re-prove a root that has become a symlink since startup", async () => {
    const filesystem = await androidFilesystem();
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));
    // why: The case the re-proof exists for: the path was proven at startup and swapped since,
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

    // why: Pointed at the home the AVD is actually in, and deliberately carrying no
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
    await userAvd(filesystem, "Elsewhere", `${googleApis}/`, { avdPath: "/work/Elsewhere.avd" });
    await userAvd(filesystem, "Other", "system-images/android-34/google_apis/arm64-v8a/");
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
    await userAvd(filesystem, "Fresh", sysdir);
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
      // why: The scripted runner fails any call it was not given, so an uninstall would fail this test.
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
      model: process.env.SIMLOCK_LIVE_ANDROID_MODEL ?? "Pixel 5",
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

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
async function provisionedHarness(
  options: {
    readonly bootCompleted?: string;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    readonly emulatorFlags?: readonly string[];
    readonly forBaselineReclaim?: boolean;
    readonly forFullCleanBoot?: boolean;
    readonly forReclaim?: boolean;
    readonly ids?: readonly string[];
    readonly initialAdbFailures?: number;
    readonly readinessTimeoutMs?: number;
    readonly firstMarkToken?: string;
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
      "pixel_5",
    ]),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
  ];

  // why: The mock idGenerator's first call is spent on the AVD name above, so `makeReady`'s tail
  // mark write is always the second call, and (when a snapshot-reclaim follows) the third.
  const firstMarkToken = options.firstMarkToken ?? "device-2";
  const secondMarkToken = "device-3";

  if (options.forReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ...baselineBuildExpectations({ launchArgs: ["-wipe-data", "-no-snapshot-load"] }),
      markWriteExpectation("emulator-5586", firstMarkToken),
    );
  } else if (options.forFullCleanBoot === true) {
    expectations.push(
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
      avdPathExpectation("emulator-5586"),
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
    ids: options.ids ?? ["one"],
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    tcpProbe,
  });
  const spec = await driver.resolveSpec({
    model: "Pixel 5",
    osVersion: "34",
    platform: "android",
  });
  const device = await driver.provision(spec);

  return { clock, device, driver, filesystem, runner, tcpProbe };
}

/**
 * why: A driver whose adb server is already running and recorded, so `create` adopts it: that is
 * the one start-up path that spawns nothing, which keeps the scripted process expectations
 * in every test about the behaviour the test is actually for. The start, reap, and refusal
 * paths are covered against the supervisor itself in `adb-server.test.ts`, and end to end
 * in this file's own `AndroidDriver.create` block.
 */
describe("AndroidDriver defaultModels", () => {
  it("lists the built-in Android preference list per class, newest first, with phone starting at Pixel 9 and tablet holding Medium Tablet", async () => {
    const driver = await createDriver(await androidFilesystem(), new ScriptedProcessRunner([]));

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

describe("AndroidDriver library catalog", () => {
  const classes: Record<string, string> = {
    "Automotive (1024p landscape)": "auto",
    "Automotive (1080p landscape)": "auto",
    "Large Desktop": "desktop",
    "Medium Desktop": "desktop",
    "Medium Phone": "phone",
    "Medium Tablet": "tablet",
    "Pixel 6": "phone",
    "Pixel 7": "phone",
    "Pixel 8": "phone",
    "Pixel 9": "phone",
    "Pixel 9 Pro XL": "phone",
    "Small Phone": "phone",
    "Television (1080p)": "tv",
    "Television (4K)": "tv",
    "Wear OS Large Round": "watch",
    "Wear OS Small Round": "watch",
  };

  it("every library model resolves, and the catalog lists all 16 with their table classes, when `avdmanager list device` lists none of them", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], "Available devices:\n"),
    ]);
    const driver = await createDriver(
      await androidFilesystem({
        images: [
          ["36", "google_apis", "arm64-v8a"],
          ["36", "android-tv", "arm64-v8a"],
          ["36", "android-wear", "arm64-v8a"],
          ["36", "android-automotive", "arm64-v8a"],
          ["36", "android-automotive-playstore", "arm64-v8a"],
          ["36", "android-desktop", "arm64-v8a"],
        ],
      }),
      runner,
    );

    const catalog = await driver.listCatalog();
    const resolved: string[] = [];
    for (const model of Object.keys(classes)) {
      resolved.push((await driver.resolveSpec({ model, platform: "android" })).model);
    }

    expect(resolved).toEqual(Object.keys(classes));
    expect(Object.keys(classes).filter((model) => !catalog.models.includes(model))).toEqual([]);
    for (const [model, deviceClass] of Object.entries(classes)) {
      expect(catalog.modelClasses[model], model).toBe(deviceClass);
    }
    expect(catalog.modelAliases["Television (4K)"]).toEqual(["tv_4k"]);
  });

  it("the catalog classes Medium Tablet `tablet` when `avdmanager list device` also lists `medium_tablet`", async () => {
    const listing =
      'Available devices:\nid: 0 or "medium_tablet"\n    Name: Medium Tablet\n    OEM : Generic\n';
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], listing),
    ]);
    const driver = await createDriver(await androidFilesystem(), runner);

    const catalog = await driver.listCatalog();

    expect(catalog.modelClasses["Medium Tablet"]).toBe("tablet");
    expect(catalog.models.filter((model) => model === "Medium Tablet")).toHaveLength(1);
  });
});

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
    await filesystem.writeFileAtomic(
      `${sdk}/cmdline-tools/latest/source.properties`,
      "Pkg.Desc=Android SDK Command-line Tools\nPkg.Revision=\n",
    );
    const driver = await createDriver(filesystem, new ScriptedProcessRunner([]));

    await expect(driver.toolVersions()).resolves.toEqual([{ name: "emulator", version: "35.4.9" }]);
  });
});

type FitImage = readonly [api: string, tag: string, abi: string, properties?: string];

const fitDevices =
  `Available devices:\n` +
  `id: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n---------\n` +
  `id: 1 or "pixel_9_pro"\n    Name: Pixel 9 Pro\n    OEM : Google\n---------\n` +
  `id: 2 or "tv_720p"\n    Name: Television (720p)\n    OEM : Google\n    Tag : android-tv\n---------\n` +
  `id: 3 or "My Tablet"\n    Name: My Tablet\n    OEM : User\n---------\n` +
  `id: 4 or "odd"\n    Name: Odd Device\n    OEM : Google\n    Tag : foo-device\n---------\n` +
  `id: 5 or "xr_headset"\n    Name: XR Headset\n    OEM : Google\n    Tag : android-xr\n---------\n` +
  `id: 6 or "glasses"\n    Name: AI Glasses\n    OEM : Google\n    Tag : ai-glasses\n`;

class ListingRunner extends ScriptedProcessRunner {
  constructor(
    private readonly listing: string,
    expectations: readonly ScriptedProcessExpectation[],
  ) {
    super(expectations);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    if (command === binaries.avdmanager && args[0] === "list") {
      return new ScriptedProcessRunner([processResult(command, args, this.listing)]).spawn(
        command,
        args,
        options,
      );
    }
    return super.spawn(command, args, options);
  }
}

type Refusal = Error & { readonly component?: string; readonly downloadable?: boolean };

async function fitHarness(
  images: readonly FitImage[],
  options: {
    readonly devicesXml?: string;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly listing?: string;
    readonly profiles?: readonly LibraryDeviceProfile[];
  } = {},
) {
  const filesystem = await androidFilesystem({
    images: images.map(([api, tag, abi]) => [api, tag, abi]),
  });
  for (const [api, tag, abi, properties] of images) {
    if (properties !== undefined) {
      await filesystem.writeFileAtomic(
        `${sdk}/system-images/android-${api}/${tag}/${abi}/source.properties`,
        properties,
      );
    }
  }
  if (options.devicesXml !== undefined) await writeDevicesXml(filesystem, options.devicesXml);
  const runner = new ListingRunner(options.listing ?? fitDevices, [
    processResult(binaries.avdmanager, [
      "create",
      "avd",
      "-n",
      "simlock_one",
      "-k",
      /.+/,
      "-d",
      /.+/,
    ]),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    processResult(binaries.adb, ["devices"], "List of devices attached\n"),
  ]);
  const driver = await createDriver(filesystem, runner, {
    hostAbi: options.hostAbi ?? "arm64-v8a",
    ids: ["one"],
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    ...(options.profiles === undefined
      ? {}
      : { deviceProfileSources: [{ profiles: async () => options.profiles ?? [] }] }),
  });
  const resolve = (model: string, osVersion?: string, imageTag?: string) =>
    driver.resolveSpec({
      model,
      platform: "android",
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(imageTag === undefined ? {} : { imageTag }),
    });
  const refusal = (model: string, osVersion?: string, imageTag?: string) =>
    resolve(model, osVersion, imageTag).then(
      () => {
        throw new Error(`${model} ${osVersion ?? ""} ${imageTag ?? ""} resolved`);
      },
      (error: unknown) => error as Refusal,
    );
  const createdPackage = () => {
    const create = runner.calls.find((call) => call.args[0] === "create");
    return create?.args[create.args.indexOf("-k") + 1];
  };
  return { createdPackage, driver, filesystem, refusal, resolve, runner };
}

const HOST_IMAGES: readonly FitImage[] = [
  ["35", "google_apis", "arm64-v8a"],
  ["36", "google_apis_playstore", "arm64-v8a"],
  ["34", "android-tv", "arm64-v8a"],
];

// why: the verbatim source.properties of the real android-Baklava image installed beside
// android-36 and android-37.0 on a reporting host, so the fixture holds what the SDK really stores.
const BAKLAVA_SOURCE_PROPERTIES =
  "Pkg.Desc=System Image arm64-v8a with Google APIs.\n" +
  "Pkg.Revision=4\n" +
  "AndroidVersion.ApiLevel=35\n" +
  "AndroidVersion.CodeName=Baklava\n" +
  "SystemImage.Abi=arm64-v8a\n" +
  "SystemImage.TagId=google_apis\n";

describe("AndroidDriver image fit", () => {
  describe("each row of the In short table", () => {
    interface Row {
      readonly name: string;
      readonly images?: readonly FitImage[];
      readonly model: string;
      readonly os?: string;
      readonly tag?: string;
      readonly resolves?: string;
      readonly resolvedTag?: string;
      readonly refusedDownloadable?: boolean;
      readonly refusedComponent?: string;
      readonly pkg?: string;
    }
    const withGoogleTv: readonly FitImage[] = [...HOST_IMAGES, ["36", "google-tv", "arm64-v8a"]];
    const withWear: readonly FitImage[] = [...HOST_IMAGES, ["34", "android-wear", "arm64-v8a"]];
    const rows: readonly Row[] = [
      { model: "Television (1080p)", name: "TV 1080p", resolves: "34" },
      { model: "Television (1080p)", name: "TV 1080p at 36", os: "36", refusedDownloadable: false },
      {
        model: "Television (1080p)",
        name: "TV 1080p with image tag google_apis",
        refusedDownloadable: false,
        tag: "google_apis",
      },
      { model: "Television (720p)", name: "TV 720p, SDK only", resolves: "34" },
      {
        images: withGoogleTv,
        model: "Television (1080p)",
        name: "TV 1080p with a google-tv image at 36",
        resolves: "36",
      },
      { images: withWear, model: "Wear OS Large Round", name: "Wear OS", resolves: "34" },
      { model: "Pixel 9", name: "Pixel 9", resolves: "36" },
      { model: "Pixel 9", name: "Pixel 9 at 34", os: "34", refusedDownloadable: false },
      {
        model: "Pixel 9",
        name: "Pixel 9 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      { model: "Television (1080p)", name: "TV 1080p at 37", os: "37", refusedDownloadable: false },
      { model: "Pixel 6", name: "Pixel 6", resolves: "35" },
      { model: "Pixel 6", name: "Pixel 6 at 36", os: "36", refusedDownloadable: false },
      {
        model: "Pixel 6",
        name: "Pixel 6 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      {
        model: "Pixel 6",
        name: "Pixel 6 with image tag google_apis_playstore",
        refusedDownloadable: false,
        tag: "google_apis_playstore",
      },
      {
        model: "Medium Phone",
        name: "Medium Phone with image tag google_apis_playstore",
        resolvedTag: "google_apis_playstore",
        resolves: "36",
        tag: "google_apis_playstore",
      },
      { model: "Medium Phone", name: "Medium Phone at 35", os: "35", resolves: "35" },
      { model: "Pixel 9 Pro", name: "Pixel 9 Pro, SDK only", resolves: "36" },
      { model: "My Tablet", name: "My Tablet, custom", resolves: "36" },
    ];

    it.each(rows)("$name gives its After result", async (row) => {
      const { driver, refusal, resolve } = await fitHarness(row.images ?? HOST_IMAGES);

      if (row.refusedDownloadable !== undefined) {
        expect(await refusal(row.model, row.os, row.tag)).toMatchObject({
          component: row.refusedComponent,
          downloadable: row.refusedDownloadable,
          name: "RuntimeMissingError",
        });
        if (row.os !== undefined) {
          expect((await driver.listCatalog()).modelRuntimes[row.model]).not.toContain(row.os);
        }
        return;
      }
      const spec = await resolve(row.model, row.os, row.tag);
      expect(spec).toEqual({
        ...(row.resolvedTag === undefined ? {} : { imageTag: row.resolvedTag }),
        model: row.model,
        osVersion: row.resolves,
        physical: false,
        platform: "android",
      });
      expect((await driver.listCatalog()).modelRuntimes[row.model]).toContain(spec.osVersion);
    });

    it("pairs My Tablet with 35 and 36 and not the TV image at 34, and the TV with 34 only", async () => {
      const { driver } = await fitHarness(HOST_IMAGES);

      const { modelRuntimes } = await driver.listCatalog();

      expect(modelRuntimes["My Tablet"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Television (1080p)"]).toEqual(["34"]);
      expect(modelRuntimes["Pixel 9"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Pixel 6"]).toEqual(["35"]);
    });

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
  });

  describe("downloads", () => {
    it("is not downloadable for an uninstalled level above the profile's API range", async () => {
      const old = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });
      expect((await old.refusal("Old Phone", "34")).downloadable).toBe(false);
    });
  });

  describe("the catalog", () => {
    it("lists in modelRuntimes only levels with a fitting image, and every installed image elsewhere", async () => {
      const { driver } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["37", "android-xr", "arm64-v8a"],
      ]);

      const catalog = await driver.listCatalog();

      expect(catalog.modelRuntimes["Pixel 5"]).toEqual(["35"]);
      expect(catalog.modelRuntimes["Television (1080p)"]).toEqual([]);
      expect(catalog.runtimes).toEqual(["35", "37"]);
      expect(catalog.defaultRuntime).toBe("37");
      expect(catalog.images).toEqual([
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "37", tag: "android-xr" },
      ]);
    });

    it("resolves every pair it lists, and refuses a level it leaves out", async () => {
      const { driver, refusal, resolve } = await fitHarness([
        ...HOST_IMAGES,
        ["36", "android-wear", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
      ]);
      const catalog = await driver.listCatalog();
      const pairs = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        levels.map((level) => ({ level, model })),
      );
      const left = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        catalog.runtimes
          .filter((level) => !levels.includes(level))
          .map((level) => ({ level, model })),
      );
      expect(pairs.length).toBeGreaterThan(0);
      expect(left.length).toBeGreaterThan(0);

      for (const { level, model } of pairs) {
        expect(await resolve(model, level)).toMatchObject({ model, osVersion: level });
      }
      for (const { level, model } of left) {
        expect(await refusal(model, level)).toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
        });
      }
    });

    it("pairs a devices.xml profile avdmanager did not list with every installed phone level", async () => {
      const { driver, resolve } = await fitHarness(HOST_IMAGES, {
        devicesXml: customDeviceXml("Legacy Phone", 2048),
      });

      const catalog = await driver.listCatalog();

      expect(catalog.modelRuntimes["Legacy Phone"]).toEqual(["35", "36"]);
      expect(await resolve("Legacy Phone", "35")).toMatchObject({ osVersion: "35" });
    });

    it("counts android-Baklava with AndroidVersion.ApiLevel=35 as a level Pixel 9 pairs with", async () => {
      const { driver, resolve } = await fitHarness([
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
        ["34", "google_apis", "arm64-v8a"],
      ]);

      const catalog = await driver.listCatalog();

      expect(catalog.modelRuntimes["Pixel 9"]).toEqual(["Baklava"]);
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "Baklava" });
    });

    it("ranks a preview image by the API level it records, so a newer numeric level stays the newest", async () => {
      const { driver, resolve } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
      ]);

      const catalog = await driver.listCatalog();

      // why: stated first so the assertions below can only fail on the *ranking* — the preview is
      // genuinely a listed candidate, not something the catalog left out.
      expect(catalog.runtimes).toContain("Baklava");
      expect(catalog.modelRuntimes["Pixel 9"]).toContain("Baklava");
      expect(catalog.defaultRuntime).toBe("37.0");
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "37.0" });
    });

    it("ranks a preview image above the numeric levels when the level it records is higher", async () => {
      const { driver } = await fitHarness([
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=38\n"],
      ]);

      expect((await driver.listCatalog()).defaultRuntime).toBe("Baklava");
    });

    it("ranks a preview folder by the highest level any of its images records, so an image recording none does not raise it", async () => {
      const { driver } = await fitHarness([
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
        ["Baklava", "google_apis_playstore", "arm64-v8a"],
      ]);

      expect((await driver.listCatalog()).defaultRuntime).toBe("37.0");
    });

    it.each([
      ["lower first", "35", "38"],
      ["higher first", "38", "35"],
    ])(
      "ranks a preview folder by the highest level among its images, whichever is read first (%s)",
      async (_order, first, second) => {
        const { driver } = await fitHarness([
          ["37.0", "google_apis", "arm64-v8a"],
          ["Baklava", "google_apis", "arm64-v8a", `AndroidVersion.ApiLevel=${first}\n`],
          ["Baklava", "google_apis_playstore", "arm64-v8a", `AndroidVersion.ApiLevel=${second}\n`],
        ]);

        expect((await driver.listCatalog()).defaultRuntime).toBe("Baklava");
      },
    );

    it("uses the folder name for --image-tag and the catalog's images[].tag when SystemImage.TagId differs", async () => {
      const { driver, refusal, resolve } = await fitHarness([
        ["35", "custom-folder", "arm64-v8a", "SystemImage.TagId=google_apis_playstore\n"],
      ]);

      const catalog = await driver.listCatalog();

      expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "35", tag: "custom-folder" }]);
      expect(await resolve("Pixel 5", undefined, "custom-folder")).toMatchObject({
        imageTag: "custom-folder",
      });
      expect(await refusal("Pixel 5", undefined, "google_apis_playstore")).toMatchObject({
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });
  });

  describe("resolveSpec", () => {
    it("gives a request with no version the newest level with a fitting image", async () => {
      const { resolve } = await fitHarness([
        ["34", "android-tv", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
      ]);

      expect(await resolve("Television (1080p)")).toMatchObject({ osVersion: "35" });
    });

    it("fails a request with no version RUNTIME_MISSING, not downloadable, when no level has a fitting image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect(await refusal("Television (1080p)")).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });

    it("skips a newest level whose image of the tag misfits and takes the newest level where it fits", async () => {
      const { resolve } = await fitHarness(
        [
          ["34", "google_apis_playstore", "arm64-v8a"],
          ["36", "google_apis_playstore", "arm64-v8a"],
        ],
        {
          profiles: [
            testLibraryProfile({
              apiRange: { max: 35, min: 24 },
              name: "Capped",
              names: ["Capped"],
            }),
          ],
        },
      );

      expect(await resolve("Capped", undefined, "google_apis_playstore")).toMatchObject({
        osVersion: "34",
      });
    });
  });

  describe("refusal messages", () => {
    const phones: readonly FitImage[] = [
      ["35", "google_apis", "arm64-v8a"],
      ["36", "google_apis_playstore", "arm64-v8a"],
    ];

    it("names the API range for an API level below the profile's minimum", async () => {
      const { refusal } = await fitHarness([["34", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("names the API range for a level above the profile's maximum", async () => {
      const { refusal } = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });

      expect((await refusal("Old Phone", "35")).message).toBe(
        "No installed system image fits Old Phone at Android 35: it needs Android 33 or older",
      );
    });

    it.each([
      ["Television (1080p)", "it needs a TV image"],
      ["Wear OS Large Round", "it needs a Wear OS image"],
      ["Automotive (1080p landscape)", "it needs an automotive image"],
      ["Medium Desktop", "it needs a desktop image"],
      ["XR Headset", "it needs an XR image"],
      ["AI Glasses", "it needs an AI glasses image"],
    ])("names the kind for %s with only phone images", async (model, reason) => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal(model, "35")).message).toBe(
        `No installed system image fits ${model} at Android 35: ${reason}`,
      );
    });

    it("names phone or tablet for a profile with no kind whose only image is a TV image", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 5", "34")).message).toBe(
        "No installed system image fits Pixel 5 at Android 34: it needs a phone or tablet image",
      );
    });

    it("names the tag for any other kind", async () => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal("Odd Device", "35")).message).toBe(
        "No installed system image fits Odd Device at Android 35: it needs an image tagged foo-device",
      );
    });

    it.each([
      ["Pixel 6", "36", "google_apis_playstore", "Play Store"],
      ["Pixel 5", "35", "tablet", "tablet"],
    ])(
      "says the model does not take the kind of image it was given (%s)",
      async (model, osVersion, imageTag, noun) => {
        const { refusal } = await fitHarness([[osVersion, imageTag, "arm64-v8a"]]);

        expect((await refusal(model, osVersion)).message).toBe(
          `No installed system image fits ${model} at Android ${osVersion}: ${model} does not take ${noun} images`,
        );
      },
    );

    it("says none of the installed images fit it when no single check rules out every image", async () => {
      const { refusal } = await fitHarness([
        ["35", "google_apis_playstore", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
      ]);

      expect((await refusal("Pixel 6", "35")).message).toBe(
        "No installed system image fits Pixel 6 at Android 35: none of the installed images fit it",
      );
    });

    it("gives the API range reason for an image that fails both API range and kind", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("drops the level from the message when no version was asked, reading every installed image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Television (1080p)")).message).toBe(
        "No installed system image fits Television (1080p): it needs a TV image",
      );
    });

    it("says an image tag's image does not fit it, and why", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Television (1080p)", undefined, "google_apis")).message).toBe(
        "No installed system image fits Television (1080p): the google_apis image does not fit it: it needs a TV image",
      );
      expect((await refusal("Television (1080p)", "35", "google_apis")).message).toBe(
        "No installed system image fits Television (1080p) at Android 35: the google_apis image does not fit it: it needs a TV image",
      );
    });

    it("says the level is not installed for a level with nothing installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 9", "37")).message).toBe(
        "No installed system image fits Pixel 9 at Android 37: Android 37 is not installed",
      );
    });

    it("says no system image is installed on a host with no image at all", async () => {
      const { refusal } = await fitHarness([]);

      expect((await refusal("Pixel 9")).message).toBe(
        "No installed system image fits Pixel 9: no system image is installed",
      );
    });

    it("keeps today's message for an image tag with no image of that tag installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 5", "35", "default")).message).toBe(
        "No default system image is installed for Android API 35",
      );
    });
  });

  describe("provision", () => {
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

  describe("an image tag whose image misfits", () => {
    it("fails RUNTIME_MISSING, not downloadable, and starts no sdkmanager", async () => {
      const { refusal, runner } = await fitHarness(HOST_IMAGES);

      const failure = await refusal("Pixel 6", undefined, "google_apis_playstore");

      expect(failure).toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
      expect(failure.message).toContain("the google_apis_playstore image does not fit it");
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
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

async function createDriver(
  filesystem: Filesystem,
  processRunner: ProcessRunner,
  options: {
    readonly acceptAndroidLicenses?: boolean;
    /** why: `ANDROID_AVD_HOME` in the environment the daemon started with; unset by default. */
    readonly avdHome?: string;
    readonly clock?: FakeClock;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** why: the ABI this host runs natively; `arm64-v8a` unless a test says otherwise. */
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
    readonly readinessTimeoutMs?: number;
    readonly scrcpyServerPath?: string;
    readonly tcpProbe?: FakeTcpProbe;
    readonly tcpStreamConnector?: FakeTcpStreamConnector;
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
      ...options.extraEnv,
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

/** why: the options this helper only forwards when a test actually set one -- `AndroidDriver.create`
 * declares them optional under `exactOptionalPropertyTypes`, so an absent one must be absent
 * rather than `undefined`. Split out of `createDriver` so that the list can keep growing
 * without the helper itself turning into a pile of conditionals. */
function onlyProvided(options: {
  readonly acceptAndroidLicenses?: boolean;
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  readonly emulator?: AndroidEmulatorLaunchOptions;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly readinessTimeoutMs?: number;
  readonly scrcpyServerPath?: string;
  readonly tcpStreamConnector?: FakeTcpStreamConnector;
}) {
  return {
    ...(options.scrcpyServerPath === undefined
      ? {}
      : { scrcpyServerPath: options.scrcpyServerPath }),
    ...(options.tcpStreamConnector === undefined
      ? {}
      : { tcpStreamConnector: options.tcpStreamConnector }),
    ...(options.acceptAndroidLicenses === undefined
      ? {}
      : { acceptAndroidLicenses: options.acceptAndroidLicenses }),
    ...(options.deviceProfileSources === undefined
      ? {}
      : { deviceProfileSources: options.deviceProfileSources }),
    ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
  };
}

async function recordRunningAdbServer(filesystem: Filesystem, port = adbServerPort): Promise<void> {
  await filesystem.mkdirp(simlockHome);
  await filesystem.writeFileAtomic(
    adbRecordPath,
    JSON.stringify({ pid: adbServerPid, port, startedAt: 1 }),
  );
}

const SEED_LINES = [
  "avd.ini.encoding=UTF-8",
  "hw.cpu.arch=arm64",
  "hw.ramSize=1G",
  "hw.lcd.density=1",
  "hw.seedOnly=yes",
  "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/",
  "tag.id=google_apis",
  "abi.type=arm64-v8a",
  "target=android-35",
  "disk.dataPartition.size=6G",
  "showDeviceFrame=yes",
  "skin.name=pixel_8",
  "skin.path=skins/pixel_8",
  "vm.heapSize=64M",
  "PlayStore.enabled=no",
];

function seedConfig(extra: readonly string[]): string {
  return `${[...SEED_LINES.filter((line) => !extra.some((added) => added.split("=")[0] === line.split("=")[0])), ...extra].join("\n")}\n`;
}

function libraryPixel9(): LibraryDeviceProfile {
  const profile = LIBRARY_PROFILES.find((candidate) => candidate.id === "pixel_9");
  if (profile === undefined) throw new Error("the library has no profile with id pixel_9");
  return profile;
}

function testLibraryProfile(overrides: Partial<LibraryDeviceProfile> = {}): LibraryDeviceProfile {
  return {
    apiRange: { min: 1 },
    bootProperties: {},
    copiedFrom: "20.0",
    deviceClass: "phone",
    hardware: { "hw.lcd.height": "100", "hw.ramSize": "2G" },
    id: "test_phone",
    imageKind: undefined,
    kind: "library",
    name: "Test Phone",
    names: ["Test Phone", "test_phone"],
    playStore: true,
    tablet: false,
    ...overrides,
  };
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

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
async function libraryHarness(
  options: {
    readonly devicesXml?: string;
    readonly extraImages?: readonly (readonly [string, string, string])[];
    readonly filesystem?: MemoryFilesystem;
    readonly imageProperties?: string;
    readonly imageTag?: string;
    readonly listing?: string;
    readonly profiles?: readonly LibraryDeviceProfile[];
    readonly secondList?: boolean;
    readonly seed?: string;
    readonly seedBootProp?: string;
    readonly sources?: readonly DeviceProfileSource[];
  } = {},
) {
  const tag = options.imageTag ?? "google_apis";
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  await androidFilesystem(
    { images: [["35", tag, "arm64-v8a"], ...(options.extraImages ?? [])] },
    filesystem,
  );
  const imageProperties = options.imageProperties ?? `Pkg.Revision=1\nSystemImage.TagId=${tag}\n`;
  if (imageProperties !== "") {
    await filesystem.writeFileAtomic(
      `${sdk}/system-images/android-35/${tag}/arm64-v8a/source.properties`,
      imageProperties,
    );
  }
  if (options.devicesXml !== undefined) {
    await writeDevicesXml(filesystem, options.devicesXml);
  }
  const avd = `${avdDirectory}/simlock_one.avd`;
  const configPath = `${avd}/config.ini`;
  const bootPropPath = `${avd}/boot.prop`;
  await filesystem.mkdirp(avd);
  await filesystem.writeFileAtomic(configPath, options.seed ?? seedConfig([]));
  if (options.seedBootProp !== undefined) {
    await filesystem.writeFileAtomic(bootPropPath, options.seedBootProp);
  }
  const listing = options.listing ?? pixelDevices;
  const runner = new ScriptedProcessRunner([
    processResult(binaries.avdmanager, ["list", "device"], listing),
    ...(options.secondList === true
      ? [processResult(binaries.avdmanager, ["list", "device"], listing)]
      : []),
    processResult(binaries.avdmanager, [
      "create",
      "avd",
      "-n",
      "simlock_one",
      "-k",
      /.+/,
      "-d",
      /.+/,
    ]),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
  ]);
  const sources =
    options.profiles === undefined
      ? options.sources
      : [{ profiles: async () => options.profiles ?? [] }];
  const driver = await createDriver(filesystem, runner, {
    ids: ["one"],
    ...(sources === undefined ? {} : { deviceProfileSources: sources }),
  });
  const resolve = (model: string) =>
    driver.resolveSpec({ model, osVersion: "35", platform: "android" });
  const readLines = async () =>
    (await filesystem.readFile(configPath)).split("\n").filter((line) => line !== "");
  return {
    bootPropPath,
    config: async () =>
      new Map(
        (await readLines()).map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
      ),
    configPath,
    createCalls: () => runner.calls.filter((call) => call.args[0] === "create"),
    driver,
    filesystem,
    lines: readLines,
    provision: async (model: string) => driver.provision(await resolve(model)),
    resolve,
    runner,
    seedDeviceId: () => {
      const create = runner.calls.find((call) => call.args[0] === "create");
      return create?.args[create.args.indexOf("-d") + 1];
    },
  };
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
  // why: Marked, so `ensureOwnedRoot` adopts it rather than creating one -- a root Simlock
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
  readonly emulatorFlags?: readonly string[] | undefined;
  readonly initialAdbFailures?: number | undefined;
  readonly launchArgs: readonly string[];
}): ScriptedProcessExpectation[] {
  const bootCompleted = options.bootCompleted ?? "1\n";
  const emulatorFlags = options.emulatorFlags ?? [];
  const expectations: ScriptedProcessExpectation[] = [
    processResult(binaries.adb, ["devices"], "List of devices attached\n"),
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
    avdPathExpectation("emulator-5586"),
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
 * why: A `ScriptedProcessRunner` that also mirrors what real `sdkmanager` does on disk: a
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
 * why: The emulators on one machine, which outlive any one daemon: as much of `avdmanager`,
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
  readonly #listening = new Map<number, string>();
  readonly #exits = new Map<number, () => void>();
  #nextPid = 1;

  constructor(private readonly filesystem: MemoryFilesystem) {}

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
    const avdName = args[args.indexOf("-n") + 1] ?? "";
    if (args[0] === "delete") {
      await this.filesystem.rm(`${avdDirectory}/${avdName}.avd`);
      return ok();
    }
    if (args[0] !== "create") return undefined;
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
    if (rest === "emu avd path") {
      return ok(`${avdDirectory}/${this.#listening.get(port) ?? ""}.avd\r\nOK\r\n`);
    }
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
      // why: Killing an emulator that never bound must not stop the one that did.
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

class RecordingRunner implements ProcessRunner {
  readonly calls: { args: readonly string[]; command: string; options: ProcessRunOptions }[] = [];

  constructor(private readonly inner: ProcessRunner) {}

  run(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.run(command, args, options);
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.spawn(command, args, options);
  }

  spawnStreaming(...args: Parameters<ProcessRunner["spawnStreaming"]>) {
    return this.inner.spawnStreaming(...args);
  }
}

const ADB_ANSWERS = new Map([
  ["shell getprop sys.boot_completed", "1\n"],
  ["shell getprop init.svc.bootanim", "stopped\n"],
  ["emu avd snapshot save simlock_clean_baseline", "OK\n"],
  ["emu avd snapshot list", "simlock_clean_baseline\n"],
  ["emu avd snapshot load simlock_clean_baseline", "OK\n"],
]);

function consolePortOf(serial: string | undefined): number {
  return Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
}

function ok(stdout = ""): ProcessResult {
  return { code: 0, stderr: "", stdout };
}

async function* emptyLines(): AsyncIterable<string> {}

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

function avdPathExpectation(serial: string, avdName = "simlock_one"): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${avdName}.avd\r\nOK\r\n`,
  );
}

function markWriteExpectation(serial: string, token: string): ScriptedProcessExpectation {
  return processResult(binaries.adb, [
    "-s",
    serial,
    "shell",
    `echo '${JSON.stringify({ token })}' > /data/local/tmp/simlock-mark.json`,
  ]);
}

/**
 * why: An `EmulatorHost` on which another emulator takes a device's console port just before the
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
  readonly #otherPaths = new Map<number, string>();
  #takeOnNextBoot: ((port: number) => void) | undefined;

  constructor(private readonly host: EmulatorHost) {
    this.#inner = host.runner();
  }

  avdPathAnswering(serial: string | undefined): string | undefined {
    const name = this.host.avdAnswering(serial);
    if (name === undefined) return undefined;
    return this.#otherPaths.get(consolePortOf(serial)) ?? `${avdDirectory}/${name}.avd`;
  }

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

class WorkingDirectoryFilesystem extends MemoryFilesystem {
  constructor(private readonly workingDirectory: string) {
    super();
  }

  override async realpath(path: string): Promise<string> {
    return super.realpath(path.startsWith("/") ? path : `${this.workingDirectory}/${path}`);
  }
}

class LinkedHomeFilesystem extends MemoryFilesystem {
  override async realpath(path: string): Promise<string> {
    const resolved = await super.realpath(path.replace(/^\/private\/home\//, "/home/"));
    return resolved.replace(/^\/home\//, "/private/home/");
  }
}

const QUERIES = /^(shell getprop \S+|emu avd (name|path|id|status|discoverypath))$/;

/**
 * why: The message of the driver's `DriverCrashError`; anything else -- a boot timeout, the fake's
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

interface CustomFitProfile {
  readonly apiLevel?: string;
  readonly diagonal?: string;
  readonly folded?: boolean;
  readonly name: string;
  readonly playStore?: string;
  readonly tagId?: string;
}

function customFitXml(profile: CustomFitProfile): string {
  const screen =
    profile.diagonal === undefined && profile.folded !== true
      ? ""
      : `<d:screen>${profile.diagonal === undefined ? "" : `<d:diagonal-length>${profile.diagonal}</d:diagonal-length>`}` +
        (profile.folded === true
          ? "<d:x-folded-dimension>1080</d:x-folded-dimension><d:y-folded-dimension>2400</d:y-folded-dimension>"
          : "") +
        "</d:screen>";
  return (
    `<d:device><d:name>${profile.name}</d:name>` +
    (profile.tagId === undefined ? "" : `<d:tag-id>${profile.tagId}</d:tag-id>`) +
    `<d:hardware>${screen}</d:hardware>` +
    (profile.apiLevel === undefined
      ? ""
      : `<d:software><d:api-level>${profile.apiLevel}</d:api-level></d:software>`) +
    (profile.playStore === undefined
      ? ""
      : `<d:playstore-enabled>${profile.playStore}</d:playstore-enabled>`) +
    "</d:device>"
  );
}

function userListing(...entries: readonly (readonly [name: string, tag?: string])[]): string {
  return (
    "Available devices:\n" +
    entries
      .map(
        ([name, tag]) =>
          `id: 9 or "${name}"\n    Name: ${name}\n    OEM : User\n` +
          (tag === undefined ? "" : `    Tag : ${tag}\n`) +
          "---------\n",
      )
      .join("")
  );
}

describe("AndroidDriver custom profile fit from devices.xml", () => {
  const wearImage: FitImage = [
    "34",
    "android-wear",
    "arm64-v8a",
    "SystemImage.TagId=android-wear,google_apis_playstore\n",
  ];

  it("a custom profile listed by avdmanager gets the API range of its devices.xml entry: api-level 31- drops levels below 31 from its modelRuntimes", async () => {
    const images: readonly FitImage[] = [
      ["30", "google_apis", "arm64-v8a"],
      ["31", "google_apis", "arm64-v8a"],
      ["30", "android-tv", "arm64-v8a"],
      ["31", "android-tv", "arm64-v8a"],
    ];
    const open = await fitHarness(images, {
      devicesXml: customFitXml({ name: "Open Phone" }),
      listing: userListing(["Open Phone"]),
    });
    expect((await open.driver.listCatalog()).modelRuntimes["Open Phone"]).toEqual(["30", "31"]);
    const { driver } = await fitHarness(images, {
      devicesXml:
        customFitXml({ apiLevel: "31-", name: "My Phone" }) +
        customFitXml({ apiLevel: "31-", name: "My TV", tagId: "android-tv" }),
      listing: userListing(["My Phone"], ["My TV", "android-tv"]),
    });

    const { modelRuntimes } = await driver.listCatalog();

    expect(modelRuntimes["My Phone"]).toEqual(["31"]);
    expect(modelRuntimes["My TV"]).toEqual(["31"]);
  });

  it("a custom profile with playstore-enabled false drops Play Store images", async () => {
    const images: readonly FitImage[] = [
      ["34", "google_apis_playstore", "arm64-v8a"],
      ["35", "google_apis", "arm64-v8a"],
    ];
    const allowed = await fitHarness(images, {
      devicesXml: customFitXml({ name: "My Phone", playStore: "true" }),
      listing: userListing(["My Phone"]),
    });
    expect((await allowed.driver.listCatalog()).modelRuntimes["My Phone"]).toEqual(["34", "35"]);
    const { driver } = await fitHarness(images, {
      devicesXml: customFitXml({ name: "My Phone", playStore: "false" }),
      listing: userListing(["My Phone"]),
    });

    expect((await driver.listCatalog()).modelRuntimes["My Phone"]).toEqual(["35"]);
  });

  it("a custom Wear profile with playstore-enabled false keeps an image tagged android-wear,google_apis_playstore, listed by avdmanager or devices.xml-only", async () => {
    const wear = customFitXml({ name: "My Watch", playStore: "false", tagId: "android-wear" });
    const listed = await fitHarness([wearImage], {
      devicesXml: wear,
      listing: userListing(["My Watch", "android-wear"]),
    });
    const only = await fitHarness([wearImage], { devicesXml: wear, listing: userListing() });

    expect((await listed.driver.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
    expect((await only.driver.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
  });

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

  it("a custom profile with no type and a 10.1-inch screen that does not fold fits tablet images; a 6-inch one, one with folded dimensions and one with no diagonal do not", async () => {
    const images: readonly FitImage[] = [
      ["35", "google_apis", "arm64-v8a"],
      ["36", "tablet", "arm64-v8a"],
    ];
    const { driver } = await fitHarness(images, {
      devicesXml:
        customFitXml({ diagonal: "10.1", name: "Big" }) +
        customFitXml({ diagonal: "6", name: "Small" }) +
        customFitXml({ diagonal: "10.1", folded: true, name: "Folds" }) +
        customFitXml({ name: "NoDiagonal" }),
      listing: userListing(["Big"], ["Small"], ["Folds"], ["NoDiagonal"]),
    });

    const { modelRuntimes } = await driver.listCatalog();

    expect(modelRuntimes["Big"]).toEqual(["35", "36"]);
    expect(modelRuntimes["Small"]).toEqual(["35"]);
    expect(modelRuntimes["Folds"]).toEqual(["35"]);
    expect(modelRuntimes["NoDiagonal"]).toEqual(["35"]);
  });

  it("a custom profile with nothing but a name pairs as after #489", async () => {
    const { driver } = await fitHarness(HOST_IMAGES, {
      devicesXml: customFitXml({ name: "Old" }),
      listing: userListing(["Old"]),
    });

    expect((await driver.listCatalog()).modelRuntimes["Old"]).toEqual(["35", "36"]);
  });

  it("a custom profile's class still comes from avdmanager's Tag line", async () => {
    const { driver } = await fitHarness(HOST_IMAGES, {
      devicesXml: customFitXml({ name: "My TV", tagId: "android-wear" }),
      listing: userListing(["My TV", "android-tv"]),
    });

    expect((await driver.listCatalog()).modelClasses["My TV"]).toBe("tv");
  });

  it("a devices.xml profile avdmanager does not list fits by its own tag-id, range, Play Store flag and screen, and is classed by its tag-id", async () => {
    const images: readonly FitImage[] = [
      ["30", "android-tv", "arm64-v8a"],
      ["31", "android-tv", "arm64-v8a"],
      ["30", "google_apis", "arm64-v8a"],
      ["31", "google_apis_playstore", "arm64-v8a"],
      ["32", "google_apis", "arm64-v8a"],
      ["33", "tablet", "arm64-v8a"],
    ];
    const { driver } = await fitHarness(images, {
      devicesXml:
        customFitXml({ apiLevel: "31-", name: "Only TV", tagId: "android-tv" }) +
        customFitXml({ name: "Only Phone", playStore: "false" }) +
        customFitXml({ diagonal: "10.1", name: "Only Tablet" }),
      listing: userListing(),
    });

    const catalog = await driver.listCatalog();

    expect(catalog.modelRuntimes["Only TV"]).toEqual(["31"]);
    expect(catalog.modelRuntimes["Only Phone"]).toEqual(["30", "32"]);
    expect(catalog.modelRuntimes["Only Tablet"]).toEqual(["30", "31", "32", "33"]);
    expect(catalog.modelClasses["Only TV"]).toBe("tv");
    expect(catalog.modelClasses["Only Phone"]).toBe("phone");
  });

  it("writes the same config.ini keys for a rich devices.xml profile as for a plain one", async () => {
    const keysOf = async (xml: string) => {
      const harness = await libraryHarness({
        devicesXml: xml,
        extraImages: [["35", "android-tv", "arm64-v8a"]],
        secondList: true,
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

  it("reads devices.xml from ANDROID_USER_HOME, then ANDROID_PREFS_ROOT, then ANDROID_SDK_HOME, then home", async () => {
    const paths = [
      "/user-home/devices.xml",
      "/prefs/.android/devices.xml",
      "/sdk-home/.android/devices.xml",
      `${home}/.android/devices.xml`,
    ];
    const env = {
      ANDROID_PREFS_ROOT: "/prefs",
      ANDROID_SDK_HOME: "/sdk-home",
      ANDROID_USER_HOME: "/user-home",
    };
    const names = ["From user home", "From prefs root", "From sdk home", "From home"];
    const outcomes: string[][] = [];
    for (let first = 0; first < paths.length; first++) {
      const used: Record<string, string> = {};
      if (first <= 0) used["ANDROID_USER_HOME"] = env.ANDROID_USER_HOME;
      if (first <= 1) used["ANDROID_PREFS_ROOT"] = env.ANDROID_PREFS_ROOT;
      if (first <= 2) used["ANDROID_SDK_HOME"] = env.ANDROID_SDK_HOME;
      const { driver, filesystem } = await fitHarness(HOST_IMAGES, {
        extraEnv: used,
        listing: userListing(),
      });
      for (const [index, path] of paths.entries()) {
        await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
        await filesystem.writeFileAtomic(
          path,
          `<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">${customFitXml({ name: names[index] as string })}</d:devices>`,
        );
      }
      outcomes.push(
        (await driver.listCatalog()).models.filter((model) => model.startsWith("From ")),
      );
    }

    expect(outcomes).toEqual(names.map((name) => [name]));
  });
});
