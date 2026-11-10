import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, OWNED_ROOT_MARKER_FILE, type OwnedRootError } from "../core/index.js";
import { androidDriverConfig, type AndroidDriverConfig } from "../drivers/android/index.js";
import { IosSimctlDriver, iosDriverConfig, type IosDriverConfig } from "../drivers/ios/index.js";
import { logAndroidDiagnostic } from "../drivers/android/local/index.js";
import { emitSlimDiagnostic } from "../drivers/ios/local/index.js";
import { EventBus } from "../bus/index.js";
import {
  CryptoIdGenerator,
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
  type IdGenerator,
} from "../ports/index.js";
import { memorySourceDatabase } from "../drivers/ios/testing.js";
import { promiseState } from "../test-support/promise-state.js";
import { deviceModeWiring, modelPreferenceWiring, processRunnerFor } from "./worker-composition.js";
import { discoverDrivers, type DriverDiscoveryContext } from "./driver-discovery.js";
import { SIMLOCK_HOME, start, stopDaemons, writeModule } from "./test-main.js";

afterEach(stopDaemons);

// why: a part of a decomposed module (ADR 0063 §2): driver discovery and the worker's wiring helpers are `driver-discovery.ts` and `worker-composition.ts`, parts of the daemon's composition root.
describe("discoverDrivers", () => {
  it("builds no Android driver when the SDK cannot be found", async () => {
    const logger = new JsonLinesLogger({
      clock: new FakeClock(),
      level: "debug",
      sink: new MemoryLogSink(),
    });
    const filesystem = new MemoryFilesystem();

    const { drivers } = await discoverDrivers({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostArch: "arm64",
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: "instance-1",
      logger,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome: "/home/.simlock",
      tcpProbe: new FakeTcpProbe(),
    });

    expect(drivers.some((driver) => driver.platform === "android")).toBe(false);
  });

  it("does not look for simulators on a host that has no simctl", async () => {
    const { drivers, rejections } = await discoverIos({ hostPlatform: "linux" });

    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    // why: Nothing refused anything here: a host without Xcode is not a fail-closed refusal
    // and must not be reported as one.
    expect(rejections).toEqual([]);
  });

  it("builds no iOS prerequisite check on a host that is not macOS, and an Android one", async () => {
    const { prerequisiteChecks } = await discoverIos({ hostPlatform: "linux" });

    expect(prerequisiteChecks.map((check) => check.platform)).toEqual(["android"]);
  });

  it("builds both prerequisite checks on macOS, whether or not a driver started", async () => {
    // why: The refused root costs the iOS driver; it must not cost the check that explains it.
    const { drivers, prerequisiteChecks } = await discoverIos({
      filesystem: await foreignOwnedRoot(),
    });

    expect(drivers.some((driver) => driver.platform === "ios")).toBe(false);
    expect(prerequisiteChecks.map((check) => check.platform)).toEqual(["ios", "android"]);
  });

  it("starts the iOS driver on a host with simctl, with the root it validated", async () => {
    const filesystem = new MemoryFilesystem();

    const { drivers, rejections } = await discoverIos({ filesystem });

    expect(rejections).toEqual([]);
    expect(drivers.find((driver) => driver.platform === "ios")?.deviceRoot).toBe(IOS_ROOT);
  });

  it("publishes the refusal as the payload docs/internal/EVENTS.md documents for driver.root-rejected", async () => {
    const filesystem = await foreignOwnedRoot();
    const refusal = await refusedRoot(filesystem);

    const { rejections } = await discoverIos({ filesystem });

    // why: Built from a real `OwnedRootError`, key by key: the payload is a wire contract
    // `simlock events --json` publishes, so renaming `root` has to fail here.
    expect(rejections[0]).toEqual({
      event: "driver.root-rejected",
      // why: the wrappers this platform would have answered to, so a request for `simctl` or
      // `devicectl` can say why the driver is missing instead of reading as "this host has no
      // Xcode".
      passthroughTools: ["simctl", "devicectl"],
      payload: { platform: "ios", reason: "wrong-instance", root: IOS_ROOT },
      platform: "ios",
      reason: "wrong-instance",
      summary: refusal.message,
    });
  });

  it("still fails startup when the iOS driver fails for a reason that is not a refusal", async () => {
    // why: Anything that is not an `OwnedRootError` is a bug rather than a fail-closed
    // decision, and swallowing it would hide it behind a silently missing platform.
    await expect(
      discoverIos({
        idGenerator: {
          generate: () => {
            throw new Error("entropy exhausted");
          },
        },
      }),
    ).rejects.toThrow("entropy exhausted");
  });
});

