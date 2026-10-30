import { otherDeviceRefusal } from "../other-device-refusal.js";
import { dirname, isAbsolute, join } from "node:path";

import {
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type LegacyDevice,
  OwnedRootError,
  type DeviceClass,
  type DeviceSpec,
  type DriverAdvisory,
  type VirtualSpec,
  BootTimeoutError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  COMPONENT_REMOVAL_TIMEOUT_MS,
  type ExactDeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverCatalogImage,
  type DriverComponent,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  type PhysicalInspection,
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
  type PresentPhysical,
  type DriverToolVersion,
  type InstalledComponent,
  LicenseNotAcceptedError,
  type ObservedDevice,
  type ObservedMark,
  type PassthroughCommand,
  PassthroughRefusedError,
  type PassthroughContext,
  type ReclaimResult,
  removeListedComponent,
  type DeviceInputFactory,
  type ScreenCapture,
  ScreenUnavailableError,
  RuntimeMissingError,
  sameReceipt,
} from "../../core/index.js";
import { runBoundedProcess, runInstallerProcess } from "../installer-process.js";
import {
  isMissingPathError,
  type Clock,
  type Filesystem,
  type IdGenerator,
  type Logger,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type TcpProbe,
  type TcpStreamConnector,
  type TimerHandle,
} from "../../ports/index.js";
import { AdbRegistrar } from "./adb-registrar.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";
import { isAndroidDriverData, type AndroidDriverData } from "./data.js";
import { AndroidPhysicalHandler, PHYSICAL_RECLAIM_ESTIMATE_MS } from "./physical-handler.js";
import {
  BuiltinDeviceProfileSource,
  hiddenUserProfiles,
  containsForbiddenCharacter,
  DeviceProfileRegistry,
  parseAvdmanagerDeviceProfiles,
  UserDeviceProfileSource,
  type DeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
  type DeviceProfile,
} from "./device-profile-source.js";
import { fits, isPlayStoreImage, misfitReason } from "./image-fit.js";
import { LibraryDeviceProfileSource } from "./profiles/index.js";
import { createAndroidDeviceInput } from "./input/index.js";
import { createAndroidScreenCapture, type ScreenTarget } from "./screen/index.js";
import { type AndroidSdkPaths, locateSdk } from "./sdk-paths.js";

export { AdbServerUnavailableError } from "./adb-server.js";

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
// why: Measured at 60-71s for a cold boot to `sys.boot_completed` on an M-series Mac against
// Pixel 8 / API 35 (ADR-era hardware verification), against the 31s this first quoted.
// Under-quoting matters more than over-quoting: `Doctor` derives its stalled-transition
// threshold from this number, so a low estimate flags healthy boots on a slower machine.
const COLD_BOOT_ESTIMATE_MS = 70_000;
// why: Console ports, even ones only, each paired with the odd adb port above it. The range
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
/**
 * why: The command timeout on the `adb devices` that `listManaged` runs. It sits below the 60-second
 * limit the daemon's startup read puts on a whole platform, so a hung adb server ends this call
 * first and the read reports the platform's failure rather than its own timeout.
 */
const ADB_DEVICES_TIMEOUT_MS = 30_000;
const AVD_PATH_TIMEOUT_MS = 5_000;
const DEFAULT_ADB_SERVER_PORT = 5038;
// why: After this long without an answer from a serial, the emulator's own registration is
// assumed lost and Simlock re-sends it. Long enough that a normally-booting emulator has
// already attached, short enough that a lost announcement costs seconds, not the whole
// readiness timeout.
const REGISTRATION_RETRY_AFTER_MS = 5_000;
// why: `sdkmanager --licenses` prompts once per outstanding license with a bare `y/N`. Answering
// more times than there are real licenses is harmless -- the extra `y`s land after the prompt
// loop has already exited and sdkmanager simply never reads them -- so this just needs to be
// comfortably above the largest real Android SDK license count rather than exact.
const LICENSE_ACCEPT_ANSWERS = 100;
// why: A defense-in-depth bound on the wait that follows a SIGKILL: NodeProcessHandle#wait
// already settles shortly after `exit`, but this keeps a pathologically slow reap
// from ever turning a "we already killed it" cleanup into an unbounded await.
const SIGKILL_REAP_TIMEOUT_MS = 5_000;
const OWNERSHIP_PROBE_TIMEOUT_MS = 5_000;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;
// why: Conservative estimate for a system-image download+install -- reserved by `ComponentInstaller`
// before `sdkmanager --install` ever starts, so a full disk fails fast instead of filling up
// mid-download.
const ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES = 2 * 1024 ** 3;
const PROVISION_ESTIMATE_MS = 1_000;
// why: Measured on an M3 Pro against Pixel 8 / API 35: 2.4-5.1s over nine steady-state reclaims
// (median 4.6s), and 3.7-5.7s with three running at once. A `snapshot` reclaim loads the clean
// baseline and commits the device straight back to `ready`, so the driver call is the whole
// window the device spends `reclaiming`. Held just above the observed maximum.
const SNAPSHOT_RECLAIM_ESTIMATE_MS = 6_000;
// why: Measured at 22.8-42.8s on the same hardware (median 31.7s) -- an order of magnitude above the
// 3s this first guessed, for a reason worth stating precisely. `reclaim` itself really does
// only shut the emulator down and defer the wipe to the next `makeReady`; what it does not do
// is end the device's time in `reclaiming`. `ReclaimCoordinator` commits what `reclaim` returns,
// so the window is the driver call alone; the figure below still prices the wipe boot a
// kept-warm reclaim used to land inside it, and is kept high. That window, not the driver call,
// is what both consumers of this number measure: a waiting requester's ETA, and the state age
// `Doctor` compares against.
// The slow branch is the one to quote: pricing the fast one would make every kept-warm reclaim
// look stalled, while over-quoting only delays a finding.
const WIPE_RECLAIM_ESTIMATE_MS = 32_000;
const CLEAN_BASELINE = "simlock_clean_baseline";
const DURABLE_MARK_KEY = "simlock.mark";
const ERASABLE_MARK_PATH = "/data/local/tmp/simlock-mark.json";

/**
 * why: How this machine's emulators are launched (`android.emulator` in config). Operator-only: it
 * reaches the driver at construction and never from a lease request. Only these four settings
 * exist, each mapped to one fixed emulator flag by `emulatorLaunchFlags`, so config cannot add
 * `-port`, a different AVD home, or any other argument that would break containment.
 */
export interface AndroidEmulatorLaunchOptions {
  readonly headless: boolean;
  readonly gpu: string;
  readonly audio: boolean;
  readonly bootAnimation: boolean;
}

const DEFAULT_EMULATOR_LAUNCH: AndroidEmulatorLaunchOptions = {
  audio: true,
  bootAnimation: true,
  gpu: "auto",
  headless: false,
};

export interface AndroidDriverOptions {
  /**
   * why: Explicit legal consent for Android SDK licenses (`downloads.acceptAndroidLicenses`),
   * independent of the per-request download permission. Defaults to `false`: an install that
   * fails on an unaccepted license fails outright rather than accepting it silently.
   */
  readonly acceptAndroidLicenses?: boolean;
  readonly clock: Clock;
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly deviceProfileSources?: readonly DeviceProfileSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  /**
   * why: The ABI this host runs natively (`hostAbiFor` of the host port's architecture), passed in
   * by the composition root so the image this driver prefers and the architecture `status.get`
   * reports come from the same reading.
   */
  readonly hostAbi: string;
  readonly idGenerator?: IdGenerator;
  readonly instanceId: string;
  // why: the input logs a device whose screen size it cannot read; nothing else in the driver logs through it.
  readonly logger?: Logger | undefined;
  readonly onDiagnostic?: (diagnostic: AndroidDriverDiagnostic) => void;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly readinessTimeoutMs?: number;
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  // why: both are optional so a host that leaves either out gets a driver without screen streams
  // rather than one that fails each stream it is asked for.
  readonly scrcpyServerPath?: string | undefined;
  readonly tcpStreamConnector?: TcpStreamConnector | undefined;
  readonly uid?: number;
  /** why: the daemon's pid is named in the staging directory of a new root. */
  readonly pid?: number;
  readonly emulator?: AndroidEmulatorLaunchOptions | undefined;
}

export type AndroidDriverDiagnostic =
  | { readonly avdName: string; readonly kind: "snapshot-cold-boot"; readonly readyAfterMs: number }
  | DeviceProfileSourceDiagnostic;

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

interface DeviceState {
  baselineCaptured: boolean;
  handle: ProcessHandle | undefined;
  imageIdentity: string;
  needsWipe: boolean;
  /**
   * why: The console port this process reserved for the device: taken at its first `prepare` boot
   * here, kept across its stops so no other device is handed the port its record names while
   * this process runs, and given back by `destroy`. Nothing persists it, so after a restart a
   * device holds none until it boots again (#52). A recovery boot reserves nothing.
   */
  port: number | undefined;
  snapshotExpected: boolean;
  /**
   * why: Set for a device this process never provisioned: after a restart an emulator it never
   * started may still run the AVD, so `destroy` looks for one.
   */
  restored?: boolean;
}

interface SystemImage {
  readonly abi: string;
  readonly apiLevel: string;
  readonly path: string;
  readonly sourceApiLevel?: string | undefined;
  readonly tag: string;
  readonly tags: readonly string[];
  readonly version: string;
}

/**
 * why: the `simlock <tool>` wrappers this driver answers to are a constant because a
 * driver that refused to start has no instance to ask, and `DriverRejection` carries the
 * names so `simlock adb` can say why it is unavailable rather than reading as a missing SDK.
 */
export const ANDROID_PASSTHROUGH_TOOLS: readonly string[] = ["adb"];

