import { join } from "node:path";

import type { DeviceSpec } from "../../core/domain.js";
import {
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type ObservedDevice,
  type ObservedMark,
  type PassthroughCommand,
  PassthroughRefusedError,
  type ReclaimResult,
  RuntimeMissingError,
  UnknownModelError,
} from "../../core/driver.js";
import {
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type LegacyDevice,
  OwnedRootError,
  validateOwnedRoot,
  type ValidateOwnedRootOptions,
} from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
  ProcessSupervisor,
  TcpProbe,
} from "../../ports/index.js";
import { AdbRegistrar } from "./adb-registrar.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";
import { isAndroidDriverData, type AndroidDriverData } from "./data.js";

export { AdbServerUnavailableError } from "./adb-server.js";

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const COLD_BOOT_ESTIMATE_MS = 31_000;
// Console ports, even ones only, each paired with the odd adb port above it. The range
// starts above the 5585 ceiling a default adb server scans, so the user's server and
// Android Studio cannot see, drive, or kill a Simlock emulator (ADR 0001, decision 4).
// It also repairs the old 5554-5682 range, which was broken at both ends: the bottom
// competed for the user's own emulators, and everything above 5585 read as free to the
// allocator below -- which derives occupancy from `adb devices` -- because no server could
// report a device up there. Simlock's server can, and not because it scans: with the
// scanner off, a transport exists for every port an emulator announced itself on or
// `#reattachRunningEmulators` swept, which is exactly this range.
const PORT_MAX = 5682;
const PORT_MIN = 5586;
const PORT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_ADB_SERVER_PORT = 5038;
// After this long without an answer from a serial, the emulator's own registration is
// assumed lost and Simlock re-sends it. Long enough that a normally-booting emulator has
// already attached, short enough that a lost announcement costs seconds, not the whole
// readiness timeout.
const REGISTRATION_RETRY_AFTER_MS = 5_000;
const SDK_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// A defense-in-depth bound on the wait that follows a SIGKILL: NodeProcessHandle#wait
// already settles shortly after `exit`, but this keeps a pathologically slow reap
// from ever turning a "we already killed it" cleanup into an unbounded await.
const SIGKILL_REAP_TIMEOUT_MS = 5_000;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;
const PROVISION_ESTIMATE_MS = 1_000;
// Measured on an M3 Pro against Pixel 8 / API 35: 2.4-5.1s over nine steady-state reclaims
// (median 4.6s), and 3.7-5.7s with three running at once. A `snapshot` reclaim loads the clean
// baseline and commits the device straight back to `ready`, so the driver call is the whole
// window the device spends `reclaiming`. Held just above the observed maximum.
const SNAPSHOT_RECLAIM_ESTIMATE_MS = 6_000;
// Measured at 22.8-42.8s on the same hardware (median 31.7s) -- an order of magnitude above the
// 3s this first guessed, for a reason worth stating precisely. `reclaim` itself really does
// only shut the emulator down and defer the wipe to the next `makeReady`; what it does not do
// is end the device's time in `reclaiming`. `WarmPoolCoordinator#disposition` re-readies a
// device the pool wants to keep warm before committing the transition, so the wipe boot and the
// baseline re-capture land inside the same window -- and that window, not the driver call, is
// what both consumers of this number measure: a waiting requester's ETA, and the state age
// `Doctor` compares against. A device the pool does not keep warm settles in seconds instead.
// The slow branch is the one to quote: pricing the fast one would make every kept-warm reclaim
// look stalled, while over-quoting only delays a finding.
const WIPE_RECLAIM_ESTIMATE_MS = 32_000;
// Lock files the emulator creates beside each AVD file it opens and removes when it exits.
// `#isAvdRunning` reads them to tell a stopped pre-root AVD from one whose disk is live.
const EMULATOR_LOCK_PATHS = [
  "hardware-qemu.ini.lock",
  "userdata-qemu.img.lock",
  "multiinstance.lock",
] as const;
const CLEAN_BASELINE = "simlock_clean_baseline";
const DURABLE_MARK_KEY = "simlock.mark";
const ERASABLE_MARK_PATH = "/data/local/tmp/simlock-mark.json";

export interface AndroidDriverOptions {
  readonly clock: Clock;
  /** This driver's own `drivers.android` block, handed over unread by the core. */
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  /** The environment every scoped invocation is layered on top of; `process.env` in production. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly hostAbi?: string;
  readonly idGenerator?: IdGenerator;
  /** Identity this driver's device root ownership marker is checked against. */
  readonly instanceId: string;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly readinessTimeoutMs?: number;
  /** `SIMLOCK_HOME`: the default device root and the adb server record are derived here, not in the core. */
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  /** `process.getuid?.()`; `undefined` skips the root's ownership check. */
  readonly uid?: number;
}

export interface AndroidDriverDiagnostic {
  readonly avdName: string;
  readonly kind: "snapshot-cold-boot";
  readonly readyAfterMs: number;
}

export class SdkMissingError extends Error {
  constructor(readonly searchedPaths: readonly string[]) {
    super(`Android SDK missing or incomplete; searched: ${searchedPaths.join(", ")}`);
    this.name = "SdkMissingError";
  }
}

interface AndroidSdkPaths {
  readonly adb: string;
  readonly avdmanager: string;
  readonly emulator: string;
  readonly root: string;
  readonly sdkmanager: string;
}

interface DeviceState {
  baselineCaptured: boolean;
  handle: ProcessHandle | undefined;
  imageIdentity: string;
  needsWipe: boolean;
  snapshotExpected: boolean;
}

interface SystemImage {
  readonly abi: string;
  readonly apiLevel: string;
  readonly path: string;
  readonly tag: string;
  readonly version: string;
}

interface DeviceProfile {
  readonly id: string;
  readonly name: string;
}

/**
 * The `simlock <tool>` wrapper this driver answers to. Published as a constant because a
 * driver that refused to start has no instance to ask, and `DriverRejection` carries the
 * name so `simlock adb` can say why it is unavailable rather than reading as a missing SDK.
 */
export const ANDROID_PASSTHROUGH_TOOL = "adb";

/** Every refusal ends the same way: the Simlock command that does it safely. */
const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

/**
 * `kill-server` would detach every leased emulator at once -- an agent's most reflexive
 * troubleshooting step. Matched anywhere in the arguments rather than in first position:
 * `adb -P 1 kill-server` is the same command with a global in front of it, and a
 * positional scan is the only rule that catches every spelling without this module having
 * to parse adb's own option grammar.
 */
const REFUSED_ADB_VERB = "kill-server";

/**
 * Console commands `simlock adb` will not proxy, matched as a run of adjacent arguments
 * anywhere in the list so that `-s <serial> emu kill` is caught along with `emu kill`.
 * Every one of them reaches through Simlock's own adb server, which is the only server
 * that can see these emulators at all -- a bare `adb` cannot, so what is refused here is
 * genuinely a capability, and it is refused because it mutates a device behind the
 * registry's back (ADR 0001, decision 7).
 */
const STOPS_A_RUNNING_DEVICE =
  "it stops a device Simlock still believes is running, which reports as drift on the next reconcile.";

const REFUSED_ADB_SEQUENCES: readonly {
  readonly sequence: readonly string[];
  readonly reason: string;
}[] = [
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "kill"] },
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "avd", "stop"] },
  {
    // Not drift, which is why it needs saying: the emulator keeps running and nothing looks
    // wrong. What is gone is the clean baseline `reclaimStrategy` restores from, so every
    // later reclaim of this device silently degrades from a snapshot load to a full wipe.
    reason:
      "it destroys the clean-boot snapshot Simlock restores from, turning every later reclaim of this device into a full wipe.",
    sequence: ["emu", "avd", "snapshot", "delete"],
  },
];

