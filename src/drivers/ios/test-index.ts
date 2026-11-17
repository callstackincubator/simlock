import { readFileSync } from "node:fs";
import {
  type ScriptedProcessExpectation,
  ScriptedProcessRunner,
  type SqliteDatabase,
  FakeClock,
  type Filesystem,
  MemoryFilesystem,
  type Logger,
} from "../../ports/index.js";
import { IosSimctlDriver, type IosSimctlDriverOptions, SLIM_CATEGORIES } from "./index.js";
import { plantReadySeed, memorySourceDatabase, type PlantedSource } from "./testing.js";
import {
  simctl,
  deviceRoot,
  driverData,
  dataPath,
  instanceId,
  printDisabled,
} from "./test-slim.js";

export const listFixture = readFileSync(
  new URL("./fixtures/simctl-list.json", import.meta.url),
  "utf8",
);

export const listInvocation = simctl("list", "-j", "devicetypes", "runtimes");

export const listDevicesInvocation = simctl("list", "-j", "devices");

// why: iPhone 16 pairs with both installed runtimes; iPhone Xs pairs only with the older one (iOS 26
// dropped it, mirroring real Xcode 27) and its range caps out at iOS 18.6; iPhone 7 caps out at
// iOS 15.0, below the 16.0 auto-download floor.
export const pairingFixture = readFileSync(
  new URL("./fixtures/simctl-list-pairing.json", import.meta.url),
  "utf8",
);

// why: Same catalog as `listFixture`, plus an iOS 18.6 runtime that has just finished downloading --
// stands in for the re-scanned catalog `resolveSpec` reads after a successful `xcodebuild` call.
export const listFixtureAfterDownload = JSON.stringify({
  devicetypes: (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes,
  runtimes: [
    ...(JSON.parse(listFixture) as { runtimes: unknown[] }).runtimes,
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      isAvailable: true,
      name: "iOS 18.6",
      supportedDeviceTypes: [
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16" },
      ],
      version: "18.6",
    },
  ],
});

export const spec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
} as const;

/** why: Every simctl call the driver makes is scoped to its device set; so is every expectation. */

export const scopedRunners: ScriptedProcessRunner[] = [];

export const legacyUdid = "00000000-0000-0000-0000-0000000000ff";

/**
 * why: The complete argv of every call the pre-root path is allowed to make without `--set`,
 * spelled out rather than pattern-matched: `findLegacy` / `destroyLegacy` deliberately
 * address the machine's default set (ADR 0001, Migration), and `listComponents` reads it with
 * the same `list` to count foreign devices (ADR 0010 §8). Every *other* call must still fail
 * the invariant below if its scoping ever goes missing.
 */
export const UNSCOPED_LEGACY_CALLS = new Set(
  [
    ["simctl", "list", "-j", "devices"],
    ["simctl", "shutdown", legacyUdid],
    ["simctl", "delete", legacyUdid],
  ].map((argv) => argv.join(" ")),
);

export const seedUdid = "00000000-0000-0000-0000-0000000000aa";

/** why: A seed lives in the sources set, a sibling of the lease device set, and its calls are scoped to that. */
export function sourcesSimctl(...args: readonly string[]): {
  readonly command: string;
  readonly args: string[];
} {
  return { args: ["simctl", "--set", `${deviceRoot}/sources`, ...args], command: "xcrun" };
}

/** why: A database that already holds the seed of the kind `spec` names, so a test of the copy step starts at the clone. */
export async function seededDatabase(
  seed: Partial<Pick<PlantedSource, "files" | "lineage" | "runtimeBuild" | "udid">> = {},
): Promise<SqliteDatabase> {
  return plantReadySeed(await memorySourceDatabase(), {
    deviceTypeId: driverData.deviceTypeId,
    runtimeId: driverData.runtimeId,
    udid: seedUdid,
    ...seed,
  });
}

export function deviceListResponse(state: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { name: driverData.name, udid: driverData.udid, state, dataPath },
      ],
    },
  });
}

export const PHYSICAL_DEVICE = {
  address: "00008110-001A2B3C4D5E",
  deviceId: "00008110-001A2B3C4D5E",
  driverData: {},
  enrolledApps: ["com.example.kept"],
  physical: true,
} as const;

export function slimOptions(bootTimeoutMs = 300_000) {
  return { bootTimeoutMs, categories: ["widgets"] } as const;
}

export const runtimeListInvocation = simctl("runtime", "list", "-j");

export const defaultSetInvocation = { args: ["simctl", "list", "-j", "devices"], command: "xcrun" };