/**
 * why: ADR 0015 §4: the models Simlock tries for each class on Android when the operator names none
 * first, newest first. Medium Tablet is Android's only `tablet`; Android has no `vision` list.
 */
const ANDROID_DEFAULT_MODELS: Readonly<Partial<Record<DeviceClass, readonly string[]>>> = {
  auto: ["Automotive (1080p landscape)", "Automotive (1024p landscape)"],
  desktop: ["Medium Desktop", "Large Desktop"],
  phone: ["Pixel 9", "Pixel 8", "Pixel 7", "Pixel 6", "Medium Phone"],
  tablet: ["Medium Tablet"],
  tv: ["Television (1080p)", "Television (4K)"],
  watch: ["Wear OS Large Round", "Wear OS Small Round"],
};

const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

/**
 * why: `kill-server` would detach every leased emulator at once -- an agent's most reflexive
 * troubleshooting step. Matched anywhere in the arguments rather than in first position:
 * `adb -P 1 kill-server` is the same command with a global in front of it, and a
 * positional scan is the only rule that catches every spelling without this module having
 * to parse adb's own option grammar.
 */
export const REFUSED_ADB_VERB = "kill-server";

/**
 * why: Console commands `simlock adb` will not proxy, matched as a run of adjacent arguments
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
 * draws, not a hole in this list; see https://github.com/callstackincubator/simlock/blob/main/src/drivers/AGENTS.md. Everything else -- the known
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
 * subcommand rather than something that precedes one -- and only when nothing follows them.
 * adb answers `--version`/`--help` and exits without ever looking at the rest of the line, so
 * this driver has no way to vouch for what comes after one: `["--version", "-P", "5037",
 * "shell", "id"]` is verified against real adb to print the version and exit 0, never reaching
 * the `-P`/`shell` that follow, but a scan that let them ride along on the strength of
 * `--version` ending it would wave through exactly the kind of unvetted tail this allow list
 * exists to refuse everywhere else.
 */
const SELF_CONTAINED_ACTIONS: readonly string[] = ["--version", "--help"];

function allowedGlobalArity(argument: string): "none" | "value" | undefined {
  if (argument === "-d" || argument === "-e") return "none";
  if (argument === "-s") return "value";
  if (argument === "-t") return "value";
  if (argument.startsWith("-t") && argument.length > 2) return "none";
  return undefined;
}

type GlobalsWalkResult =
  | { readonly kind: "subcommand"; readonly index: number }
  | { readonly kind: "refused"; readonly argument: string }
  | { readonly kind: "none" };

/**
 * why: Walks adb's globals grammar (`allowedGlobalArity`) up to the subcommand, the one place both
 * `callerSuppliedScopeFlag` and `isBareShell` need to agree on where the globals region ends
 * and the subcommand's own operands begin -- `adb shell echo -Please` is a word to echo, not
 * an attempt to move the server, and `adb shell input text shell` is a command with `shell` as
 * an *operand*, not the bare interactive shell `isBareShell` refuses without a terminal. Same
 * scan the iOS driver runs for `--set`/`--profiles`, for the same reason, except this one
 * refuses by *not* recognizing a flag rather than by recognizing it: see `allowedGlobalArity`.
 */
function walkGlobals(args: readonly string[]): GlobalsWalkResult {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    // why: The first argument that is not a flag is the subcommand, and everything from there on is
    // its own -- unless it is the *value* of a global that takes one (`-s <serial>`), which is
    // why this walks adb's small global grammar rather than stopping at the first bare word.
    if (!argument.startsWith("-")) return { index, kind: "subcommand" };
    // why: Self-contained only when it is the *sole* argument: adb answers it and exits without
    // looking at anything else on the line, so anything after it is a tail this driver never
    // gets to vouch for and must refuse rather than wave through (the hardening note above).
    if (SELF_CONTAINED_ACTIONS.includes(argument)) {
      if (args.length === 1) return { index, kind: "subcommand" };
      return { argument, kind: "refused" };
    }
    const arity = allowedGlobalArity(argument);
    // why: Not one of the four we allow through: refuse rather than guess whether it takes a value
    // (and so whether the *next* argument is really the subcommand or this flag's operand).
    if (arity === undefined) return { argument, kind: "refused" };
    if (arity === "value") index += 1;
  }
  return { kind: "none" };
}

/**
 * why: ADR 0047 §1. `adb help` (platform-tools 37.0.0): these subcommands act on no device, so
 * a `-s` in front of them would be noise. `forward --list` and `reconnect offline` are the
 * two that depend on their operand and are matched in `actsOnNoDevice`.
 */
const NO_DEVICE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "devices",
  "help",
  "version",
  "connect",
  "disconnect",
  "pair",
  "mdns",
  "keygen",
  "start-server",
  "kill-server",
  "--version",
  "--help",
]);

function actsOnNoDevice(args: readonly string[], index: number): boolean {
  const subcommand = args[index] as string;
  if (NO_DEVICE_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "forward") return args[index + 1] === "--list";
  return subcommand === "reconnect" && args[index + 1] === "offline";
}

/** why: Whether the globals before `end` already name `serial` with `-s`; `-t`, `-e`, `-d` and any other serial are refused. */
function namesOwnSerial(args: readonly string[], end: number, serial: string): boolean {
  let named = false;
  for (let index = 0; index < end; index += 1) {
    const flag = args[index] as string;
    const value = flag === "-s" || flag === "-t" ? args[index + 1] : undefined;
    if (flag !== "-s" || value !== serial) {
      throw otherDeviceRefusal(
        "adb",
        args,
        value === undefined ? flag : `${flag} ${value}`,
        serial,
      );
    }
    named = true;
    index += 1;
  }
  return named;
}

/** why: Puts `-s <serial>` in front of the globals unless the subcommand needs no device or the caller already named this one. */
function fillAdbDevice(args: readonly string[], serial: string): readonly string[] {
  const walked = walkGlobals(args);
  if (walked.kind !== "subcommand" || actsOnNoDevice(args, walked.index)) return args;
  return namesOwnSerial(args, walked.index, serial) ? args : ["-s", serial, ...args];
}

function callerSuppliedScopeFlag(args: readonly string[]): string | undefined {
  const walked = walkGlobals(args);
  return walked.kind === "refused" ? walked.argument : undefined;
}

export const REFUSED_ADB_SEQUENCES: readonly {
  readonly sequence: readonly string[];
  readonly reason: string;
}[] = [
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "kill"] },
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "avd", "stop"] },
  {
    // why: Not drift, which is why it needs saying: the emulator keeps running and nothing looks
    // wrong. What is gone is the clean baseline `reclaimStrategy` restores from, so every
    // later reclaim of this device silently degrades from a snapshot load to a full wipe.
    reason:
      "it destroys the clean-boot snapshot Simlock restores from, turning every later reclaim of this device into a full wipe.",
    sequence: ["emu", "avd", "snapshot", "delete"],
  },
];

/**
 * why: Whether this is `adb shell` with nothing after it -- the interactive shell. Recognised by
 * walking `walkGlobals` to find the actual *subcommand* -- the first argument past any
 * `-s <serial>` / `-P <port>` / other global -- and checking that it is `shell` **and** the
 * last argument, rather than by checking whether the line's last word happens to spell
 * `shell`. The naive check refused `adb shell echo shell`, `adb shell input text shell`, and
 * even `adb push ./x shell` -- every one of them ends in the word `shell` as an *operand*, not
 * as the bare subcommand, so none of them is the interactive shell this refusal exists for
 * (round 4, F2). A line whose globals region this driver refuses (`walkGlobals` returning
 * `"refused"`) or that names no subcommand at all is never the bare shell either -- it is
 * refused by `callerSuppliedScopeFlag`, or has nothing to run in the first place.
 */
function isBareShell(args: readonly string[]): boolean {
  const walked = walkGlobals(args);
  return (
    walked.kind === "subcommand" &&
    args[walked.index] === "shell" &&
    walked.index === args.length - 1
  );
}

const allocationsByRunner = new WeakMap<ProcessRunner, PortAllocator>();

function containsSequence(args: readonly string[], sequence: readonly string[]): boolean {
  return args.some((_, index) => sequence.every((token, offset) => args[index + offset] === token));
}

