import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Driver } from "../../core/driver.js";
import { OWNED_ROOT_MARKER_FILE, OwnedRootError } from "../../core/index.js";
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
  type ScriptedProcessExpectation,
  SystemClock,
} from "../../ports/index.js";
import { AdbServerUnavailableError, AndroidDriver, SdkMissingError } from "./index.js";

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
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.sdkmanager, [
        "--install",
        "system-images;android-35;google_apis;arm64-v8a",
      ]),
    ]);
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
          match: { args: ["-o", "comm=", "-p", String(adbServerPid)], command: "ps" },
          result: { code: 0, stderr: "", stdout: "adb\n" },
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
  it("announces a freshly started emulator to Simlock's own adb server", async () => {
    const harness = await provisionedHarness();

    await harness.driver.makeReady(harness.device);

    // The adb port is the console port + 1, and with the scanner off this announcement is
    // what attaches the emulator at all.
    expect(harness.tcpProbe.sends).toContainEqual({
      payload: "0012host:emulator:5587",
      port: adbServerPort,
    });
  });

  it("re-announces an emulator that stays unreachable, since nothing else will", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 2 });
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(1));

    // Past the grace period on the second failure: adb's own reconnect queue is drained by
    // the scanner thread, which `ADB_EMU=0` does not run.
    harness.clock.advance(6_000);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(2));
    await vi.waitFor(() => expect(harness.tcpProbe.sends).toHaveLength(2));

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
    readonly clock?: FakeClock;
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly ids?: readonly string[];
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
    clock: options.clock ?? new FakeClock(),
    driverConfig,
    env: { ANDROID_HOME: sdk },
    filesystem,
    homeDirectory: home,
    hostAbi: "arm64-v8a",
    idGenerator: {
      generate: () => options.ids?.[nextId++] ?? `device-${nextId}`,
    },
    instanceId,
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

async function androidFilesystem(
  options: {
    readonly config?: string;
    readonly images?: readonly (readonly [string, string, string])[];
    readonly withDeviceRoot?: boolean;
  } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
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
