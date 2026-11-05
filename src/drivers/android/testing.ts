import {
  type DriverCatalogEntry,
  type DriverDevice,
  type ExactDeviceRequest,
  OWNED_ROOT_MARKER_FILE,
  type VirtualSpec,
} from "../../core/index.js";
import { type DeviceProfileSource } from "./device-profile-source.js";
import {
  MemoryFilesystem,
  NodeSqliteOpener,
  ScriptedProcessRunner,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
  type SqliteDatabase,
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type Filesystem,
} from "../../ports/index.js";
import { type LibraryDeviceProfile } from "./profiles/index.js";
import { androidSourceDataOwner } from "./source-data.js";
import { basename } from "node:path";
import {
  AndroidDriver,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";

export const ANDROID_SDK_ROOT = "/android-sdk";
export const ANDROID_HOME_DIRECTORY = "/home/simlock";
const sdk = ANDROID_SDK_ROOT;
const home = ANDROID_HOME_DIRECTORY;

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

/** why: answers every `adb -s <serial> emu avd path` with `answer` and leaves each other call to `inner`, so a test lies about where an emulator runs. */
export function answeringAvdPath(
  adb: string,
  inner: ProcessRunner,
  answer: ProcessResult,
): ProcessRunner {
  return {
    run: async (command, args, options) =>
      command === adb && args[0] === "-s" && args.slice(2).join(" ") === "emu avd path"
        ? answer
        : inner.run(command, args, options),
    spawn: (command, args, options) => inner.spawn(command, args, options),
    spawnStreaming: (command, args, options) => inner.spawnStreaming(command, args, options),
  };
}

export const simlockHome = "/home/simlock/.simlock";

export const instanceId = "instance-1";

export const avdDirectory = `${simlockHome}/devices/android`;

export const binaries = {
  adb: `${ANDROID_SDK_ROOT}/platform-tools/adb`,
  avdmanager: `${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${ANDROID_SDK_ROOT}/emulator/emulator`,
  sdkmanager: `${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager`,
} as const;

/**
 * why: A scripted emulator stays up until it is told to stop, as a real one does, so a boot that
 * sees it exit has failed; `emu kill` and the seed's `reboot -p` are what stop it.
 */
export class EmulatorExitingRunner extends ScriptedProcessRunner {
  /** why: a test of an emulator that ignores `emu kill` sets this. */
  ignoresEmuKill = false;

  /** why: the flag probe is not one of the calls a boot test scripts, so it is answered here and never enters `calls` or the script's order. */
  override run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    if (command === binaries.emulator && args[0] === "-help") {
      return Promise.resolve(ok(emulatorHelpListing));
    }
    return super.run(command, args, options);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    const handle = super.spawn(command, args, options);
    const stopsTheEmulator = /(?:emu kill|shell reboot -p)$/.test(args.join(" "));
    if (!this.ignoresEmuKill && stopsTheEmulator) {
      for (const [index, call] of this.calls.entries()) {
        if (call.command === binaries.emulator && call.args.includes("-avd")) {
          this.handles[index]?.kill("SIGKILL");
        }
      }
    }
    return handle;
  }
}

/** why: an emulator new enough to list every flag Simlock passes, `-crash-report-mode` included. */
export const emulatorHelpListing = [
  "-avd",
  "-port",
  "-no-snapshot-save",
  "-grpc",
  "-grpc-use-token",
  "-crash-report-mode",
]
  .map((flag) => `  ${flag} <value>  described`)
  .join("\n");

const defaultSeedHome = `${avdDirectory}/sources/seed_two`;

/** why: the calls of making and booting a seed, shared by the seed tests and the harness every driver test starts from. */
export const seedEmulatorLine = [
  "-port",
  "5586",
  "-no-snapshot-save",
  "-grpc",
  "8586",
  "-grpc-use-token",
  "-crash-report-mode",
  "never",
];

