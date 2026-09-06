import { join } from "node:path";

import type { DeviceSpec } from "../../core/domain.js";
import {
  BootTimeoutError,
  type DeviceRequest,
  DiskSpaceGuard,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  LicenseNotAcceptedError,
  type ObservedDevice,
  type ObservedMark,
  type PassthroughCommand,
  PassthroughRefusedError,
  type PassthroughContext,
  type ReclaimResult,
  RuntimeMissingError,
} from "../../core/driver.js";
import {
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type LegacyDevice,
  OwnedRootError,
} from "../../core/index.js";
import { stableError } from "../../core/stable-error.js";
import type { ComponentInstallDiagnostic } from "../diagnostics.js";
import {
  isMissingPathError,
  type Clock,
  type Filesystem,
  type IdGenerator,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
} from "../../ports/index.js";
import { AdbRegistrar } from "./adb-registrar.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";
import { isAndroidDriverData, type AndroidDriverData } from "./data.js";
import {
  BuiltinDeviceProfileSource,
  DeviceProfileRegistry,
  parseAvdmanagerDeviceProfiles,
  UserDeviceProfileSource,
  type DeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
  type ResolvedDeviceProfile,
} from "./device-profile-source.js";

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
// Mirrors `downloads.timeoutMs`'s config default (`src/core/config.ts`) -- used only when a
// caller constructs the driver directly without threading the configured value through (tests,
// `SIMLOCK_DRIVERS_MODULE`). See the iOS driver's `DEFAULT_DOWNLOAD_TIMEOUT_MS` for the same
// pattern.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// `sdkmanager --licenses` prompts once per outstanding license with a bare `y/N`. Answering
// more times than there are real licenses is harmless -- the extra `y`s land after the prompt
// loop has already exited and sdkmanager simply never reads them -- so this just needs to be
// comfortably above the largest real Android SDK license count rather than exact.
const LICENSE_ACCEPT_ANSWERS = 100;
// A defense-in-depth bound on the wait that follows a SIGKILL: NodeProcessHandle#wait
// already settles shortly after `exit`, but this keeps a pathologically slow reap
// from ever turning a "we already killed it" cleanup into an unbounded await.
const SIGKILL_REAP_TIMEOUT_MS = 5_000;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;
// Conservative estimate for a system-image download+install -- checked before `sdkmanager
// --install` ever starts, so a full disk fails fast instead of filling up mid-download.
const ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES = 2 * 1024 ** 3;
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
const CLEAN_BASELINE = "simlock_clean_baseline";
const DURABLE_MARK_KEY = "simlock.mark";
const ERASABLE_MARK_PATH = "/data/local/tmp/simlock-mark.json";

