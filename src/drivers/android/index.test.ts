import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Driver } from "../../core/driver.js";
import { DiskSpaceGuard, InsufficientDiskSpaceError } from "../../core/index.js";
import {
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
const binaries = {
  adb: `${sdk}/platform-tools/adb`,
  avdmanager: `${sdk}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${sdk}/emulator/emulator`,
  sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
} as const;
const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;

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

    await expect(
      driver.resolveSpec({ model: "Pixel 8", platform: "android" }, { allowDownload: false }),
    ).resolves.toEqual({ model: "Pixel 8", osVersion: "34", platform: "android" });
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

    await expect(
      driver.resolveSpec({ model: "Pixel 8", platform: "android" }, { allowDownload: false }),
    ).resolves.toEqual({ model: "Pixel 8", osVersion: "35", platform: "android" });
  });

  it("fails for a missing image unless downloads are explicitly allowed", async () => {
    const filesystem = await androidFilesystem();
    const runner = new InstallReflectingProcessRunner(
      [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.sdkmanager, [
          "--install",
          "system-images;android-35;google_apis;arm64-v8a",
        ]),
      ],
      filesystem,
    );
    const driver = await createDriver(filesystem, runner);
    const request = { model: "Pixel 8", osVersion: "35", platform: "android" } as const;

    await expect(driver.resolveSpec(request, { allowDownload: false })).rejects.toMatchObject({
      name: "RuntimeMissingError",
    });
    await expect(driver.resolveSpec(request, { allowDownload: true })).resolves.toEqual({
      model: "Pixel 8",
      osVersion: "35",
      platform: "android",
    });
    expect(runner.calls.at(-1)).toMatchObject({
      args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
      command: binaries.sdkmanager,
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
    await Promise.all([
      first.resolveSpec(spec, { allowDownload: false }),
      second.resolveSpec(spec, { allowDownload: false }),
    ]);

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
      options: scopedOptions,
    });
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
      options: scopedOptions,
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
      options: scopedOptions,
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
    const spec = await driver.resolveSpec(
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      { allowDownload: false },
    );
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
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(31_000);
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
      models: ["Pixel 8"],
      runtimes: ["34", "35"],
    });
  });

  it("reports no default runtime and no installed API levels without system images", async () => {
    const filesystem = await androidFilesystem({ images: [] });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ]);
    const driver = await createDriver(filesystem, runner);

    await expect(driver.listCatalog()).resolves.toEqual({
      defaultRuntime: undefined,
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
      markWriteExpectation("emulator-5586", "device-3"),
    ]);
    const driver = await createDriver(filesystem, runner, { clock, ids: ["one"] });
    const spec = await driver.resolveSpec(
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      { allowDownload: false },
    );
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
    const spec = await driver.resolveSpec(
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      { allowDownload: false },
    );
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
    await driverA.resolveSpec(spec, { allowDownload: false });
    await driverB.resolveSpec(spec, { allowDownload: false });

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

      const spec = await driver.resolveSpec(
        { model: "Custom A", osVersion: "34", platform: "android" },
        { allowDownload: false },
      );
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
        const spec = await driver.resolveSpec(
          { model: "Custom A", osVersion: "34", platform: "android" },
          { allowDownload: false },
        );
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

      const spec = await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "34", platform: "android" },
        { allowDownload: false },
      );
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
        async listModels() {
          return ["Evil Phone"];
        },
        async resolve(model: string) {
          if (model.toLocaleLowerCase() !== "evil phone") {
            return undefined;
          }
          return {
            hardwareProperties: {
              "hw.device.manufacturer": "Acme\ndisk.dataPartition.path=/evil",
              "hw.device.name": "Evil Phone",
            },
            kind: "properties" as const,
            name: "Evil Phone",
          };
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
        processSupervisor: new FakeProcessSupervisor(),
        simlockHome: home,
        tcpProbe: new FakeTcpProbe(),
      });

      const spec = await driver.resolveSpec(
        { model: "Evil Phone", osVersion: "34", platform: "android" },
        { allowDownload: false },
      );

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
        driver.resolveSpec(
          { model: "Nonexistent Model", osVersion: "34", platform: "android" },
          { allowDownload: false },
        ),
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
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

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
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licensesHaveNotBeenAcceptedOutput },
        },
      ]);
      const driver = await createDriver(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AndroidLicenseNotAcceptedError);
    });

    it("accepts licenses through piped confirmation and retries the install once when the flag is on", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
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

      await expect(
        driver.resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        ),
      ).resolves.toEqual({ model: "Pixel 8", osVersion: "35", platform: "android" });

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
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
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

      await expect(
        driver.resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        ),
      ).rejects.toMatchObject({ name: "DriverCrashError" });
    });
  });

  it("dedupes concurrent resolveSpec calls for the same missing system image behind one sdkmanager install", async () => {
    const filesystem = await androidFilesystem();
    const runner = new InstallReflectingProcessRunner(
      [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.sdkmanager, [
          "--install",
          "system-images;android-35;google_apis;arm64-v8a",
        ]),
      ],
      filesystem,
    );
    const driver = await createDriver(filesystem, runner);
    const request = { model: "Pixel 8", osVersion: "35", platform: "android" } as const;

    const [first, second] = await Promise.all([
      driver.resolveSpec(request, { allowDownload: true }),
      driver.resolveSpec(request, { allowDownload: true }),
    ]);

    expect(first).toEqual({ model: "Pixel 8", osVersion: "35", platform: "android" });
    expect(second).toEqual({ model: "Pixel 8", osVersion: "35", platform: "android" });
    expect(runner.calls.filter((call) => call.args[0] === "--install")).toHaveLength(1);
  });

  describe("component install diagnostics", () => {
    it("reports component-install-started then component-installed with a duration on a clean install", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "35", platform: "android" },
        { allowDownload: true },
      );

      expect(diagnostics).toEqual([
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          kind: "component-install-started",
        },
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          durationMs: 0,
          kind: "component-installed",
        },
      ]);
    });

    it("reports component-install-failed with a stable error summary when the install is rejected outright", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: binaries.sdkmanager,
          },
          result: { code: 1, stderr: "no network", stdout: "" },
        },
      ]);
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((error: unknown) => error);

      expect(diagnostics).toEqual([
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          kind: "component-install-started",
        },
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          durationMs: 0,
          error: expect.stringContaining("DriverCrashError:"),
          kind: "component-install-failed",
        },
      ]);
    });

    it("reports exactly one component-install-failed for a license-retry failure, not one per attempt", async () => {
      const licenseNotAcceptedOutput =
        "Warning: License for package Android SDK Platform 35 not accepted.\n\n" +
        "1 package(s) were skipped due to license issues. Please accept the license(s) and try " +
        "again.\nTo resolve, run: sdkmanager --licenses\n";
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
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
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        acceptAndroidLicenses: true,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((error: unknown) => error);

      const installDiagnostics = diagnostics.filter((diagnostic) =>
        diagnostic.kind.startsWith("component-install"),
      );
      expect(installDiagnostics).toEqual([
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          kind: "component-install-started",
        },
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          durationMs: 0,
          error: expect.stringContaining("DriverCrashError:"),
          kind: "component-install-failed",
        },
      ]);
    });

    it("fails disk preflight before ever invoking sdkmanager, and reports no diagnostic", async () => {
      const filesystem = await androidFilesystem({ freeDiskBytes: 1024 });
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      const error = await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
      expect((error as Error).message).toMatch(/needs ~2\.0 GiB.*only 0\.0 GiB available/);
      // The device-profile lookup ran (avdmanager list device), but no sdkmanager call at all.
      expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
      expect(diagnostics).toEqual([]);
    });

    it("checks disk space on the SDK's own volume, not the daemon's working directory", async () => {
      class RecordingFilesystem extends MemoryFilesystem {
        readonly diskFreePaths: string[] = [];

        override async diskFree(path: string): Promise<number> {
          this.diskFreePaths.push(path);
          return super.diskFree(path);
        }
      }
      const recordingFilesystem = new RecordingFilesystem();
      const filesystem = await androidFilesystem({}, recordingFilesystem);
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);

      await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "35", platform: "android" },
        { allowDownload: true },
      );

      expect(recordingFilesystem.diskFreePaths).toEqual([sdk]);
    });

    it("reports component-install-failed, never component-installed, when sdkmanager exits 0 but the image never shows up", async () => {
      const filesystem = await androidFilesystem();
      // Deliberately a plain ScriptedProcessRunner, not InstallReflectingProcessRunner: sdkmanager
      // claims success, but nothing ever lands in the filesystem's system-images tree -- the
      // "reported success but still not installed" case the post-install re-scan exists to catch.
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.sdkmanager, [
          "--install",
          "system-images;android-35;google_apis;arm64-v8a",
        ]),
      ]);
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      const error = await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "sdkmanager reported success but system-images;android-35;google_apis;arm64-v8a is still not installed",
      );
      expect(diagnostics).toEqual([
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          kind: "component-install-started",
        },
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          durationMs: 0,
          error: expect.stringContaining("still not installed"),
          kind: "component-install-failed",
        },
      ]);
    });

    it("carries requesterId through to component-install diagnostics when resolveSpec's caller knows one", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const diagnostics: AndroidDriverDiagnostic[] = [];
      const driver = await createDriver(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "35", platform: "android" },
        { allowDownload: true, requesterId: "agent-7" },
      );

      expect(diagnostics).toEqual([
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          kind: "component-install-started",
          requesterId: "agent-7",
        },
        {
          componentId: "system-images;android-35;google_apis;arm64-v8a",
          durationMs: 0,
          kind: "component-installed",
          requesterId: "agent-7",
        },
      ]);
    });

    it("respects disk-space reservations already outstanding on a shared DiskSpaceGuard", async () => {
      const filesystem = await androidFilesystem({ freeDiskBytes: 2.5 * 1024 ** 3 });
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const diskSpaceGuard = new DiskSpaceGuard();
      // Stands in for another driver's (or another install's) concurrent reservation against the
      // same shared guard -- 2 of the 2.5 GiB free is already spoken for, leaving less than the
      // 2 GiB `ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES` floor this install needs.
      const releaseOther = await diskSpaceGuard.reserve(filesystem, "ios", 1.5 * 1024 ** 3, sdk);
      const driver = await createDriver(filesystem, runner, { diskSpaceGuard });

      const error = await driver
        .resolveSpec(
          { model: "Pixel 8", osVersion: "35", platform: "android" },
          { allowDownload: true },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
      expect(runner.calls.some((call) => call.command === binaries.sdkmanager)).toBe(false);
      releaseOther();
    });
  });

  describe("download timeout", () => {
    it("threads the configured downloadTimeoutMs into the sdkmanager install call", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner, { downloadTimeoutMs: 42_000 });

      await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "35", platform: "android" },
        { allowDownload: true },
      );

      const installCall = runner.calls.find(
        (call) => call.command === binaries.sdkmanager && call.args[0] === "--install",
      );
      expect(installCall?.options.timeoutMs).toBe(42_000);
    });

    it("defaults to the same 20-minute timeout as before this option existed", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
          processResult(binaries.sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const driver = await createDriver(filesystem, runner);

      await driver.resolveSpec(
        { model: "Pixel 8", osVersion: "35", platform: "android" },
        { allowDownload: true },
      );

      const installCall = runner.calls.find(
        (call) => call.command === binaries.sdkmanager && call.args[0] === "--install",
      );
      expect(installCall?.options.timeoutMs).toBe(20 * 60_000);
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
    await driver.resolveSpec({ model: "Pixel 8", platform: "android" }, { allowDownload: false });
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
      instanceId: `live-${process.pid}`,
      processRunner: new NodeProcessRunner(),
      processSupervisor: new NodeProcessSupervisor(),
      simlockHome: join(tmpdir(), `simlock-live-android-${process.pid}`),
      tcpProbe: new NodeTcpProbe(),
    });
    const spec = await driver.resolveSpec(
      {
        model: process.env.SIMLOCK_LIVE_ANDROID_MODEL ?? "Pixel 8",
        platform: "android",
        ...(process.env.SIMLOCK_LIVE_ANDROID_API === undefined
          ? {}
          : { osVersion: process.env.SIMLOCK_LIVE_ANDROID_API }),
      },
      { allowDownload: false },
    );
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
    readonly forBaselineReclaim?: boolean;
    readonly forFullCleanBoot?: boolean;
    readonly forReclaim?: boolean;
    readonly initialAdbFailures?: number;
    readonly readinessTimeoutMs?: number;
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
      markWriteExpectation("emulator-5586", secondMarkToken),
    );
  }

  const runner = new ScriptedProcessRunner(expectations);
  const driver = await createDriver(filesystem, runner, {
    clock,
    ids: ["one"],
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    tcpProbe,
  });
  const spec = await driver.resolveSpec(
    { model: "Pixel 8", osVersion: "34", platform: "android" },
    { allowDownload: false },
  );
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
async function createDriver(
  filesystem: Filesystem,
  processRunner: ScriptedProcessRunner,
  options: {
    readonly acceptAndroidLicenses?: boolean;
    readonly clock?: FakeClock;
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly diskSpaceGuard?: DiskSpaceGuard;
    readonly downloadTimeoutMs?: number;
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
    ...(options.acceptAndroidLicenses === undefined
      ? {}
      : { acceptAndroidLicenses: options.acceptAndroidLicenses }),
    clock: options.clock ?? new FakeClock(),
    driverConfig,
    ...(options.diskSpaceGuard === undefined ? {} : { diskSpaceGuard: options.diskSpaceGuard }),
    ...(options.downloadTimeoutMs === undefined
      ? {}
      : { downloadTimeoutMs: options.downloadTimeoutMs }),
    env: { ANDROID_HOME: sdk },
    filesystem,
    homeDirectory: home,
    hostAbi: "arm64-v8a",
    idGenerator: {
      generate: () => options.ids?.[nextId++] ?? `device-${nextId}`,
    },
    instanceId,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    processRunner,
    processSupervisor: new FakeProcessSupervisor([adbServerPid]),
    simlockHome,
    tcpProbe: options.tcpProbe ?? new FakeTcpProbe([configuredPort]),
  });
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
    `<d:device><d:name>${name}</d:name><d:hardware><d:ram>` +
    `<d:ram-size unit="MiB">${ramMiB}</d:ram-size></d:ram></d:hardware></d:device>`
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
  readonly initialAdbFailures?: number | undefined;
  readonly launchArgs: readonly string[];
}): ScriptedProcessExpectation[] {
  const bootCompleted = options.bootCompleted ?? "1\n";
  const expectations: ScriptedProcessExpectation[] = [
    {
      hangs: bootCompleted.trim() !== "1",
      match: {
        args: ["-avd", "simlock_one", "-port", "5586", "-no-snapshot-save", ...options.launchArgs],
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
            void this.#filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
          }
        }
      });
    }
    return handle;
  }
}

function processResult(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return {
    match: { args, command },
    result: { code: 0, stderr: "", stdout },
  };
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