type AndroidTargetFor = (
  device: VirtualDriverDevice | PhysicalDriverDevice,
) => Promise<ScreenTarget>;

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly defaultModels = ANDROID_DEFAULT_MODELS;
  readonly #adbServer: AdbServerSupervisor;
  readonly #adbServerPort: number;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #acceptAndroidLicenses: boolean;
  readonly #clock: Clock;
  readonly #deviceProfiles: DeviceProfileRegistry;
  readonly #profileSources: ReturnType<typeof defaultDeviceProfileSources> | undefined;
  readonly #devices = new Map<string, DeviceState>();
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #hostAbi: string;
  readonly #idGenerator: IdGenerator;
  readonly #legacyAvdHome: string;
  readonly #emulatorFlags: readonly string[];
  readonly #baselineLaunchInputs: readonly string[];
  readonly #locks = new Map<string, Promise<void>>();
  readonly #onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined;
  readonly #portAllocator: PortAllocator;
  readonly #processRunner: ProcessRunner;
  readonly #physical: AndroidPhysicalHandler;
  readonly #resolvedProfiles = new Map<string, DeviceProfile>();
  readonly #readinessTimeoutMs: number;
  readonly #registrar: AdbRegistrar;
  readonly #rootOptions: EnsureOwnedRootOptions;
  readonly #sdk: AndroidSdkPaths;
  readonly #tcpProbe: TcpProbe;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;

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
    this.#emulatorFlags = emulatorLaunchFlags(options.emulator);
    this.#baselineLaunchInputs = baselineLaunchInputs(options.emulator);
    this.#filesystem = options.filesystem;
    this.#hostAbi = options.hostAbi;
    this.#idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.#onDiagnostic = options.onDiagnostic;
    this.#processRunner = options.processRunner;
    this.#physical = new AndroidPhysicalHandler({
      adb: sdk.adb,
      baseEnv: options.env,
      filesystem: options.filesystem,
      isBareShell,
      processRunner: options.processRunner,
      tcpProbe: options.tcpProbe,
    });
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#registrar = new AdbRegistrar({ serverPort: adbServerPort, tcp: options.tcpProbe });
    this.#rootOptions = rootOptions;
    this.#sdk = sdk;
    this.#tcpProbe = options.tcpProbe;
    this.componentFootprint = { bytes: ANDROID_SYSTEM_IMAGE_MIN_FREE_BYTES, path: sdk.root };
    const targetFor = this.#screenTargetFor(options, sdk.adb, adbServerPort);
    this.screenCapture = this.#screenCaptureFor(options, targetFor);
    this.input = this.#inputFor(options, targetFor);
    // why: Where an AVD Simlock made before it owned a root still sits: the AVD home the user
    // had configured then, or the SDK's own default. Used only by `findLegacy` /
    // `destroyLegacy` -- the fallback CP3 deleted from the driver proper, kept exactly here
    // because a stranded device cannot be found anywhere else (ADR 0001, Migration) -- and
    // read by `listComponents`, which counts the user's own AVDs there (ADR 0010 §8).
    this.#legacyAvdHome =
      options.env.ANDROID_AVD_HOME ?? join(options.homeDirectory, ".android", "avd");
    this.#portAllocator = portAllocatorFor(options.processRunner, sdk.adb);
    const defaults =
      options.deviceProfileSources === undefined
        ? defaultDeviceProfileSources(options, sdk, this.#onDiagnostic, () => this.#env())
        : undefined;
    this.#profileSources = defaults;
    this.#deviceProfiles = new DeviceProfileRegistry(
      options.deviceProfileSources ??
        (defaults === undefined ? [] : [defaults.library, defaults.builtin, defaults.user]),
    );
  }

  #screenTargetFor(
    options: AndroidDriverOptions,
    adb: string,
    adbServerPort: number,
  ): AndroidTargetFor | undefined {
    const tcp = options.tcpStreamConnector;
    if (options.scrcpyServerPath === undefined || tcp === undefined) return undefined;
    const runner = options.processRunner;
    return async (device) =>
      isPhysicalDriverDevice(device)
        ? this.#physical.screenTargetFor(device, tcp)
        : emulatorScreenTarget(
            runner,
            adb,
            tcp,
            adbServerPort,
            () => this.#env(),
            this.#dataFor(device).serial,
            device,
          );
  }

  #screenCaptureFor(
    options: AndroidDriverOptions,
    targetFor: AndroidTargetFor | undefined,
  ): ScreenCapture | undefined {
    if (options.scrcpyServerPath === undefined || targetFor === undefined) return undefined;
    return createAndroidScreenCapture({
      clock: options.clock,
      filesystem: options.filesystem,
      serverPath: options.scrcpyServerPath,
      targetFor,
    });
  }

  // why: the input uses the same jar and the same targets as the stream, so it is offered exactly
  // when the stream is.
  #inputFor(
    options: AndroidDriverOptions,
    targetFor: AndroidTargetFor | undefined,
  ): DeviceInputFactory | undefined {
    if (options.scrcpyServerPath === undefined || targetFor === undefined) return undefined;
    return createAndroidDeviceInput({
      clock: options.clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      serverPath: options.scrcpyServerPath,
      targetFor,
    });
  }

  /**
   * why: Establishes everything containment rests on before the driver can be asked to do
   * anything: the AVD home this instance owns, and the private adb server its emulators
   * are reachable through. Both fail closed -- an `OwnedRootError` or an
   * `AdbServerUnavailableError` here costs the Android platform and nothing else, because
   * the alternatives are the user's own AVD directory and the machine's shared adb server,
   * which Simlock can prove nothing about (safety rule 9).
   */
  static async create(options: AndroidDriverOptions): Promise<AndroidDriver> {
    const sdk = await discoverSdk(options);
    const adbServerPort = configuredAdbServerPort(options);
    // why: Resolved once and shared: the root's staging directory, the AVD names, and the
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
      ...(options.pid === undefined ? {} : { pid: options.pid }),
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
   * why: The same call `create` made, with the same arguments, because the proof *is* that call:
   * a cheaper second check here would be a second validator, free to drift from the one
   * every start is judged by. It is asked for immediately before Simlock destroys anything
   * inside this root, since between then and startup the path can have become a symlink, or
   * a `mv` can have left the user's own AVD home standing where this root was.
   */
  async revalidateRoot(): Promise<void> {
    await ensureOwnedRoot(this.#rootOptions);
  }

  /**
   * why: Looks for an AVD Simlock created before it owned a root, in the AVD home it would have
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
        // why: A stranded AVD has no console port and no serial: it is not running on Simlock's
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
   * why: Permitted outside this driver's root because the registry names the AVD (safety rule 1). The
   * environment omits Simlock's adb server: stopping devices on a server it does not own is off limits.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { avdName } = this.#dataFor(device);
    await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", avdName], {
      env: { ...this.#baseEnv, ANDROID_AVD_HOME: this.#legacyAvdHome },
    });
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    // why: without this their `adb` talks to the shared server, which cannot see the emulator.
    return { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) };
  }

  leaseEnvironment(device: DriverDevice): Readonly<Record<string, string>> {
    if (isPhysicalDriverDevice(device)) {
      return { ANDROID_ADB_SERVER_PORT: "5037", ANDROID_SERIAL: device.deviceId };
    }
    return this.virtualLeaseEnvironment();
  }

  readonly passthroughTools = ANDROID_PASSTHROUGH_TOOLS;

  /** why: `ANDROID_ADB_SERVER_PORT` rides along so an adb that re-execs itself stays on the same server. */
  async passthrough(
    _tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    if (context?.platform !== undefined && context.platform !== this.platform) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`adb\`: it only serves an Android device, and this lease is on the ${context.platform} platform.`,
      );
    }
    if (device !== undefined && isPhysicalDriverDevice(device)) {
      return this.#physical.passthrough(device, args, context);
    }
    this.#assertProxyable(args, context);
    const scopedArgs =
      device === undefined || device.address === "" ? args : fillAdbDevice(args, device.address);
    return await Promise.resolve({
      args: ["-P", String(this.#adbServerPort), ...scopedArgs],
      command: this.#sdk.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(this.#adbServerPort) },
    });
  }

  #assertProxyable(args: readonly string[], context?: PassthroughContext): void {
    // why: A shell with nothing to run *is* the interactive shell, and an interactive shell
    // without a terminal is a process that reads a pipe that will never carry anything --
    // it hangs until whatever timeout its caller has. Refused only where there is no
    // terminal (`device.exec`, ADR 0005 §19c); the local `simlock adb shell`, which inherits
    // the CLI's own tty, is untouched and still the way to get one.
    if (context?.hasTerminal === false && isBareShell(args)) {
      throw new PassthroughRefusedError(
        "adb",
        "Refusing `simlock adb shell` with no command: an interactive shell needs a terminal, and this one runs on the device's own machine with none. Pass the command to run (`simlock adb shell getprop`), or run `simlock adb shell` on that machine.",
      );
    }
    if (args.includes(REFUSED_ADB_VERB)) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${REFUSED_ADB_VERB}\`: it would detach every leased emulator at once. Use \`simlock release\` to give a device back, or \`simlock cleanup\` to reclaim idle ones.`,
      );
    }
    const refused = REFUSED_ADB_SEQUENCES.find((candidate) =>
      containsSequence(args, candidate.sequence),
    );
    if (refused !== undefined) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${refused.sequence.join(" ")}\`: ${refused.reason} ${RECLAIM_INSTEAD}`,
      );
    }

    const scopeFlag = callerSuppliedScopeFlag(args);
    if (scopeFlag !== undefined) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${scopeFlag}\`: \`simlock adb\` supplies the adb server itself, and only allows \`-s\`/\`-t\`/\`-d\`/\`-e\` ahead of the subcommand -- anything else there, whether it is a known way to move the server or one this driver does not recognize, might point the command at a server that cannot see Simlock's devices, or at one it must not touch. Drop the flag -- the command is already scoped -- or run \`adb\` directly if you mean to leave Simlock's server.`,
      );
    }
  }

  /**
   * why: Stops the adb server this driver started. Nothing else can: `ADB_REJECT_KILL_SERVER=1`
   * makes `adb kill-server` refuse Simlock too, and the spawned child is not unref'd, so a
   * shutdown that skipped this would leave both a server and a daemon that cannot exit.
   */
  async dispose(): Promise<void> {
    await this.#adbServer.stop();
  }

  /**
   * why: The single insertion point for Android's scoping, the way `--set` is iOS's: every
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
   * why: Announces every console port Simlock may have an emulator on to the server that was
   * just started or adopted -- deliberately doing, for Simlock's own range only, what adb's
   * scanner would do for everyone's.
   *
   * An emulator announces itself exactly once, at its own startup, to the server that
   * existed then. A clean `daemon stop` reaps that server, and with `ADB_EMU=0` the next one
   * has no scanner to rediscover anything -- so every emulator that survived the restart
   * (which is by design: a released device may stay running, kept by the warm pool) would be
   * invisible forever. Invisible is worse than gone: `listManaged` reports no process, so
   * `doctor` can never call it an orphan and several gigabytes of RSS leak permanently.
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

    // why: `#register` swallows its own failures, so one unreachable port cannot end the sweep.
    await Promise.all(ports.map((consolePort) => this.#register(consolePort)));
  }

  /**
   * why: Announces an emulator to Simlock's adb server, which with the scanner off is what
   * attaches it (see `AdbRegistrar`). Always best-effort: the emulator announces itself
   * too, so a failure here is usually a duplicate of something that already worked, and
   * failing a boot over it would trade a working device for a redundant message.
   */
  async #register(consolePort: number): Promise<void> {
    try {
      await this.#registrar.register(consolePort + 1);
    } catch {}
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    if (request.platform !== this.platform) {
      throw new Error(`Android driver cannot resolve ${request.platform} requests`);
    }

    const profile = await this.#deviceProfiles.resolve(request.model);
    const images = await this.#installedImages();
    if (request.imageTag !== undefined) {
      const apiLevel = this.#taggedApiLevel(profile, images, request.imageTag, request.osVersion);
      this.#resolvedProfiles.set(profile.name.toLocaleLowerCase(), profile);
      return {
        imageTag: request.imageTag,
        model: profile.name,
        osVersion: apiLevel,
        physical: false,
        platform: this.platform,
      };
    }

    const levels = fittingApiLevels(profile, images);
    const apiLevel = request.osVersion ?? levels.at(-1);
    if (apiLevel === undefined || !levels.includes(apiLevel)) {
      throw this.#noFittingImage(profile, images, request.osVersion);
    }

    this.#resolvedProfiles.set(profile.name.toLocaleLowerCase(), profile);
    return { model: profile.name, osVersion: apiLevel, physical: false, platform: this.platform };
  }

  // fallow-ignore-next-line complexity -- one refusal builder: each branch is one message the spec lists.
  #noFittingImage(
    profile: DeviceProfile,
    images: readonly SystemImage[],
    level: string | undefined,
    imageTag?: string,
  ): RuntimeMissingError {
    const considered = level === undefined ? images : images.filter((i) => i.apiLevel === level);
    const where = level === undefined ? "" : ` at Android ${level}`;
    const tagged = imageTag === undefined ? [] : considered.filter((i) => i.tag === imageTag);
    const downloadable =
      level !== undefined &&
      imageTag === undefined &&
      considered.length === 0 &&
      fits(profile, { apiLevel: level, tag: "google_apis", tags: ["google_apis"] });
    const error = downloadable
      ? new RuntimeMissingError(this.platform, level, { component: level })
      : new RuntimeMissingError(this.platform, level ?? "default", { downloadable: false });
    let reason: string;
    if (imageTag !== undefined) {
      const why = misfitReason(profile, tagged);
      reason = `the ${imageTag} image does not fit it${why === undefined ? "" : `: ${why}`}`;
    } else if (images.length === 0) {
      reason = "no system image is installed";
    } else if (considered.length === 0) {
      reason = `Android ${level} is not installed`;
    } else {
      reason = misfitReason(profile, considered) ?? "none of the installed images fit it";
    }
    error.message = `No installed system image fits ${profile.name}${where}: ${reason}`;
    return error;
  }

  async provision(spec: VirtualSpec): Promise<DriverDevice> {
    this.#assertAndroidSpec(spec);
    const profile = await this.#profileFor(spec.model);
    const image = await this.#requireImage(profile, spec.osVersion, spec.imageTag);
    // why: Cosmetic only, and worth saying so: the prefix is a label that makes an emulator
    // recognisable in `adb devices` and in its window title. Nothing reads it back as
    // evidence of anything -- ownership comes from the root this AVD is created in.
    const avdName = `simlock_${this.#idGenerator.generate()}`;
    const packageName = systemImagePackage(image.apiLevel, image.tag, image.abi);

    if (profile.kind === "library") {
      assertLibraryProfileWritable(profile);
    }
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
      // why: Must happen before `#configHash` below captures the driver's snapshot/config-hash
      // baseline: applying it after would let the baseline settle on the seed device's
      // hardware and then see a spurious drift on the very next boot.
      await this.#applyHardwareProperties(avdName, profile.hardwareProperties);
    }

    if (profile.kind === "library") {
      await this.#applyLibraryProfile(avdName, profile, image);
    }

    const configHash = await this.#configHash(avdName, image);
    const driverData: AndroidDriverData = {
      avdName,
      configHash,
      imageIdentity: `${image.path}@${image.version}`,
      port: 0,
      serial: "",
    };
    this.#devices.set(avdName, {
      baselineCaptured: false,
      handle: undefined,
      imageIdentity: `${image.path}@${image.version}`,
      needsWipe: false,
      port: undefined,
      snapshotExpected: false,
    });

    return { address: "", deviceId: avdName, driverData };
  }

  /**
   * why: Returns the device with its address re-read: see `Driver.makeReady` for why it is read here.
   *
   * `options.purpose === "recover"` boots and nothing else. The clean-baseline check below can
   * decide to wipe the device (a baseline hash that no longer matches: an emulator upgrade, a
   * config.ini change, or a changed `android.emulator.headless`/`gpu`) or to capture a fresh
   * baseline from whatever is on the device -- and either would run against a device that is
   * still leased, whose data is the agent's. So a recovery boot skips the baseline logic
   * entirely: a cold boot from disk, never a snapshot load and never a wipe. Whatever the
   * baseline check would have decided is decided instead by the next `reclaim`, once the
   * lease is over.
   */
  async makeReady(
    device: DriverDevice,
    options?: { readonly purpose: "prepare" | "recover" },
  ): Promise<DriverDevice> {
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);
      if (state.handle !== undefined) {
        const running = this.#onReservedPort(data, state);
        await this.#waitForReadiness(running, this.#clock.now());
        // why: The device was already running (or booting) under this driver instance -- reclaim
        // never touched it, so its mark can't have gone stale. Re-mark anyway: this is the
        // single readiness transition that lets a caller re-lease an already-ready device
        // without ever seeing a moment where "ready" and "marked" disagree.
        await this.#writeMark(running);
        return { address: running.serial, deviceId: device.deviceId, driverData: running };
      }

      if (options?.purpose === "recover") {
        await this.#startEmulator(data, state, ["-no-snapshot-load"], false);
        await this.#writeMark(data);
        return { address: data.serial, deviceId: device.deviceId, driverData: data };
      }

      await this.#reconcileBaseline(data, state);
      const booted = await this.#withReservedPort(data, state);
      await this.#startEmulator(booted, state, prepareLaunchArgs(state), state.snapshotExpected);
      state.needsWipe = false;
      state.snapshotExpected = false;
      if (!state.baselineCaptured) {
        await this.#captureBaseline(booted, state);
        await this.#shutdown(booted, state);
        await this.#startEmulator(booted, state, ["-snapshot", CLEAN_BASELINE], true);
      }
      // why: Covers all three boot paths above (wipe, snapshot restore, cold boot -- including the
      // baseline-capture restart) with a single call: whichever path ran, the device is ready
      // now and must be re-marked unconditionally.
      await this.#writeMark(booted);
      return { address: booted.serial, deviceId: device.deviceId, driverData: booted };
    });
  }

  /**
   * why: The device's data on the console port this process reserved for it, taking one on its
   * first `prepare` boot here. The port its record names is never booted on as such: after a
   * restart nothing reserves it, so another device may have been handed it since (#52).
   */
  async #withReservedPort(data: AndroidDriverData, state: DeviceState): Promise<AndroidDriverData> {
    state.port ??= await this.#portAllocator.allocate(this.#env(), this.#tcpProbe);
    return this.#onReservedPort(data, state);
  }

  /** why: The reserved port is the truth; `data` is only what the registry last committed. */
  #onReservedPort(data: AndroidDriverData, state: DeviceState): AndroidDriverData {
    return state.port === undefined
      ? data
      : { ...data, port: state.port, serial: serialFor(state.port) };
  }

  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<ReclaimResult> {
    if (isPhysicalDriverDevice(device)) {
      return this.#physical.reclaim(device);
    }
    const data = this.#dataFor(device);
    return this.#withDeviceLock(data.avdName, async () => {
      const state = this.#stateFor(data);

      if (options.clean === "full") {
        // why: No mark write: `-wipe-data` is deferred to the next `makeReady`, which writes the mark.
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

      // why: After a restart the serial is from the registry and may answer as another device's
      // emulator (#284), so the snapshot load goes only to an emulator proved to be this one's.
      if (!(await this.#serialIsOwn(data))) {
        await this.#shutdown(data, state);
        state.needsWipe = true;
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
      // why: Snapshot restore reverts the mark to its capture-time value and this path skips `makeReady`,
      // so the mark is written here.
      await this.#writeMark(data);
      return { state: "ready", strategy: "snapshot" };
    });
  }

  reclaimStrategy(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): "snapshot" | "wipe" | "uninstall" {
    if (isPhysicalDriverDevice(device)) return "uninstall";
    return virtualReclaimStrategy(options.clean);
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
      const state = this.#stateFor(data);
      // why: After a restart a stopped device's recorded port may be another device's (#52), so a
      // handle-less device is sent a kill only on a serial whose own answer names its AVD directory.
      if (state.handle !== undefined) {
        await this.#shutdown(this.#onReservedPort(data, state), state);
      } else if (state.restored === true) {
        await this.#stopUnownedEmulator(data);
      }
      await this.#runOrThrow(this.#sdk.avdmanager, ["delete", "avd", "-n", data.avdName]);
      this.#devices.delete(data.avdName);
      if (state.port !== undefined) {
        this.#portAllocator.release(state.port);
      }
    });
  }

  /**
   * why: An orphan found after a restart has no handle and no usable serial, so the emulator
   * running its AVD is found by asking each attached one which AVD folder it runs. Deletion is
   * refused when that emulator does not exit in time, never done under a live process.
   */
  async #stopUnownedEmulator(data: AndroidDriverData): Promise<void> {
    const expected = `${this.#deviceRoot}/${data.avdName}.avd`;
    const { settledSerials } = await this.#scanAdbSerials();
    const serials: string[] = [];
    for (const serial of settledSerials) {
      const answered = await this.#answeredAvdPathOf(serial);
      if (answered === undefined || answered === "") {
        throw new DriverCrashError(
          `Refusing to delete ${data.avdName}: could not tell which AVD the emulator on ${serial} runs`,
        );
      }
      if (await this.#isOwnAvdPath(answered, expected)) serials.push(serial);
    }
    for (const serial of serials) {
      await this.#processRunner.run(this.#sdk.adb, ["-s", serial, "emu", "kill"], {
        env: this.#env(),
        timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
      });
    }
    const startedAt = this.#clock.now();
    let remaining = serials;
    while (remaining.length > 0) {
      const attached = (await this.#scanAdbSerials()).settledSerials;
      remaining = remaining.filter((serial) => attached.includes(serial));
      if (remaining.length === 0) return;
      if (this.#clock.now() - startedAt >= this.#readinessTimeoutMs) {
        throw new DriverCrashError(
          `Refusing to delete ${data.avdName}: its emulator on ${remaining.join(", ")} did not exit`,
        );
      }
      await this.#delay(PORT_POLL_INTERVAL_MS);
    }
  }

  /** why: Bounded like the ownership gate; undefined means the emulator did not say. */
  async #answeredAvdPathOf(serial: string): Promise<string | undefined> {
    try {
      const answer = await this.#processRunner.run(
        this.#sdk.adb,
        ["-s", serial, "emu", "avd", "path"],
        { env: this.#env(), timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS },
      );
      return answer.code === 0 ? answeredAvdPath(answer.stdout) : undefined;
    } catch {
      return undefined;
    }
  }

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    return this.#physical.listPresentPhysical(enrolledIds);
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    return this.#physical.inspectPhysical(id);
  }

  async advisories(): Promise<readonly DriverAdvisory[]> {
    const physical = await this.#physical.advisories();
    if (this.#profileSources === undefined) return physical;
    const hidden = await hiddenUserProfiles(
      this.#profileSources.library,
      this.#profileSources.user,
    );
    return [
      ...physical,
      ...hidden.map(({ libraryName, userName }) => ({
        code: "device-profile-hidden",
        message: `"${userName}" in devices.xml is not used: Simlock's own ${libraryName} profile answers to that name`,
      })),
    ];
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
   * why: Every AVD in the root, whatever it is called. The name is a cosmetic label with no
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

  async #scanAdbSerials(): Promise<{
    readonly settledSerials: readonly string[];
    readonly unattributableTransitionalSerial: boolean;
  }> {
    const attached = await this.#runOrThrow(this.#sdk.adb, ["devices"], {
      timeoutMs: ADB_DEVICES_TIMEOUT_MS,
    });
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
      // why: `adb shell` reports the exit status of the last command it ran, so a missing
      // mark file would fail the whole invocation -- and a missing mark file is exactly
      // the foreign-erase case this feature exists to detect. `|| true` keeps an absent
      // mark an observation rather than a crash.
      const output = await this.#adbShellOrUndefined([
        "-s",
        candidate,
        "shell",
        `getprop ro.boot.qemu.avd_name; cat ${ERASABLE_MARK_PATH} 2>/dev/null || true`,
      ]);
      // why: An emulator can die between `adb devices` and this call. Losing the whole
      // reality view over one dead serial would strand every other device, so treat it
      // like a transitional serial: unattributable this tick, nothing concluded.
      if (output === undefined) {
        unreadableSerial = true;
        continue;
      }
      const [nameLine = "", ...markLines] = output.stdout.split(/\r?\n/);
      const avdName = nameLine.trim();
      if (!avdNamesInRoot.has(avdName)) continue;
      let answered: string;
      try {
        answered = await this.#readAvdPath(candidate);
      } catch {
        // why: A serial can disappear after its shell answered; keep the observation
        // inconclusive just as when it disappears before that shell call.
        unreadableSerial = true;
        continue;
      }
      if (!(await this.#sameDirectory(answered, `${this.#deviceRoot}/${avdName}.avd`))) continue;
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

  async #adbShellOrUndefined(args: readonly string[]): Promise<ProcessResult | undefined> {
    try {
      return await this.#runOrThrow(this.#sdk.adb, args);
    } catch {
      return undefined;
    }
  }

  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    const packages = [
      { name: "emulator", path: dirname(this.#sdk.emulator) },
      { name: "platform-tools", path: dirname(this.#sdk.adb) },
      {
        name: this.#sdk.sdkmanager.includes("/cmdline-tools/") ? "cmdline-tools" : "tools",
        path: dirname(dirname(this.#sdk.sdkmanager)),
      },
    ];
    const versions = await Promise.all(
      packages.map(async ({ name, path }) => {
        const version = await packageRevision(this.#filesystem, path);
        return version === undefined ? undefined : { name, version };
      }),
    );
    return versions.filter((version) => version !== undefined);
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const [{ catalog, modelProfiles }, images] = await Promise.all([
      this.#deviceProfiles.catalogWithProfiles(),
      this.#installedImages(),
    ]);
    const { customModels, modelAliases, modelClasses, models } = catalog;
    const runtimes = installedApiLevels(images);
    return {
      ...(customModels.length === 0 ? {} : { customModels: [...customModels] }),
      defaultRuntime: runtimes.at(-1),
      images: images
        .map((image) => ({ abi: image.abi, runtime: image.apiLevel, tag: image.tag }))
        .sort(compareCatalogImages),
      modelAliases,
      modelClasses,
      modelRuntimes: Object.fromEntries(
        models.map((model) => {
          const profile = modelProfiles.get(model);
          return [model, profile === undefined ? [] : fittingApiLevels(profile, images)];
        }),
      ),
      models: [...models],
      runtimes,
    };
  }

  estimate(
    estimate: DriverEstimate & { readonly operation: "boot"; readonly device: DriverDevice },
    spec: DeviceSpec,
  ): Promise<number>;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number;
  estimate(estimate: DriverEstimate, spec: DeviceSpec): number | Promise<number> {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        if (estimate.device === undefined) return COLD_BOOT_ESTIMATE_MS;
        return this.#bootEstimate(estimate.device, estimate.purpose, spec);
      case "reclaim":
        if (spec.physical) return PHYSICAL_RECLAIM_ESTIMATE_MS;
        // why: `standard` can still fall back to the wipe branch (about five times longer); `Doctor`
        // takes the slower clean level instead of averaging the two.
        return virtualReclaimStrategy(estimate.clean) === "wipe"
          ? WIPE_RECLAIM_ESTIMATE_MS
          : SNAPSHOT_RECLAIM_ESTIMATE_MS;
    }
  }

  async #profileFor(model: string): Promise<DeviceProfile> {
    return (
      this.#resolvedProfiles.get(model.toLocaleLowerCase()) ?? this.#deviceProfiles.resolve(model)
    );
  }

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

  async #applyLibraryProfile(
    avdName: string,
    profile: Extract<DeviceProfile, { readonly kind: "library" }>,
    image: SystemImage,
  ): Promise<void> {
    await this.#mergeConfigIniLines(
      avdName,
      {
        ...profile.hardware,
        "PlayStore.enabled": profile.playStore && isPlayStoreImage(image) ? "yes" : "no",
      },
      (line) => !isSeedHardwareLine(line),
    );
    const bootPropPath = `${this.#configIniPath(avdName).replace(/\/config\.ini$/, "")}/boot.prop`;
    const properties = Object.entries(profile.bootProperties);
    if (properties.length > 0) {
      await this.#filesystem.writeFileAtomic(
        bootPropPath,
        `${properties.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
      );
    } else if (await this.#filesystem.exists(bootPropPath)) {
      await this.#filesystem.rm(bootPropPath);
    }
  }

  async #applyHardwareProperties(
    avdName: string,
    properties: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#mergeConfigIniLines(avdName, properties);
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const image = this.#matchingImage(await this.#installedImages(), component, undefined);
    return image === undefined ? undefined : this.#installedComponent(image);
  }

  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    const packageName = systemImagePackage(component, "google_apis", this.#hostAbi);
    const before = await Promise.all(
      (await this.#installedImages()).map(async (image) => this.#imageReceipt(image)),
    );
    await this.#installSystemImageOrThrow(packageName, options);

    const image = (await this.#installedImages()).find(
      (candidate) =>
        systemImagePackage(candidate.apiLevel, candidate.tag, candidate.abi) === packageName,
    );
    if (image === undefined) {
      throw new DriverCrashError(
        `sdkmanager reported success but ${packageName} is still not installed`,
      );
    }
    const installed = await this.#installedComponent(image);
    const wasThere = before.some((receipt) => sameReceipt(receipt, installed.receipt));
    return { ...installed, outcome: wasThere ? "already-installed" : "installed" };
  }

  async listComponents(): Promise<readonly DriverComponent[]> {
    return (await this.#listedImages()).map(({ image: _image, ...component }) => component);
  }

  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    return removeListedComponent({
      list: () => this.#listedImages(),
      platform: this.platform,
      receipt,
      remove: async ({ image }) => {
        await this.#uninstall(systemImagePackage(image.apiLevel, image.tag, image.abi), options);
        return {};
      },
    });
  }

  async #uninstall(packageName: string, options: { readonly signal: AbortSignal }): Promise<void> {
    const command = `${this.#sdk.sdkmanager} --uninstall ${packageName}`;
    let outcome;
    try {
      outcome = await runBoundedProcess(
        this.#processRunner,
        this.#clock,
        this.#sdk.sdkmanager,
        ["--uninstall", packageName],
        { signal: options.signal, timeoutMs: COMPONENT_REMOVAL_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      throw new DriverCrashError(
        `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome.timedOut) {
      throw new DriverCrashError(
        `${command} timed out after ${String(COMPONENT_REMOVAL_TIMEOUT_MS)}ms`,
      );
    }
    if (outcome.stopped) throw new DriverCrashError(`${command} was ended before it finished`);
    if (outcome.result.code !== 0) {
      throw new DriverCrashError(
        `${command} failed: ${outcome.result.stderr || outcome.result.stdout}`,
      );
    }
  }

  async #listedImages(): Promise<(DriverComponent & { readonly image: SystemImage })[]> {
    const [images, foreignAvds] = await Promise.all([
      this.#installedImages(),
      this.#foreignAvdImageDirectories(),
    ]);
    return Promise.all(
      images.map(async (image): Promise<DriverComponent & { readonly image: SystemImage }> => {
        const sizeBytes = await this.#filesystem.directorySize(image.path).catch(() => undefined);
        const directories = [image.path, relativeImageDirectory(image)];
        return {
          ...(await this.#installedComponent(image)),
          image,
          foreignDevices: foreignAvds.filter((named) =>
            named.some((directory) => directories.includes(directory)),
          ).length,
          variant: `${image.tag}/${image.abi}`,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        };
      }),
    );
  }

  /**
   * why: For every AVD in the user's own AVD home, the image directories its `config.ini` names
   * (`image.sysdir.N`), without trailing slashes. Read-only (safety rule 1). A home or a
   * `config.ini` that does not exist names no image. Any other read failure rejects: a count that
   * silently left an AVD out would read as "nothing of the user's uses this image". A home that is
   * this driver's own root -- the daemon started from a lease's environment -- holds Simlock's
   * AVDs, which the registry counts, and none of the user's.
   */
  async #foreignAvdImageDirectories(): Promise<readonly (readonly string[])[]> {
    const home = this.#legacyAvdHome;
    if (home === this.#deviceRoot) return [];
    let entries: string[];
    try {
      entries = await this.#filesystem.readdir(home);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    const avds = entries
      .filter((entry) => entry.endsWith(".ini"))
      .map(async (entry) => {
        const pointer = await this.#filesystem.readFile(join(home, entry));
        const avdPath =
          iniValues(pointer, /^path$/)[0] ?? join(home, `${entry.slice(0, -".ini".length)}.avd`);
        const config = await this.#readIfPresent(join(avdPath, "config.ini"));
        if (config === undefined) return [];
        return iniValues(config, /^image\.sysdir\.\d+$/).map((value) => value.replace(/\/+$/, ""));
      });
    return Promise.all(avds);
  }

  async #readIfPresent(path: string): Promise<string | undefined> {
    try {
      return await this.#filesystem.readFile(path);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  async #installedComponent(image: SystemImage): Promise<InstalledComponent> {
    return { receipt: await this.#imageReceipt(image), version: image.apiLevel };
  }

  /**
   * why: The one function that builds this driver's receipt (ADR 0010 §5): the package, its
   * revision, and a stamp of the image's own `source.properties` -- which file it is and when it
   * was written -- so an image deleted and installed again at the same revision differs.
   */
  async #imageReceipt(image: SystemImage): Promise<ComponentReceipt> {
    let stamp = "";
    try {
      const stat = await this.#filesystem.stat(`${image.path}/source.properties`);
      stamp = `${stat.identity}@${String(stat.modifiedAtMs)}`;
    } catch {}
    return {
      package: systemImagePackage(image.apiLevel, image.tag, image.abi),
      revision: image.version,
      stamp,
    };
  }

  /**
   * why: Installs a system image, accepting Android SDK licenses first when `sdkmanager` refuses
   * on an unaccepted one and `acceptAndroidLicenses` allows it -- never otherwise: license
   * consent is independent of, and never implied by, download permission.
   */
  async #installSystemImageOrThrow(
    packageName: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    const result = await this.#sdkmanager(["--install", packageName], options);
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

    await this.#acceptLicenses(options);

    const retry = await this.#sdkmanager(["--install", packageName], options);
    if (retry.code !== 0 || hasUnacceptedLicense(retry)) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --install ${packageName} still failed after accepting licenses: ` +
          `${retry.stderr || retry.stdout}`,
      );
    }
  }

  async #acceptLicenses(options: {
    readonly onProgress: (progress: ComponentInstallProgress) => void;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const result = await this.#sdkmanager(["--licenses"], {
      ...options,
      // why: `sdkmanager --licenses` prompts once per outstanding license; answering more times
      // than there are real licenses is harmless (see `LICENSE_ACCEPT_ANSWERS`).
      input: "y\n".repeat(LICENSE_ACCEPT_ANSWERS),
    });
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} --licenses failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  async #sdkmanager(
    args: readonly string[],
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
      readonly input?: string;
    },
  ): Promise<ProcessResult> {
    let outcome;
    try {
      outcome = await runInstallerProcess(
        this.#processRunner,
        this.#clock,
        this.#sdk.sdkmanager,
        args,
        options,
      );
    } catch (error: unknown) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} ${args.join(" ")} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome.stopped) {
      throw new DriverCrashError(
        `${this.#sdk.sdkmanager} ${args.join(" ")} was ended before it finished`,
      );
    }
    return outcome.result;
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
      // why: A dot entry (`.DS_Store`, an editor's swap file) is never a tag or an ABI.
      for (const tag of (await this.#filesystem.readdir(apiPath)).filter(isVisibleEntry)) {
        const tagPath = `${apiPath}/${tag}`;
        for (const abi of (await this.#filesystem.readdir(tagPath)).filter(isVisibleEntry)) {
          const path = `${tagPath}/${abi}`;
          const properties = await readSourceProperties(this.#filesystem, path);
          const sourceApiLevel = sourcePropertyValue(properties, "AndroidVersion.ApiLevel");
          images.push({
            abi,
            apiLevel: apiMatch[1],
            path,
            ...(sourceApiLevel === undefined ? {} : { sourceApiLevel }),
            tag,
            tags: systemImageTags(properties, tag),
            version: await systemImageVersion(this.#filesystem, path),
          });
        }
      }
    }
    return images;
  }

  #matchingImage(
    images: readonly SystemImage[],
    apiLevel: string,
    imageTag: string | undefined,
  ): SystemImage | undefined {
    const matching = images.filter((image) => image.apiLevel === apiLevel);
    if (imageTag !== undefined) {
      const tagged = matching.filter((image) => image.tag === imageTag);
      return tagged.find((image) => image.abi === this.#hostAbi) ?? tagged[0];
    }
    return (
      matching.find((image) => image.tag === "google_apis" && image.abi === this.#hostAbi) ??
      matching.find((image) => image.abi === this.#hostAbi) ??
      matching.find((image) => image.tag === "google_apis") ??
      matching[0]
    );
  }

  async #requireImage(
    profile: DeviceProfile,
    apiLevel: string,
    imageTag: string | undefined,
  ): Promise<SystemImage> {
    const images = await this.#installedImages();
    const image = this.#matchingImage(
      images.filter((candidate) => fits(profile, candidate)),
      apiLevel,
      imageTag,
    );
    if (image === undefined) {
      if (
        imageTag !== undefined &&
        !images.some((i) => i.apiLevel === apiLevel && i.tag === imageTag)
      ) {
        throw new AndroidImageTagMissingError(apiLevel, imageTag);
      }
      throw this.#noFittingImage(profile, images, apiLevel, imageTag);
    }
    return image;
  }

  #taggedApiLevel(
    profile: DeviceProfile,
    images: readonly SystemImage[],
    imageTag: string,
    requested: string | undefined,
  ): string {
    const tagged = images.filter(
      (image) =>
        image.tag === imageTag && (requested === undefined || image.apiLevel === requested),
    );
    if (tagged.length === 0) {
      throw new AndroidImageTagMissingError(requested ?? "default", imageTag);
    }
    const levels = fittingApiLevels(profile, tagged);
    const apiLevel = requested ?? levels.at(-1);
    if (apiLevel === undefined || !levels.includes(apiLevel)) {
      throw this.#noFittingImage(profile, images, requested, imageTag);
    }
    return apiLevel;
  }

  async #configHash(avdName: string, image: SystemImage): Promise<string> {
    return this.#currentConfigHash(avdName, `${image.path}@${image.version}`);
  }

  /**
   * why: What a clean baseline snapshot depends on. A mismatch against the hash stored with the
   * baseline rebuilds it on the next boot rather than loading a snapshot the emulator would
   * refuse, which would degrade every later reclaim to a full wipe.
   */
  async #currentConfigHash(avdName: string, imageIdentity: string): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      this.#emulatorVersion(),
      this.#avdConfig(avdName),
    ]);
    return stableHash([imageIdentity, emulatorVersion, config, ...this.#baselineLaunchInputs]);
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
   * why: Writes the same provenance token into both regions of the mark: the durable
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

  async #mergeConfigIniLines(
    avdName: string,
    entries: Readonly<Record<string, string>>,
    keepLine: (line: string) => boolean = () => true,
  ): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      if (containsForbiddenCharacter(key) || containsForbiddenCharacter(value)) {
        throw new DriverCrashError(
          `Refusing to merge config.ini entry with a line break or NUL (key ${JSON.stringify(key)})`,
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
    const lines = (contents === "" ? [] : contents.replace(/\r?\n$/, "").split(/\r?\n/)).filter(
      keepLine,
    );
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
        // why: A serial that will not answer is a serial the server has no transport for, which
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
          await this.#confirmAvdAnswers(data);
          return;
        }
      }

      await this.#delay(
        Math.min(PORT_POLL_INTERVAL_MS, this.#readinessTimeoutMs - (this.#clock.now() - startedAt)),
      );
    }
  }

  /**
   * why: Proves the emulator that answered the readiness wait on `data.serial` runs this device's
   * AVD, by the AVD directory it reports: only this device's own directory in the device root
   * will do -- not a sibling's, and never a name (safety rule 8). An emulator whose console
   * port is already held exits without answering, so the one that answers is whoever holds
   * the port -- another device, another Simlock instance, the user's own emulator. Refusing
   * here, before a mark or a baseline capture touches it, is what keeps a port collision from
   * readying a device at another device's address; `#serialIsOwn` then keeps the
   * shutdown and destroy that follow a failed boot from sending it `emu kill`, by asking the
   * serial again each time. The reported
   * path is compared whole, and through `realpath` when the two spellings differ (an ancestor
   * symlink such as macOS's `/var` -> `/private/var`); anything unreadable fails closed.
   */
  async #confirmAvdAnswers(data: AndroidDriverData): Promise<void> {
    const expected = `${this.#deviceRoot}/${data.avdName}.avd`;
    const answered = await this.#readAvdPath(data.serial);
    if (await this.#isOwnAvdPath(answered, expected)) {
      return;
    }
    throw new DriverCrashError(
      `Refusing to ready ${data.avdName}: the emulator answering on ${data.serial} runs ${JSON.stringify(answered)}, not ${expected} -- another emulator holds its console port`,
    );
  }

  async #readAvdPath(serial: string): Promise<string> {
    const result = await this.#runOrThrow(this.#sdk.adb, ["-s", serial, "emu", "avd", "path"], {
      timeoutMs: AVD_PATH_TIMEOUT_MS,
    });
    return answeredAvdPath(result.stdout);
  }

  /**
   * why: The gate before any emulator mutation (`emu kill`, snapshot load): asks the emulator on the
   * serial for its AVD path, bounded by a timeout, on every call -- the answer is never kept,
   * because the serial can change hands between calls. An unreachable, timed-out or unreadable
   * answer is "not ours" (fail closed), so nothing is sent.
   */
  async #serialIsOwn(data: AndroidDriverData): Promise<boolean> {
    try {
      const result = await this.#processRunner.run(
        this.#sdk.adb,
        ["-s", data.serial, "emu", "avd", "path"],
        { env: this.#env(), timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS },
      );
      if (result.code !== 0) return false;
      return await this.#isOwnAvdPath(
        answeredAvdPath(result.stdout),
        `${this.#deviceRoot}/${data.avdName}.avd`,
      );
    } catch {
      return false;
    }
  }

  async #isOwnAvdPath(answered: string, expected: string): Promise<boolean> {
    return answered === expected || (await this.#sameDirectory(answered, expected));
  }

  async #sameDirectory(left: string, right: string): Promise<boolean> {
    if (left === right) return true;
    if (!isAbsolute(left)) return false;
    try {
      const [realLeft, realRight] = await Promise.all([
        this.#filesystem.realpath(left),
        this.#filesystem.realpath(right),
      ]);
      return realLeft === realRight;
    } catch {
      return false;
    }
  }

  async #startEmulator(
    data: AndroidDriverData,
    state: DeviceState,
    launchArgs: readonly string[],
    fromSnapshot: boolean,
  ): Promise<void> {
    const startedAt = this.#clock.now();
    // why: `stdio: "ignore"` and `unref()` for the same reason the adb server gets them: an
    // emulator outlives the daemon by design (`#reattachRunningEmulators` adopts it after
    // a restart) and is reaped through adb and by pid, never by awaiting its exit. Left
    // referenced, its handle and stdio pipes would hold the event loop open, and a
    // `daemon stop` that had logged "Daemon stopped" would leave the process alive for as
    // long as any emulator ran.
    const handle = this.#processRunner.spawn(
      this.#sdk.emulator,
      [
        "-avd",
        data.avdName,
        "-port",
        String(data.port),
        "-no-snapshot-save",
        ...this.#emulatorFlags,
        ...launchArgs,
      ],
      { env: this.#env(), stdio: "ignore" },
    );
    handle.unref();
    state.handle = handle;
    // why: No announcement here, deliberately. adb answers `host:emulator:<port>` by connecting
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

  /**
   * why: The one decision both `makeReady` (through `#reconcileBaseline`) and the boot estimate read,
   * so the figure quoted is the boot `makeReady` then takes: `load` where the baseline is recorded
   * and matches the current emulator and image, `stale` where it is recorded but no longer matches,
   * and `none` where a wipe is pending or no baseline is recorded. It changes nothing.
   */
  async #baselineVerdict(
    data: AndroidDriverData,
    needsWipe: boolean,
    imageIdentity: string,
  ): Promise<"load" | "stale" | "none"> {
    const baselineHash = await this.#baselineHash(data.avdName);
    if (needsWipe || baselineHash === undefined) return "none";
    const currentHash = await this.#currentConfigHash(data.avdName, imageIdentity);
    return baselineHash === currentHash ? "load" : "stale";
  }

  async #bootEstimate(
    device: DriverDevice,
    purpose: "prepare" | "recover" | undefined,
    spec: DeviceSpec,
  ): Promise<number> {
    if (spec.physical || purpose === "recover") return COLD_BOOT_ESTIMATE_MS;
    const data = this.#dataFor(device);
    const state = this.#devices.get(data.avdName);
    const verdict = await this.#baselineVerdict(
      data,
      state?.needsWipe === true,
      state?.imageIdentity ?? data.imageIdentity ?? "",
    );
    return verdict === "load" ? SNAPSHOT_BOOT_ESTIMATE_MS : COLD_BOOT_ESTIMATE_MS;
  }

  async #reconcileBaseline(data: AndroidDriverData, state: DeviceState): Promise<void> {
    const verdict = await this.#baselineVerdict(data, state.needsWipe, state.imageIdentity);
    if (verdict === "none") return;
    if (verdict === "load") {
      state.baselineCaptured = true;
      state.snapshotExpected = true;
      return;
    }
    await this.#filesystem.rm(`${this.#deviceRoot}/${data.avdName}.avd/snapshots`);
    state.baselineCaptured = false;
    state.needsWipe = true;
    state.snapshotExpected = false;
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
    if (data.port > 0 && (await this.#serialIsOwn(data))) {
      await this.#processRunner.run(this.#sdk.adb, ["-s", data.serial, "emu", "kill"], {
        env: this.#env(),
      });
    }
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
    let timer: TimerHandle | undefined;
    try {
      return await Promise.race([
        handle.wait().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = this.#clock.setTimer(timeoutMs, () => resolve(false));
        }),
      ]);
    } finally {
      // why: An armed timer holds the event loop open, so a stopped daemon would outlive it (#237).
      if (timer !== undefined) {
        this.#clock.cancel(timer);
      }
    }
  }

  async #runOrThrow(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
  ) {
    // why: The scoped environment unless a caller supplies its own, which only the two legacy
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
      port: undefined,
      restored: true,
      snapshotExpected: false,
    };
    this.#devices.set(data.avdName, restored);
    return restored;
  }

  #assertAndroidSpec(spec: VirtualSpec): void {
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
   * why: The scoped environment and the probe are passed per call rather than held, because one
   * allocator is shared by every driver on a runner (see `portAllocatorFor`) while both
   * belong to one driver instance -- a stored environment would go stale the moment a
   * second driver appeared and would silently poll the wrong adb server.
   *
   * `adb devices` answers only for emulators announced to this instance's own server, so a
   * port it leaves free is then probed: an emulator another Simlock instance started is in
   * neither this process's reservations nor this server's list, but it holds its console
   * port and the adb port above it on the machine, and an emulator told to take either
   * exits at once. Each probe is one loopback connect, refused at once on a free port and
   * bounded by the probe's own timeout otherwise; the walk stops at the first free port, so
   * the wait is at most one probe pair per console port in the range.
   *
   * The probe sees only an emulator that is running now. A port handed out but not booted on
   * -- by another instance, or by this one before a restart emptied `#reserved` -- still
   * reads free here when its device sits between `provision` and `makeReady` or is shut
   * down, and two devices can then reach the same port at boot.
   */
  async allocate(env: NodeJS.ProcessEnv, tcpProbe: TcpProbe): Promise<number> {
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
        if (!unavailable.has(port) && !(await consolePortsInUse(tcpProbe, port))) {
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

async function consolePortsInUse(tcpProbe: TcpProbe, consolePort: number): Promise<boolean> {
  const listening = await Promise.all([
    tcpProbe.isListening(consolePort),
    tcpProbe.isListening(consolePort + 1),
  ]);
  return listening.includes(true);
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
 * why: A `deviceRoot` that is not a usable path refuses this platform's *configuration*, which
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
 * why: The port is only read here; whether it can actually carry a server is the supervisor's
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
  const location = await locateSdk(options.env, options.homeDirectory, options.filesystem);
  if (location.kind === "complete") {
    return location.paths;
  }
  throw new SdkMissingError(location.searched);
}

/**
 * why: No installed image of the requested tag for the API level. Never downloadable: a component is
 * an API level, not a tag, so `--allow-download` cannot supply it; the operator installs it with
 * `sdkmanager`.
 */
class AndroidImageTagMissingError extends RuntimeMissingError {
  constructor(apiLevel: string, imageTag: string) {
    super("android", apiLevel, { downloadable: false });
    this.message =
      apiLevel === "default"
        ? `No ${imageTag} system image is installed for any Android API level`
        : `No ${imageTag} system image is installed for Android API ${apiLevel}`;
  }
}

function installedApiLevels(images: readonly SystemImage[]): string[] {
  // why: a preview folder (`Baklava`) ranks by the highest level any of its images records, so an
  // image that records none cannot make the preview outrank a numeric level.
  const rank = new Map<string, string>();
  for (const image of images) {
    const level = /^\d/.test(image.apiLevel) ? image.apiLevel : image.sourceApiLevel;
    const current = rank.get(image.apiLevel);
    if (level !== undefined && (current === undefined || compareApiLevels(level, current) > 0)) {
      rank.set(image.apiLevel, level);
    }
  }
  return [...new Set(images.map((image) => image.apiLevel))].sort(
    (left, right) =>
      compareApiLevels(rank.get(left) ?? left, rank.get(right) ?? right) ||
      left.localeCompare(right),
  );
}

function fittingApiLevels(profile: DeviceProfile, images: readonly SystemImage[]): string[] {
  return installedApiLevels(images.filter((image) => fits(profile, image)));
}

function isVisibleEntry(name: string): boolean {
  return !name.startsWith(".");
}

function compareCatalogImages(left: DriverCatalogImage, right: DriverCatalogImage): number {
  return (
    compareApiLevels(left.runtime, right.runtime) ||
    left.tag.localeCompare(right.tag) ||
    left.abi.localeCompare(right.abi)
  );
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
  return (await packageRevision(filesystem, imagePath)) ?? "unknown";
}

async function packageRevision(
  filesystem: Filesystem,
  packagePath: string,
): Promise<string | undefined> {
  try {
    const properties = await filesystem.readFile(`${packagePath}/source.properties`);
    const revision = properties
      .split(/\r?\n/)
      .find((line) => line.startsWith("Pkg.Revision="))
      ?.slice("Pkg.Revision=".length)
      .trim();
    return revision === "" ? undefined : revision;
  } catch {
    return undefined;
  }
}

function iniValues(contents: string, key: RegExp): string[] {
  return contents.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || !key.test(line.slice(0, separator).trim())) return [];
    const value = line.slice(separator + 1).trim();
    return value === "" ? [] : [value];
  });
}