export function bootingAt(
  folder: string,
  launch: readonly string[],
  hangs: boolean,
  notReadyPolls = 0,
  flags: readonly string[] = [],
) {
  const serial = "emulator-5586";
  const notReady = Array.from({ length: notReadyPolls }, () =>
    processResult(binaries.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], "0\n"),
  );
  return [
    {
      hangs,
      match: {
        args: ["-avd", "simlock", ...seedEmulatorLine, ...flags, ...launch],
        command: binaries.emulator,
      },
    },
    ...notReady,
    processResult(binaries.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], "1\n"),
    processResult(binaries.adb, ["-s", serial, "shell", "getprop", "init.svc.bootanim"], ""),
    processResult(
      binaries.adb,
      ["-s", serial, "emu", "avd", "path"],
      `${folder}/simlock.avd\r\nOK\r\n`,
    ),
    processResult(
      binaries.adb,
      ["-s", serial, "shell", "pm", "path", "android"],
      "package:/system/framework/framework-res.apk\n",
    ),
  ] satisfies ScriptedProcessExpectation[];
}

/** why: the calls of making a seed, by stage, so a test can stop it at the step that fails. */
export function seedStages(
  home = defaultSeedHome,
  emulatorVersion = "Android emulator version 36.1.9",
  flags: readonly string[] = [],
) {
  const serial = "emulator-5586";
  return {
    create: processResult(binaries.avdmanager, [
      "create",
      "avd",
      "-n",
      "simlock",
      "-k",
      "system-images;android-34;google_apis;arm64-v8a",
      "-d",
      "pixel_5",
    ]),
    devices: processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    firstBoot: bootingAt(home, ["-no-snapshot-load"], true, 0, flags),
    kill: processResult(binaries.adb, ["-s", serial, "emu", "kill"]),
    list: processResult(
      binaries.adb,
      ["-s", serial, "emu", "avd", "snapshot", "list"],
      "simlock_boot\n",
    ),
    powerOff: processResult(binaries.adb, ["-s", serial, "shell", "reboot", "-p"]),
    probe: processResult(
      binaries.adb,
      ["-s", serial, "emu", "avd", "path"],
      `${home}/simlock.avd\r\nOK\r\n`,
    ),
    save: processResult(binaries.adb, [
      "-s",
      serial,
      "emu",
      "avd",
      "snapshot",
      "save",
      "simlock_boot",
    ]),
    secondBoot: bootingAt(home, ["-no-snapshot-load"], true, 0, flags),
    sync: processResult(binaries.adb, ["-s", serial, "shell", "sync"]),
    version: processResult(binaries.emulator, ["-version"], emulatorVersion),
  };
}

export function makingTheSeed(
  home = defaultSeedHome,
  emulatorVersion = "Android emulator version 36.1.9",
  flags: readonly string[] = [],
): ScriptedProcessExpectation[] {
  const stage = seedStages(home, emulatorVersion, flags);
  return [
    stage.version,
    stage.create,
    stage.devices,
    ...stage.firstBoot,
    stage.sync,
    stage.powerOff,
    ...stage.secondBoot,
    stage.save,
    stage.list,
    stage.probe,
    stage.kill,
  ];
}

export async function writeSeedFiles(
  filesystem: MemoryFilesystem,
  home: string,
  config = "hw.ramSize=2048\n",
  avdName = "simlock",
): Promise<void> {
  await filesystem.mkdirp(`${home}/${avdName}.avd`);
  await filesystem.writeFileAtomic(`${home}/${avdName}.avd/config.ini`, config);
  await filesystem.writeFileAtomic(
    `${home}/${avdName}.ini`,
    `avd.ini.encoding=UTF-8\npath=${home}/${avdName}.avd\ntarget=android-34\n`,
  );
}

