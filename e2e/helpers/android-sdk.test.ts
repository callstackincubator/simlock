import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "../../src/ports/index.js";
import { findAndroidSdk, sdkToolInvocation } from "./android-sdk.js";

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
// these prove only what this helper adds: a skip on anything short of a complete SDK, and how a
// `.bat` tool is run.
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

describe("sdkToolInvocation", () => {
  it("runs a .bat on Windows through a shell with the tool and every argument quoted", () => {
    expect(
      sdkToolInvocation("C:/Program Files/Sdk/avdmanager.bat", ["list", "avd"], "win32"),
    ).toEqual({
      args: ['"list"', '"avd"'],
      file: '"C:/Program Files/Sdk/avdmanager.bat"',
      shell: true,
    });
  });

  it.each([
    ["an .exe on Windows", "C:/Sdk/adb.exe", "win32"],
    ["a tool on macOS", "/Sdk/cmdline-tools/latest/bin/avdmanager", "darwin"],
  ] as const)("runs %s directly, without a shell", (_case, tool, platform) => {
    expect(sdkToolInvocation(tool, ["list", "avd"], platform)).toEqual({
      args: ["list", "avd"],
      file: tool,
      shell: false,
    });
  });

  it.each(["%PATH%", 'a"b', "a!b"])("refuses to pass %s to a .bat through cmd.exe", (arg) => {
    expect(() => sdkToolInvocation("C:/Sdk/avdmanager.bat", [arg], "win32")).toThrow(
      `cannot pass ${JSON.stringify(arg)} to a .bat through cmd.exe`,
    );
  });
});