const allocationsByRunner = new WeakMap<ProcessRunner, PortAllocator>();

/** True when `sequence` appears as consecutive arguments starting anywhere in `args`. */
function containsSequence(args: readonly string[], sequence: readonly string[]): boolean {
  return args.some((_, index) => sequence.every((token, offset) => args[index + offset] === token));
}

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly #adbServer: AdbServerSupervisor;
  readonly #adbServerPort: number;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #clock: Clock;
  readonly #devices = new Map<string, DeviceState>();
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #hostAbi: string;
  readonly #idGenerator: IdGenerator;
  readonly #legacyAvdHomes: readonly string[];
  readonly #locks = new Map<string, Promise<void>>();
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #portAllocator: PortAllocator;
  readonly #processRunner: ProcessRunner;
  readonly #profiles = new Map<string, DeviceProfile>();
  readonly #readinessTimeoutMs: number;
  readonly #registrar: AdbRegistrar;
  readonly #rootOptions: ValidateOwnedRootOptions;
  readonly #sdk: AndroidSdkPaths;

  private constructor(
    options: AndroidDriverOptions,
    sdk: AndroidSdkPaths,
    deviceRoot: string,
    rootOptions: ValidateOwnedRootOptions,
    adbServer: AdbServerSupervisor,
    adbServerPort: number,
  ) {
    this.#adbServer = adbServer;
    this.#adbServerPort = adbServerPort;
    this.#baseEnv = options.env;
    this.#clock = options.clock;
    this.#deviceRoot = deviceRoot;
    this.#filesystem = options.filesystem;
    this.#hostAbi = options.hostAbi ?? hostAbiFor(process.arch);
    this.#idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.#onDiagnostic = options.onDiagnostic;
    this.#processRunner = options.processRunner;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#registrar = new AdbRegistrar({ serverPort: adbServerPort, tcp: options.tcpProbe });
    this.#rootOptions = rootOptions;
    this.#sdk = sdk;
    // Every AVD home an AVD Simlock made before it owned a root can still sit in: the one
    // configured in this daemon's environment *and* the SDK's own default. Both, because
    // `ANDROID_AVD_HOME` as it stands today says nothing about where an AVD was created
    // before roots existed -- someone who made Simlock AVDs under `~/.android/avd` and later
    // pointed the variable at their own volume would otherwise have those AVDs looked for in
    // the wrong place, reported as merely missing, and their records marked deleted, leaving
    // gigabytes with nothing left to name them (ADR 0001, Migration). The root itself is
    // never one of them: an AVD there is not pre-root, it is simply gone, and it must never
    // be answered through the unscoped path below. Read only by `listLegacy` /
    // `destroyLegacy` -- the fallback CP3 deleted from the driver proper, kept exactly here.
    this.#legacyAvdHomes = [
      ...new Set([options.env.ANDROID_AVD_HOME, join(options.homeDirectory, ".android", "avd")]),
    ].filter((home): home is string => home !== undefined && home !== "" && home !== deviceRoot);
    this.#portAllocator = portAllocatorFor(options.processRunner, sdk.adb);
  }

  /**
   * Establishes everything containment rests on before the driver can be asked to do
   * anything: the AVD home this instance owns, and the private adb server its emulators
   * are reachable through. Both fail closed -- an `OwnedRootError` or an
   * `AdbServerUnavailableError` here costs the Android platform and nothing else, because
   * the alternatives are the user's own AVD directory and the machine's shared adb server,
   * which Simlock can prove nothing about (safety rule 9).
   */
  static async create(options: AndroidDriverOptions): Promise<AndroidDriver> {
    const sdk = await discoverSdk(options);
    const adbServerPort = configuredAdbServerPort(options);
    // Resolved once and shared: the root's staging directory, the AVD names, and the
    // provenance tokens all come from the same generator, so a caller that injected one
    // controls all three rather than two of them.
    const idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "android",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    };
    const deviceRoot = await ensureOwnedRoot(rootOptions);
    const adbServer = new AdbServerSupervisor({
      adbPath: sdk.adb,
      clock: options.clock,
      env: options.env,
      filesystem: options.filesystem,
      port: adbServerPort,
      processRunner: options.processRunner,
      processSupervisor: options.processSupervisor,
      recordPath: join(options.simlockHome, "adb-server.json"),
      tcpProbe: options.tcpProbe,
    });
    await adbServer.start();

    const driver = new AndroidDriver(
      { ...options, idGenerator },
      sdk,
      deviceRoot,
      rootOptions,
      adbServer,
      adbServerPort,
    );
    await driver.#reattachRunningEmulators();
    return driver;
  }

  get sdkPath(): string {
    return this.#sdk.root;
  }

  get deviceRoot(): string {
    return this.#deviceRoot;
  }

  /**
   * The checks `create` made, minus the one thing a re-proof must never do: create. It is
   * asked for immediately before Simlock destroys anything inside this root, since between
   * then and startup the path can have become a symlink, or a `mv` can have left the user's
   * own AVD home standing where this root was -- and a root that has simply gone (an
   * `rm -rf`, an unmounted volume under a configured `deviceRoot`) refuses here rather than
   * being rebuilt empty under a device list that describes what used to be in it.
   */
  async revalidateRoot(): Promise<void> {
    await validateOwnedRoot(this.#rootOptions);
  }

  /**
   * Every AVD sitting in a pre-root AVD home, read straight off the filesystem and touched
   * in no other way. Both homes are searched (see `#legacyAvdHomes`), and what comes back is
   * candidates rather than findings: only the ones a registry record names ever reach a
   * destroy, which is what keeps this registry-only destruction (safety rule 1) and not a
   * claim over AVDs the user made themselves.
   */
  async listLegacy(): Promise<readonly LegacyDevice[]> {
    const legacy: LegacyDevice[] = [];
    for (const home of this.#legacyAvdHomes) {
      for (const avdName of await this.#listAvdNames(home)) {
        legacy.push({
          device: legacyAndroidDevice(avdName),
          path: join(home, `${avdName}.avd`),
        });
      }
    }
    return legacy;
  }

  /**
   * Deletes a pre-root AVD through the AVD home it actually lives in. Permitted despite
   * sitting outside this driver's root because the registry names it: registry-only
   * destruction (safety rule 1) is satisfied by the record, not by the root. The environment
   * points at that home and deliberately not at Simlock's adb server -- a pre-root emulator
   * answers to the user's own server, which Simlock does not own and will not drive.
   *
   * Which is why a running one is refused outright instead. Not driving the user's server
   * and deleting the AVD's files anyway is the worst of both: `avdmanager delete avd`
   * unlinks the `.ini`, the userdata images and the snapshots from under a live qemu
   * process. Refusing costs a person one `adb emu kill` and a re-run of `doctor --fix`;
   * the alternative costs them a corrupted device they cannot report. iOS shuts its
   * pre-root simulators down instead, and that asymmetry is deliberate -- there is one
   * CoreSimulator service per user and Simlock is already talking to it, so stopping a
   * simulator there uses no privilege the scoped path does not already have.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { avdName } = this.#dataFor(device);
    const home = await this.#legacyHomeOf(avdName);
    // Gone between the listing and the fix. Nothing to delete, and nothing wrong: the
    // caller's next step -- recording the device missing -- is the right one either way.
    if (home === undefined) return;

    if (await this.#isAvdRunning(join(home, `${avdName}.avd`))) {
      throw new DriverCrashError(
        `Refusing to delete the pre-root AVD ${avdName} in ${home}: an emulator still holds its files (a \`.lock\` beside them says so). Stop it with \`adb emu kill\` on the machine's own adb server -- or, if nothing is running, remove the stale locks -- then run \`simlock doctor --fix\` again.`,
      );
    }

    await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", avdName], {
      env: { ...this.#baseEnv, ANDROID_AVD_HOME: home },
    });
  }

  /** The pre-root home that holds this AVD, or `undefined` when none of them does. */
  async #legacyHomeOf(avdName: string): Promise<string | undefined> {
    for (const home of this.#legacyAvdHomes) {
      if (await this.#filesystem.exists(join(home, `${avdName}.avd`))) {
        return home;
      }
    }
    return undefined;
  }

  /**
   * True while an emulator holds the AVD's files open. The emulator locks each file it
   * opens by creating `<file>.lock` beside it and removes them when it exits, so this
   * answers the question without contacting an adb server -- the only one that could see a
   * pre-root emulator is the user's, and asking it would both start one on their behalf
   * (`adb devices` launches a server) and mean reaching for a device on a server Simlock
   * does not own. A lock left behind by a crashed emulator refuses the delete too; that is
   * the error worth making, and the refusal says what to remove.
   */
  async #isAvdRunning(avdPath: string): Promise<boolean> {
    for (const lock of EMULATOR_LOCK_PATHS) {
      if (await this.#filesystem.exists(join(avdPath, lock))) {
        return true;
      }
    }
    return false;
  }

  leaseEnvironment(): Readonly<Record<string, string>> {
    // `adb` reads this variable natively, so a lease holder needs nothing else to reach the
    // device: without it their `adb` talks to the shared server, which cannot see it.
    return { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) };
  }

  readonly passthroughTool = ANDROID_PASSTHROUGH_TOOL;

  /**
   * `adb -P <port> <args...>` against Simlock's own server, which is the only one that can
   * see a Simlock emulator at all. `ANDROID_ADB_SERVER_PORT` rides along as well so any adb
   * that re-execs itself stays on the same server; it says the same thing `-P` does, and
   * saying it twice costs nothing.
   */
  passthrough(args: readonly string[]): PassthroughCommand {
    this.#assertProxyable(args);
    return {
      args: ["-P", String(this.#adbServerPort), ...args],
      command: this.#sdk.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) },
    };
  }

  #assertProxyable(args: readonly string[]): void {
    if (args.includes(REFUSED_ADB_VERB)) {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        `Refusing \`simlock adb ${REFUSED_ADB_VERB}\`: it would detach every leased emulator at once. Use \`simlock release\` to give a device back, or \`simlock cleanup\` to reclaim idle ones.`,
      );
    }
    const refused = REFUSED_ADB_SEQUENCES.find((candidate) =>
      containsSequence(args, candidate.sequence),
    );
    if (refused !== undefined) {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        `Refusing \`simlock adb ${refused.sequence.join(" ")}\`: ${refused.reason} ${RECLAIM_INSTEAD}`,
      );
    }
  }

  /**
   * Stops the adb server this driver started. Nothing else can: `ADB_REJECT_KILL_SERVER=1`
   * makes `adb kill-server` refuse Simlock too, and the spawned child is not unref'd, so a
   * shutdown that skipped this would leave both a server and a daemon that cannot exit.
   */
  async dispose(): Promise<void> {
    await this.#adbServer.stop();
  }

  /**
   * The single insertion point for Android's scoping, the way `--set` is iOS's: every
   * `adb`, `emulator`, and `avdmanager` invocation this driver makes carries both keys, so
   * a call that slipped past here would address the user's AVD home and the shared adb
   * server. Layered over the injected environment because `ProcessRunner` replaces a
   * child's environment wholesale rather than merging into it -- a scoped env alone would
   * drop `PATH` and `ANDROID_HOME` and break every tool it scopes.
   */
  #env(): NodeJS.ProcessEnv {
    return {
      ...this.#baseEnv,
      ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort),
      ANDROID_AVD_HOME: this.#deviceRoot,
    };
  }

  /**
   * Announces every console port Simlock may have an emulator on to the server that was
   * just started or adopted -- deliberately doing, for Simlock's own range only, what adb's
   * scanner would do for everyone's.
   *
   * An emulator announces itself exactly once, at its own startup, to the server that
   * existed then. A clean `daemon stop` reaps that server, and with `ADB_EMU=0` the next one
   * has no scanner to rediscover anything -- so every emulator that survived the restart
   * (which is by design: releasing a lease hands a device to the warm pool) would be
   * invisible forever. Invisible is worse than gone: `listManaged` reports no process, so
   * `doctor` can never call it an orphan and several gigabytes of RSS leak permanently; the
   * port allocator derives occupancy from `adb devices` and hands out a console port that is
   * already in use, whose emulator then cannot bind and is quarantined for it.
   *
   * `connect_emulator` is idempotent (adb keys transports by port), a port with nothing on
   * it is a cheap failed connect, and the range is bounded and Simlock's own -- so this is
   * safe to do unconditionally, and it never touches the user's emulators below 5586. It
   * also makes the design independent of whether a running emulator re-announces itself.
   */
  async #reattachRunningEmulators(): Promise<void> {
    const ports: number[] = [];
    for (let consolePort = PORT_MIN; consolePort <= PORT_MAX; consolePort += 2) {
      ports.push(consolePort);
    }

    // `#register` swallows its own failures, so one unreachable port cannot end the sweep.
    await Promise.all(ports.map((consolePort) => this.#register(consolePort)));
  }

  /**
   * Announces an emulator to Simlock's adb server, which with the scanner off is what
   * attaches it (see `AdbRegistrar`). Always best-effort: the emulator announces itself
   * too, so a failure here is usually a duplicate of something that already worked, and
   * failing a boot over it would trade a working device for a redundant message.
   */
  async #register(consolePort: number): Promise<void> {
    try {
      await this.#registrar.register(consolePort + 1);
    } catch {
      // Nothing to do but wait for the readiness loop, which retries this itself.
    }
  }

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec> {
    if (request.platform !== this.platform) {
      throw new Error(`Android driver cannot resolve ${request.platform} requests`);
    }

    const profile = await this.#resolveProfile(request.model);
    const images = await this.#installedImages();
    const apiLevel = request.osVersion ?? newestApiLevel(images);
    if (apiLevel === undefined) {
      throw new RuntimeMissingError(this.platform, request.osVersion ?? "default");
    }

    if (this.#matchingImage(images, apiLevel) === undefined) {
      if (!options.allowDownload) {
        throw new RuntimeMissingError(this.platform, apiLevel);
      }

      const packageName = systemImagePackage(apiLevel, "google_apis", this.#hostAbi);
      await this.#runOrThrow(this.#sdk.sdkmanager, ["--install", packageName], {
        timeoutMs: SDK_DOWNLOAD_TIMEOUT_MS,
      });
    }

    this.#profiles.set(profile.name.toLocaleLowerCase(), profile);
    return { model: profile.name, osVersion: apiLevel, platform: this.platform };
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    this.#assertAndroidSpec(spec);
    const profile = await this.#profileFor(spec.model);
    const image = await this.#requireImage(spec.osVersion);
    // Cosmetic only, and worth saying so: the prefix is a label that makes an emulator
    // recognisable in `adb devices` and in its window title. Nothing reads it back as
    // evidence of anything -- ownership comes from the root this AVD is created in.
    const avdName = `simlock_${this.#idGenerator.generate()}`;
    const packageName = systemImagePackage(image.apiLevel, image.tag, image.abi);

    await this.#runOrThrow(this.#sdk.avdmanager, [
      "create",
      "avd",
      "-n",
      avdName,
      "-k",
      packageName,
      "-d",
      profile.id,
    ]);

    const configHash = await this.#configHash(avdName, image);
    const port = await this.#portAllocator.allocate(this.#env());
    const driverData: AndroidDriverData = {
      avdName,
      configHash,
      imageIdentity: `${image.path}@${image.version}`,
      port,
      serial: serialFor(port),
    };
    this.#devices.set(avdName, {
      baselineCaptured: false,
      handle: undefined,
      imageIdentity: `${image.path}@${image.version}`,
      needsWipe: false,
      snapshotExpected: false,
    });

    return { address: serialFor(port), deviceId: avdName, driverData };
  }

  /** Returns the device with its address re-read: see `Driver.makeReady` for why it is read here. */
  async makeReady(device: DriverDevice): Promise<DriverDevice> {
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);
      if (state.handle !== undefined) {
        await this.#waitForReadiness(data, this.#clock.now());
        // The device was already running (or booting) under this driver instance -- reclaim
        // never touched it, so its mark can't have gone stale. Re-mark anyway: this is the
        // single readiness transition that lets a caller re-lease an already-ready device
        // without ever seeing a moment where "ready" and "marked" disagree.
        await this.#writeMark(data);
        return { address: data.serial, deviceId: device.deviceId, driverData: data };
      }

      const baselineHash = await this.#baselineHash(data.avdName);
      if (!state.needsWipe && baselineHash !== undefined) {
        const currentHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
        if (baselineHash === currentHash) {
          state.baselineCaptured = true;
          state.snapshotExpected = true;
        } else {
          await this.#filesystem.rm(`${this.#deviceRoot}/${data.avdName}.avd/snapshots`);
          state.baselineCaptured = false;
          state.needsWipe = true;
          state.snapshotExpected = false;
        }
      }

      await this.#startEmulator(
        data,
        state,
        state.needsWipe
          ? ["-wipe-data", "-no-snapshot-load"]
          : state.snapshotExpected
            ? ["-snapshot", CLEAN_BASELINE]
            : ["-no-snapshot-load"],
        state.snapshotExpected,
      );
      state.needsWipe = false;
      state.snapshotExpected = false;
      if (!state.baselineCaptured) {
        await this.#captureBaseline(data, state);
        await this.#shutdown(data, state);
        await this.#startEmulator(data, state, ["-snapshot", CLEAN_BASELINE], true);
      }
      // Covers all three boot paths above (wipe, snapshot restore, cold boot -- including the
      // baseline-capture restart) with a single call: whichever path ran, the device is ready
      // now and must be re-marked unconditionally.
      await this.#writeMark(data);
      return { address: data.serial, deviceId: device.deviceId, driverData: data };
    });
  }

  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);

      if (options.clean === "full") {
        // No mark write here: `-wipe-data` hasn't happened yet -- it's deferred to the next
        // `makeReady` (`state.needsWipe`) -- so there is no post-erase moment on this path to
        // mark. The next `makeReady` call covers it via its unconditional tail write.
        await this.#shutdown(data, state);
        state.needsWipe = true;
        state.snapshotExpected = false;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }

      const currentHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
      const baselineHash = await this.#baselineHash(data.avdName);
      if (baselineHash !== currentHash) {
        await this.#shutdown(data, state);
        await this.#filesystem.rm(`${this.#deviceRoot}/${data.avdName}.avd/snapshots`);
        state.needsWipe = true;
        state.snapshotExpected = false;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }

      const restored = await this.#runOrThrow(this.#sdk.adb, [
        "-s",
        data.serial,
        "emu",
        "avd",
        "snapshot",
        "load",
        CLEAN_BASELINE,
      ]);
      if (!/OK|loaded|success/i.test(`${restored.stdout}\n${restored.stderr}`)) {
        await this.#shutdown(data, state);
        state.needsWipe = true;
        state.baselineCaptured = false;
        return { state: "shutdown", strategy: "wipe" };
      }
      await this.#waitForReadiness(data, this.#clock.now());
      // Snapshot restore reverts the erasable half of the mark to whatever it was at capture
      // time, and this path returns "ready" directly without going through `makeReady` --
      // skipping this write would leave the mark frozen at a stale generation forever.
      await this.#writeMark(data);
      return { state: "ready", strategy: "snapshot" };
    });
  }

  reclaimStrategy(options: { readonly clean: "standard" | "full" }): "snapshot" | "wipe" {
    return options.clean === "full" ? "wipe" : "snapshot";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      await this.#shutdown(data, this.#stateFor(data));
    });
  }

  /**
   * Stops whatever is running the AVD, then deletes it -- in that order, always.
   *
   * The address on `device` is not trusted to be there. An observed device carries none
   * (`observedAndroidDevice` reports `port: 0`, `serial: ""`, because nothing addresses a
   * device that is never granted), and `doctor --purge-orphans` destroys exactly those. On
   * that evidence alone this used to skip the shutdown and go straight to `avdmanager delete
   * avd`, unlinking the `.ini`, `config.ini`, userdata and snapshots from under a live qemu
   * process -- and the AVD then being gone from the root, the surviving emulator could never
   * be attributed to it again: invisible to Simlock forever, unreportable and unkillable,
   * the permanent leak ADR 0001 exists to eliminate. So an address that is missing is looked
   * up among the emulators actually running before anything is unlinked, and a device that
   * will not stop fails the destroy rather than losing the AVD out from under it.
   */
  async destroy(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      const running = data.port > 0 ? data : await this.#runningEmulator(data.avdName);
      if (running !== undefined) {
        await this.#shutdown(running, this.#stateFor(running));
        await this.#awaitEmulatorStopped(data.avdName, this.#clock.now());
      }
      await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", data.avdName]);
      this.#devices.delete(data.avdName);
      this.#portAllocator.release(running?.port ?? data.port);
    });
  }

  /**
   * The live console address of an AVD in this root, or `undefined` when nothing is running
   * it. Membership in the root is checked first and the attribution is the same one
   * `listManaged` makes: ownership is proven from where the AVD lives, never from which
   * emulator happens to answer to a name (safety rule 8).
   */
  async #runningEmulator(avdName: string): Promise<AndroidDriverData | undefined> {
    const avdNamesInRoot = new Set(await this.#listAvdNames());
    if (!avdNamesInRoot.has(avdName)) {
      return undefined;
    }
    const { settledSerials } = await this.#scanAdbSerials();
    const { processes } = await this.#resolveRunningAvds(settledSerials, avdNamesInRoot);
    const running = processes.find((candidate) => candidate.deviceId === avdName);
    return running === undefined ? undefined : this.#dataFor(running);
  }

  /**
   * Waits for a stopped emulator's transport to disappear. `emu kill` returns when the
   * emulator acknowledges it, not when the process is gone, and an emulator this driver
   * never spawned leaves no `ProcessHandle` to wait on -- so the transport going away is the
   * only evidence available that the AVD's files have been released. Timing out throws:
   * leaving an orphan reported is recoverable, deleting its disk while it runs is not.
   */
  async #awaitEmulatorStopped(avdName: string, startedAt: number): Promise<void> {
    while ((await this.#runningEmulator(avdName)) !== undefined) {
      if (this.#clock.now() - startedAt >= this.#readinessTimeoutMs) {
        throw new DriverCrashError(
          `Android emulator for ${avdName} is still attached after emu kill; refusing to delete an AVD a process is running against`,
        );
      }
      await this.#delay(PORT_POLL_INTERVAL_MS);
    }
  }

  async listManaged(): Promise<DriverReality> {
    const avdNames = await this.#listAvdNames();
    const { settledSerials, unattributableTransitionalSerial } = await this.#scanAdbSerials();
    const { processes, runningByAvdName, erasableMarkByAvdName, unreadableSerial } =
      await this.#resolveRunningAvds(settledSerials, new Set(avdNames));
    const unattributable = unattributableTransitionalSerial || unreadableSerial;

    const devices: ObservedDevice[] = await Promise.all(
      avdNames.map((avdName) =>
        this.#observedDevice(avdName, runningByAvdName, unattributable, erasableMarkByAvdName),
      ),
    );

    return { devices, processes };
  }

  async #observedDevice(
    avdName: string,
    runningByAvdName: ReadonlySet<string>,
    unattributableTransitionalSerial: boolean,
    erasableMarkByAvdName: ReadonlyMap<string, string | undefined>,
  ): Promise<ObservedDevice> {
    const base = observedAndroidDevice(avdName, runningByAvdName, unattributableTransitionalSerial);
    const running = runningByAvdName.has(avdName);
    const durable = await this.#readDurableMark(avdName);
    const mark = buildObservedMark(durable, running, erasableMarkByAvdName.get(avdName));
    return mark === undefined ? base : { ...base, mark };
  }

  /**
   * Every AVD in a directory, whatever it is called. The name is a cosmetic label with no
   * authority: what makes these AVDs Simlock's is that they sit inside a root Simlock
   * created empty and marked, which nothing else can put an AVD into (safety rule 8) --
   * which is also why `listLegacy`, the one caller that passes a directory that is *not*
   * the root, produces candidates for the registry to confirm rather than owned devices.
   */
  async #listAvdNames(directory: string = this.#deviceRoot): Promise<string[]> {
    const avdNames: string[] = [];
    if (await this.#filesystem.exists(directory)) {
      for (const entry of await this.#filesystem.readdir(directory)) {
        const match = /^(.+)\.avd$/.exec(entry);
        if (match?.[1] === undefined) continue;
        avdNames.push(match[1]);
      }
    }
    return avdNames;
  }

  /**
   * Serials attached in a settled `device` state can answer `getprop`, so they can be
   * attributed to an AVD by name. A serial in any other adb state (offline, unauthorized,
   * booting, ...) cannot answer `getprop` yet, so it cannot be attributed to an AVD name --
   * `unattributableTransitionalSerial` records that this tick saw at least one such serial.
   */
  async #scanAdbSerials(): Promise<{
    readonly settledSerials: readonly string[];
    readonly unattributableTransitionalSerial: boolean;
  }> {
    const attached = await this.#runOrThrow(this.#sdk.adb, ["devices"]);
    const settledSerials: string[] = [];
    let unattributableTransitionalSerial = false;
    for (const match of attached.stdout.matchAll(/^((?:emulator)-\d+)\s+(\S+)$/gm)) {
      const candidate = match[1];
      const state = match[2];
      if (candidate === undefined || state === undefined) continue;
      if (state === "device") {
        settledSerials.push(candidate);
      } else {
        unattributableTransitionalSerial = true;
      }
    }
    return { settledSerials, unattributableTransitionalSerial };
  }

  /**
   * Reads the running AVD's name and its erasable mark in a single `adb shell` round trip
   * per serial -- the mark read is folded into the `getprop` call that this method already
   * makes, so it costs nothing extra.
   */
  async #resolveRunningAvds(
    settledSerials: readonly string[],
    avdNamesInRoot: ReadonlySet<string>,
  ): Promise<{
    readonly erasableMarkByAvdName: ReadonlyMap<string, string | undefined>;
    readonly processes: readonly DriverDevice[];
    readonly runningByAvdName: ReadonlySet<string>;
    readonly unreadableSerial: boolean;
  }> {
    const processes: DriverDevice[] = [];
    const runningByAvdName = new Set<string>();
    const erasableMarkByAvdName = new Map<string, string | undefined>();
    let unreadableSerial = false;
    for (const candidate of settledSerials) {
      // `adb shell` reports the exit status of the last command it ran, so a missing
      // mark file would fail the whole invocation -- and a missing mark file is exactly
      // the foreign-erase case this feature exists to detect. `|| true` keeps an absent
      // mark an observation rather than a crash.
      const output = await this.#adbShellOrUndefined([
        "-s",
        candidate,
        "shell",
        `getprop ro.boot.qemu.avd_name; cat ${ERASABLE_MARK_PATH} 2>/dev/null || true`,
      ]);
      // An emulator can die between `adb devices` and this call. Losing the whole
      // reality view over one dead serial would strand every other device, so treat it
      // like a transitional serial: unattributable this tick, nothing concluded.
      if (output === undefined) {
        unreadableSerial = true;
        continue;
      }
      const [nameLine = "", ...markLines] = output.stdout.split(/\r?\n/);
      const avdName = nameLine.trim();
      // Root membership, never the name and never "our server can see it". `ADB_EMU=0`
      // should mean this server only holds transports Simlock registered itself, but a
      // device is Simlock's because of where its AVD lives -- ownership is proven, not
      // inferred from who happens to be looking at it (safety rule 8).
      if (!avdNamesInRoot.has(avdName)) continue;
      runningByAvdName.add(avdName);
      erasableMarkByAvdName.set(avdName, parseErasableMark(markLines.join("\n")));
      const port = Number(candidate.slice("emulator-".length));
      processes.push({
        address: candidate,
        deviceId: avdName,
        driverData: {
          avdName,
          configHash: "recovered",
          imageIdentity: "",
          port,
          serial: candidate,
        } satisfies AndroidDriverData,
      });
    }
    return { erasableMarkByAvdName, processes, runningByAvdName, unreadableSerial };
  }

  /** Undefined when the serial could not be reached at all, as opposed to answering. */
  async #adbShellOrUndefined(args: readonly string[]): Promise<ProcessResult | undefined> {
    try {
      return await this.#runOrThrow(this.#sdk.adb, args);
    } catch {
      return undefined;
    }
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const [profiles, images] = await Promise.all([
      this.#listDeviceProfiles(),
      this.#installedImages(),
    ]);
    return {
      defaultRuntime: newestApiLevel(images),
      models: profiles.map((profile) => profile.name),
      runtimes: [...new Set(images.map((image) => image.apiLevel))].sort(compareApiLevels),
    };
  }

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `standard` is priced as the snapshot restore it selects. It can still fall back to
        // the wipe branch when the baseline no longer matches the AVD config, which runs some
        // five times longer; that is the exception rather than the case to quote, and `Doctor`
        // covers it by taking the slower clean level instead of this averaging the two.
        return this.reclaimStrategy({ clean: estimate.clean }) === "wipe"
          ? WIPE_RECLAIM_ESTIMATE_MS
          : SNAPSHOT_RECLAIM_ESTIMATE_MS;
    }
  }

  async #profileFor(model: string): Promise<DeviceProfile> {
    return this.#profiles.get(model.toLocaleLowerCase()) ?? this.#resolveProfile(model);
  }

  async #listDeviceProfiles(): Promise<readonly DeviceProfile[]> {
    const result = await this.#runOrThrow(this.#sdk.avdmanager, ["list", "device"]);
    return parseDeviceProfiles(result.stdout);
  }

  async #resolveProfile(model: string): Promise<DeviceProfile> {
    const profiles = await this.#listDeviceProfiles();
    const normalized = model.toLocaleLowerCase();
    const profile = profiles.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === normalized ||
        candidate.id.toLocaleLowerCase() === normalized,
    );
    if (profile === undefined) {
      throw new UnknownModelError(this.platform, model);
    }
    return profile;
  }

  async #installedImages(): Promise<SystemImage[]> {
    const root = `${this.#sdk.root}/system-images`;
    if (!(await this.#filesystem.exists(root))) {
      return [];
    }

    const images: SystemImage[] = [];
    for (const apiDirectory of await this.#filesystem.readdir(root)) {
      const apiMatch = /^android-(.+)$/.exec(apiDirectory);
      if (apiMatch?.[1] === undefined) {
        continue;
      }
      const apiPath = `${root}/${apiDirectory}`;
      for (const tag of await this.#filesystem.readdir(apiPath)) {
        const tagPath = `${apiPath}/${tag}`;
        for (const abi of await this.#filesystem.readdir(tagPath)) {
          const path = `${tagPath}/${abi}`;
          images.push({
            abi,
            apiLevel: apiMatch[1],
            path,
            tag,
            version: await systemImageVersion(this.#filesystem, path),
          });
        }
      }
    }
    return images;
  }

  #matchingImage(images: readonly SystemImage[], apiLevel: string): SystemImage | undefined {
    const matching = images.filter((image) => image.apiLevel === apiLevel);
    return (
      matching.find((image) => image.tag === "google_apis" && image.abi === this.#hostAbi) ??
      matching.find((image) => image.abi === this.#hostAbi) ??
      matching.find((image) => image.tag === "google_apis") ??
      matching[0]
    );
  }

  async #requireImage(apiLevel: string): Promise<SystemImage> {
    const image = this.#matchingImage(await this.#installedImages(), apiLevel);
    if (image === undefined) {
      throw new RuntimeMissingError(this.platform, apiLevel);
    }
    return image;
  }

  async #configHash(avdName: string, image: SystemImage): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      this.#emulatorVersion(),
      this.#avdConfig(avdName),
    ]);
    return stableHash([`${image.path}@${image.version}`, emulatorVersion, config]);
  }

  async #currentConfigHash(avdName: string, imageIdentity: string): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      this.#emulatorVersion(),
      this.#avdConfig(avdName),
    ]);
    return stableHash([imageIdentity, emulatorVersion, config]);
  }

  async #emulatorVersion(): Promise<string> {
    const result = await this.#runOrThrow(this.#sdk.emulator, ["-version"]);
    return result.stdout.trim();
  }

  async #avdConfig(avdName: string): Promise<string> {
    try {
      const contents = await this.#filesystem.readFile(this.#configIniPath(avdName));
      return contents
        .split(/\r?\n/)
        .filter((line) => /^(image\.sysdir\.1|hw\.|disk\.dataPartition\.)/.test(line))
        .sort()
        .join("\n");
    } catch {
      return "";
    }
  }

  #configIniPath(avdName: string): string {
    return `${this.#deviceRoot}/${avdName}.avd/config.ini`;
  }

  /**
   * Writes the same provenance token into both regions of the mark: the durable
   * `simlock.mark` key in `config.ini` (host-side, survives an erase) and the erasable
   * `/data/local/tmp/simlock-mark.json` file on the device (destroyed by an erase). Must be
   * called after every readiness transition -- see the call sites in `makeReady` and
   * `reclaim` for why "the tail of `makeReady`" alone is not sufficient.
   */
  async #writeMark(data: AndroidDriverData): Promise<void> {
    const token = this.#idGenerator.generate();
    await Promise.all([
      this.#writeDurableMark(data.avdName, token),
      this.#writeErasableMark(data.serial, token),
    ]);
  }

  async #writeDurableMark(avdName: string, token: string): Promise<void> {
    const path = this.#configIniPath(avdName);
    let contents: string;
    try {
      contents = await this.#filesystem.readFile(path);
    } catch {
      contents = "";
    }
    const lines = contents === "" ? [] : contents.replace(/\r?\n$/, "").split(/\r?\n/);
    const markLine = `${DURABLE_MARK_KEY}=${token}`;
    const existingIndex = lines.findIndex((line) => line.startsWith(`${DURABLE_MARK_KEY}=`));
    if (existingIndex >= 0) {
      lines[existingIndex] = markLine;
    } else {
      lines.push(markLine);
    }
    await this.#filesystem.writeFileAtomic(path, `${lines.join("\n")}\n`);
  }

  async #writeErasableMark(serial: string, token: string): Promise<void> {
    const payload = JSON.stringify({ token });
    await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      serial,
      "shell",
      `echo '${payload}' > ${ERASABLE_MARK_PATH}`,
    ]);
  }

  async #readDurableMark(avdName: string): Promise<string | undefined> {
    try {
      const contents = await this.#filesystem.readFile(this.#configIniPath(avdName));
      const line = contents
        .split(/\r?\n/)
        .find((entry) => entry.startsWith(`${DURABLE_MARK_KEY}=`));
      const value = line?.slice(`${DURABLE_MARK_KEY}=`.length).trim();
      return value === undefined || value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }

  async #waitForReadiness(data: AndroidDriverData, startedAt: number): Promise<void> {
    while (true) {
      if (this.#clock.now() - startedAt >= this.#readinessTimeoutMs) {
        throw new BootTimeoutError(data.avdName);
      }

      const completed = await this.#processRunner.run(
        this.#sdk.adb,
        ["-s", data.serial, "shell", "getprop", "sys.boot_completed"],
        { env: this.#env() },
      );
      if (completed.code !== 0) {
        // A serial that will not answer is a serial the server has no transport for, which
        // is the same evidence "absent from `adb devices`" would give and costs no extra
        // round trip. Past the grace period, assume the emulator's own announcement was
        // lost -- with the scanner off nothing else will ever re-send it -- and re-announce.
        if (this.#clock.now() - startedAt >= REGISTRATION_RETRY_AFTER_MS) {
          await this.#register(data.port);
        }
        await this.#delay(
          Math.min(
            PORT_POLL_INTERVAL_MS,
            this.#readinessTimeoutMs - (this.#clock.now() - startedAt),
          ),
        );
        continue;
      }
      if (completed.stdout.trim() === "1") {
        const bootAnimation = await this.#runOrThrow(this.#sdk.adb, [
          "-s",
          data.serial,
          "shell",
          "getprop",
          "init.svc.bootanim",
        ]);
        if (bootAnimation.stdout.trim() === "" || bootAnimation.stdout.trim() === "stopped") {
          return;
        }
      }

      await this.#delay(
        Math.min(PORT_POLL_INTERVAL_MS, this.#readinessTimeoutMs - (this.#clock.now() - startedAt)),
      );
    }
  }

  async #startEmulator(
    data: AndroidDriverData,
    state: DeviceState,
    launchArgs: readonly string[],
    fromSnapshot: boolean,
  ): Promise<void> {
    const startedAt = this.#clock.now();
    const handle = this.#processRunner.spawn(
      this.#sdk.emulator,
      ["-avd", data.avdName, "-port", String(data.port), "-no-snapshot-save", ...launchArgs],
      { env: this.#env() },
    );
    state.handle = handle;
    // No announcement here, deliberately. adb answers `host:emulator:<port>` by connecting
    // *out* to that port, and the emulator has not opened it yet a millisecond after the
    // spawn -- so a call here could only ever fail, and with the scanner off nothing drains
    // adb's retry queue afterwards. The announcement that can land is the one in
    // `#waitForReadiness`, once the serial has stayed silent past the grace period.

    try {
      await this.#waitForReadiness(data, startedAt);
    } catch (error: unknown) {
      handle.kill("SIGKILL");
      await this.#waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
      state.handle = undefined;
      throw error;
    }

    const readyAfterMs = this.#clock.now() - startedAt;
    if (fromSnapshot && readyAfterMs > SNAPSHOT_BOOT_ESTIMATE_MS * 3) {
      this.#onDiagnostic?.({ avdName: data.avdName, kind: "snapshot-cold-boot", readyAfterMs });
    }
  }

  async #captureBaseline(data: AndroidDriverData, state: DeviceState): Promise<void> {
    await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      data.serial,
      "emu",
      "avd",
      "snapshot",
      "save",
      CLEAN_BASELINE,
    ]);
    const snapshots = await this.#runOrThrow(this.#sdk.adb, [
      "-s",
      data.serial,
      "emu",
      "avd",
      "snapshot",
      "list",
    ]);
    if (!snapshots.stdout.includes(CLEAN_BASELINE)) {
      throw new DriverCrashError(`Android clean baseline ${CLEAN_BASELINE} was not validated`);
    }
    const configHash = await this.#currentConfigHash(data.avdName, state.imageIdentity);
    await this.#filesystem.writeFileAtomic(
      this.#baselineMetadataPath(data.avdName),
      JSON.stringify({ configHash, snapshot: CLEAN_BASELINE }),
    );
    state.baselineCaptured = true;
  }

  async #baselineHash(avdName: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(
        await this.#filesystem.readFile(this.#baselineMetadataPath(avdName)),
      ) as {
        readonly configHash?: unknown;
        readonly snapshot?: unknown;
      };
      return value.snapshot === CLEAN_BASELINE && typeof value.configHash === "string"
        ? value.configHash
        : undefined;
    } catch {
      return undefined;
    }
  }

  #baselineMetadataPath(avdName: string): string {
    return `${this.#deviceRoot}/${avdName}.avd/simlock-clean-baseline.json`;
  }

  async #shutdown(data: AndroidDriverData, state: DeviceState): Promise<void> {
    await this.#processRunner.run(this.#sdk.adb, ["-s", data.serial, "emu", "kill"], {
      env: this.#env(),
    });
    const handle = state.handle;
    if (handle === undefined) {
      return;
    }

    const exited = await this.#waitForExit(handle, this.#readinessTimeoutMs);
    if (!exited) {
      handle.kill("SIGKILL");
      await this.#waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
    }
    state.handle = undefined;
  }

  async #waitForExit(handle: ProcessHandle, timeoutMs: number): Promise<boolean> {
    let timerFired = false;
    const timer = this.#clock.setTimer(timeoutMs, () => {
      timerFired = true;
    });
    const result = await Promise.race([
      handle.wait().then(() => true),
      new Promise<boolean>((resolve) => {
        this.#clock.setTimer(timeoutMs, () => resolve(false));
      }),
    ]);
    this.#clock.cancel(timer);
    return timerFired ? false : result;
  }

  async #runOrThrow(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
  ) {
    // The scoped environment unless a caller supplies its own, which only the two legacy
    // methods do -- pointing a command at a root this driver does not own is the whole of
    // what they are for, and nothing else here may.
    const result = await this.#processRunner.run(command, args, {
      ...options,
      env: options.env ?? this.#env(),
    });
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  #dataFor(device: DriverDevice): AndroidDriverData {
    if (!isAndroidDriverData(device.driverData)) {
      throw new Error(`Android device ${device.deviceId} has invalid driver data`);
    }
    if (device.deviceId !== device.driverData.avdName) {
      throw new Error(
        `Android device id ${device.deviceId} does not match AVD ${device.driverData.avdName}`,
      );
    }
    return device.driverData;
  }

  #stateFor(data: AndroidDriverData): DeviceState {
    const existing = this.#devices.get(data.avdName);
    if (existing !== undefined) {
      return existing;
    }
    const restored: DeviceState = {
      baselineCaptured: false,
      handle: undefined,
      imageIdentity: data.imageIdentity ?? "",
      needsWipe: false,
      snapshotExpected: false,
    };
    this.#devices.set(data.avdName, restored);
    return restored;
  }

  #assertAndroidSpec(spec: DeviceSpec): void {
    if (spec.platform !== this.platform) {
      throw new Error(`Android driver cannot provision ${spec.platform} devices`);
    }
  }

  async #withDeviceLock<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(deviceId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(deviceId) === queued) {
        this.#locks.delete(deviceId);
      }
    }
  }

  #delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.#clock.setTimer(milliseconds, resolve);
    });
  }
}