export async function androidFilesystem(
  options: {
    readonly config?: string;
    readonly freeDiskBytes?: number;
    readonly images?: readonly (readonly [string, string, string])[];
    readonly withDeviceRoot?: boolean;
  } = {},
  filesystem: MemoryFilesystem = new MemoryFilesystem(options.freeDiskBytes),
): Promise<MemoryFilesystem> {
  for (const binary of Object.values(binaries)) {
    await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
    await filesystem.writeFileAtomic(binary, "binary");
  }
  // why: Marked, so `ensureOwnedRoot` adopts it rather than creating one -- a root Simlock
  // created in an earlier run is the ordinary case, and it keeps the id generator's first
  // value available for the AVD name the tests assert on.
  if (options.withDeviceRoot !== false) {
    await filesystem.mkdirp(avdDirectory);
    await filesystem.writeFileAtomic(
      `${avdDirectory}/${OWNED_ROOT_MARKER_FILE}`,
      JSON.stringify({ instanceId, owner: "simlock", platform: "android", schemaVersion: 1 }),
    );
  }
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${ANDROID_SDK_ROOT}/system-images/android-${api}/${tag}/${abi}`);
  }
  if (options.config !== undefined) {
    await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
    await filesystem.writeFileAtomic(`${avdDirectory}/simlock_one.avd/config.ini`, options.config);
  }
  return filesystem;
}

/** why: making a seed from whichever image and device profile the test's request resolves to; `device` pins the profile when the test cares. */
export function makingASeedFrom(
  home = defaultSeedHome,
  device: string | RegExp = /.+/,
): ScriptedProcessExpectation[] {
  const making = makingTheSeed(home);
  making[1] = processResult(binaries.avdmanager, [
    "create",
    "avd",
    "-n",
    "simlock",
    "-k",
    /.+/,
    "-d",
    device,
  ]);
  return making;
}

/**
 * why: the boot of a copy, as the driver asks the emulator for it: `adb devices` for the port,
 * the launch, then the readiness polls. `launch` is `-snapshot simlock_boot` for a prepare boot.
 */
function copyBootExpectations(options: {
  readonly bootCompleted?: string | undefined;
  readonly copyHome: string;
  readonly emulatorFlags?: readonly string[] | undefined;
  readonly initialAdbFailures?: number | undefined;
  readonly launch?: readonly string[];
  readonly unsettledPmAnswers?: readonly ProcessResult[] | undefined;
}): ScriptedProcessExpectation[] {
  const bootCompleted = options.bootCompleted ?? "1\n";
  const serial = "emulator-5586";
  const poll = (property: string, answer: string) =>
    processResult(binaries.adb, ["-s", serial, "shell", "getprop", property], answer);
  const path = processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${options.copyHome}/simlock.avd\r\nOK\r\n`,
  );
  const pm = (answer: ProcessResult): ScriptedProcessExpectation => ({
    match: { args: ["-s", serial, "shell", "pm", "path", "android"], command: binaries.adb },
    result: answer,
  });
  const expectations: ScriptedProcessExpectation[] = [
    processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    {
      hangs: true,
      match: {
        args: [
          "-avd",
          "simlock",
          ...seedEmulatorLine,
          ...(options.emulatorFlags ?? []),
          ...(options.launch ?? ["-snapshot", "simlock_boot"]),
        ],
        command: binaries.emulator,
      },
    },
  ];
  for (let failure = 0; failure < (options.initialAdbFailures ?? 0); failure += 1) {
    expectations.push({
      match: {
        args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        command: binaries.adb,
      },
      result: { code: 1, stderr: "connection refused", stdout: "" },
    });
  }
  expectations.push(poll("sys.boot_completed", bootCompleted));
  if (bootCompleted.trim() !== "1") return expectations;
  for (const answer of options.unsettledPmAnswers ?? []) {
    expectations.push(
      poll("init.svc.bootanim", ""),
      path,
      pm(answer),
      poll("sys.boot_completed", "1\n"),
    );
  }
  expectations.push(
    poll("init.svc.bootanim", ""),
    path,
    pm({ code: 0, stderr: "", stdout: "package:/system/framework/framework-res.apk\n" }),
  );
  return expectations;
}

class ListingRunner extends EmulatorExitingRunner {
  constructor(
    private readonly listing: string,
    expectations: readonly ScriptedProcessExpectation[],
  ) {
    super(expectations);
  }

  override spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): ProcessHandle {
    if (command === binaries.avdmanager && args[0] === "list") {
      return new EmulatorExitingRunner([processResult(command, args, this.listing)]).spawn(
        command,
        args,
        options,
      );
    }
    return super.spawn(command, args, options);
  }
}

/** why: what the seed and library tests need of whatever makes a seed: a driver at the root, or the part with the catalog beside it. */
export interface SeedProvisioner {
  listCatalog(): Promise<DriverCatalogEntry>;
  provision(spec: VirtualSpec): Promise<DriverDevice>;
  resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec>;
}

