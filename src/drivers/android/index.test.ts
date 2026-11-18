import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  ComponentInUseError,
  ComponentNotOwnedError,
  OWNED_ROOT_MARKER_FILE,
  OwnedRootError,
} from "../../core/index.js";
import { FakeClock, FakeProcessSupervisor, FakeTcpProbe } from "../../ports/index.js";
import { AdbServerUnavailableError, AndroidDriver } from "./index.js";
import {
  androidFilesystem,
  avdDirectory,
  privateAliasOf,
  binaries,
  EmulatorExitingRunner,
  instanceId,
  simlockHome,
  InstallReflectingProcessRunner,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  userAvd,
  adbServerPort,
  adbServerPid,
  adbRecordPath,
  scopedEnv,
  createDriver,
  recordRunningAdbServer,
  ok,
  WorkingDirectoryFilesystem,
} from "./testing.js";
import { sdk, home, VIRTUAL_DEVICE } from "./test-index.js";

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
      answer: ok(`${join(avdDirectory, "simlock_one.avd")}/\r\nOK\r\n`),
      runState: "running",
    },
    {
      reported: "a canonical alias",
      answer: ok(`${privateAliasOf(join(avdDirectory, "simlock_one.avd"))}\r\nOK\r\n`),
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
      answer: ok(`${join(avdDirectory, "simlock_two.avd")}\r\nOK\r\n`),
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
      await filesystem.mkdirp(join(avdDirectory, "simlock_two.avd"));

      for (const result of [ok(`${join(avdDirectory, "simlock_one.avd")}\r\nOK\r\n`), answer]) {
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
      join(avdDirectory, "simlock_a", "simlock.avd"),
      join(avdDirectory, "simlock_b", "simlock.avd"),
      join(avdDirectory, "simlock_old.avd"),
      join(avdDirectory, "sources", "seed_x", "simlock.avd"),
    ]) {
      await filesystem.mkdirp(folder);
    }
    const running = [
      ["emulator-5554", "simlock", join(avdDirectory, "simlock_b", "simlock.avd")],
      ["emulator-5556", "simlock", join(avdDirectory, "simlock_a", "simlock.avd")],
      ["emulator-5558", "simlock_old", join(avdDirectory, "simlock_old.avd")],
      ["emulator-5560", "simlock", join(avdDirectory, "sources", "seed_x", "simlock.avd")],
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
    await filesystem.mkdirp(join(avdDirectory, "simlock_new.avd"));
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
    expect(legacy?.path).toBe(join(legacyHome, "simlock_old.avd"));
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