describe("discoverDrivers on a host with an Android SDK", () => {
  const previousAndroidHome = process.env.ANDROID_HOME;

  afterEach(() => {
    if (previousAndroidHome === undefined) {
      delete process.env.ANDROID_HOME;
    } else {
      process.env.ANDROID_HOME = previousAndroidHome;
    }
  });

  it("keeps the daemon up when Simlock's adb port is occupied, reporting the platform instead", async () => {
    const filesystem = await androidSdk();

    const { drivers, rejections } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]));

    expect(drivers.some((driver) => driver.platform === "android")).toBe(false);
    // why: The payload is a wire contract `simlock events --json` publishes for
    // `driver.adb-server-rejected`, so a renamed key has to fail here.
    expect(rejections[0]).toMatchObject({
      event: "driver.adb-server-rejected",
      passthroughTools: ["adb"],
      payload: { port: 5038, reason: "occupied" },
      platform: "android",
      reason: "occupied",
    });
  });

  it("starts the Android driver on its own root once its adb server is established", async () => {
    const filesystem = await androidSdk();
    const probe = new FakeTcpProbe([5038]);
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );

    const { drivers, rejections } = await discoverAndroid(filesystem, probe, [4242]);

    expect(rejections).toEqual([]);
    expect(drivers.find((driver) => driver.platform === "android")?.deviceRoot).toBe(
      join(SIMLOCK_HOME, "devices", "android"),
    );
  });

  it.each([
    {
      platform: "ios",
      root: IOS_ROOT,
      discover: async (filesystem: MemoryFilesystem) => {
        await discoverIos({ filesystem });
      },
    },
    {
      platform: "android",
      root: join(SIMLOCK_HOME, "devices", "android"),
      discover: async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp(SIMLOCK_HOME);
        await filesystem.writeFileAtomic(
          join(SIMLOCK_HOME, "adb-server.json"),
          JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
        );
        await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242]);
      },
    },
  ])(
    "names the daemon's pid in the staging directory of the $platform root it creates",
    async ({ platform, root, discover }) => {
      const filesystem = platform === "android" ? await androidSdk() : new MemoryFilesystem();
      const rename = vi.spyOn(filesystem, "rename");

      await discover(filesystem);

      expect(rename).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`/devices/\\.${platform}\\.${process.pid}\\.[^/]+\\.staging$`),
        ),
        root,
      );
    },
  );

  it("launches the discovered Android driver's emulators with the android.emulator options it was handed", async () => {
    const filesystem = await androidSdk();
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );
    const processRunner = new ScriptedProcessRunner([
      {
        match: { args: ["devices"], command: "/android-sdk/platform-tools/adb" },
        result: { code: 0, stderr: "", stdout: "List of devices attached\n" },
      },
      {
        match: { args: ["-help"], command: "/android-sdk/emulator/emulator" },
        result: { code: 0, stderr: "", stdout: "  -crash-report-mode <mode>  crash reporting\n" },
      },
    ]);

    const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
      androidConfig: {
        ...androidDriverConfig.defaults,
        emulator: { audio: true, bootAnimation: true, gpu: "host", headless: true },
      },
      processRunner,
    });
    const android = drivers.find((driver) => driver.platform === "android");
    // why: the emulator's log is written into the AVD's folder.
    await filesystem.mkdirp(join(SIMLOCK_HOME, "devices", "android", "simlock_one.avd"));
    await expect(
      android?.makeReady(
        {
          backend: "local",
          physical: false,
          address: "emulator-5586",
          deviceId: "simlock_one",
          driverData: {
            avdName: "simlock_one",
            configHash: "",
            port: 5586,
            serial: "emulator-5586",
          },
        },
        { mode: "full", purpose: "prepare" },
      ),
    ).rejects.toThrow(/Unexpected process invocation/);

    expect(processRunner.calls.map((call) => call.args)).toEqual([
      ["devices"],
      ["-help"],
      [
        "-avd",
        "simlock_one",
        "-port",
        "5586",
        "-no-snapshot-save",
        "-grpc",
        "8586",
        "-grpc-use-token",
        "-crash-report-mode",
        "never",
        "-no-window",
        "-gpu",
        "host",
        "-wipe-data",
        "-no-snapshot-load",
      ],
    ]);
  });

  it.each([
    { abi: "x86_64", hostArch: "x64" },
    { abi: "arm64-v8a", hostArch: "arm64" },
  ] as const)(
    "hands the Android driver the ABI of the host architecture it was given: $hostArch -> $abi",
    async ({ abi, hostArch }) => {
      const filesystem = await androidSdk();
      await filesystem.mkdirp(SIMLOCK_HOME);
      await filesystem.writeFileAtomic(
        join(SIMLOCK_HOME, "adb-server.json"),
        JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
      );
      // why: nothing is scripted: the install is refused once its argv is recorded.
      const processRunner = new ScriptedProcessRunner([]);

      const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
        hostArch,
        processRunner,
      });
      await drivers
        .find((driver) => driver.platform === "android")
        ?.installComponent("35", {
          onProgress: () => undefined,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);

      expect(processRunner.calls.flatMap((call) => call.args)).toContain(
        `system-images;android-35;google_apis;${abi}`,
      );
    },
  );

  it("logs a warning when the Android driver reports that devices.xml could not be read", async () => {
    const filesystem = await androidSdk();
    await filesystem.mkdirp(SIMLOCK_HOME);
    await filesystem.writeFileAtomic(
      join(SIMLOCK_HOME, "adb-server.json"),
      JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
    );
    const previousUserHome = process.env.ANDROID_USER_HOME;
    process.env.ANDROID_USER_HOME = "/android-user";
    try {
      await filesystem.mkdirp("/android-user");
      await filesystem.writeFileAtomic("/android-user/devices.xml", "not xml at all {{{");
      const sink = new MemoryLogSink();
      const processRunner = new ScriptedProcessRunner([
        {
          match: {
            args: ["list", "device"],
            command: "/android-sdk/cmdline-tools/latest/bin/avdmanager",
          },
          result: { code: 0, stderr: "", stdout: "Available devices:\n" },
        },
      ]);

      const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
        logger: new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink }),
        processRunner,
      });
      await drivers.find((driver) => driver.platform === "android")?.listCatalog();

      expect(sink.records.filter((record) => record.level === "warn")).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({ path: "/android-user/devices.xml" }),
          message: "Android device profile source could not be read",
        }),
      );
    } finally {
      if (previousUserHome === undefined) {
        delete process.env.ANDROID_USER_HOME;
      } else {
        process.env.ANDROID_USER_HOME = previousUserHome;
      }
    }
  });

  it("logs a warning, with the device id and how long the boot took, when a snapshot boot fell back to a cold boot", () => {
    const sink = new MemoryLogSink();

    logAndroidDiagnostic(new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink }), {
      deviceId: "simlock_one",
      kind: "snapshot-cold-boot",
      readyAfterMs: 30_000,
    });

    expect(sink.records).toEqual([
      expect.objectContaining({
        fields: { deviceId: "simlock_one", readyAfterMs: 30_000 },
        level: "warn",
      }),
    ]);
  });

  it("a worker's discovered drivers boot within the deadlines of its config: ios.full.bootTimeoutMs, android.bootTimeoutMs", async () => {
    // why: a hand-off dropped in `discoverDrivers` leaves the driver on its 300 s default, so each case configures another value and watches the boot end exactly there.
    const bootIos = async (clock: FakeClock): Promise<readonly [Promise<unknown>]> => {
      const filesystem = new MemoryFilesystem();
      const udid = "00000000-0000-0000-0000-000000000001";
      const simctl = (...args: string[]) => ["simctl", "--set", IOS_ROOT, ...args];
      const runner = new ScriptedProcessRunner([
        { match: { command: "xcrun", args: simctl("boot", udid) } },
        { hangs: true, match: { command: "xcrun", args: simctl("bootstatus", udid, "-b") } },
        { match: { command: "xcrun", args: simctl("shutdown", udid) } },
      ]);
      const { drivers } = await discoverIos({
        clock,
        filesystem,
        iosConfig: { ...iosDriverConfig.defaults, full: { bootTimeoutMs: 400_000 } },
        processRunner: runner,
      });
      const driver = drivers.find((candidate) => candidate.platform === "ios");
      await filesystem.mkdirp(join(IOS_ROOT, udid, "data"));
      const ready = driver!.makeReady(
        {
          address: udid,
          deviceId: udid,
          backend: "local",
          physical: false,
          driverData: {
            deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
            name: "simlock-device-1",
            runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
            udid,
          },
        },
        { mode: "full", purpose: "recover" },
      );
      for (let turn = 0; turn < 50 && runner.calls.length < 2; turn += 1) await Promise.resolve();
      return [ready];
    };
    const bootAndroid = async (clock: FakeClock): Promise<readonly [Promise<unknown>]> => {
      const filesystem = await androidSdk();
      await filesystem.mkdirp(SIMLOCK_HOME);
      await filesystem.writeFileAtomic(
        join(SIMLOCK_HOME, "adb-server.json"),
        JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
      );
      const runner = new ScriptedProcessRunner([]);
      // why: the emulator never finishes booting and never exits, so only the deadline ends the boot.
      vi.spyOn(runner, "spawn").mockImplementation((command, args, options) =>
        new ScriptedProcessRunner([{ hangs: true, match: { command, args } }]).spawn(
          command,
          args,
          options,
        ),
      );
      vi.spyOn(runner, "run").mockImplementation((_command, args) =>
        Promise.resolve({
          code: 0,
          stderr: "",
          stdout: args.at(-1) === "sys.boot_completed" ? "0\n" : "",
        }),
      );
      const { drivers } = await discoverAndroid(filesystem, new FakeTcpProbe([5038]), [4242], {
        androidConfig: { ...androidDriverConfig.defaults, bootTimeoutMs: 600_000 },
        clock,
        processRunner: runner,
      });
      const driver = drivers.find((candidate) => candidate.platform === "android");
      const avdHome = join(SIMLOCK_HOME, "devices", "android", "device-1");
      await filesystem.mkdirp(join(avdHome, "simlock.avd"));
      const ready = driver!.makeReady(
        {
          address: "emulator-5586",
          deviceId: "device-1",
          backend: "local",
          physical: false,
          driverData: {
            avdHome,
            avdName: "simlock",
            configHash: "hash",
            port: 5586,
            serial: "emulator-5586",
          },
        },
        { mode: "full", purpose: "recover" },
      );
      return [ready];
    };

    for (const { configuredMs, boot, stepMs } of [
      { configuredMs: 400_000, boot: bootIos, stepMs: 400_000 },
      { configuredMs: 600_000, boot: bootAndroid, stepMs: 1_000 },
    ]) {
      const clock = new FakeClock();
      const [ready] = await boot(clock);
      const state = promiseState(ready);
      const failed = ready.then(
        () => undefined,
        (error: unknown) => error,
      );
      // why: Android arms each poll's delay only after the previous one fired, so its clock moves in steps; iOS's deadline is one timer.
      for (let elapsed = 0; elapsed < configuredMs - 1; elapsed += stepMs) {
        expect(state.state, `still booting at ${String(elapsed)} ms`).toBe("pending");
        if (stepMs < configuredMs) {
          await vi.waitFor(() => expect(clock.pendingTimerCount).toBeGreaterThan(0));
        }
        clock.advance(Math.min(stepMs, configuredMs - 1 - elapsed));
        for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
      }
      expect(state.state, `still booting at ${String(configuredMs - 1)} ms`).toBe("pending");

      if (stepMs < configuredMs) {
        await vi.waitFor(() => expect(clock.pendingTimerCount).toBeGreaterThan(0));
      }
      clock.advance(1);
      await expect(failed).resolves.toMatchObject({ name: "BootTimeoutError" });
    }
  });

  async function androidSdk(): Promise<MemoryFilesystem> {
    const filesystem = new MemoryFilesystem();
    process.env.ANDROID_HOME = "/android-sdk";
    for (const binary of [
      "/android-sdk/platform-tools/adb",
      "/android-sdk/emulator/emulator",
      "/android-sdk/cmdline-tools/latest/bin/avdmanager",
      "/android-sdk/cmdline-tools/latest/bin/sdkmanager",
    ]) {
      await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
      await filesystem.writeFileAtomic(binary, "binary");
    }
    return filesystem;
  }

  async function discoverAndroid(
    filesystem: MemoryFilesystem,
    tcpProbe: FakeTcpProbe,
    livePids: readonly number[] = [],
    overrides: Partial<
      Pick<DriverDiscoveryContext, "clock" | "hostArch" | "logger" | "processRunner">
    > & { readonly androidConfig?: AndroidDriverConfig } = {},
  ) {
    return discoverDrivers({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem,
      hostArch: "arm64",
      ...overrides,
      platformConfigurations: { android: overrides.androidConfig },
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: INSTANCE_ID,
      logger:
        overrides.logger ??
        new JsonLinesLogger({
          clock: new FakeClock(),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
      processRunner: overrides.processRunner ?? new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(livePids),
      simlockHome: SIMLOCK_HOME,
      tcpProbe,
    });
  }
});

