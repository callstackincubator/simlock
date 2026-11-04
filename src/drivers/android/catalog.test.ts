import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type { ProcessRunner } from "../../ports/index.js";
import { Catalog } from "./catalog.js";
import type { DeviceProfileSourceDiagnostic } from "./device-profile-source.js";
import { SystemImages } from "./system-images.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  processResult,
} from "./testing.js";

const avdmanager = `${sdk}/cmdline-tools/latest/bin/avdmanager`;
const pixelDevices = `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n`;

async function androidFilesystem(
  options: { readonly images?: readonly (readonly [string, string, string])[] } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  return filesystem;
}

function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void;
  } = {},
): Catalog {
  return new Catalog({
    avdmanager,
    avdmanagerEnv: () => ({ ANDROID_HOME: sdk }),
    env: { ANDROID_HOME: sdk, ...options.extraEnv },
    filesystem,
    homeDirectory: home,
    onDiagnostic: options.onDiagnostic,
    processRunner,
    sdkRoot: sdk,
    systemImages: new SystemImages({
      acceptAndroidLicenses: false,
      clock: new FakeClock(),
      deviceRoot: `${home}/.simlock/devices/android`,
      filesystem,
      hostAbi: "arm64-v8a",
      legacyAvdHome: `${home}/.android/avd`,
      processRunner,
      sdk: {
        adb: `${sdk}/platform-tools/adb`,
        emulator: `${sdk}/emulator/emulator`,
        root: sdk,
        sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
      },
    }),
  });
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Catalog` directly over a memory filesystem and a scripted `avdmanager`.
describe("Catalog", () => {
  it("resolves the newest installed matching image", async () => {
    const filesystem = await androidFilesystem({
      images: [
        ["34", "google_apis", "x86_64"],
        ["35", "google_apis", "arm64-v8a"],
        ["35", "google_apis", "x86_64"],
      ],
    });
    const runner = new ScriptedProcessRunner([
      processResult(avdmanager, ["list", "device"], pixelDevices),
    ]);
    const part = createPart(filesystem, runner);

    await expect(part.resolveSpec({ model: "Pixel 5", platform: "android" })).resolves.toEqual({
      physical: false,
      model: "Pixel 5",
      osVersion: "35",
      platform: "android",
    });
  });
});