class PortAllocator {
  readonly #reserved = new Set<number>();
  #lock = Promise.resolve();

  constructor(
    private readonly adb: string,
    private readonly processRunner: ProcessRunner,
  ) {}

  /**
   * The scoped environment is passed per call rather than held, because one allocator is
   * shared by every driver on a runner (see `portAllocatorFor`) while the environment
   * belongs to one driver instance -- a stored one would go stale the moment a second
   * driver appeared and would silently poll the wrong adb server.
   */
  async allocate(env: NodeJS.ProcessEnv): Promise<number> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await this.processRunner.run(this.adb, ["devices"], { env });
      if (result.code !== 0) {
        throw new DriverCrashError(`adb devices failed: ${result.stderr || result.stdout}`);
      }
      const unavailable = new Set([...this.#reserved, ...portsFromAdbDevices(result.stdout)]);
      for (let port = PORT_MIN; port <= PORT_MAX; port += 2) {
        if (!unavailable.has(port)) {
          this.#reserved.add(port);
          return port;
        }
      }
      throw new DriverCrashError("No Android emulator console ports are available");
    } finally {
      release();
    }
  }

  release(port: number): void {
    this.#reserved.delete(port);
  }
}

class SequentialIdGenerator implements IdGenerator {
  #next = 1;

