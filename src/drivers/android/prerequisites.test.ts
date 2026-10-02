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

function check(filesystem: MemoryFilesystem, runner: ScriptedProcessRunner) {
  return androidPrerequisites({
    env: { ANDROID_HOME: sdk },
    filesystem,
    homeDirectory: home,
    processRunner: runner,
  });
}

describe("androidPrerequisites", () => {
  it("reports nothing missing for a complete SDK whose sdkmanager runs, starting only `sdkmanager --version`, bounded at 30 seconds", async () => {
    const runner = new ScriptedProcessRunner([SDKMANAGER_RUNS]);

    await expect(check(await sdkFilesystem(), runner).check()).resolves.toEqual([]);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      [sdkmanager, "--version"],
    ]);
    expect(runner.calls[0]?.options.timeoutMs).toBe(30_000);
  });

  it("reports android-emulator with the `sdkmanager --install emulator` remedy when only the emulator binary is missing", async () => {
    const runner = new ScriptedProcessRunner([SDKMANAGER_RUNS]);

    const missing = await check(await sdkFilesystem(["emulator"]), runner).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "android-emulator",
        remedy: expect.stringContaining("sdkmanager --install emulator") as unknown,
      }),
    ]);
  });

  it("stops reporting a package on the next check once it is installed", async () => {
    const filesystem = await sdkFilesystem(["emulator"]);
    const prerequisites = check(
      filesystem,
      new ScriptedProcessRunner([SDKMANAGER_RUNS, SDKMANAGER_RUNS]),
    );
    expect((await prerequisites.check()).map((found) => found.prerequisite)).toEqual([
      "android-emulator",
    ]);

    await writeFile(filesystem, `${sdk}/emulator/emulator`);

    await expect(prerequisites.check()).resolves.toEqual([]);
  });

  it("reports android-platform-tools when only adb is missing", async () => {
    const runner = new ScriptedProcessRunner([SDKMANAGER_RUNS]);

    const missing = await check(await sdkFilesystem(["platform-tools"]), runner).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "android-platform-tools",
        remedy: expect.stringContaining("sdkmanager --install platform-tools") as unknown,
      }),
    ]);
  });

  it("reports android-cmdline-tools when no tool bin is complete, and does not run sdkmanager", async () => {
    const filesystem = await sdkFilesystem(["cmdline-tools"]);
    // A bin with only one of the two tools is not complete.
    await writeFile(filesystem, sdkmanager);
    const runner = new ScriptedProcessRunner([]);

    const missing = await check(filesystem, runner).check();

    expect(missing).toEqual([
      expect.objectContaining({
        prerequisite: "android-cmdline-tools",
        remedy: expect.stringContaining(
          "https://developer.android.com/studio#command-line-tools-only",
        ) as unknown,
      }),
    ]);
    expect(runner.calls).toEqual([]);
  });

  it("reports one android-sdk finding that lists the searched paths when no root exists, and no per-tool finding", async () => {
    const runner = new ScriptedProcessRunner([]);
    const prerequisites = androidPrerequisites({
      env: { ANDROID_HOME: "/nowhere/home", ANDROID_SDK_ROOT: "/nowhere/root" },
      filesystem: new MemoryFilesystem(),
      homeDirectory: home,
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