export type BuildProvisioner = (
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly ids: readonly string[];
  },
) => Promise<SeedProvisioner>;

export async function fitHarness(
  build: BuildProvisioner,
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
        `${ANDROID_SDK_ROOT}/system-images/android-${api}/${tag}/${abi}/source.properties`,
        properties,
      );
    }
  }
  if (options.devicesXml !== undefined) await writeDevicesXml(filesystem, options.devicesXml);
  await writeSeedFiles(filesystem, defaultSeedHome);
  const runner = new ListingRunner(options.listing ?? fitDevices, makingASeedFrom());
  const driver = await build(filesystem, runner, {
    hostAbi: options.hostAbi ?? "arm64-v8a",
    ids: ["one", "two"],
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    ...(options.profiles === undefined
      ? {}
      : { deviceProfileSources: [{ profiles: async () => options.profiles ?? [] }] }),
  });
  const resolve = (model: string, osVersion?: string, imageTag?: string) =>
    driver.resolveSpec({
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
  const createdPackage = () => {
    const create = runner.calls.find((call) => call.args[0] === "create");
    return create?.args[create.args.indexOf("-k") + 1];
  };
  return { createdPackage, driver, filesystem, refusal, resolve, runner };
}

const SEED_LINES = [
  "avd.ini.encoding=UTF-8",
  "hw.cpu.arch=arm64",
  "hw.ramSize=1G",
  "hw.lcd.density=1",
  "hw.seedOnly=yes",
  "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/",
  "tag.id=google_apis",
  "abi.type=arm64-v8a",
  "target=android-35",
  "disk.dataPartition.size=6G",
  "showDeviceFrame=yes",
  "skin.name=pixel_8",
  "skin.path=skins/pixel_8",
  "vm.heapSize=64M",
  "PlayStore.enabled=no",
];

export function seedConfig(extra: readonly string[]): string {
  return `${[...SEED_LINES.filter((line) => !extra.some((added) => added.split("=")[0] === line.split("=")[0])), ...extra].join("\n")}\n`;
}

// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
export async function libraryHarness(
  build: BuildProvisioner,
  options: {
    readonly devicesXml?: string;
    readonly extraImages?: readonly (readonly [string, string, string])[];
    readonly filesystem?: MemoryFilesystem;
    readonly imageProperties?: string;
    readonly imageTag?: string;
    readonly listing?: string;
    readonly profiles?: readonly LibraryDeviceProfile[];
    readonly seed?: string;
    readonly seedBootProp?: string;
    readonly sources?: readonly DeviceProfileSource[];
  } = {},
) {
  const tag = options.imageTag ?? "google_apis";
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  await androidFilesystem(
    { images: [["35", tag, "arm64-v8a"], ...(options.extraImages ?? [])] },
    filesystem,
  );
  const imageProperties = options.imageProperties ?? `Pkg.Revision=1\nSystemImage.TagId=${tag}\n`;
  if (imageProperties !== "") {
    await filesystem.writeFileAtomic(
      `${ANDROID_SDK_ROOT}/system-images/android-35/${tag}/arm64-v8a/source.properties`,
      imageProperties,
    );
  }
  if (options.devicesXml !== undefined) {
    await writeDevicesXml(filesystem, options.devicesXml);
  }
  // why: the profile is applied to the seed's AVD, which `avdmanager create` writes in the seed's own folder.
  const seedFolder = `${avdDirectory}/sources/seed_two`;
  const avd = `${seedFolder}/simlock.avd`;
  const configPath = `${avd}/config.ini`;
  const bootPropPath = `${avd}/boot.prop`;
  await writeSeedFiles(filesystem, seedFolder, options.seed ?? seedConfig([]));
  if (options.seedBootProp !== undefined) {
    await filesystem.writeFileAtomic(bootPropPath, options.seedBootProp);
  }
  const listing = options.listing ?? pixelDevices;
  const runner = new EmulatorExitingRunner([
    processResult(binaries.avdmanager, ["list", "device"], listing),
    ...makingASeedFrom(seedFolder),
  ]);
  const sources =
    options.profiles === undefined
      ? options.sources
      : [{ profiles: async () => options.profiles ?? [] }];
  const driver = await build(filesystem, runner, {
    ids: ["one", "two"],
    ...(sources === undefined ? {} : { deviceProfileSources: sources }),
  });
  const resolve = (model: string) =>
    driver.resolveSpec({ model, osVersion: "35", platform: "android" });
  const readLines = async () =>
    (await filesystem.readFile(configPath)).split("\n").filter((line) => line !== "");
  return {
    bootPropPath,
    config: async () =>
      new Map(
        (await readLines()).map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
      ),
    configPath,
    createCalls: () => runner.calls.filter((call) => call.args[0] === "create"),
    driver,
    filesystem,
    lines: readLines,
    provision: async (model: string) => driver.provision(await resolve(model)),
    resolve,
    runner,
    seedDeviceId: () => {
      const create = runner.calls.find((call) => call.args[0] === "create");
      return create?.args[create.args.indexOf("-d") + 1];
    },
  };
}

// why: the erasable mark a boot writes into the running device.
export function markWriteExpectation(serial: string, token: string): ScriptedProcessExpectation {
  return processResult(binaries.adb, [
    "-s",
    serial,
    "shell",
    `echo '${JSON.stringify({ token })}' > /data/local/tmp/simlock-mark.json`,
  ]);
}

export function createdFromPackage(runner: ScriptedProcessRunner): string | undefined {
  const create = runner.calls.find(
    (call) => call.command === binaries.avdmanager && call.args[0] === "create",
  );
  return create?.args[create.args.indexOf("-k") + 1];
}

export async function taggedHarness(
  build: BuildProvisioner,
  images: readonly (readonly [string, string, string])[],
  hostAbi = "arm64-v8a",
) {
  const filesystem = await androidFilesystem({ images });
  await writeSeedFiles(filesystem, defaultSeedHome);
  const runner = new EmulatorExitingRunner([
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ...makingASeedFrom(defaultSeedHome, "pixel_5"),
    ...copyBootExpectations({ copyHome: `${avdDirectory}/simlock_one` }),
    markWriteExpectation("emulator-5586", "device-3"),
  ]);
  const driver = await build(filesystem, runner, { hostAbi, ids: ["one", "two"] });
  return { driver, filesystem, runner };
}

export function bootProbes(runner: ScriptedProcessRunner): number {
  return runner.calls.filter((call) => call.args.includes("sys.boot_completed")).length;
}

export const adbServerPort = 5038;

export const adbServerPid = 4242;

export const adbRecordPath = `${simlockHome}/adb-server.json`;

export const scopedEnv = {
  ANDROID_ADB_SERVER_PORT: String(adbServerPort),
  ANDROID_AVD_HOME: avdDirectory,
  ANDROID_HOME: sdk,
} as const;

export const PHYSICAL_DEVICE = {
  address: "R58M123ABC",
  deviceId: "R58M123ABC",
  driverData: {},
  enrolledApps: ["com.example.kept"],
  physical: true,
} as const;

/** why: the arguments of every emulator start, in order. */
export function emulatorLaunchArgs(runner: ScriptedProcessRunner): (readonly string[])[] {
  return runner.calls
    .filter((call) => call.command === binaries.emulator && call.args.includes("-avd"))
    .map((call) => call.args);
}

/**
 * why: a driver and the copy it provisioned: the seed is made (scripted) and copied, so what a test
 * scripts after `afterwards` is about that copy. The seed's id is the second the generator gives
 * and the copy's the first, so a copy's folder is `<root>/simlock_one/` and the mark token of its
 * first boot is the third id, `device-3`.
 */
// fallow-ignore-next-line complexity -- one test harness builder; each option is a plain pass-through to a collaborator.
export async function provisionedHarness(
  options: {
    readonly bootCompleted?: string;
    readonly config?: string;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    readonly filesystem?: MemoryFilesystem;
    readonly emulatorFlags?: readonly string[];
    readonly ids?: readonly string[];
    readonly initialAdbFailures?: number;
    readonly tcpListener?: FakeTcpListenerFactory;
    readonly unsettledPmAnswers?: readonly ProcessResult[];
    readonly readinessTimeoutMs?: number;
    readonly firstMarkToken?: string;
    readonly afterwards?: readonly ScriptedProcessExpectation[];
  } = {},
) {
  const filesystem = await androidFilesystem({}, options.filesystem);
  const ids = options.ids ?? ["one", "two"];
  const seedHome = `${avdDirectory}/sources/seed_${ids[1] ?? "two"}`;
  const copyHome = `${avdDirectory}/simlock_${ids[0] ?? "one"}`;
  await writeSeedFiles(filesystem, seedHome, options.config);
  const tcpProbe = new FakeTcpProbe([adbServerPort]);
  const clock = new FakeClock();
  const expectations: ScriptedProcessExpectation[] = [
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ...makingTheSeed(seedHome, "Android emulator version 36.1.9", options.emulatorFlags),
    ...copyBootExpectations({ ...options, copyHome }),
  ];
  if ((options.bootCompleted ?? "1\n").trim() === "1") {
    expectations.push(markWriteExpectation("emulator-5586", options.firstMarkToken ?? "device-3"));
  }
  expectations.push(...(options.afterwards ?? []));
  const runner = new EmulatorExitingRunner(expectations);
  const driver = await createDriver(filesystem, runner, {
    clock,
    ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
    ids,
    ...(options.tcpListener === undefined ? {} : { tcpListener: options.tcpListener }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    tcpProbe,
  });
  const spec = await driver.resolveSpec({
    model: "Pixel 5",
    osVersion: "34",
    platform: "android",
  });
  const device = await driver.provision(spec);

  return { clock, copyHome, device, driver, filesystem, runner, seedHome, tcpProbe };
}

export async function createDriver(
  filesystem: Filesystem,
  processRunner: ProcessRunner,
  options: {
    readonly acceptAndroidLicenses?: boolean;
    /** why: `ANDROID_AVD_HOME` in the environment the daemon started with; unset by default. */
    readonly avdHome?: string;
    readonly clock?: FakeClock;
    /** why: a second driver over the same table is the daemon after a restart. */
    readonly database?: Awaited<ReturnType<typeof memoryAndroidSourceDatabase>>;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** why: the ABI this host runs natively; `arm64-v8a` unless a test says otherwise. */
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
    readonly readinessTimeoutMs?: number;
    readonly scrcpyServerPath?: string;
    readonly tcpListener?: FakeTcpListenerFactory;
    readonly tcpProbe?: FakeTcpProbe;
    readonly tcpStreamConnector?: FakeTcpStreamConnector;
  } = {},
) {
  let nextId = 0;
  const driverConfig = options.driverConfig ?? {};
  const configuredPort =
    typeof driverConfig["adbServerPort"] === "number"
      ? driverConfig["adbServerPort"]
      : adbServerPort;
  await recordRunningAdbServer(filesystem, configuredPort);
  return AndroidDriver.create({
    ...onlyProvided(options),
    clock: options.clock ?? new FakeClock(),
    database: options.database ?? (await memoryAndroidSourceDatabase()),
    driverConfig,
    env: {
      ANDROID_HOME: sdk,
      ...options.extraEnv,
      ...(options.avdHome === undefined ? {} : { ANDROID_AVD_HOME: options.avdHome }),
    },
    filesystem,
    homeDirectory: home,
    hostAbi: options.hostAbi ?? "arm64-v8a",
    idGenerator: {
      generate: () => options.ids?.[nextId++] ?? `device-${nextId}`,
    },
    instanceId,
    processRunner,
    processSupervisor: new FakeProcessSupervisor([adbServerPid]),
    simlockHome,
    tcpProbe: options.tcpProbe ?? new FakeTcpProbe([configuredPort]),
  });
}

/** why: the options this helper only forwards when a test actually set one -- `AndroidDriver.create`
 * declares them optional under `exactOptionalPropertyTypes`, so an absent one must be absent
 * rather than `undefined`. Split out of `createDriver` so that the list can keep growing
 * without the helper itself turning into a pile of conditionals. */
function onlyProvided(options: {
  readonly acceptAndroidLicenses?: boolean;
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  readonly emulator?: AndroidEmulatorLaunchOptions;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly readinessTimeoutMs?: number;
  readonly scrcpyServerPath?: string;
  readonly tcpListener?: FakeTcpListenerFactory;
  readonly tcpStreamConnector?: FakeTcpStreamConnector;
}) {
  return {
    ...(options.tcpListener === undefined ? {} : { tcpListener: options.tcpListener }),
    ...(options.scrcpyServerPath === undefined
      ? {}
      : { scrcpyServerPath: options.scrcpyServerPath }),
    ...(options.tcpStreamConnector === undefined
      ? {}
      : { tcpStreamConnector: options.tcpStreamConnector }),
    ...(options.acceptAndroidLicenses === undefined
      ? {}
      : { acceptAndroidLicenses: options.acceptAndroidLicenses }),
    ...(options.deviceProfileSources === undefined
      ? {}
      : { deviceProfileSources: options.deviceProfileSources }),
    ...(options.emulator === undefined ? {} : { emulator: options.emulator }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
  };
}

export async function recordRunningAdbServer(
  filesystem: Filesystem,
  port = adbServerPort,
): Promise<void> {
  await filesystem.mkdirp(simlockHome);
  await filesystem.writeFileAtomic(
    adbRecordPath,
    JSON.stringify({ pid: adbServerPid, port, startedAt: 1 }),
  );
}

/**
 * why: The emulators on one machine, which outlive any one daemon: as much of `avdmanager`,
 * `emulator` and `adb` as provisioning, booting, saving a snapshot and stopping use. Each
 * `runner()` is one daemon process's view of it -- the driver keeps its port reservations per
 * runner, as a real daemon keeps them per process.
 *
 * Two behaviours are the real tools', not Simlock's. An emulator told to take a console port
 * another one holds exits at once: `emulator -help` (36.1.9) says that "if any of these ports
 * is already used, the emulator will fail to start". And a serial is answered by whichever
 * emulator is listening on its port.
 */
export class EmulatorHost {
  /** why: the AVD folder each console port's emulator runs, as its `emu avd path` answers it. */
  readonly #listening = new Map<number, string>();
  readonly #exits = new Map<number, () => void>();
  #nextPid = 1;

  constructor(private readonly filesystem: MemoryFilesystem) {}

  pathAnswering(serial: string | undefined): string | undefined {
    return this.#listening.get(consolePortOf(serial));
  }

  /** why: the id of the device whose AVD answers: a copy's folder name, or an old-layout AVD's name. */
  avdAnswering(serial: string | undefined): string | undefined {
    const folder = this.#listening.get(consolePortOf(serial));
    if (folder === undefined) return undefined;
    const home = folder.slice(0, folder.lastIndexOf("/"));
    return home === avdDirectory ? basename(folder, ".avd") : basename(home);
  }

  runner(): ProcessRunner {
    return {
      run: (command, args, options) => this.#run(command, args, options?.env),
      spawn: (command, args, options) => this.#spawn(command, args, options?.env),
      spawnStreaming: (command, args) => {
        throw new Error(`Unexpected streaming invocation: ${command} ${args.join(" ")}`);
      },
    };
  }

  async #run(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ProcessResult> {
    const result =
      command === binaries.avdmanager
        ? await this.#avdmanager(args, env?.["ANDROID_AVD_HOME"] ?? avdDirectory)
        : command === binaries.adb
          ? this.#adb(args)
          : command === binaries.emulator
            ? emulatorQuery(args)
            : undefined;
    if (result === undefined) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }
    return result;
  }

  async #avdmanager(args: readonly string[], home: string): Promise<ProcessResult | undefined> {
    if (args[0] === "list") return ok(pixelDevices);
    const avdName = args[args.indexOf("-n") + 1] ?? "";
    if (args[0] === "delete") {
      await this.filesystem.rm(`${home}/${avdName}.avd`);
      return ok();
    }
    if (args[0] !== "create") return undefined;
    await writeSeedFiles(this.filesystem, home, "hw.ramSize=2048\n", avdName);
    return ok();
  }

  // fallow-ignore-next-line complexity -- one fake adb: each branch answers one command of the table.
  #adb(args: readonly string[]): ProcessResult | undefined {
    if (args[0] === "devices") {
      const lines = [...this.#listening.keys()].map((port) => `emulator-${port}\tdevice\n`);
      return ok(`List of devices attached\n${lines.join("")}`);
    }
    if (args[0] !== "-s") return undefined;
    const port = consolePortOf(args[1]);
    if (!this.#listening.has(port)) {
      return { code: 1, stderr: `adb: device '${args[1]}' not found`, stdout: "" };
    }
    const rest = args.slice(2).join(" ");
    if (rest === "emu kill" || rest === "shell reboot -p") {
      this.#exit(port);
      return ok("OK: killing emulator, bye bye\n");
    }
    if (rest.startsWith("shell echo ")) return ok();
    if (rest.startsWith("shell getprop ro.boot.qemu.avd_name; head -c ")) {
      return ok(`${basename(this.#listening.get(port) ?? "", ".avd")}\n`);
    }
    if (rest === "emu avd path") {
      return ok(`${this.#listening.get(port) ?? ""}\r\nOK\r\n`);
    }
    const answer = ADB_ANSWERS.get(rest);
    return answer === undefined ? undefined : ok(answer);
  }

  #spawn(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): ProcessHandle {
    if (command !== binaries.emulator || args[0] !== "-avd") {
      throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
    }
    const avdName = `${env?.["ANDROID_AVD_HOME"] ?? avdDirectory}/${args[1] ?? ""}.avd`;
    const port = Number(args[args.indexOf("-port") + 1]);
    let exit!: (result: ProcessResult) => void;
    const exited = new Promise<ProcessResult>((resolve) => {
      exit = resolve;
    });
    const bound = !this.#listening.has(port);
    if (bound) {
      this.#listening.set(port, avdName);
      this.#exits.set(port, () => exit({ code: 0, stderr: "", stdout: "" }));
    } else {
      exit({ code: 1, stderr: `console port ${port} is already used`, stdout: "" });
    }
    return {
      // why: Killing an emulator that never bound must not stop the one that did.
      kill: () => {
        if (bound && this.#listening.get(port) === avdName) this.#exit(port);
      },
      pid: this.#nextPid++,
      stderr: emptyLines(),
      stdout: emptyLines(),
      unref: () => undefined,
      wait: () => exited,
    };
  }

  #exit(port: number): void {
    this.#listening.delete(port);
    this.#exits.get(port)?.();
    this.#exits.delete(port);
  }
}

