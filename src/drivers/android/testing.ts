import {
  type MemoryFilesystem,
  NodeSqliteOpener,
  ScriptedProcessRunner,
  type ProcessHandle,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
  type SqliteDatabase,
} from "../../ports/index.js";
import type { LibraryDeviceProfile } from "./profiles/index.js";
import { androidSourceDataOwner } from "./source-data.js";

export const ANDROID_SDK_ROOT = "/android-sdk";
export const ANDROID_HOME_DIRECTORY = "/home/simlock";

export async function memoryAndroidSourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of androidSourceDataOwner.migrations) database.exec(migration);
  return database;
}

export function processResult(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return {
    match: { args, command },
    result: { code: 0, stderr: "", stdout },
  };
}

function imageDirectory(packageName: string | undefined): string | undefined {
  const match = /^system-images;android-(.+);(.+);(.+)$/.exec(packageName ?? "");
  if (match === null) return undefined;
  const [, api, tag, abi] = match;
  return `${ANDROID_SDK_ROOT}/system-images/android-${api ?? ""}/${tag ?? ""}/${abi ?? ""}`;
}

/**
 * why: An AVD in the user's own AVD home, as `avdmanager` writes it: a pointer file beside a folder
 * whose `config.ini` names the system image (`image.sysdir.1`).
 */
export async function userAvd(
  filesystem: MemoryFilesystem,
  name: string,
  sysdir: string,
  options: { readonly avdHome?: string; readonly avdPath?: string } = {},
): Promise<void> {
  const avdHome = options.avdHome ?? `${ANDROID_HOME_DIRECTORY}/.android/avd`;
  const avdPath = options.avdPath ?? `${avdHome}/${name}.avd`;
  await filesystem.mkdirp(avdPath);
  await filesystem.writeFileAtomic(
    `${avdHome}/${name}.ini`,
    `avd.ini.encoding=UTF-8\npath=${avdPath}\n`,
  );
  await filesystem.writeFileAtomic(
    `${avdPath}/config.ini`,
    `hw.ramSize=2048\nimage.sysdir.1=${sysdir}\ntag.id=google_apis\n`,
  );
}

/**
 * why: A `ScriptedProcessRunner` that also mirrors what real `sdkmanager` does on disk: a
 * successful (`code: 0`, no unaccepted-license text) `--install <package>` call creates the
 * corresponding `system-images/android-<api>/<tag>/<abi>` directory in `filesystem`, and a
 * successful `--uninstall` removes it. A bare `ScriptedProcessRunner` only scripts the process's own
 * stdout/stderr/exit code, never a filesystem side effect, so the scan after an install would not
 * find the image it just "installed".
 */
export class InstallReflectingProcessRunner extends ScriptedProcessRunner {
  readonly #filesystem: MemoryFilesystem;

  constructor(expectations: readonly ScriptedProcessExpectation[], filesystem: MemoryFilesystem) {
    super(expectations);
    this.#filesystem = filesystem;
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    const handle = super.spawn(command, args, options);
    const uninstalled = args[0] === "--uninstall" ? imageDirectory(args[1]) : undefined;
    if (uninstalled !== undefined) {
      void handle.wait().then(async (result) => {
        if (result.code === 0) await this.#filesystem.rm(uninstalled);
      });
    }
    if (args[0] === "--install" && typeof args[1] === "string") {
      const packageName = args[1];
      void handle.wait().then((result) => {
        const combined = `${result.stdout}\n${result.stderr}`;
        const licenseNotAccepted =
          /licen[cs]e/i.test(combined) && /not (?:been )?accepted/i.test(combined);
        if (result.code === 0 && !licenseNotAccepted) {
          const match = /^system-images;android-(.+);(.+);(.+)$/.exec(packageName);
          if (match !== null) {
            const [, api, tag, abi] = match;
            const imagePath = `${ANDROID_SDK_ROOT}/system-images/android-${api}/${tag}/${abi}`;
            void this.#filesystem
              .mkdirp(imagePath)
              .then(() =>
                this.#filesystem.writeFileAtomic(
                  `${imagePath}/source.properties`,
                  "Pkg.Revision=1\n",
                ),
              );
          }
        }
      });
    }
    return handle;
  }
}

export const pixelDevices = `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n`;
export const twoPixelDevices =
  `Available devices:\nid: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n` +
  `---------\nid: 1 or "pixel_9"\n    Name: Pixel 9\n    OEM : Google\n`;