const IOS_ROOT = join(SIMLOCK_HOME, "devices", "ios");

const INSTANCE_ID = "instance-1";

async function foreignOwnedRoot(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(IOS_ROOT);
  await filesystem.writeFileAtomic(
    join(IOS_ROOT, OWNED_ROOT_MARKER_FILE),
    JSON.stringify({
      instanceId: "someone-else",
      owner: "simlock",
      platform: "ios",
      schemaVersion: 1,
    }),
  );
  return filesystem;
}

async function refusedRoot(filesystem: MemoryFilesystem): Promise<OwnedRootError> {
  try {
    await IosSimctlDriver.create({
      clock: new FakeClock(),
      database: await memorySourceDatabase(),
      driverConfig: {},
      filesystem,
      idGenerator: new CryptoIdGenerator(),
      instanceId: INSTANCE_ID,
      processRunner: new ScriptedProcessRunner([]),
      simlockHome: SIMLOCK_HOME,
    });
  } catch (error: unknown) {
    return error as OwnedRootError;
  }
  throw new Error("expected the iOS device root to be refused");
}

async function discoverIos(
  overrides: {
    readonly clock?: FakeClock;
    readonly filesystem?: MemoryFilesystem;
    readonly hostPlatform?: NodeJS.Platform;
    readonly idGenerator?: IdGenerator;
    readonly iosConfig?: IosDriverConfig;
    readonly processRunner?: ScriptedProcessRunner;
    readonly sink?: MemoryLogSink;
  } = {},
) {
  return discoverDrivers({
    database: await memorySourceDatabase(),
    clock: overrides.clock ?? new FakeClock(),
    platformConfigurations: { ios: overrides.iosConfig },
    driversConfig: {},
    eventBus: new EventBus(new FakeClock()),
    filesystem: overrides.filesystem ?? new MemoryFilesystem(),
    hostArch: "arm64",
    hostPlatform: overrides.hostPlatform ?? "darwin",
    idGenerator: overrides.idGenerator ?? new CryptoIdGenerator(),
    instanceId: INSTANCE_ID,
    logger: new JsonLinesLogger({
      clock: new FakeClock(),
      level: "debug",
      sink: overrides.sink ?? new MemoryLogSink(),
    }),
    processRunner: overrides.processRunner ?? new ScriptedProcessRunner([]),
    processSupervisor: new FakeProcessSupervisor(),
    simlockHome: SIMLOCK_HOME,
    tcpProbe: new FakeTcpProbe(),
  });
}

