import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "../../src/ports/index.js";
import { findAndroidSdk, runSdkTool } from "./test-android-sdk.js";

const SDK = "/Local/Android/Sdk";
const WINDOWS_TOOLS = [
  "cmdline-tools/latest/bin/avdmanager.bat",
  "cmdline-tools/latest/bin/sdkmanager.bat",
  "emulator/emulator.exe",
  "platform-tools/adb.exe",
];

async function sdkWith(tools: readonly string[]): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(SDK);
  for (const tool of tools) {
    const path = `${SDK}/${tool}`;
    await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
    await filesystem.writeFileAtomic(path, "");
  }
  return filesystem;
}

// why: the lookup's search order and tool names are proven in src/drivers/android/prerequisites.test.ts;
// these prove only what this helper adds: a skip on anything short of a complete SDK, and that a
// tool which fails or runs past its timeout rejects, as `execFile` did.
describe("findAndroidSdk", () => {
  it("finds a Windows SDK under %LOCALAPPDATA% with its .exe and .bat tools", async () => {
    const sdk = await findAndroidSdk(
      { LOCALAPPDATA: "/Local" },
      "/Users/me",
      await sdkWith(WINDOWS_TOOLS),
      "win32",
    );

    expect(sdk).toEqual({
      adb: "/Local/Android/Sdk/platform-tools/adb.exe",
      avdmanager: "/Local/Android/Sdk/cmdline-tools/latest/bin/avdmanager.bat",
      emulator: "/Local/Android/Sdk/emulator/emulator.exe",
      root: "/Local/Android/Sdk",
      sdkmanager: "/Local/Android/Sdk/cmdline-tools/latest/bin/sdkmanager.bat",
    });
  });

  it.each([
    [
      "an SDK missing its emulator (incomplete)",
      WINDOWS_TOOLS.filter((t) => !t.startsWith("emulator/")),
    ],
    [
      "an SDK of extensionless tools on Windows (incomplete)",
      WINDOWS_TOOLS.map((t) => t.replace(/\.(bat|exe)$/, "")),
    ],
  ])("is undefined for %s", async (_case, tools) => {
    await expect(
      findAndroidSdk({ ANDROID_HOME: SDK }, "/Users/me", await sdkWith(tools), "win32"),
    ).resolves.toBeUndefined();
  });

  it("is undefined when no searched root exists (absent)", async () => {
    await expect(
      findAndroidSdk({ ANDROID_HOME: "/nowhere" }, "/Users/me", new MemoryFilesystem(), "darwin"),
    ).resolves.toBeUndefined();
  });
});

describe("runSdkTool", () => {
  it("answers a tool that exits 0 with its output", async () => {
    await expect(
      runSdkTool(process.execPath, ["-e", 'process.stdout.write("ok")']),
    ).resolves.toMatchObject({ stdout: "ok" });
  });

  it("rejects a tool that exits non-zero, not killed", async () => {
    await expect(runSdkTool(process.execPath, ["-e", "process.exit(3)"])).rejects.toMatchObject({
      killed: false,
    });
  });

  it("rejects a tool its timeout ended, killed", async () => {
    await expect(
      runSdkTool(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 200 }),
    ).rejects.toMatchObject({ killed: true });
  });
});
