import { describe, expect, it } from "vitest";

import {
  MemoryFilesystem,
  type ProcessResult,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { androidPrerequisites } from "./prerequisites.js";

const home = "/home/simlock";
const sdk = "/android-sdk";
const sdkmanager = `${sdk}/cmdline-tools/latest/bin/sdkmanager`;

async function writeFile(filesystem: MemoryFilesystem, path: string): Promise<void> {
  await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
  await filesystem.writeFileAtomic(path, "");
}

/** A complete SDK at `sdk`, minus whatever `without` names. */
async function sdkFilesystem(
  without: readonly ("cmdline-tools" | "emulator" | "platform-tools")[] = [],
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(sdk);
  if (!without.includes("cmdline-tools")) {
    await writeFile(filesystem, sdkmanager);
    await writeFile(filesystem, `${sdk}/cmdline-tools/latest/bin/avdmanager`);
  }
  if (!without.includes("emulator")) await writeFile(filesystem, `${sdk}/emulator/emulator`);
  if (!without.includes("platform-tools")) await writeFile(filesystem, `${sdk}/platform-tools/adb`);
  return filesystem;
}

function sdkmanagerVersion(result: ProcessResult): ScriptedProcessExpectation {
  return { match: { args: ["--version"], command: sdkmanager }, result };
}

const SDKMANAGER_RUNS = sdkmanagerVersion({ code: 0, stderr: "", stdout: "12.0\n" });

const emulator = `${sdk}/emulator/emulator`;
// why: the flags Simlock puts on every emulator launch; each is listed in `emulator -help` by the emulators that accept it.
const LAUNCH_FLAGS = [
  "-avd",
  "-port",
  "-no-snapshot-save",
  "-grpc",
  "-grpc-use-token",
  "-crash-report-mode",
] as const;

function emulatorHelp(
  listed: readonly string[],
  stream: "stdout" | "stderr" = "stdout",
): ScriptedProcessExpectation {
  const lines = listed.map((flag) => `    ${flag} <value>      what ${flag} does`);
  const usage = `Android Emulator usage: emulator [options]\n${lines.join("\n")}\n`;
  return {
    match: { args: ["-help"], command: emulator },
    result: {
      code: 0,
      stderr: stream === "stderr" ? usage : "",
      stdout: stream === "stdout" ? usage : "",
    },
  };
}

const EMULATOR_ACCEPTS_EVERYTHING = emulatorHelp(LAUNCH_FLAGS);

function check(filesystem: MemoryFilesystem, runner: ScriptedProcessRunner) {
  return androidPrerequisites({
    env: { ANDROID_HOME: sdk },
    filesystem,
    homeDirectory: home,
    platform: "linux",
    processRunner: runner,
  });
}

describe("androidPrerequisites", () => {
  it("reports nothing missing for a complete SDK whose sdkmanager runs, starting only `sdkmanager --version` and `emulator -help`, bounded at 30 seconds", async () => {
    const runner = new ScriptedProcessRunner([SDKMANAGER_RUNS, EMULATOR_ACCEPTS_EVERYTHING]);

    await expect(check(await sdkFilesystem(), runner).check()).resolves.toEqual([]);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      [sdkmanager, "--version"],
      [emulator, "-help"],
    ]);
    expect(runner.calls[0]?.options.timeoutMs).toBe(30_000);
    expect(runner.calls[1]?.options.timeoutMs).toBe(30_000);
  });

  it.each([
    ["emulator", "android-emulator", "sdkmanager --install emulator"],
    ["platform-tools", "android-platform-tools", "sdkmanager --install platform-tools"],
  ] as const)(
    "reports the package with its `sdkmanager --install` remedy when only %s is missing",
    async (without, prerequisite, remedy) => {
      const runner = new ScriptedProcessRunner(
        without === "emulator" ? [SDKMANAGER_RUNS] : [SDKMANAGER_RUNS, EMULATOR_ACCEPTS_EVERYTHING],
      );

      const missing = await check(await sdkFilesystem([without]), runner).check();

      expect(missing).toEqual([
        expect.objectContaining({
          prerequisite,
          remedy: expect.stringContaining(remedy) as unknown,
        }),
      ]);
    },
  );

  it("reports an installed emulator that does not list a flag Simlock always passes, naming the flag and `sdkmanager --install emulator`, and nothing for one that lists every flag", async () => {
    const lacking = await check(
      await sdkFilesystem(),
      new ScriptedProcessRunner([
        SDKMANAGER_RUNS,
        emulatorHelp(LAUNCH_FLAGS.filter((flag) => flag !== "-grpc-use-token")),
      ]),
    ).check();
    const complete = await check(
      await sdkFilesystem(),
      new ScriptedProcessRunner([SDKMANAGER_RUNS, emulatorHelp(LAUNCH_FLAGS, "stderr")]),
    ).check();

    expect(lacking).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("-grpc-use-token") as unknown,
        prerequisite: "android-emulator",
        remedy: expect.stringContaining("sdkmanager --install emulator") as unknown,
      }),
    ]);
    expect(complete).toEqual([]);
  });

  it("reports nothing missing for an emulator whose -help lists every launch flag but -crash-report-mode, which Simlock passes only to an emulator that accepts it (#1297)", async () => {
    const missing = await check(
      await sdkFilesystem(),
      new ScriptedProcessRunner([
        SDKMANAGER_RUNS,
        emulatorHelp(LAUNCH_FLAGS.filter((flag) => flag !== "-crash-report-mode")),
      ]),
    ).check();

    expect(missing).toEqual([]);
  });

  it("stops reporting a package on the next check once it is installed", async () => {
    const filesystem = await sdkFilesystem(["emulator"]);
    const prerequisites = check(
      filesystem,
      new ScriptedProcessRunner([SDKMANAGER_RUNS, SDKMANAGER_RUNS, EMULATOR_ACCEPTS_EVERYTHING]),
    );
    expect((await prerequisites.check()).map((found) => found.prerequisite)).toEqual([
      "android-emulator",
    ]);

    await writeFile(filesystem, `${sdk}/emulator/emulator`);

    await expect(prerequisites.check()).resolves.toEqual([]);
  });

  it("reports android-cmdline-tools when no tool bin is complete, and does not run sdkmanager", async () => {
    const filesystem = await sdkFilesystem(["cmdline-tools"]);
    // A bin with only one of the two tools is not complete.
    await writeFile(filesystem, sdkmanager);
    const runner = new ScriptedProcessRunner([EMULATOR_ACCEPTS_EVERYTHING]);

    const missing = await check(filesystem, runner).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "android-cmdline-tools",
        remedy: expect.stringContaining(
          "https://developer.android.com/studio#command-line-tools-only",
        ) as unknown,
      }),
    ]);
    expect(runner.calls.map((call) => call.command)).toEqual([emulator]);
  });

  it("reports one android-sdk finding that lists the searched paths when no root exists, and no per-tool finding", async () => {
    const runner = new ScriptedProcessRunner([]);
    const prerequisites = androidPrerequisites({
      env: { ANDROID_HOME: "/nowhere/home", ANDROID_SDK_ROOT: "/nowhere/root" },
      filesystem: new MemoryFilesystem(),
      homeDirectory: home,
      platform: "linux",
      processRunner: runner,
    });

    const missing = await prerequisites.check();

    expect(missing).toHaveLength(1);
    expect(missing[0]?.prerequisite).toBe("android-sdk");
    for (const path of ["/nowhere/home", "/nowhere/root", `${home}/Library/Android/sdk`]) {
      expect(missing[0]?.message).toContain(path);
    }
    expect(missing[0]?.remedy).toContain("ANDROID_HOME");
    expect(runner.calls).toEqual([]);
  });

  it("checks the complete SDK discovery would run, not an earlier root that is incomplete", async () => {
    const studioSdk = `${home}/Library/Android/sdk`;
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/stale-sdk");
    for (const tool of [
      "cmdline-tools/latest/bin/sdkmanager",
      "cmdline-tools/latest/bin/avdmanager",
      "emulator/emulator",
      "platform-tools/adb",
    ]) {
      await writeFile(filesystem, `${studioSdk}/${tool}`);
    }
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["--version"], command: `${studioSdk}/cmdline-tools/latest/bin/sdkmanager` },
        result: { code: 0, stderr: "", stdout: "12.0\n" },
      },
      {
        ...EMULATOR_ACCEPTS_EVERYTHING,
        match: { args: ["-help"], command: `${studioSdk}/emulator/emulator` },
      },
    ]);
    const prerequisites = androidPrerequisites({
      env: { ANDROID_HOME: "/stale-sdk" },
      filesystem,
      homeDirectory: home,
      platform: "linux",
      processRunner: runner,
    });

    await expect(prerequisites.check()).resolves.toEqual([]);
  });

  it("reports on the first root that is a directory when no root is complete", async () => {
    const filesystem = await sdkFilesystem(["emulator"]);
    const prerequisites = androidPrerequisites({
      env: { ANDROID_HOME: "/nowhere", ANDROID_SDK_ROOT: sdk },
      filesystem,
      homeDirectory: home,
      platform: "linux",
      processRunner: new ScriptedProcessRunner([SDKMANAGER_RUNS]),
    });

    const missing = await prerequisites.check();

    expect(missing.map((found) => found.prerequisite)).toEqual(["android-emulator"]);
    expect(missing[0]?.message).toContain(sdk);
  });

  it("treats a root that is a file, not a directory, as no SDK", async () => {
    const filesystem = new MemoryFilesystem();
    await writeFile(filesystem, sdk);

    const missing = await check(filesystem, new ScriptedProcessRunner([])).check();

    expect(missing.map((found) => found.prerequisite)).toEqual(["android-sdk"]);
  });

  it("reports android-jdk with the first stderr line when `sdkmanager --version` fails", async () => {
    const runner = new ScriptedProcessRunner([
      sdkmanagerVersion({
        code: 1,
        stderr:
          "\nERROR: JAVA_HOME is not set and no 'java' command could be found.\nPlease set it.\n",
        stdout: "",
      }),
      EMULATOR_ACCEPTS_EVERYTHING,
    ]);

    const missing = await check(await sdkFilesystem(), runner).check();

    expect(missing).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "ERROR: JAVA_HOME is not set and no 'java' command could be found.",
        ) as unknown,
        prerequisite: "android-jdk",
      }),
    ]);
    expect(missing[0]?.message).not.toContain("Please set it.");
  });

  it("rejects when `sdkmanager --version` times out, and reports nothing as missing", async () => {
    // A `null` exit code is how the runner reports a process its timeout ended.
    const runner = new ScriptedProcessRunner([
      sdkmanagerVersion({ code: null, stderr: "", stdout: "" }),
    ]);

    await expect(check(await sdkFilesystem(), runner).check()).rejects.toThrow(/did not finish/);
  });
});