export interface AndroidDriverOptions {
  /**
   * Explicit legal consent for Android SDK licenses (`downloads.acceptAndroidLicenses`),
   * independent of the per-request download permission. Defaults to `false`: an install that
   * fails on an unaccepted license fails outright rather than accepting it silently.
   */
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  /** This driver's own `drivers.android` block, handed over unread by the core. */
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  /** The environment every scoped invocation is layered on top of; `process.env` in production. */
  /**
   * Ordered device-profile sources, first match wins (see `DeviceProfileRegistry`). Defaults
   * to `[builtin, user]` -- `avdmanager list device` first, then a read-only parse of
   * `~/.android/devices.xml`, so a name defined in both resolves to the built-in.
   */
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  /**
   * Disk-space preflight, shared with every other driver that installs components -- see the
   * iOS driver's `IosSimctlDriverOptions.diskSpaceGuard` for why a bare `assertDiskSpace` call
   * isn't enough on its own. Defaults to a private, driver-local guard when omitted (tests,
   * `SIMLOCK_DRIVERS_MODULE`); production wiring (`src/daemon/main.ts`) passes one shared
   * instance to every driver.
   */
  readonly diskSpaceGuard?: DiskSpaceGuard;
  /** Per-install timeout for `sdkmanager`; defaults to `downloads.timeoutMs`'s own default. */
  readonly downloadTimeoutMs?: number;
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

export type AndroidDriverDiagnostic =
  | { readonly avdName: string; readonly kind: "snapshot-cold-boot"; readonly readyAfterMs: number }
  | DeviceProfileSourceDiagnostic
  | ComponentInstallDiagnostic;

export class SdkMissingError extends Error {
  constructor(readonly searchedPaths: readonly string[]) {
    super(`Android SDK missing or incomplete; searched: ${searchedPaths.join(", ")}`);
    this.name = "SdkMissingError";
  }
}

export class AndroidLicenseNotAcceptedError extends LicenseNotAcceptedError {
  constructor(readonly packageName: string) {
    super("android", packageName);
    this.message =
      `sdkmanager refused to install ${packageName}: an Android SDK license is not accepted. ` +
      `Set "downloads.acceptAndroidLicenses": true in config to accept automatically, or run ` +
      `\`sdkmanager --licenses\` manually.`;
    this.name = "AndroidLicenseNotAcceptedError";
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

/**
 * adb globals `simlock adb` passes a caller's command through unchanged. This is an
 * **allow list**, not a blocklist of the flags known to point `adb` at a different server
 * than the one Simlock owns (`-P`/`-H`/`-L`/`--server-port`, which adb takes the **last** of
 * on the line, so a caller-supplied one would silently win over the one this driver inserts
 * and land the command on the machine's default server, outside containment entirely --
 * safety rule 9, the same hole the iOS driver closes by refusing a caller-supplied
 * `--set`/`--profiles`).
 *
 * A blocklist only refuses what someone already thought to name, and adb has globals this
 * list never needed to: `--reply-fd` takes a value, is absent from `adb --help`, and is real
 * -- confirmed against the adb binary on this machine (1.0.41 / 37.0.1), which errors
 * `--reply-fd requires an argument` rather than `unknown command`. A scanner that assumes an
 * unrecognized flag takes no value treats `--reply-fd 9` as ending the globals region at `9`,
 * and never sees the `-H`/`-P` that follow it -- exactly the bypass this allow list closes.
 * Root validation fails closed (safety rule 9): an argument here whose arity this driver does
 * not know is refused, not assumed harmless.
 *
 * Only `-s`, `-t`, `-d`, `-e` are allowed through: they select which device on Simlock's own
 * server a command talks to, which is what arguments before the subcommand are *for*, and
 * refusing them would break every multi-device invocation to prevent nothing, since every
 * device they can name is one Simlock already manages. What that does mean -- any lease
 * holder can name any Simlock device on this machine -- is the accident boundary ADR 0001
 * draws, not a hole in this list; see `docs/known-pitfalls.md`. Everything else -- the known
 * scope flags, `-a`, `--exit-on-write-error`, `--one-device`, `--reply-fd`, and any global a
 * future adb adds -- is refused in this position, whether or not it turns out to be benign.
 *
 * Arity, verified against real adb on this machine: `-d` and `-e` take no value. `-s` is
 * **separate-only** -- adb rejects the fused `-sSERIAL` outright (`-s requires an argument`).
 * `-t` accepts both `-t 123` and the fused `-t123` (`strncmp(argv[0], "-t", 2)`).
 *
 * `--version` and `--help` are also allowed through, but not as globals with an arity: adb
 * answers them on their own, before it ever looks for a subcommand (`-h` gets no such
 * treatment and is `unknown command` on real adb), so for this scan they *are* the
 * subcommand rather than something that precedes one.
 */
const SELF_CONTAINED_ACTIONS: readonly string[] = ["--version", "--help"];

function allowedGlobalArity(argument: string): "none" | "value" | undefined {
  if (argument === "-d" || argument === "-e") return "none";
  if (argument === "-s") return "value";
  if (argument === "-t") return "value";
  if (argument.startsWith("-t") && argument.length > 2) return "none"; // fused, e.g. `-t123`
  return undefined;
}

/**
 * The caller-supplied argument that ends this driver's tolerance of the *globals* region, if
 * any: adb's globals come before the subcommand, and everything from the subcommand onwards
 * is that subcommand's operand -- `adb shell echo -Please` is a word to echo, not an attempt
 * to move the server. Same scan the iOS driver runs for `--set`/`--profiles`, for the same
 * reason, except this one refuses by *not* recognizing a flag rather than by recognizing it:
 * see `allowedGlobalArity`.
 */
function callerSuppliedScopeFlag(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    // The first argument that is not a flag is the subcommand, and everything from there on is
    // its own -- unless it is the *value* of a global that takes one (`-s <serial>`), which is
    // why this walks adb's small global grammar rather than stopping at the first bare word.
    if (!argument.startsWith("-")) return undefined;
    if (SELF_CONTAINED_ACTIONS.includes(argument)) return undefined;
    const arity = allowedGlobalArity(argument);
    // Not one of the four we allow through: refuse rather than guess whether it takes a value
    // (and so whether the *next* argument is really the subcommand or this flag's operand).
    if (arity === undefined) return argument;
    if (arity === "value") index += 1;
  }
  return undefined;
}

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

/**
 * Whether this is `adb shell` with nothing after it -- the interactive shell. Recognised by
 * `shell` being the last argument rather than by parsing adb's option grammar: everything
 * before it is a global (`-s <serial>`, `-P <port>`) and everything after it is the command
 * to run, so "nothing after it" is exactly the case with no command. `adb shell -t` and
 * friends still pass, deliberately: they name a flag rather than a command, and refusing on
 * a guess would cost a working invocation to catch a hang the timeout already bounds.
 */
function isBareShell(args: readonly string[]): boolean {
  return args.at(-1) === "shell";
}

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
  readonly #acceptAndroidLicenses: boolean;
  readonly #clock: Clock;
  readonly #deviceProfiles: DeviceProfileRegistry;
  readonly #devices = new Map<string, DeviceState>();
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #hostAbi: string;
  readonly #idGenerator: IdGenerator;
  readonly #legacyAvdHome: string;
  readonly #diskSpaceGuard: DiskSpaceGuard;
  readonly #downloadTimeoutMs: number;
  readonly #installLocks = new Map<string, Promise<void>>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #portAllocator: PortAllocator;
  readonly #processRunner: ProcessRunner;
  readonly #resolvedProfiles = new Map<string, ResolvedDeviceProfile>();
  readonly #readinessTimeoutMs: number;
  readonly #registrar: AdbRegistrar;
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #sdk: AndroidSdkPaths;