export class RecordingRunner implements ProcessRunner {
  readonly calls: { args: readonly string[]; command: string; options: ProcessRunOptions }[] = [];

  constructor(private readonly inner: ProcessRunner) {}

  run(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.run(command, args, options);
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.spawn(command, args, options);
  }

  spawnStreaming(...args: Parameters<ProcessRunner["spawnStreaming"]>) {
    return this.inner.spawnStreaming(...args);
  }
}

const ADB_ANSWERS = new Map([
  ["shell getprop sys.boot_completed", "1\n"],
  ["shell getprop init.svc.bootanim", "stopped\n"],
  ["shell pm path android", "package:/system/framework/framework-res.apk\n"],
  ["shell sync", ""],
  ["emu avd snapshot save simlock_boot", "OK\n"],
  ["emu avd snapshot list", "simlock_boot\n"],
]);

export function consolePortOf(serial: string | undefined): number {
  return Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
}

export function ok(stdout = ""): ProcessResult {
  return { code: 0, stderr: "", stdout };
}

export async function* emptyLines(): AsyncIterable<string> {}

/** why: what a running copy answers to `emu avd path`: the AVD inside its own folder. */
export function copyPathExpectation(
  serial: string,
  folder = "simlock_one",
): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${folder}/simlock.avd\r\nOK\r\n`,
  );
}

export class WorkingDirectoryFilesystem extends MemoryFilesystem {
  constructor(private readonly workingDirectory: string) {
    super();
  }

  override async realpath(path: string): Promise<string> {
    return super.realpath(path.startsWith("/") ? path : `${this.workingDirectory}/${path}`);
  }
}

/** why: the two read-only `emulator` calls the fake answers; any other is unexpected. */
function emulatorQuery(args: readonly string[]): ProcessResult | undefined {
  if (args[0] === "-version") return ok("Android emulator version 36.1.9");
  if (args[0] === "-help") return ok(emulatorHelpListing);
  return undefined;
}