  generate(): string {
    const value = this.#next;
    this.#next += 1;
    return String(value);
  }
}

/**
 * A `deviceRoot` that is not a usable path refuses this platform's *configuration*, which
 * costs Android and nothing else -- not the daemon. `"deviceRoot": true` and
 * `"deviceRoot": "devices/android"` are one keystroke apart, and killing the process over
 * the first would take iOS down with it and leave the reason unreachable, since `doctor`
 * needs a daemon to answer. `not-absolute` is the published vocabulary term for "this
 * names no usable directory"; nothing new is invented here.
 */
function configuredDeviceRoot(options: AndroidDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    throw new OwnedRootError(
      `Refusing the android device root: drivers.android.deviceRoot must be an absolute path, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "not-absolute",
      String(configured),
      "android",
    );
  }

  return configured ?? join(options.simlockHome, "devices", "android");
}

/**
 * The port is only read here; whether it can actually carry a server is the supervisor's
 * decision, so range and reserved-port checks are not duplicated. A value that is not a
 * number at all cannot reach that check as itself, and the event payload has nowhere to
 * put it -- hence the `0` stand-in, with the configured value named in the message.
 */
function configuredAdbServerPort(options: AndroidDriverOptions): number {
  const configured = options.driverConfig["adbServerPort"];

  if (configured !== undefined && typeof configured !== "number") {
    throw new AdbServerUnavailableError(
      `Refusing to run the android driver: drivers.android.adbServerPort must be a TCP port number, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "invalid-port",
      0,
    );
  }

  return configured ?? DEFAULT_ADB_SERVER_PORT;
}