  private constructor(
    options: AndroidDriverOptions,
    sdk: AndroidSdkPaths,
    deviceRoot: string,
    rootOptions: EnsureOwnedRootOptions,
    adbServer: AdbServerSupervisor,
    adbServerPort: number,
  ) {
    this.#acceptAndroidLicenses = options.acceptAndroidLicenses ?? false;
    this.#adbServer = adbServer;
    this.#adbServerPort = adbServerPort;
    this.#baseEnv = options.env;
    this.#clock = options.clock;
    this.#deviceRoot = deviceRoot;
    this.#diskSpaceGuard = options.diskSpaceGuard ?? new DiskSpaceGuard();
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.#filesystem = options.filesystem;
    this.#hostAbi = options.hostAbi ?? hostAbiFor(process.arch);
    this.#idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.#onDiagnostic = options.onDiagnostic;
    this.#processRunner = options.processRunner;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#registrar = new AdbRegistrar({ serverPort: adbServerPort, tcp: options.tcpProbe });
    this.#rootOptions = rootOptions;
    this.#sdk = sdk;
    // Where an AVD Simlock made before it owned a root still sits: the AVD home the user
    // had configured then, or the SDK's own default. Read only by `findLegacy` /
    // `destroyLegacy` -- the fallback CP3 deleted from the driver proper, kept exactly here
    // because a stranded device cannot be found anywhere else (ADR 0001, Migration).
    this.#legacyAvdHome =
      options.env.ANDROID_AVD_HOME ?? join(options.homeDirectory, ".android", "avd");
    this.#portAllocator = portAllocatorFor(options.processRunner, sdk.adb);
    this.#deviceProfiles = new DeviceProfileRegistry(
      options.deviceProfileSources ??
        defaultDeviceProfileSources(options, sdk, this.#onDiagnostic, () => this.#env()),
    );
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
   * The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this root, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own AVD home standing where this root was.
   */
  async revalidateRoot(): Promise<void> {
    await ensureOwnedRoot(this.#rootOptions);
  }

  /**
   * Looks for an AVD Simlock created before it owned a root, in the AVD home it would have
   * used then. Reached only for a registry device this root no longer holds, and it only
   * reads the filesystem. A legacy home that *is* the root means there is nothing pre-root
   * about the device -- it is simply gone -- and must never be answered through the
   * unscoped path below.
   */
  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    if (this.#legacyAvdHome === this.#deviceRoot) {
      return undefined;
    }
    const path = join(this.#legacyAvdHome, `${driverDeviceId}.avd`);
    if (!(await this.#filesystem.exists(path))) {
      return undefined;
    }

    return {
      device: {
        address: driverDeviceId,
        deviceId: driverDeviceId,
        // A stranded AVD has no console port and no serial: it is not running on Simlock's
        // server, and it is not this driver's business to look for it on anyone else's.
        driverData: {
          avdName: driverDeviceId,
          configHash: "",
          port: 0,
          serial: "",
        } satisfies AndroidDriverData,
      },
      path,
    };
  }

  /**
   * Deletes a pre-root AVD through the AVD home it actually lives in. Permitted despite
   * sitting outside this driver's root because the registry names it: registry-only
   * destruction (safety rule 1) is satisfied by the record, not by the root. The
   * environment points at the legacy home and deliberately not at Simlock's adb server --
   * an AVD that is somehow still running is running on the user's, and stopping devices on
   * a server Simlock does not own is not something this may do.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { avdName } = this.#dataFor(device);
    await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", avdName], {
      env: { ...this.#baseEnv, ANDROID_AVD_HOME: this.#legacyAvdHome },
    });
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
  passthrough(args: readonly string[], context?: PassthroughContext): PassthroughCommand {
    this.#assertProxyable(args, context);
    return {
      args: ["-P", String(this.#adbServerPort), ...args],
      command: this.#sdk.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) },
    };
  }

  #assertProxyable(args: readonly string[], context?: PassthroughContext): void {
    // A shell with nothing to run *is* the interactive shell, and an interactive shell
    // without a terminal is a process that reads a pipe that will never carry anything --
    // it hangs until whatever timeout its caller has. Refused only where there is no
    // terminal (`device.exec`, ADR 0005 §19c); the local `simlock adb shell`, which inherits
    // the CLI's own tty, is untouched and still the way to get one.
    if (context?.hasTerminal === false && isBareShell(args)) {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        "Refusing `simlock adb shell` with no command: an interactive shell needs a terminal, and this one runs on the device's own machine with none. Pass the command to run (`simlock adb shell getprop`), or run `simlock adb shell` on that machine.",
      );
    }
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

    const scopeFlag = callerSuppliedScopeFlag(args);
    if (scopeFlag !== undefined) {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        `Refusing \`simlock adb ${scopeFlag}\`: \`simlock adb\` supplies the adb server itself, and only allows \`-s\`/\`-t\`/\`-d\`/\`-e\` ahead of the subcommand -- anything else there, whether it is a known way to move the server or one this driver does not recognize, might point the command at a server that cannot see Simlock's devices, or at one it must not touch. Drop the flag -- the command is already scoped -- or run \`adb\` directly if you mean to leave Simlock's server.`,
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
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    if (request.platform !== this.platform) {
      throw new Error(`Android driver cannot resolve ${request.platform} requests`);
    }

    const profile = await this.#deviceProfiles.resolve(request.model);
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
      await this.#installSystemImage(packageName, options.requesterId);
    }

    this.#resolvedProfiles.set(profile.name.toLocaleLowerCase(), profile);
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

    // A `builtin` profile already carries the `avdmanager` device id `-d` wants. A
    // `properties` profile has none -- it never came from `avdmanager list device` -- so
    // `avdmanager create avd` is seeded with *some* built-in device (only to skip the
    // interactive "custom hardware profile?" prompt) and the profile's own properties then
    // overwrite that seed's config.ini values below, before anything reads them.
    const seedDeviceId =
      profile.kind === "builtin" ? profile.avdmanagerId : await this.#defaultAvdmanagerDeviceId();
    await this.#runOrThrow(this.#sdk.avdmanager, [
      "create",
      "avd",
      "-n",
      avdName,
      "-k",
      packageName,
      "-d",
      seedDeviceId,
    ]);

    if (profile.kind === "properties") {
      // Must happen before `#configHash` below captures the driver's snapshot/config-hash
      // baseline: applying it after would let the baseline settle on the seed device's
      // hardware and then see a spurious drift on the very next boot.
      await this.#applyHardwareProperties(avdName, profile.hardwareProperties);
    }

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

  async destroy(device: DriverDevice): Promise<void> {
    const data = this.#dataFor(device);
    await this.#withDeviceLock(data.avdName, async () => {
      if (data.port > 0) {
        await this.#shutdown(data, this.#stateFor(data));
      }
      await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", data.avdName]);
      this.#devices.delete(data.avdName);
      this.#portAllocator.release(data.port);
    });
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
   * Every AVD in the root, whatever it is called. The name is a cosmetic label with no
   * authority: what makes these AVDs Simlock's is that they sit inside a root Simlock
   * created empty and marked, which nothing else can put an AVD into (safety rule 8).
   */
  async #listAvdNames(): Promise<string[]> {
    const avdNames: string[] = [];
    if (await this.#filesystem.exists(this.#deviceRoot)) {
      for (const entry of await this.#filesystem.readdir(this.#deviceRoot)) {
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
    const [models, images] = await Promise.all([
      this.#deviceProfiles.listModels(),
      this.#installedImages(),
    ]);
    return {
      defaultRuntime: newestApiLevel(images),
      models: [...models],
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

  async #profileFor(model: string): Promise<ResolvedDeviceProfile> {
    return (
      this.#resolvedProfiles.get(model.toLocaleLowerCase()) ?? this.#deviceProfiles.resolve(model)
    );
  }

  /** See the seed-device comment at its `provision` call site. */
  async #defaultAvdmanagerDeviceId(): Promise<string> {
    const result = await this.#runOrThrow(this.#sdk.avdmanager, ["list", "device"]);
    const [first] = parseAvdmanagerDeviceProfiles(result.stdout);
    if (first === undefined) {
      throw new DriverCrashError(
        `${this.#sdk.avdmanager} list device reported no built-in device profiles`,
      );
    }
    return first.id;
  }

  /** Merges `properties` into the AVD's `config.ini` -- see `#mergeConfigIniLines`. */
  async #applyHardwareProperties(
    avdName: string,
    properties: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#mergeConfigIniLines(avdName, properties);
  }

  /**
   * Dedupes concurrent installs of the same system-image package behind one in-flight promise
   * -- mirrors the iOS driver's `#downloadLocks`, sized to a package instead of a whole
   * `xcodebuild` invocation. The map entry is removed once the install settles (success or
   * failure), so a later, non-concurrent call starts a fresh attempt rather than replaying a
   * stale result.
   */
  async #installSystemImage(packageName: string, requesterId: string | undefined): Promise<void> {
    const inFlight = this.#installLocks.get(packageName);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = this.#installSystemImageOnce(packageName, requesterId).finally(() => {
      if (this.#installLocks.get(packageName) === promise) {
        this.#installLocks.delete(packageName);
      }
    });
    this.#installLocks.set(packageName, promise);
    return promise;
  }

