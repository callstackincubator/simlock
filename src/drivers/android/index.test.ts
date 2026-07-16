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

  it("treats an unset boot animation property as ready", async () => {
    const harness = await provisionedHarness();

    await expect(harness.driver.makeReady(harness.device)).resolves.toBeUndefined();
    expect(harness.runner.calls.at(-3)).toMatchObject({
      args: ["-avd", "pitlane_one", "-port", "5554", "-no-window", "-no-audio", "-no-boot-anim"],
      command: binaries.emulator,
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
    await expect(
      harness.filesystem.exists(`${avdDirectory}/pitlane_one.avd/snapshots`),
    ).resolves.toBe(false);
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
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-wipe-data",
        "-no-snapshot-load",
      ],
      command: binaries.emulator,
      options: {},
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
      processResult(binaries.adb, ["-s", "emulator-5554", "emu", "kill"]),
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
    readonly forFullCleanBoot?: boolean;
    readonly forReclaim?: boolean;
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

  if (options.forReclaim === true || options.forFullCleanBoot === true) {
    expectations.push(processResult(binaries.adb, ["-s", "emulator-5554", "emu", "kill"]));
  }
  if (options.forReclaim === true) {
    expectations.push(
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    );
  }
  if (options.forFullCleanBoot !== true) {
    expectations.push({
      hangs: true,
      match: {
        command: binaries.emulator,
        args: ["-avd", "pitlane_one", "-port", "5554", "-no-window", "-no-audio", "-no-boot-anim"],
      },
    });
    expectations.push(
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        options.bootCompleted ?? "1\n",
      ),
    );
    if ((options.bootCompleted ?? "1\n").trim() === "1") {
      expectations.push(
        processResult(
          binaries.adb,
          ["-s", "emulator-5554", "shell", "getprop", "init.svc.bootanim"],
          "",
        ),
      );
    }
  } else {
    expectations.push({
      hangs: true,
      match: {
        command: binaries.emulator,
        args: [
          "-avd",
          "pitlane_one",
          "-port",
          "5554",
          "-no-window",
          "-no-audio",
          "-no-boot-anim",
          "-wipe-data",
          "-no-snapshot-load",
        ],
      },
    });
    expectations.push(
      processResult(
        binaries.adb,
        ["-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"],
        "1\n",
      ),
    );
    expectations.push(
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

function processResult(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return {
    match: { args, command },
    result: { code: 0, stderr: "", stdout },
  };
}