describe("androidPrerequisites on Windows", () => {
  const winSdk = "/Users/me/AppData/Local/Android/Sdk";
  // why: differs from the home-directory fallback, so only a read LOCALAPPDATA finds this one.
  const localSdk = "/Volumes/Data/Local/Android/Sdk";
  const winSdkmanager = `${winSdk}/cmdline-tools/latest/bin/sdkmanager.bat`;
  const sdkmanagerIn = (root: string) => `${root}/cmdline-tools/latest/bin/sdkmanager.bat`;

  /** why: Android Studio installs `.exe` binaries and `.bat` tools on Windows, never the bare names. */
  async function windowsSdk(root = winSdk): Promise<MemoryFilesystem> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(root);
    await writeFile(filesystem, sdkmanagerIn(root));
    await writeFile(filesystem, `${root}/cmdline-tools/latest/bin/avdmanager.bat`);
    await writeFile(filesystem, `${root}/emulator/emulator.exe`);
    await writeFile(filesystem, `${root}/platform-tools/adb.exe`);
    return filesystem;
  }

  function windowsCheck(
    filesystem: MemoryFilesystem,
    runner: ScriptedProcessRunner,
    env: Readonly<Record<string, string>>,
  ) {
    return androidPrerequisites({
      env,
      filesystem,
      homeDirectory: "/Users/me",
      platform: "win32",
      processRunner: runner,
    });
  }

  const WINDOWS_SDKMANAGER_RUNS: ScriptedProcessExpectation = {
    match: { args: ["--version"], command: winSdkmanager },
    result: { code: 0, stderr: "", stdout: "12.0\n" },
  };

  it.each([
    ["ANDROID_HOME", { ANDROID_HOME: winSdk }, winSdk],
    ["Android Studio's %LOCALAPPDATA% default", { LOCALAPPDATA: "/Volumes/Data/Local" }, localSdk],
  ])(
    "finds a complete SDK of .exe and .bat tools through %s and runs its sdkmanager.bat",
    async (_source, env, root) => {
      const sdkmanager = sdkmanagerIn(root);
      const runner = new ScriptedProcessRunner([
        { ...WINDOWS_SDKMANAGER_RUNS, match: { args: ["--version"], command: sdkmanager } },
        {
          ...EMULATOR_ACCEPTS_EVERYTHING,
          match: { args: ["-help"], command: `${root}/emulator/emulator.exe` },
        },
      ]);

      await expect(windowsCheck(await windowsSdk(root), runner, env).check()).resolves.toEqual([]);
      expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
        [sdkmanager, "--version"],
        [`${root}/emulator/emulator.exe`, "-help"],
      ]);
    },
  );

  it("reads a Windows SDK holding only the extensionless names as missing every tool", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(winSdk);
    await writeFile(filesystem, `${winSdk}/cmdline-tools/latest/bin/sdkmanager`);
    await writeFile(filesystem, `${winSdk}/cmdline-tools/latest/bin/avdmanager`);
    await writeFile(filesystem, `${winSdk}/emulator/emulator`);
    await writeFile(filesystem, `${winSdk}/platform-tools/adb`);
    const runner = new ScriptedProcessRunner([]);

    const missing = await windowsCheck(filesystem, runner, { ANDROID_HOME: winSdk }).check();

    expect(missing.map((finding) => finding.prerequisite)).toEqual([
      "android-cmdline-tools",
      "android-emulator",
      "android-platform-tools",
    ]);
  });
});
