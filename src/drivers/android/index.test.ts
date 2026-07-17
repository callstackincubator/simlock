import { describe, expect, it, vi } from "vitest";

import type { Driver } from "../../core/driver.js";
import {
  FakeClock,
  type Filesystem,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  SystemClock,
} from "../../ports/index.js";
import { AndroidDriver, SdkMissingError } from "./index.js";

const sdk = "/android-sdk";
const home = "/home/pitlane";
const avdDirectory = `${home}/.android/avd`;
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

    const driver = await AndroidDriver.create({
      clock: new FakeClock(),
      env: {
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: "/ignored-sdk",
      },
      filesystem,
      homeDirectory: home,
      processRunner: runner,
    });

    expect(driver.sdkPath).toBe(sdk);
    await expect(
      AndroidDriver.create({
        clock: new FakeClock(),
        env: {},
        filesystem: new MemoryFilesystem(),
        homeDirectory: home,
        processRunner: runner,
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
        "pitlane_first",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "pitlane_second",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5554\tdevice\n"),
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5554\tdevice\n"),
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

    expect(firstDevice.driverData).toMatchObject({ avdName: "pitlane_first", port: 5556 });
    expect(secondDevice.driverData).toMatchObject({ avdName: "pitlane_second", port: 5558 });
  });

  it("cold boots without loading or automatically saving snapshots", async () => {
    const harness = await provisionedHarness();

    await expect(harness.driver.makeReady(harness.device)).resolves.toBeUndefined();
    expect(harness.runner.calls).toContainEqual({
      args: ["-avd", "pitlane_one", "-port", "5554", "-no-snapshot-save", "-no-snapshot-load"],
      command: binaries.emulator,
      options: {},
    });
  });

  it("validates a new clean baseline by restarting from it before becoming ready", async () => {
    const harness = await provisionedHarness();

    await expect(harness.driver.makeReady(harness.device)).resolves.toBeUndefined();

    expect(harness.runner.calls).toContainEqual({
      args: [
        "-avd",
        "pitlane_one",
        "-port",
        "5554",
        "-no-snapshot-save",
        "-snapshot",
        "pitlane_clean_baseline",
      ],
      command: binaries.emulator,
      options: {},
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
        args: ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
        options: {},
      }),
    );
    harness.clock.advance(2_000);

    await expect(ready).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(kills).toContain("SIGKILL");
  });

  it("retries adb while the emulator is starting", async () => {
    const harness = await provisionedHarness({ initialAdbFailure: true });
    const ready = harness.driver.makeReady(harness.device);

    await vi.waitFor(() =>
      expect(harness.runner.calls).toContainEqual({
        args: ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
        options: {},
      }),
    );
    harness.clock.advance(2_000);

    await expect(ready).resolves.toBeUndefined();
  });

  it("invalidates stale quickboot snapshots and flags the next boot to wipe data", async () => {
    const harness = await provisionedHarness({ forReclaim: true });
    await harness.filesystem.mkdirp(`${avdDirectory}/pitlane_one.avd/snapshots/default_boot`);
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/pitlane_one.avd/config.ini`,
      "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a\nhw.ramSize=4096\n",
    );

    await expect(harness.driver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "shutdown",
      strategy: "wipe",
    });
    await harness.driver.makeReady(harness.device);
    await expect(
      harness.filesystem.exists(`${avdDirectory}/pitlane_one.avd/snapshots`),
    ).resolves.toBe(false);
    await expect(
      harness.filesystem.exists(`${avdDirectory}/pitlane_one.avd/pitlane-clean-baseline.json`),
    ).resolves.toBe(true);
  });

  it("uses wipe-data and disables snapshot loading after a full reclaim", async () => {
    const harness = await provisionedHarness({ forFullCleanBoot: true });
    await harness.driver.reclaim(harness.device, { clean: "full" });

    await harness.driver.makeReady(harness.device);

    expect(harness.runner.calls).toContainEqual({
      args: [
        "-avd",
        "pitlane_one",
        "-port",
        "5554",
        "-no-snapshot-save",
        "-wipe-data",
        "-no-snapshot-load",
      ],
      command: binaries.emulator,
      options: {},
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
      args: ["-s", "emulator-5554", "emu", "avd", "snapshot", "load", "pitlane_clean_baseline"],
      command: binaries.adb,
      options: {},
    });
    const saves = harness.runner.calls.filter((call) => call.args.includes("save"));
    expect(saves).toHaveLength(1);
  });

  it("tags the baseline with the emulator-normalized post-boot configuration", async () => {
    const harness = await provisionedHarness({ forBaselineReclaim: true });
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/pitlane_one.avd/config.ini`,
      "hw.ramSize = 2048\n",
    );

    await harness.driver.makeReady(harness.device);
    const reclaimCallStart = harness.runner.calls.length;

    await expect(harness.driver.reclaim(harness.device, { clean: "standard" })).resolves.toEqual({
      state: "ready",
      strategy: "snapshot",
    });
    expect(harness.runner.calls.slice(reclaimCallStart)).not.toContainEqual({
      args: ["-s", "emulator-5554", "emu", "kill"],
      command: binaries.adb,
      options: {},
    });
  });

  it("reclaims from persisted baseline metadata after a driver restart", async () => {
    const harness = await provisionedHarness();
    await harness.filesystem.writeFileAtomic(
      `${avdDirectory}/pitlane_one.avd/config.ini`,
      "hw.ramSize = 2048\n",
    );
    await harness.driver.makeReady(harness.device);

    const restartedRunner = new ScriptedProcessRunner([
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "emu", "avd", "snapshot", "load", "pitlane_clean_baseline"],
        "OK\n",
      ),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        "1\n",
      ),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
        "",
      ),
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
            "pitlane_one",
            "-port",
            "5554",
            "-no-snapshot-save",
            "-snapshot",
            "pitlane_clean_baseline",
          ],
          command: binaries.emulator,
        },
      },
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        "1\n",
      ),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
        "",
      ),
    ]);
    const restartedDriver = await createDriver(harness.filesystem, restartedRunner);

    await expect(restartedDriver.makeReady(harness.device)).resolves.toBeUndefined();
    expect(restartedRunner.calls[1]).toMatchObject({
      args: [
        "-avd",
        "pitlane_one",
        "-port",
        "5554",
        "-no-snapshot-save",
        "-snapshot",
        "pitlane_clean_baseline",
      ],
      command: binaries.emulator,
    });
  });

  it("shuts down and deletes only the provisioned pitlane AVD", async () => {
    const filesystem = await androidFilesystem({ config: "hw.ramSize=2048\n" });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      processResult(binaries.avdmanager, [
        "create",
        "avd",
        "-n",
        "pitlane_delete-me",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      {
        match: { args: ["-s", "emulator-5554", "emu", "kill"], command: binaries.adb },
        result: { code: 1, stderr: "connection refused", stdout: "" },
      },
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "pitlane_delete-me"]),
    ]);
    const driver: Driver = await createDriver(filesystem, runner, { ids: ["delete-me"] });
    const spec = await driver.resolveSpec(
      { model: "Pixel 8", osVersion: "34", platform: "android" },
      { allowDownload: false },
    );
    const device = await driver.provision(spec);

    await expect(driver.destroy(device)).resolves.toBeUndefined();
    expect(runner.calls.at(-1)).toMatchObject({
      args: ["delete", "avd", "-n", "pitlane_delete-me"],
      command: binaries.avdmanager,
    });
  });

  it("reports conservative cold-boot estimates through the Driver contract", async () => {
    const driver: Driver = await createDriver(
      await androidFilesystem(),
      new ScriptedProcessRunner([]),
    );
    const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;

    expect(driver.estimate("provision", spec)).toBe(1_000);
    expect(driver.estimate("boot", spec)).toBe(31_000);
    expect(driver.estimate("reclaim", spec)).toBe(2_000);
  });
});