describe("deviceModeWiring", () => {
  it.each(["slim", "full"] as const)(
    "maps ios.defaultMode %s to the default-mode map and to whether the iOS default is slim",
    (defaultMode) => {
      expect(
        deviceModeWiring({
          ios: {
            defaultMode,
            defaultModels: {},
          },
        }),
      ).toEqual({
        defaultModes: { ios: defaultMode },
        slimByDefault: defaultMode === "slim",
      });
    },
  );
});

describe("modelPreferenceWiring", () => {
  const drivers = [
    {
      defaultModels: { phone: ["iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
      platform: "ios" as const,
    },
    { defaultModels: { phone: ["Pixel 9"] }, platform: "android" as const },
  ];
  const config = (
    ios: Config["ios"]["defaultModels"],
    android: Config["android"]["defaultModels"],
  ) =>
    ({
      android: { defaultModels: android },
      ios: { defaultModels: ios },
    }) as Pick<Config, "android" | "ios">;

  it("puts the configured names of a class before the driver's built-in ones", () => {
    expect(
      modelPreferenceWiring(
        config({ phone: ["iPhone 15", "iPhone 14"] }, { phone: ["Pixel 7"] }),
        drivers,
      ),
    ).toEqual({
      android: { phone: ["Pixel 7", "Pixel 9"] },
      ios: { phone: ["iPhone 15", "iPhone 14", "iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
    });
  });

  it("is the driver's built-in list alone for a class the config does not name", () => {
    expect(modelPreferenceWiring(config({}, {}), drivers)).toEqual({
      android: { phone: ["Pixel 9"] },
      ios: { phone: ["iPhone 17", "iPhone 16"], tablet: ["iPad (A16)"] },
    });
  });

  it("keeps a configured class the driver has no built-in list for", () => {
    expect(
      modelPreferenceWiring(config({ vision: ["Apple Vision Pro"] }, {}), drivers).ios?.vision,
    ).toEqual(["Apple Vision Pro"]);
  });

  it("leaves out a platform with no driver", () => {
    expect(modelPreferenceWiring(config({}, {}), [drivers[0]!])).not.toHaveProperty("android");
  });
});

describe("slim diagnostic bridging", () => {
  it("emits device.slimmed with the driver-diagnostics module for a SlimmedFact", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const seen: unknown[] = [];
    eventBus.subscribeAll((envelope) => seen.push(envelope));
    const bridge = emitSlimDiagnostic((diagnostic) => {
      eventBus.emit(diagnostic.event, diagnostic.payload, "driver-diagnostics");
    });

    bridge({
      address: "simlock-ios-1-address",
      categories: ["siri", "spotlight"],
      deviceId: "simlock-ios-1",
      durationMs: 12_000,
      labelCount: 170,
      signature: "sig-abc123",
      unknownLabels: ["com.apple.unknown-daemon"],
    });

    expect(seen).toEqual([
      expect.objectContaining({
        event: "device.slimmed",
        module: "driver-diagnostics",
        payload: {
          address: "simlock-ios-1-address",
          categories: ["siri", "spotlight"],
          deviceId: "simlock-ios-1",
          durationMs: 12_000,
          labelCount: 170,
          platform: "ios",
          signature: "sig-abc123",
          unknownLabels: ["com.apple.unknown-daemon"],
        },
      }),
    ]);
  });
});

describe("processRunnerFor", () => {
  async function runOnce(level: "debug" | "info") {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const inner = new ScriptedProcessRunner([
      { match: { args: ["devices"], command: "adb" }, result: { code: 0, stderr: "", stdout: "" } },
    ]);

    await processRunnerFor(level, inner, logger, clock).run("adb", ["devices"]);
    return sink.records.filter((record) => record.message === "process");
  }

  it.each([
    { level: "info", expected: [] },
    {
      level: "debug",
      expected: [
        expect.objectContaining({
          level: "debug",
          module: "daemon.process",
          fields: expect.objectContaining({ command: "adb", args: ["devices"], code: 0 }),
        }),
      ],
    },
  ] as const)(
    "at log.level: $level a command leaves the expected process lines",
    async ({ level, expected }) => {
      expect(await runOnce(level)).toEqual(expected);
    },
  );
});

describe("discoverDrivers with SIMLOCK_DRIVERS_MODULE", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  async function discover(sink: MemoryLogSink) {
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    return discoverDrivers({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      driversConfig: {},
      eventBus: new EventBus(new FakeClock()),
      filesystem: new MemoryFilesystem(),
      hostArch: "arm64",
      hostPlatform: "linux",
      idGenerator: new CryptoIdGenerator(),
      instanceId: "instance-1",
      logger,
      processRunner: new ScriptedProcessRunner([]),
      processSupervisor: new FakeProcessSupervisor(),
      simlockHome: "/home/.simlock",
      tcpProbe: new FakeTcpProbe(),
    });
  }

  it("substitutes discovery with the module's createDrivers(context)", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         return [{ platform: "ios", fromModule: true, sawContext: typeof context.logger === "object" }];
       }`,
    );
    const sink = new MemoryLogSink();

    const { drivers, rejections } = await discover(sink);

    expect(drivers).toEqual([{ platform: "ios", fromModule: true, sawContext: true }]);
    expect(rejections).toEqual([]);
  });

  it("takes the module's prerequisiteChecks export in place of the real checks", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }
       export const prerequisiteChecks = [{ platform: "android", fromModule: true, check: async () => [] }];`,
    );

    const { prerequisiteChecks } = await discover(new MemoryLogSink());

    expect(prerequisiteChecks).toEqual([expect.objectContaining({ fromModule: true })]);
  });

  it("hands each driver its own section of the config, android.emulator and ios.simulator as set and ios.slim defaulted, to driver discovery when the daemon starts", async () => {
    const key = "__simlockDiscoveredDriverConfig";
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         globalThis.${key} = {
           emulator: context.platformConfigurations.android.emulator,
           simulator: context.platformConfigurations.ios.simulator,
           slim: context.platformConfigurations.ios.slim,
         };
         return [];
       }`,
    );
    const emulator = { audio: false, bootAnimation: false, gpu: "host", headless: true };
    const simulator = { audio: false, headless: true };

    try {
      await start({
        configOverrides: { android: { emulator }, ios: { simulator } },
        drivers: undefined,
      });

      expect((globalThis as Record<string, unknown>)[key]).toEqual({
        emulator,
        simulator,
        slim: { bootTimeoutMs: 600_000 },
      });
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it("starts its drivers with ios.full.bootTimeoutMs and android.bootTimeoutMs from its config", async () => {
    const key = "__simlockDiscoveredBootTimeouts";
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         globalThis.${key} = [context.platformConfigurations.ios.full.bootTimeoutMs, context.platformConfigurations.android.bootTimeoutMs];
         return [];
       }`,
    );

    try {
      await start({
        configOverrides: {
          android: { bootTimeoutMs: 600_000 },
          ios: { full: { bootTimeoutMs: 400_000 } },
        },
        drivers: undefined,
      });

      expect((globalThis as Record<string, unknown>)[key]).toEqual([400_000, 600_000]);
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it("a throwing event subscriber writes nothing through console.error", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         context.eventBus.subscribe("daemon.started", () => {
           throw new Error("subscriber broke");
         });
         return [];
       }`,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await start({ drivers: undefined });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("supports a synchronous createDrivers returning an array directly", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }`,
    );

    await expect(discover(new MemoryLogSink())).resolves.toEqual({
      drivers: [],
      prerequisiteChecks: [],
      rejections: [],
    });
  });

  it("fails loudly when the module has no createDrivers export", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(`export const nope = 1;`);

    await expect(discover(new MemoryLogSink())).rejects.toThrow(/createDrivers/);
  });

  it("fails loudly when the module cannot be imported", async () => {
    process.env.SIMLOCK_DRIVERS_MODULE = join(
      tmpdir(),
      "simlock-drivers-module-does-not-exist.mjs",
    );

    await expect(discover(new MemoryLogSink())).rejects.toThrow(
      /simlock-drivers-module-does-not-exist/,
    );
  });
});