async function discoverSdk(options: AndroidDriverOptions): Promise<AndroidSdkPaths> {
  const roots = [
    options.env.ANDROID_HOME,
    options.env.ANDROID_SDK_ROOT,
    `${options.homeDirectory}/Library/Android/sdk`,
  ].filter((root): root is string => root !== undefined && root !== "");
  const searchedPaths: string[] = [];

  for (const root of roots) {
    const paths = await sdkPathsAt(root, options.filesystem);
    searchedPaths.push(root);
    if (paths !== undefined) {
      return paths;
    }
  }
  throw new SdkMissingError(searchedPaths);
}

async function sdkPathsAt(
  root: string,
  filesystem: Filesystem,
): Promise<AndroidSdkPaths | undefined> {
  const commandLineTools = await commandLineToolBins(root, filesystem);
  const legacyTools = `${root}/tools/bin`;
  const toolBins = [...commandLineTools, legacyTools];
  const tools = await firstCompleteToolBin(filesystem, toolBins);
  const emulator = `${root}/emulator/emulator`;
  const adb = `${root}/platform-tools/adb`;
  if (
    tools === undefined ||
    !(await filesystem.exists(emulator)) ||
    !(await filesystem.exists(adb))
  ) {
    return undefined;
  }
  return { adb, emulator, root, ...tools };
}