const live = process.env.PITLANE_LIVE_ANDROID === "1" ? it : it.skip;

live(
  "live smoke: provision, quickboot reclaim, re-ready, and destroy",
  async () => {
    const driver = await AndroidDriver.create({
      clock: new SystemClock(),
      env: process.env,
      filesystem: new NodeFilesystem(),
      homeDirectory: process.env.HOME ?? home,
      processRunner: new NodeProcessRunner(),
    });
    const spec = await driver.resolveSpec(
      {
        model: process.env.PITLANE_LIVE_ANDROID_MODEL ?? "Pixel 8",
        platform: "android",
        ...(process.env.PITLANE_LIVE_ANDROID_API === undefined
          ? {}
          : { osVersion: process.env.PITLANE_LIVE_ANDROID_API }),
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
    readonly initialAdbFailure?: boolean;
    readonly readinessTimeoutMs?: number;
  } = {},
) {
  const filesystem = await androidFilesystem({ config: "hw.ramSize=2048\n" });
  const clock = new FakeClock();
  const expectations: ScriptedProcessExpectation[] = [
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    processResult(binaries.avdmanager, [
      "create",
      "avd",
      "-n",
      "pitlane_one",
      "-k",
      /.+/,
      "-d",
      "pixel_8",
    ]),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    processResult(binaries.adb, ["devices"], "List of devices attached\n"),
  ];

  if (options.forReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.adb, ["-s", "emulator-5554", "emu", "kill"]),
      ...baselineBuildExpectations({ launchArgs: ["-wipe-data", "-no-snapshot-load"] }),
    );
  } else if (options.forFullCleanBoot === true) {
    expectations.push(
      processResult(binaries.adb, ["-s", "emulator-5554", "emu", "kill"]),
      ...baselineBuildExpectations({ launchArgs: ["-wipe-data", "-no-snapshot-load"] }),
    );
  } else {
    expectations.push(
      ...baselineBuildExpectations({
        bootCompleted: options.bootCompleted,
        initialAdbFailure: options.initialAdbFailure,
        launchArgs: ["-no-snapshot-load"],
      }),
    );
  }

  if (options.forBaselineReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "emu", "avd", "snapshot", "load", "pitlane_clean_baseline"],
        "OK\n",
      ),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        "1\n",
      ),
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
        "",
      ),
    );
  }

  const runner = new ScriptedProcessRunner(expectations);
  const driver = await createDriver(filesystem, runner, {
    clock,
    ids: ["one"],
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
  });
  const spec = await driver.resolveSpec(
    { model: "Pixel 8", osVersion: "34", platform: "android" },
    { allowDownload: false },
  );
  const device = await driver.provision(spec);

  return { clock, device, driver, filesystem, runner };
}