  /**
   * Disk preflight (via the shared `DiskSpaceGuard`, released once the install settles either
   * way), then the actual `sdkmanager` install, wrapped with `component.install-*` diagnostics
   * -- split from `#installSystemImageOrThrow` below so the license-retry branching stays its
   * own single-responsibility function rather than growing this one's complexity. A preflight
   * failure is reported before any diagnostic fires: no install was actually attempted, so
   * there is nothing to report as started or failed. The try/catch means a caller sees exactly
   * one `install-failed` regardless of which branch below throws, never one per attempt.
   *
   * `component-installed` is a verified fact, not "`sdkmanager` exited 0 (possibly after a
   * license-accept retry)": once the install call itself succeeds, this re-scans
   * `#installedImages` and only reports `component-installed` once the package actually
   * installed is present there. Absent (a "reported success but nothing showed up" case)
   * reports `component-install-failed` instead and throws, matching the iOS driver's
   * post-download verification.
   */
  // fallow-ignore-next-line complexity -- reservation, install, and post-install verification are one attempt with one exit per outcome.
  async #installSystemImageOnce(
    packageName: string,
    requesterId: string | undefined,
  ): Promise<void> {
    const release = await this.#diskSpaceGuard.reserve(
      this.#filesystem,
      this.platform,
      ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES,
      this.#sdk.root,
    );
    try {
      this.#onDiagnostic?.({
        componentId: packageName,
        kind: "component-install-started",
        ...(requesterId === undefined ? {} : { requesterId }),
      });
      const startedAt = this.#clock.now();
      try {
        await this.#installSystemImageOrThrow(packageName);
      } catch (error: unknown) {
        this.#onDiagnostic?.({
          componentId: packageName,
          durationMs: this.#clock.now() - startedAt,
          error: stableError(error),
          kind: "component-install-failed",
          ...(requesterId === undefined ? {} : { requesterId }),
        });
        throw error;
      }

      const images = await this.#installedImages();
      if (
        !images.some(
          (image) => systemImagePackage(image.apiLevel, image.tag, image.abi) === packageName,
        )
      ) {
        const message = `sdkmanager reported success but ${packageName} is still not installed`;
        this.#onDiagnostic?.({
          componentId: packageName,
          durationMs: this.#clock.now() - startedAt,
          error: message,
          kind: "component-install-failed",
          ...(requesterId === undefined ? {} : { requesterId }),
        });
        throw new DriverCrashError(message);
      }

      this.#onDiagnostic?.({
        componentId: packageName,
        durationMs: this.#clock.now() - startedAt,
        kind: "component-installed",
        ...(requesterId === undefined ? {} : { requesterId }),
      });
    } finally {
      release();
    }
  }

  /**
   * Installs a system image, accepting Android SDK licenses first when `sdkmanager` refuses
   * on an unaccepted one and `acceptAndroidLicenses` allows it -- never otherwise: license
   * consent is independent of, and never implied by, download permission.
   */
  async #installSystemImageOrThrow(packageName: string): Promise<void> {
    const result = await this.#processRunner.run(this.#sdk.sdkmanager, ["--install", packageName], {
      timeoutMs: this.#downloadTimeoutMs,
    });
    if (result.code === 0 && !hasUnacceptedLicense(result)) {
      return;
    }
    if (!hasUnacceptedLicense(result)) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --install ${packageName} failed: ${result.stderr || result.stdout}`,
      );
    }
    if (!this.#acceptAndroidLicenses) {
      throw new AndroidLicenseNotAcceptedError(packageName);
    }

    await this.#acceptLicenses();

    const retry = await this.#processRunner.run(this.#sdk.sdkmanager, ["--install", packageName], {
      timeoutMs: this.#downloadTimeoutMs,
    });
    if (retry.code !== 0 || hasUnacceptedLicense(retry)) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --install ${packageName} still failed after accepting licenses: ` +
          `${retry.stderr || retry.stdout}`,
      );
    }
  }

  async #acceptLicenses(): Promise<void> {
    const result = await this.#processRunner.run(this.#sdk.sdkmanager, ["--licenses"], {
      // `sdkmanager --licenses` prompts once per outstanding license; answering more times
      // than there are real licenses is harmless (see `LICENSE_ACCEPT_ANSWERS`).
      input: "y\n".repeat(LICENSE_ACCEPT_ANSWERS),
      timeoutMs: this.#downloadTimeoutMs,
    });
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --licenses failed: ${result.stderr || result.stdout}`,
      );
    }
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
    await this.#mergeConfigIniLines(avdName, { [DURABLE_MARK_KEY]: token });
  }

  /**
   * Reads `avdName`'s `config.ini`, merges `entries` into it -- overwriting any key already
   * present, appending the rest -- and writes it back atomically. Shared by
   * `#applyHardwareProperties` and `#writeDurableMark`, the driver's two config.ini
   * read-modify-write sites. A missing file (the AVD's config.ini not created yet) starts the
   * merge from empty content; any other read failure is rethrown rather than treated as an
   * empty file -- silently starting from "" on, say, an EACCES or EIO would write back only
   * `entries` and clobber whatever config.ini already held.
   *
   * Defense in depth against a config.ini injection: `#applyHardwareProperties` calls this with
   * values sourced from a device profile (`avdmanager list device`, or a parsed
   * `~/.android/devices.xml` -- see `device-profile-source.ts`'s own line-break rejection at the
   * parse boundary). A key or value containing a line break would let one logical property
   * inject arbitrary extra `config.ini` lines once joined in -- rejected here unconditionally,
   * independent of and in addition to that parse-time check, so this merge is never the only
   * thing standing between untrusted input and config.ini.
   */
  async #mergeConfigIniLines(
    avdName: string,
    entries: Readonly<Record<string, string>>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      if (containsLineBreak(key) || containsLineBreak(value)) {
        throw new DriverCrashError(
          `Refusing to merge config.ini entry with an embedded line break (key ${JSON.stringify(key)})`,
        );
      }
    }
    const path = this.#configIniPath(avdName);
    let contents: string;
    try {
      contents = await this.#filesystem.readFile(path);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      contents = "";
    }
    const lines = contents === "" ? [] : contents.replace(/\r?\n$/, "").split(/\r?\n/);
    for (const [key, value] of Object.entries(entries)) {
      const line = `${key}=${value}`;
      const existingIndex = lines.findIndex((entry) => entry.startsWith(`${key}=`));
      if (existingIndex >= 0) {
        lines[existingIndex] = line;
      } else {
        lines.push(line);
      }
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

function observedAndroidDevice(
  avdName: string,
  runningByAvdName: ReadonlySet<string>,
  unattributableTransitionalSerial: boolean,
): ObservedDevice {
  return {
    // Reconnaissance only: an observed device is never granted, so it carries no usable address.
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

/** See `#mergeConfigIniLines`'s defense-in-depth check. */
function containsLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
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

/**
 * `sdkmanager --install` reports an unaccepted license in its output rather than through a
 * dedicated exit code, so this is a best-effort text match against sdkmanager's own wording
 * (e.g. `Warning: License for package ... not accepted.` /
 * `... licenses have not been accepted.`), checked across both streams since sdkmanager splits
 * its output between them across versions.
 */
function hasUnacceptedLicense(result: ProcessResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  // Covers both documented sdkmanager phrasings: "License for package ... not accepted." and
  // "licenses have not been accepted." -- the latter has "been" between "not" and "accepted".
  return /licen[cs]e/i.test(combined) && /not (?:been )?accepted/i.test(combined);
}

/**
 * `[builtin, user]`: `avdmanager list device` first, then a read-only parse of Android
 * Studio's `~/.android/devices.xml`. `ANDROID_SDK_HOME` (not `ANDROID_AVD_HOME`, which only
 * relocates created AVDs) is the historical env var Android tooling uses to relocate the whole
 * `~/.android` directory, including `devices.xml`.
 */
function defaultDeviceProfileSources(
  options: AndroidDriverOptions,
  sdk: AndroidSdkPaths,
  onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined,
  env: () => NodeJS.ProcessEnv,
): readonly DeviceProfileSource[] {
  const devicesXmlPath = `${options.env.ANDROID_SDK_HOME ?? options.homeDirectory}/.android/devices.xml`;
  return [
    // Scoped like every other invocation this driver makes: `avdmanager` is the tool that
    // both lists profiles and creates AVDs, and leaving one of its calls pointed at the
    // user's own `~/.android` is the exception that makes "every call is scoped" untrue
    // (ADR 0001, decision 4).
    new BuiltinDeviceProfileSource(sdk.avdmanager, options.processRunner, env),
    new UserDeviceProfileSource(devicesXmlPath, options.filesystem, onDiagnostic),
  ];
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
