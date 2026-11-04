import { describe, expect, it } from "vitest";

import {
  FakeClock,
  FakeTcpProbe,
  type MemoryFilesystem,
  type ProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";
import { Catalog } from "./catalog.js";
import { ConsolePorts, portAllocatorFor } from "./console-ports.js";
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
  EmulatorExitingRunner,
  makingTheSeed,
  memoryAndroidSourceDatabase,
  pixelDevices,
  processResult,
  writeSeedFiles,
} from "./testing.js";

const adbServerPort = 5038;
const env = { ANDROID_HOME: sdk } as const;

/** why: the part and the catalog that resolves its specs, built the way the driver builds them over one scripted runner. */
function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly clock?: FakeClock;
    readonly database: Awaited<ReturnType<typeof memoryAndroidSourceDatabase>>;
    readonly ids?: readonly string[];
  },
) {
  let nextId = 0;
  const clock = options.clock ?? new FakeClock();
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
    seedLaunchInputs: [],
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
    readinessTimeoutMs: 180_000,
    tcpProbe: new FakeTcpProbe([adbServerPort]),
  });
  const systemImages = new SystemImages({
    acceptAndroidLicenses: false,
    clock,
    deviceRoot: avdDirectory,
    filesystem,
    hostAbi: "arm64-v8a",
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

const sources = `${avdDirectory}/sources`;
const seedHome = `${sources}/seed_two`;

async function seedHarness(
  expectations: readonly ScriptedProcessExpectation[],
  options: {
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

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Seeds` directly over a memory filesystem and a scripted runner, with the real parts it takes.
describe("Seeds", () => {
  it("makes one seed when two plain leases of one kind are provisioned at once", async () => {
    const madeHome = `${sources}/seed_three`;
    const harness = await seedHarness([
      ...makingTheSeed(madeHome),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
    ]);
    await writeSeedFiles(harness.filesystem, madeHome);

    const [first, second] = await Promise.all([
      harness.seeds.provision(harness.spec),
      harness.seeds.provision(harness.spec),
    ]);

    expect(harness.runner.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
    expect([first.deviceId, second.deviceId]).toEqual(["simlock_one", "simlock_two"]);
    await expect(
      harness.filesystem.exists(`${avdDirectory}/simlock_two/simlock.avd`),
    ).resolves.toBe(true);
    const listed = await harness.seeds.listSources();
    expect(listed.filter((source) => source.orphan !== true)).toHaveLength(1);
  });
});