async function createDriver(
  filesystem: Filesystem,
  processRunner: ScriptedProcessRunner,
  options: {
    readonly clock?: FakeClock;
    readonly ids?: readonly string[];
    readonly readinessTimeoutMs?: number;
  } = {},
) {
  let nextId = 0;
  return AndroidDriver.create({
    clock: options.clock ?? new FakeClock(),
    env: { ANDROID_HOME: sdk },
    filesystem,
    homeDirectory: home,
    hostAbi: "arm64-v8a",
    idGenerator: {
      generate: () => options.ids?.[nextId++] ?? `device-${nextId}`,
    },
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    processRunner,
  });
}

async function androidFilesystem(
  options: {
    readonly config?: string;
    readonly images?: readonly (readonly [string, string, string])[];
  } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  for (const binary of Object.values(binaries)) {
    await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
    await filesystem.writeFileAtomic(binary, "binary");
  }
  await filesystem.mkdirp(avdDirectory);
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  if (options.config !== undefined) {
    await filesystem.mkdirp(`${avdDirectory}/pitlane_one.avd`);
    await filesystem.writeFileAtomic(`${avdDirectory}/pitlane_one.avd/config.ini`, options.config);
  }
  return filesystem;
}

function baselineBuildExpectations(options: {
  readonly bootCompleted?: string | undefined;
  readonly initialAdbFailure?: boolean | undefined;
  readonly launchArgs: readonly string[];
}): ScriptedProcessExpectation[] {
  const bootCompleted = options.bootCompleted ?? "1\n";
  const expectations: ScriptedProcessExpectation[] = [
    {
      hangs: bootCompleted.trim() !== "1",
      match: {
        args: ["-avd", "pitlane_one", "-port", "5554", "-no-snapshot-save", ...options.launchArgs],
        command: binaries.emulator,
      },
    },
  ];
  if (options.initialAdbFailure === true) {
    expectations.push({
      match: {
        args: ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
      },
      result: { code: 1, stderr: "connection refused", stdout: "" },
    });
  }
  expectations.push(
    processResult(
      binaries.adb,
      ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
      bootCompleted,
    ),
  );
  if (bootCompleted.trim() !== "1") {
    return expectations;
  }

  expectations.push(
    processResult(
      binaries.adb,
      ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
      "",
    ),
    processResult(binaries.adb, [
      "-s",
      "emulator-5554",
      "emu",
      "avd",
      "snapshot",
      "save",
      "pitlane_clean_baseline",
    ]),
    processResult(
      binaries.adb,
      ["-s", "emulator-5554", "emu", "avd", "snapshot", "list"],
      "pitlane_clean_baseline\n",
    ),
    processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    processResult(binaries.adb, ["-s", "emulator-5554", "emu", "kill"]),
    {
      hangs: true,
      match: {
        args: [
          "-avd",
          "pitlane_one",
          "-port",
          "5554",
          "-no-snapshot-save",
          "-snapshot",
          "pitlane_clean_baseline",
        ],
        command: binaries.emulator,
      },
    },
    processResult(
      binaries.adb,
      ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
      "1\n",
    ),
    processResult(
      binaries.adb,
      ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
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
