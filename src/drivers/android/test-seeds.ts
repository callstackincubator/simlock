import { join } from "node:path";
import {
  FakeClock,
  FakeTcpProbe,
  MemoryFilesystem,
  type ProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";

import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";
import { Catalog } from "./catalog.js";
import { ConsolePorts, portAllocatorFor } from "./console-ports.js";
import type { DeviceProfileSource } from "./device-profile-source.js";
import { DeviceTable } from "./device-table.js";
import { Emulator } from "./emulator.js";
import { Ownership } from "./ownership.js";
import { Seeds } from "./seeds.js";
import { SystemImages } from "./system-images.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  androidFilesystem,
  avdDirectory,
  binaries,
  type BuildProvisioner,
  EmulatorExitingRunner,
  libraryHarness as libraryHarnessWith,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  writeSeedFiles,
} from "./testing.js";

const adbServerPort = 5038;

/** why: the part and the catalog that resolves its specs, built the way the driver builds them over one scripted runner. */
export function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly bootTimeoutMs?: number;
    readonly clock?: FakeClock;
    readonly database: Awaited<ReturnType<typeof memoryAndroidSourceDatabase>>;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly seedLaunchInputs?: readonly string[];
  },
) {
  let nextId = 0;
  const clock = options.clock ?? new FakeClock();
  const env = { ANDROID_HOME: sdk, ...options.extraEnv };
  const adbTools = new AdbTools({
    adb: binaries.adb,
    adbServerPort,
    baseEnv: env,
    clock,
    deviceRoot: avdDirectory,
    emulator: binaries.emulator,
    processRunner,
  });
  const idGenerator = { generate: () => options.ids?.[nextId++] ?? `device-${nextId}` };
  const ownership = new Ownership({ adb: binaries.adb, adbTools, filesystem });
  const avdConfig = new AvdConfig({
    adb: binaries.adb,
    adbTools,
    filesystem,
    idGenerator,
    seedLaunchInputs: options.seedLaunchInputs ?? [],
  });
  const emulator = new Emulator({
    adb: binaries.adb,
    adbServerPort,
    adbTools,
    clock,
    deviceRoot: avdDirectory,
    emulator: binaries.emulator,
    emulatorLaunch: undefined,
    filesystem,
    onDiagnostic: undefined,
    ownership,
    processRunner,
    bootTimeoutMs: options.bootTimeoutMs ?? 300_000,
    tcpProbe: new FakeTcpProbe([adbServerPort]),
  });
  const systemImages = new SystemImages({
    acceptAndroidLicenses: false,
    clock,
    deviceRoot: avdDirectory,
    filesystem,
    hostAbi: options.hostAbi ?? "arm64-v8a",
    legacyAvdHome: `${home}/.android/avd`,
    processRunner,
    sdk: {
      adb: binaries.adb,
      emulator: binaries.emulator,
      root: sdk,
      sdkmanager: binaries.sdkmanager,
    },
  });
  const catalog = new Catalog({
    avdmanager: binaries.avdmanager,
    avdmanagerEnv: () => adbTools.env(),
    deviceProfileSources: options.deviceProfileSources,
    env,
    filesystem,
    homeDirectory: home,
    onDiagnostic: undefined,
    processRunner,
    sdkRoot: sdk,
    systemImages,
  });
  const seeds = new Seeds({
    adb: binaries.adb,
    adbTools,
    avdConfig,
    avdmanager: binaries.avdmanager,
    bootTimeoutMs: options.bootTimeoutMs ?? 300_000,
    catalog,
    clock,
    consolePorts: new ConsolePorts({
      adbTools,
      allocator: portAllocatorFor(processRunner, binaries.adb),
      tcpProbe: new FakeTcpProbe([adbServerPort]),
    }),
    database: options.database,
    deviceRoot: avdDirectory,
    deviceTable: new DeviceTable({
      adbTools,
      avdConfig,
      avdmanager: binaries.avdmanager,
      baseEnv: env,
      deviceRoot: avdDirectory,
      filesystem,
      legacyAvdHome: `${home}/.android/avd`,
      ownership,
      register: async () => undefined,
    }),
    emulator,
    filesystem,
    idGenerator,
    ownership,
    processRunner,
    systemImages,
  });
  return { catalog, seeds };
}

export const buildPart: BuildProvisioner = async (filesystem, processRunner, options) => {
  const { catalog, seeds } = createPart(filesystem, processRunner, {
    ...options,
    database: await memoryAndroidSourceDatabase(),
  });
  return {
    listCatalog: () => catalog.listCatalog(),
    provision: (spec) => seeds.provision(spec),
    resolveSpec: (request) => catalog.resolveSpec(request),
  };
};

export const libraryHarness = (options?: Parameters<typeof libraryHarnessWith>[1]) =>
  libraryHarnessWith(buildPart, options);

export const sources = join(avdDirectory, "sources");

export const seedHome = join(sources, "seed_two");

export async function seedHarness(
  expectations: readonly ScriptedProcessExpectation[],
  options: {
    readonly bootTimeoutMs?: number;
    readonly clock?: FakeClock;
    readonly config?: string;
    readonly filesystem?: MemoryFilesystem;
    readonly ids?: readonly string[];
  } = {},
) {
  const filesystem = await androidFilesystem({}, options.filesystem);
  await writeSeedFiles(filesystem, seedHome, options.config);
  const database = await memoryAndroidSourceDatabase();
  const runner = new EmulatorExitingRunner([
    processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
    ...expectations,
  ]);
  const part = createPart(filesystem, runner, {
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    database,
    ids: options.ids ?? ["one", "two", "three"],
  });
  const spec = await part.catalog.resolveSpec({
    model: "Pixel 5",
    osVersion: "34",
    platform: "android",
  });
  return { database, filesystem, runner, spec, ...part };
}
