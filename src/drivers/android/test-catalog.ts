import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type { ProcessHandle, ProcessRunner, ProcessRunOptions } from "../../ports/index.js";

import { Catalog } from "./catalog.js";
import type {
  DeviceProfileSource,
  DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";
import { SystemImages } from "./system-images.js";
import { type LibraryDeviceProfile } from "./profiles/index.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  fitDevices,
  type FitImage,
  processResult,
  type Refusal,
  writeDevicesXml,
} from "./testing.js";

export const avdmanager = `${sdk}/cmdline-tools/latest/bin/avdmanager`;
export const binaries = {
  avdmanager,
  sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
} as const;

export async function androidFilesystem(
  options: { readonly images?: readonly (readonly [string, string, string])[] } = {},
  filesystem: MemoryFilesystem = new MemoryFilesystem(),
): Promise<MemoryFilesystem> {
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  return filesystem;
}

export function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly avdmanager?: string;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void;
  } = {},
): Catalog {
  return new Catalog({
    avdmanager: options.avdmanager ?? avdmanager,
    avdmanagerEnv: () => ({ ANDROID_HOME: sdk }),
    deviceProfileSources: options.deviceProfileSources,
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
      hostAbi: options.hostAbi ?? "arm64-v8a",
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

// why: `avdmanager list device` answers with the listing a test names however often it is asked, so a
// second read is counted rather than refused.
class ListingRunner extends ScriptedProcessRunner {
  constructor(private readonly listing: string) {
    super([]);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    if (command === binaries.avdmanager && args[0] === "list") {
      return new ScriptedProcessRunner([processResult(command, args, this.listing)]).spawn(
        command,
        args,
        options,
      );
    }
    return super.spawn(command, args, options);
  }
}

export async function fitHarness(
  images: readonly FitImage[],
  options: {
    readonly devicesXml?: string;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly listing?: string;
    readonly profiles?: readonly LibraryDeviceProfile[];
  } = {},
) {
  const filesystem = await androidFilesystem({
    images: images.map(([api, tag, abi]) => [api, tag, abi]),
  });
  for (const [api, tag, abi, properties] of images) {
    if (properties !== undefined) {
      await filesystem.writeFileAtomic(
        `${sdk}/system-images/android-${api}/${tag}/${abi}/source.properties`,
        properties,
      );
    }
  }
  if (options.devicesXml !== undefined) await writeDevicesXml(filesystem, options.devicesXml);
  const runner = new ListingRunner(options.listing ?? fitDevices);
  const part = createPart(filesystem, runner, {
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    hostAbi: options.hostAbi ?? "arm64-v8a",
    ...(options.profiles === undefined
      ? {}
      : { deviceProfileSources: [{ profiles: async () => options.profiles ?? [] }] }),
  });
  const resolve = (model: string, osVersion?: string, imageTag?: string) =>
    part.resolveSpec({
      model,
      platform: "android",
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(imageTag === undefined ? {} : { imageTag }),
    });
  const refusal = (model: string, osVersion?: string, imageTag?: string) =>
    resolve(model, osVersion, imageTag).then(
      () => {
        throw new Error(`${model} ${osVersion ?? ""} ${imageTag ?? ""} resolved`);
      },
      (error: unknown) => error as Refusal,
    );
  return { filesystem, part, refusal, resolve, runner };
}