async function commandLineToolBins(root: string, filesystem: Filesystem): Promise<string[]> {
  const toolsRoot = `${root}/cmdline-tools`;
  if (!(await filesystem.exists(toolsRoot))) {
    return [];
  }

  const directories = await filesystem.readdir(toolsRoot);
  return directories
    .sort(compareCommandLineToolVersions)
    .reverse()
    .map((directory) => `${toolsRoot}/${directory}/bin`);
}

async function firstCompleteToolBin(
  filesystem: Filesystem,
  bins: readonly string[],
): Promise<Pick<AndroidSdkPaths, "avdmanager" | "sdkmanager"> | undefined> {
  for (const bin of bins) {
    const avdmanager = `${bin}/avdmanager`;
    const sdkmanager = `${bin}/sdkmanager`;
    if ((await filesystem.exists(avdmanager)) && (await filesystem.exists(sdkmanager))) {
      return { avdmanager, sdkmanager };
    }
  }
  return undefined;
}

function compareCommandLineToolVersions(left: string, right: string): number {
  if (left === "latest") {
    return 1;
  }
  if (right === "latest") {
    return -1;
  }

  const leftSegments = left.split(".").map(Number);
  const rightSegments = right.split(".").map(Number);
  if (leftSegments.every(Number.isFinite) && rightSegments.every(Number.isFinite)) {
    const length = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftSegments[index] ?? 0) - (rightSegments[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
  }

  return left.localeCompare(right);
}

function parseDeviceProfiles(output: string): DeviceProfile[] {
  const profiles: DeviceProfile[] = [];
  let id: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"/.exec(line.trim());
    if (idMatch?.[1] !== undefined) {
      id = idMatch[1];
      continue;
    }
    const nameMatch = /^Name:\s*(.+)$/.exec(line.trim());
    if (id !== undefined && nameMatch?.[1] !== undefined) {
      profiles.push({ id, name: nameMatch[1] });
      id = undefined;
    }
  }
  return profiles;
}

