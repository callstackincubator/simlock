import { afterEach, expect, describe, it } from "vitest";
import {
  MemoryFilesystem,
  FakeBytePipeLauncher,
  FakeClock,
  ScriptedProcessRunner,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { deviceRoot, sourcesSetPath, instanceId } from "./test-slim.js";
import { UNSCOPED_LEGACY_CALLS, createDriver, scopedRunners } from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, sourcesSetPath]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver screen capture commands", () => {
  const physicalDevice = {
    address: "UDID-P",
    deviceId: "UDID-P",
    driverData: {},
    enrolledApps: [],
    physical: true,
  } as const;
  const settings = { bitrateKbps: 1_500, fps: 30, maxDimension: 720 };

  // why: the daemon hands the driver its packaged programs; `drivers.ios.deviceCaptureCommand`
  // replaces only the physical iPhone's program, and an empty string counts as unset exactly as
  // `screenCaptureCommand` does, so one mistaken `""` does not turn iPhone streams off.
  it.each([
    ["the configured program", "/worker/custom-device-capture", "/worker/custom-device-capture"],
    ["the daemon's program when unset", undefined, "/dist/bin/simlock-device-capture"],
    ["the daemon's program when set empty", "", "/dist/bin/simlock-device-capture"],
  ] as const)("a physical iPhone's stream starts %s", async (_claim, configured, expected) => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/worker");
    await filesystem.mkdirp("/dist/bin");
    await filesystem.writeFileAtomic("/worker/custom-device-capture", "");
    await filesystem.writeFileAtomic("/dist/bin/simlock-device-capture", "");
    const launcher = new FakeBytePipeLauncher();
    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      driverConfig: configured === undefined ? {} : { deviceCaptureCommand: configured },
      filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: new ScriptedProcessRunner([]),
      screenCapture: {
        baseEnvironment: { PATH: "/usr/bin" },
        command: "/dist/bin/simlock-screen-capture",
        deviceCommand: "/dist/bin/simlock-device-capture",
        launcher,
      },
      simlockHome: "/home/.simlock",
    });

    const capture = driver.screenCapture;
    if (capture === undefined) throw new Error("the driver offers no screen capture");
    await capture.open(physicalDevice, settings, new AbortController().signal);
    expect(launcher.starts.map((start) => start.command)).toEqual([expected]);
  });
});

describe("IosSimctlDriver defaultModels", () => {
  it("lists the built-in iOS preference list per class, newest first, with phone starting at iPhone 17", async () => {
    const driver = await createDriver(new ScriptedProcessRunner([]));

    expect(driver.defaultModels).toEqual({
      phone: ["iPhone 17", "iPhone 16", "iPhone 15", "iPhone 14", "iPhone 13"],
      tablet: [
        "iPad Pro 11-inch (M5)",
        "iPad Pro 11-inch (M4)",
        "iPad Air 11-inch (M3)",
        "iPad (A16)",
        "iPad (10th generation)",
      ],
      tv: ["Apple TV 4K (3rd generation)", "Apple TV"],
      vision: ["Apple Vision Pro"],
      watch: [
        "Apple Watch Series 11 (46mm)",
        "Apple Watch Series 10 (46mm)",
        "Apple Watch Series 9 (45mm)",
      ],
    });
  });
});

describe("IosSimctlDriver toolVersions()", () => {
  it("reports the Xcode version and build that xcodebuild -version prints", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["-version"], command: "xcodebuild" },
        result: { code: 0, stderr: "", stdout: "Xcode 16.4\nBuild version 16F6\n" },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.toolVersions()).resolves.toEqual([
      { build: "16F6", name: "xcode", version: "16.4" },
    ]);
    expect(runner.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it("reports the Xcode version without a build when xcodebuild prints none", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["-version"], command: "xcodebuild" },
        result: { code: 0, stderr: "", stdout: "Xcode 16.4\n" },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.toolVersions()).resolves.toEqual([{ name: "xcode", version: "16.4" }]);
  });

  it("reports no Xcode entry when only the command line tools are installed", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["-version"], command: "xcodebuild" },
        result: {
          code: 1,
          stderr:
            "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance",
          stdout: "",
        },
      },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.toolVersions()).resolves.toEqual([]);
  });

  it.each([
    // why: Output that would parse, so only the exit code can be what turns it away.
    ["exits non-zero", { code: 1, stderr: "error", stdout: "Xcode 16.4\nBuild version 16F6\n" }],
    ["is killed by its timeout", { code: null, stderr: "", stdout: "" }],
    ["prints no Xcode version", { code: 0, stderr: "", stdout: "something else\n" }],
  ])("rejects when xcodebuild %s", async (_case, result) => {
    const runner = new ScriptedProcessRunner([
      { match: { args: ["-version"], command: "xcodebuild" }, result },
    ]);
    const driver = await createDriver(runner);

    await expect(driver.toolVersions()).rejects.toThrow(/xcodebuild/);
  });

  it("rejects when xcodebuild cannot be started", async () => {
    // why: No scripted invocation: the runner refuses to start it, as a spawn failure would.
    const driver = await createDriver(new ScriptedProcessRunner([]));

    await expect(driver.toolVersions()).rejects.toThrow(/xcodebuild/);
  });
});