export async function writeDevicesXml(
  filesystem: MemoryFilesystem,
  deviceBodies: string,
): Promise<void> {
  await filesystem.mkdirp(`${ANDROID_HOME_DIRECTORY}/.android`);
  await filesystem.writeFileAtomic(
    `${ANDROID_HOME_DIRECTORY}/.android/devices.xml`,
    `<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">${deviceBodies}</d:devices>`,
  );
}

export function customDeviceXml(name: string, ramMiB: number): string {
  return (
    `<d:device><d:name>${name}</d:name><d:hardware>` +
    `<d:ram unit="MiB">${ramMiB}</d:ram></d:hardware></d:device>`
  );
}

export type FitImage = readonly [api: string, tag: string, abi: string, properties?: string];

export const fitDevices =
  `Available devices:\n` +
  `id: 0 or "pixel_5"\n    Name: Pixel 5\n    OEM : Google\n---------\n` +
  `id: 1 or "pixel_9_pro"\n    Name: Pixel 9 Pro\n    OEM : Google\n---------\n` +
  `id: 2 or "tv_720p"\n    Name: Television (720p)\n    OEM : Google\n    Tag : android-tv\n---------\n` +
  `id: 3 or "My Tablet"\n    Name: My Tablet\n    OEM : User\n---------\n` +
  `id: 4 or "odd"\n    Name: Odd Device\n    OEM : Google\n    Tag : foo-device\n---------\n` +
  `id: 5 or "xr_headset"\n    Name: XR Headset\n    OEM : Google\n    Tag : android-xr\n---------\n` +
  `id: 6 or "glasses"\n    Name: AI Glasses\n    OEM : Google\n    Tag : ai-glasses\n`;

export type Refusal = Error & { readonly component?: string; readonly downloadable?: boolean };

export const HOST_IMAGES: readonly FitImage[] = [
  ["35", "google_apis", "arm64-v8a"],
  ["36", "google_apis_playstore", "arm64-v8a"],
  ["34", "android-tv", "arm64-v8a"],
];

export function testLibraryProfile(
  overrides: Partial<LibraryDeviceProfile> = {},
): LibraryDeviceProfile {
  return {
    apiRange: { min: 1 },
    bootProperties: {},
    copiedFrom: "20.0",
    deviceClass: "phone",
    hardware: { "hw.lcd.height": "100", "hw.ramSize": "2G" },
    id: "test_phone",
    imageKind: undefined,
    kind: "library",
    name: "Test Phone",
    names: ["Test Phone", "test_phone"],
    playStore: true,
    tablet: false,
    ...overrides,
  };
}

export interface CustomFitProfile {
  readonly apiLevel?: string;
  readonly diagonal?: string;
  readonly folded?: boolean;
  readonly name: string;
  readonly playStore?: string;
  readonly tagId?: string;
}

export function customFitXml(profile: CustomFitProfile): string {
  const screen =
    profile.diagonal === undefined && profile.folded !== true
      ? ""
      : `<d:screen>${profile.diagonal === undefined ? "" : `<d:diagonal-length>${profile.diagonal}</d:diagonal-length>`}` +
        (profile.folded === true
          ? "<d:x-folded-dimension>1080</d:x-folded-dimension><d:y-folded-dimension>2400</d:y-folded-dimension>"
          : "") +
        "</d:screen>";
  return (
    `<d:device><d:name>${profile.name}</d:name>` +
    (profile.tagId === undefined ? "" : `<d:tag-id>${profile.tagId}</d:tag-id>`) +
    `<d:hardware>${screen}</d:hardware>` +
    (profile.apiLevel === undefined
      ? ""
      : `<d:software><d:api-level>${profile.apiLevel}</d:api-level></d:software>`) +
    (profile.playStore === undefined
      ? ""
      : `<d:playstore-enabled>${profile.playStore}</d:playstore-enabled>`) +
    "</d:device>"
  );
}

export function userListing(
  ...entries: readonly (readonly [name: string, tag?: string])[]
): string {
  return (
    "Available devices:\n" +
    entries
      .map(
        ([name, tag]) =>
          `id: 9 or "${name}"\n    Name: ${name}\n    OEM : User\n` +
          (tag === undefined ? "" : `    Tag : ${tag}\n`) +
          "---------\n",
      )
      .join("")
  );
}