function newestApiLevel(images: readonly SystemImage[]): string | undefined {
  return [...new Set(images.map((image) => image.apiLevel))].sort(compareApiLevels).at(-1);
}

function compareApiLevels(left: string, right: string): number {
  const numericDifference = Number(left) - Number(right);
  return Number.isNaN(numericDifference) || numericDifference === 0
    ? left.localeCompare(right)
    : numericDifference;
}

function systemImagePackage(apiLevel: string, tag: string, abi: string): string {
  return `system-images;android-${apiLevel};${tag};${abi}`;
}

async function systemImageVersion(filesystem: Filesystem, imagePath: string): Promise<string> {
  try {
    const properties = await filesystem.readFile(`${imagePath}/source.properties`);
    return (
      properties
        .split(/\r?\n/)
        .find((line) => line.startsWith("Pkg.Revision="))
        ?.slice("Pkg.Revision=".length)
        .trim() ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

function serialFor(port: number): string {
  return `emulator-${port}`;
}

/**
 * A pre-root AVD as a `DriverDevice`: named, and carrying no console port and no serial. It
 * is not on Simlock's adb server, and finding it on the user's is not this driver's business
 * -- which is why `destroyLegacy` refuses a running one rather than reaching for it.
 */
function legacyAndroidDevice(avdName: string): DriverDevice {
  return {
    address: avdName,
    deviceId: avdName,
    driverData: {
      avdName,
      configHash: "",
      port: 0,
      serial: "",
    } satisfies AndroidDriverData,
  };
}

function observedAndroidDevice(
  avdName: string,
  runningByAvdName: ReadonlySet<string>,
  unattributableTransitionalSerial: boolean,
): ObservedDevice {
  return {
    // Reconnaissance only: an observed device is never granted, so it carries no usable
    // address. Anything that acts on one has to resolve the address itself -- see `destroy`,
    // which is handed exactly these by `doctor --purge-orphans`.
    address: "",
    deviceId: avdName,
    driverData: {
      avdName,
      configHash: "recovered",
      imageIdentity: "",
      port: 0,
      serial: "",
    } satisfies AndroidDriverData,
    // Conservative: an emulator serial we can't attribute (transitional adb state) might
    // belong to any AVD that otherwise looks stopped, so treat all of them as transitioning
    // for this tick rather than risk a false-positive foreign-state-change finding.
    runState: runningByAvdName.has(avdName)
      ? "running"
      : unattributableTransitionalSerial
        ? "transitioning"
        : "stopped",
  };
}

/**
 * `undefined` (no `mark` at all) only when the durable key is absent *and* the device isn't
 * running: that is the upgrade path for an AVD provisioned before marks existed, where the
 * erasable half is also unreadable and can't corroborate either way. Reporting a half-empty
 * mark there would read as tampering (`durable-mark-missing`) on every tick forever. Once the
 * device is running with neither half present, a mark object is the correct, honest reading.
 */
function buildObservedMark(
  durable: string | undefined,
  running: boolean,
  erasable: string | undefined,
): ObservedMark | undefined {
  if (durable === undefined && !running) {
    return undefined;
  }
  return { durable, erasable: running ? erasable : undefined, erasableReadable: running };
}

function parseErasableMark(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { readonly token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function portsFromAdbDevices(output: string): number[] {
  return [...output.matchAll(/^emulator-(\d+)\s+/gm)]
    .map((match) => Number(match[1]))
    .filter((port) => Number.isInteger(port));
}

function stableHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join("\u0000")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hostAbiFor(architecture: string): string {
  return architecture === "arm64" ? "arm64-v8a" : "x86_64";
}

function portAllocatorFor(processRunner: ProcessRunner, adb: string): PortAllocator {
  const existing = allocationsByRunner.get(processRunner);
  if (existing !== undefined) {
    return existing;
  }
  const allocator = new PortAllocator(adb, processRunner);
  allocationsByRunner.set(processRunner, allocator);
  return allocator;
}