function relativeImageDirectory(image: SystemImage): string {
  return `system-images/android-${image.apiLevel}/${image.tag}/${image.abi}`;
}

function answeredAvdPath(stdout: string): string {
  return (stdout.split("\n")[0] ?? "").trim().replace(/(?<=.)\/+$/, "");
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
    // why: Reconnaissance only: an observed device is never granted, so it carries no usable address.
    address: "",
    deviceId: avdName,
    driverData: {
      avdName,
      configHash: "recovered",
      imageIdentity: "",
      port: 0,
      serial: "",
    } satisfies AndroidDriverData,
    // why: Conservative: an emulator serial we can't attribute (transitional adb state) might
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
 * why: `undefined` (no `mark` at all) only when the durable key is absent *and* the device isn't
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

function isSeedHardwareLine(line: string): boolean {
  return (
    (line.startsWith("hw.") && !line.startsWith("hw.cpu.arch=")) ||
    line.startsWith("vm.heapSize=") ||
    line.startsWith("skin.")
  );
}

function assertLibraryProfileWritable(
  profile: Extract<DeviceProfile, { readonly kind: "library" }>,
): void {
  for (const [key, value] of [
    ...Object.entries(profile.hardware),
    ...Object.entries(profile.bootProperties),
  ]) {
    if (containsForbiddenCharacter(key) || containsForbiddenCharacter(value)) {
      throw new DriverCrashError(
        `Refusing library profile ${JSON.stringify(profile.name)}: ${JSON.stringify(key)} holds a line break or NUL`,
      );
    }
  }
}

async function readSourceProperties(
  filesystem: Filesystem,
  imagePath: string,
): Promise<string | undefined> {
  try {
    return await filesystem.readFile(`${imagePath}/source.properties`);
  } catch {
    return undefined;
  }
}

function sourcePropertyValue(properties: string | undefined, key: string): string | undefined {
  const value = properties
    ?.split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();
  return value === undefined || value === "" ? undefined : value;
}

function systemImageTags(properties: string | undefined, folder: string): readonly string[] {
  const tags = (sourcePropertyValue(properties, "SystemImage.TagId") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return tags.length > 0 ? tags : [folder];
}

function emulatorLaunchFlags(
  launch: AndroidEmulatorLaunchOptions = DEFAULT_EMULATOR_LAUNCH,
): string[] {
  return [
    ...(launch.headless ? ["-no-window"] : []),
    ...(launch.gpu === DEFAULT_EMULATOR_LAUNCH.gpu ? [] : ["-gpu", launch.gpu]),
    ...(launch.audio ? [] : ["-no-audio"]),
    ...(launch.bootAnimation ? [] : ["-no-boot-anim"]),
  ];
}

/**
 * why: The launch settings a baseline snapshot depends on: the window and the GPU mode change the
 * emulator's graphics state, so a baseline taken under one does not load cleanly under the
 * other. Audio and the boot animation do not, and stay out. Nothing is added while both are at
 * their defaults, so a baseline captured before these settings existed keeps its hash and is
 * not rebuilt (with a data wipe) on the first boot after an upgrade.
 */
function baselineLaunchInputs(
  launch: AndroidEmulatorLaunchOptions = DEFAULT_EMULATOR_LAUNCH,
): string[] {
  if (
    launch.headless === DEFAULT_EMULATOR_LAUNCH.headless &&
    launch.gpu === DEFAULT_EMULATOR_LAUNCH.gpu
  ) {
    return [];
  }
  return [`headless=${String(launch.headless)}`, `gpu=${launch.gpu}`];
}

function prepareLaunchArgs(state: DeviceState): readonly string[] {
  if (state.needsWipe) {
    return ["-wipe-data", "-no-snapshot-load"];
  }
  return state.snapshotExpected ? ["-snapshot", CLEAN_BASELINE] : ["-no-snapshot-load"];
}

function stableHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join("\u0000")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hostAbiFor(architecture: string): string {
  return architecture === "arm64" ? "arm64-v8a" : "x86_64";
}

/**
 * why: `sdkmanager --install` reports an unaccepted license in its output rather than through a
 * dedicated exit code, so this is a best-effort text match against sdkmanager's own wording
 * (e.g. `Warning: License for package ... not accepted.` /
 * `... licenses have not been accepted.`), checked across both streams since sdkmanager splits
 * its output between them across versions.
 */
function hasUnacceptedLicense(result: ProcessResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  // why: Covers both documented sdkmanager phrasings: "License for package ... not accepted." and
  // "licenses have not been accepted." -- the latter has "been" between "not" and "accepted".
  return /licen[cs]e/i.test(combined) && /not (?:been )?accepted/i.test(combined);
}

/**
 * why: `devices.xml` is found the way `avdmanager` finds it: `ANDROID_USER_HOME`, else
 * `ANDROID_PREFS_ROOT/.android`, else `ANDROID_SDK_HOME/.android`, else `~/.android`. Not
 * `ANDROID_AVD_HOME`, which only relocates created AVDs.
 */
function defaultDeviceProfileSources(
  options: AndroidDriverOptions,
  sdk: AndroidSdkPaths,
  onDiagnostic: ((diagnostic: AndroidDriverDiagnostic) => void) | undefined,
  env: () => NodeJS.ProcessEnv,
): {
  readonly library: DeviceProfileSource;
  readonly builtin: DeviceProfileSource;
  readonly user: DeviceProfileSource;
} {
  const { ANDROID_PREFS_ROOT, ANDROID_SDK_HOME, ANDROID_USER_HOME } = options.env;
  const devicesXmlPath =
    ANDROID_USER_HOME !== undefined
      ? `${ANDROID_USER_HOME}/devices.xml`
      : `${ANDROID_PREFS_ROOT ?? ANDROID_SDK_HOME ?? options.homeDirectory}/.android/devices.xml`;
  return {
    library: new LibraryDeviceProfileSource(),
    // why: Scoped like every other call: an unscoped `avdmanager` would read the user's `~/.android`.
    builtin: new BuiltinDeviceProfileSource(sdk.avdmanager, options.processRunner, env),
    user: new UserDeviceProfileSource(devicesXmlPath, options.filesystem, onDiagnostic),
  };
}

// why: an emulator's capture target -- the same `adb -s <serial> …` with this driver's scoped env
// that every other emulator call carries, and raw connections to Simlock's own adb server. A phone
// gets its target from the physical handler, behind that server's version check; the capture itself
// names neither a port nor a check.
function emulatorScreenTarget(
  processRunner: ProcessRunner,
  adb: string,
  tcp: TcpStreamConnector,
  serverPort: number,
  env: () => NodeJS.ProcessEnv,
  serial: string,
  device: VirtualDriverDevice,
): ScreenTarget {
  if (serial === "") {
    throw new ScreenUnavailableError(
      `${device.deviceId} is not running, so it has no screen to stream`,
    );
  }
  return {
    connect: async (timeoutMs) => await tcp.connect(serverPort, timeoutMs),
    serial,
    spawn: async (args) => processRunner.spawn(adb, ["-s", serial, ...args], { env: env() }),
    run: async (args, timeoutMs) =>
      await processRunner.run(adb, ["-s", serial, ...args], { env: env(), timeoutMs }),
  };
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
export { androidDeviceDataTable } from "./device-data.js";
export { androidPrerequisites } from "./prerequisites.js";

function virtualReclaimStrategy(clean: "standard" | "full"): "snapshot" | "wipe" {
  return clean === "full" ? "wipe" : "snapshot";
}
