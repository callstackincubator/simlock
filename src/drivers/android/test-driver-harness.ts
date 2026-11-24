import { join } from "node:path";
import {
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ScriptedProcessExpectation,
  FakeClock,
  FakeProcessSupervisor,
  type ProcessTable,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type Filesystem,
} from "../../ports/index.js";
import { type DeviceProfileSource } from "./device-profile-source.js";
import {
  AndroidDriver,
  type AndroidDriverDiagnostic,
  type AndroidEmulatorLaunchOptions,
} from "./index.js";
import {
  sdk,
  home,
  memoryAndroidSourceDatabase,
  processResult,
  pixelDevices,
  simlockHome,
  instanceId,
  avdDirectory,
  binaries,
} from "./test-sdk-fixtures.js";
import {
  EmulatorExitingRunner,
  makingTheSeed,
  writeSeedFiles,
  androidFilesystem,
  copyBootExpectations,
  markWriteExpectation,
} from "./test-seed-harness.js";

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
    readonly bootTimeoutMs?: number;
    readonly firstMarkToken?: string;
    readonly afterwards?: readonly ScriptedProcessExpectation[];
  } = {},
) {
  const filesystem = await androidFilesystem({}, options.filesystem);
  const ids = options.ids ?? ["one", "two"];
  const seedHome = join(avdDirectory, "sources", `seed_${ids[1] ?? "two"}`);
  const copyHome = join(avdDirectory, `simlock_${ids[0] ?? "one"}`);
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
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
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
    /** why: the worker's `android.defaultImageTag`, unset unless a test says otherwise. */
    readonly defaultImageTag?: string;
    readonly deviceProfileSources?: readonly DeviceProfileSource[];
    readonly driverConfig?: Readonly<Record<string, string | number | boolean>>;
    readonly emulator?: AndroidEmulatorLaunchOptions;
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** why: the ABI this host runs natively; `arm64-v8a` unless a test says otherwise. */
    readonly hostAbi?: string;
    readonly ids?: readonly string[];
    readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
    readonly bootTimeoutMs?: number;
    /** why: a settle judges its copy idle from it; with none the driver offers no `settleSeed`. */
    readonly processTable?: ProcessTable;
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
  readonly defaultImageTag?: string;
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  readonly emulator?: AndroidEmulatorLaunchOptions;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly bootTimeoutMs?: number;
  readonly processTable?: ProcessTable;
  readonly scrcpyServerPath?: string;
  readonly tcpListener?: FakeTcpListenerFactory;
  readonly tcpStreamConnector?: FakeTcpStreamConnector;
}) {
  return {
    ...omitUndefined({
      defaultImageTag: options.defaultImageTag,
      tcpListener: options.tcpListener,
      scrcpyServerPath: options.scrcpyServerPath,
      tcpStreamConnector: options.tcpStreamConnector,
      acceptAndroidLicenses: options.acceptAndroidLicenses,
      deviceProfileSources: options.deviceProfileSources,
      onDiagnostic: options.onDiagnostic,
      processTable: options.processTable,
    }),
    config: omitUndefined({ emulator: options.emulator, bootTimeoutMs: options.bootTimeoutMs }),
  };
}

/** why: under `exactOptionalPropertyTypes` an absent option must be absent, not `undefined`. */
function omitUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
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