export interface Image {
  readonly id: string;
  readonly runtime: string;
  readonly build: string;
  readonly version: string;
  readonly sizeBytes?: number;
  readonly platform?: string;
}

export function image(version: string, build: string, extra: Partial<Image> = {}): Image {
  return {
    build,
    id: `IMG-${version}-${build}`,
    runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`,
    version,
    ...extra,
  };
}

export function imagesListed(images: readonly Image[], state = "Ready") {
  const stdout = JSON.stringify(
    Object.fromEntries(
      images.map((entry) => [
        entry.id,
        {
          build: entry.build,
          identifier: entry.id,
          platformIdentifier: entry.platform ?? "com.apple.platform.iphonesimulator",
          runtimeIdentifier: entry.runtime,
          sizeBytes: entry.sizeBytes ?? 1_000,
          state,
          version: entry.version,
        },
      ]),
    ),
  );
  return { match: runtimeListInvocation, result: { code: 0, stderr: "", stdout } };
}

/**
 * why: The default set's devices per runtime: a number is that many used devices, or name both
 * kinds. A used device carries `lastUsedAt`, as `simctl list -j devices` reports one that has
 * been booted; an unused one -- like the batch CoreSimulator creates when a runtime install
 * ends -- carries every other key a real entry has and no `lastUsedAt`.
 */
export function defaultSetListed(
  devices: Readonly<Record<string, number | { readonly used?: number; readonly unused?: number }>>,
) {
  const entry = (runtime: string, index: number, used: boolean) => ({
    dataPath: `/Users/me/Library/Developer/CoreSimulator/Devices/${runtime}-${String(index)}/data`,
    dataPathSize: used ? 1_500_000_000 : 18_000_000,
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    isAvailable: true,
    ...(used ? { lastUsedAt: "2026-10-01T12:00:00Z" } : {}),
    logPath: `/Users/me/Library/Logs/CoreSimulator/${runtime}-${String(index)}`,
    logPathSize: 4096,
    name: `user-${String(index)}`,
    state: "Shutdown",
    udid: `USER-${runtime}-${String(index)}`,
  });
  const stdout = JSON.stringify({
    devices: Object.fromEntries(
      Object.entries(devices).map(([runtime, counts]) => {
        const { unused = 0, used = 0 } = typeof counts === "number" ? { used: counts } : counts;
        return [
          runtime,
          [
            ...Array.from({ length: used }, (_, index) => entry(runtime, index, true)),
            ...Array.from({ length: unused }, (_, index) => entry(runtime, used + index, false)),
          ],
        ];
      }),
    ),
  });
  return { match: defaultSetInvocation, result: { code: 0, stderr: "", stdout } };
}

export function simctlPassthrough(driver: IosSimctlDriver, args: readonly string[]) {
  return driver.passthrough("simctl", undefined, args);
}

export async function createDriver(
  runner: ScriptedProcessRunner,
  clock = new FakeClock(),
  filesystem: Filesystem = new MemoryFilesystem(),
  database?: SqliteDatabase,
  logger?: Logger,
  fullBootTimeoutMs?: number,
  extra: Partial<IosSimctlDriverOptions> = {},
): Promise<IosSimctlDriver> {
  scopedRunners.push(runner);
  return IosSimctlDriver.create({
    ...extra,
    database: database ?? (await memorySourceDatabase()),
    clock,
    driverConfig: { deviceRoot },
    filesystem,
    idGenerator: { generate: () => "device-1" },
    instanceId,
    ...(fullBootTimeoutMs === undefined
      ? {}
      : { config: { full: { bootTimeoutMs: fullBootTimeoutMs } } }),
    ...(logger === undefined ? {} : { logger }),
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
}

/** why: a LaunchServices database file and a neighbour that must stay, in the device folder `device`. */
export async function plantLaunchServices(
  filesystem: MemoryFilesystem,
  device: string,
): Promise<void> {
  const folder = `${device}/data/var/db/lsd`;
  await filesystem.mkdirp(folder);
  await filesystem.writeFileAtomic(`${folder}/com.apple.LaunchServices-33554481-v2.csstore`, "x");
  await filesystem.writeFileAtomic(
    `${folder}/com.apple.LaunchServices.unregisteredtypes-501.db`,
    "",
  );
}

export async function launchServicesFiles(
  filesystem: MemoryFilesystem,
  device: string,
): Promise<string[]> {
  return (await filesystem.readdir(`${device}/data/var/db/lsd`)).sort();
}

/** why: Records every `warn` message, so the destroy's log line is asserted on its text. */
export class RecordingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly debugs: string[] = [];

  debug(message: string): void {
    this.debugs.push(message);
  }
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

// why: spelled out here, not imported: the labels simslim v0.13.0 never disables (ADR 0060 §1).
export const neverDisabled = ["com.apple.assistantd", "com.apple.gamed", "com.apple.sharingd"];

/** why: What the driver must write for categories ["widgets"]: its labels on, every other managed label off. */
export function wantedOverrides(): Record<string, boolean> {
  const wanted: Record<string, boolean> = {};
  for (const category of SLIM_CATEGORIES) {
    for (const label of category.labels) wanted[label] = false;
  }
  for (const label of neverDisabled) wanted[label] = false;
  for (const label of widgetsLabelList()) {
    if (!neverDisabled.includes(label)) wanted[label] = true;
  }
  return wanted;
}

export function widgetsLabelList(): readonly string[] {
  return SLIM_CATEGORIES.find((category) => category.name === "widgets")?.labels ?? [];
}

/** why: The readback of a boot that honoured every label as written. */
export function wantedReadback(): string {
  return printDisabled(
    Object.fromEntries(
      Object.entries(wantedOverrides()).map(([label, off]) => [
        label,
        off ? "disabled" : "enabled",
      ]),
    ),
  );
}

export function scriptedListRunner(): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    {
      match: listInvocation,
      result: { code: 0, stderr: "", stdout: listFixture },
    },
  ]);
}

/**
 * why: Where macOS keeps the simulator runtimes `xcodebuild -downloadPlatform` fetches. Spelled
 * out here rather than imported from the driver, which keeps its own copy of the same path: this
 * suite reads the store as the OS lays it out, so a fixture stays a fact about macOS rather than
 * about what the driver happens to look at (#79).
 */
export const IOS_RUNTIME_ASSET_ROOT =
  "/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime";

/**
 * why: A `MemoryFilesystem` whose `directorySize` answers a set size for the directories in `sizes`,
 * as a downloaded runtime bundle of several GiB would; it measures every other path as usual.
 */
export class SizedFilesystem extends MemoryFilesystem {
  constructor(private readonly sizes: ReadonlyMap<string, number>) {
    super();
  }

  override async directorySize(path: string): Promise<number> {
    return this.sizes.get(path) ?? super.directorySize(path);
  }
}

/**
 * why: mobileassetd's own metadata for one downloaded simulator runtime, cut down to the keys that
 * identify it. `NeverCollected` is verbatim from a real bundle on macOS 26.6.1 / Xcode 27: the
 * store is told not to reclaim these, which is why deleting the runtime does not shrink it.
 */
export function assetInfoPlist(simulatorVersion: string, build: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "  <key>MobileAssetProperties</key>",
    "  <dict>",
    "    <key>__AssetDefaultGarbageCollectionBehavior</key><string>NeverCollected</string>",
    `    <key>Build</key><string>${build}</string>`,
    `    <key>SimulatorVersion</key><string>${simulatorVersion}</string>`,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export const prepareFull = { mode: "full", purpose: "prepare" } as const;

export const throwawayUdid = "00000000-0000-0000-0000-0000000000bb";

export const logsRoot = "/Logs/CoreSimulator";

/** why: the calls that make a seed from a throwaway under the `simlock` set, in order; a test starts its script with these, after the catalog read. */
type ScriptedStep = Pick<ScriptedProcessExpectation, "match" | "result">;

export function throwawaySeedSteps(
  seed: string = seedUdid,
): [
  ScriptedStep,
  ScriptedStep,
  ScriptedStep,
  ScriptedStep,
  ScriptedStep,
  ScriptedStep,
  ScriptedStep,
] {
  const name = "simlock-seed-device-1";
  return [
    {
      match: simctl("create", name, driverData.deviceTypeId, driverData.runtimeId),
      result: { code: 0, stderr: "", stdout: `${throwawayUdid}\n` },
    },
    { match: simctl("boot", throwawayUdid) },
    { match: simctl("bootstatus", throwawayUdid, "-b") },
    { match: simctl("listapps", throwawayUdid) },
    { match: simctl("shutdown", throwawayUdid) },
    {
      match: simctl("clone", throwawayUdid, name, `${deviceRoot}/sources`),
      result: { code: 0, stderr: "", stdout: `${seed}\n` },
    },
    { match: simctl("delete", throwawayUdid) },
  ];
}

/** why: `simctl clone` made the seed's folder in the sources set, which the scripted runner cannot do, and a make walks it before the seed turns ready. */
export async function plantSeedClone(
  filesystem: Filesystem,
  sourcesSet: string = `${deviceRoot}/sources`,
  udid: string = seedUdid,
): Promise<void> {
  await filesystem.mkdirp(`${sourcesSet}/${udid}`);
}
