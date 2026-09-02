import { dirname, join } from "node:path";

import {
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  DriverCrashError,
  type DriverEstimate,
  type DriverReality,
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type LegacyDevice,
  type ObservedDevice,
  OwnedRootError,
  type PassthroughCommand,
  PassthroughRefusedError,
  type ObservedRunState,
  RuntimeMissingError,
  UnknownModelError,
  validateOwnedRoot,
  type ValidateOwnedRootOptions,
} from "../../core/index.js";
import type { ObservedMark } from "../../core/driver.js";
import type { DeviceSpec } from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  IdGenerator,
  ProcessResult,
  ProcessRunner,
} from "../../ports/index.js";

const COMMAND_TIMEOUT_MS = 30_000;
const BOOTSTATUS_TIMEOUT_MS = 120_000;
const PROVISION_ESTIMATE_MS = 500;
// A cold `simctl boot` to `bootstatus` measures roughly 30s on a fast, idle machine and up to
// a minute on a loaded or slower one. The upper end is the estimate, deliberately: this number
// is what a waiting requester is quoted, and quoting 30s to someone who then waits 60s is the
// failure mode #56 is about. The cost is that `Doctor`'s `provisioning` stall threshold widens
// with it -- see the note there on why that is the cheaper of the two errors.
const COLD_BOOT_ESTIMATE_MS = 60_000;
// Measured, not guessed: a single `simctl erase` took ~34s in #43's investigation. Unlike
// Android, iOS has no deferred-wipe path -- `erase` is synchronous and every reclaim pays it,
// at either clean level, so this is the only reclaim number the driver has.
const ERASE_ESTIMATE_MS = 34_000;
const MARK_FILE_NAME = "simlock-mark.json";
/**
 * The `simlock <tool>` wrapper this driver answers to. Published as a constant because a
 * driver that refused to start has no instance to ask, and `DriverRejection` carries the
 * name so `simlock simctl` can say why it is unavailable rather than reading as a missing
 * SDK.
 */
export const IOS_PASSTHROUGH_TOOL = "simctl";

/**
 * Verbs `simlock simctl` will not proxy. Every one of them changes a device's lifecycle,
 * which the registry -- not `simctl` -- is the record of: a device created here has no
 * registry entry and reads as an orphan, and one erased or deleted under a live lease
 * reads as tampering on the next reconcile. Injecting `--set` for them would hand back
 * exactly the capability the device set exists to take away (ADR 0001, decision 7).
 */
const REFUSED_SIMCTL_VERBS = new Set(["create", "erase", "delete"]);

/**
 * simctl's usage is `simctl [--set <path>] [--profiles <path>] <subcommand>`, so these are
 * the only two globals whose value is a separate argv entry -- and a separated value is
 * indistinguishable from a subcommand once it is in the array, which is how
 * `--profiles /tmp erase all` used to read as the subcommand `/tmp` and slide past every
 * refusal below. Refusing them is what makes "the first non-flag argument is the
 * subcommand" true by construction rather than by pattern-matching. It is also right on
 * its own terms: this wrapper exists to supply the device set, and a caller-supplied one
 * would aim Simlock's own containment wherever it pointed.
 */
const CALLER_SUPPLIED_SCOPE_FLAGS = new Set(["set", "profiles"]);

/**
 * `shutdown all` is the iOS analogue of `adb kill-server`: it stops every device in the
 * set, for every agent, and each affected lease then spends its recovery budget rebooting
 * -- one that runs out ends as `lease_lost`. Shutting down a single device stays allowed.
 */
const SHUTDOWN_ALL_TARGET = "all";

/** Every lifecycle refusal ends the same way: the Simlock command that does it safely. */
const RECLAIM_INSTEAD =
  "Use `simlock release` (which reclaims the device for you) or `simlock cleanup` instead.";

interface IosDriverData {
  readonly deviceTypeId: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly udid: string;
}

export interface IosSimctlDriverOptions {
  readonly clock: Clock;
  /** This driver's own `drivers.ios` block, handed over unread by the core. */
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  /** Identity every device root's ownership marker is checked against. */
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  /** `SIMLOCK_HOME`, from which the default device root is derived here rather than in the core. */
  readonly simlockHome: string;
  /** `process.getuid?.()`; `undefined` skips the root's ownership check. */
  readonly uid?: number;
}

interface DeviceType {
  readonly identifier: string;
  readonly name: string;
}

interface Runtime {
  readonly identifier: string;
  readonly name: string;
  readonly version: string;
  readonly isAvailable: boolean;
}

interface SimctlCatalog {
  readonly deviceTypes: readonly DeviceType[];
  readonly runtimes: readonly Runtime[];
}

interface ResolvedIosSpec {
  readonly deviceType: DeviceType;
  readonly runtime: Runtime;
  readonly spec: DeviceSpec;
}

type ProcessOutcome =
  | { readonly kind: "finished"; readonly result: ProcessResult }
  | { readonly kind: "timed-out" };

/** iOS simulator implementation. Its simctl details remain opaque to the core. */
export class IosSimctlDriver implements Driver {
  readonly platform = "ios" as const;
  readonly #clock: Clock;
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #processRunner: ProcessRunner;
  readonly #resolvedSpecs = new Map<string, ResolvedIosSpec>();
  readonly #deviceRoot: string;
  readonly #rootOptions: ValidateOwnedRootOptions;

  private constructor(
    options: IosSimctlDriverOptions,
    deviceRoot: string,
    rootOptions: ValidateOwnedRootOptions,
  ) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#processRunner = options.processRunner;
    this.#deviceRoot = deviceRoot;
    this.#rootOptions = rootOptions;
  }

  /**
   * Establishes the device set this driver owns before it can be asked to do anything,
   * which is why construction is asynchronous: a driver that had not yet proven its root
   * would be a driver that can address devices it cannot prove are Simlock's, and every
   * later `--set` would be pointing at an unvalidated path. An `OwnedRootError` here is
   * the fail-closed path -- the caller skips iOS entirely rather than falling back to the
   * machine's default device set (safety rule 9).
   */
  static async create(options: IosSimctlDriverOptions): Promise<IosSimctlDriver> {
    const rootOptions: EnsureOwnedRootOptions = {
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "ios",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    };
    const deviceRoot = await ensureOwnedRoot(rootOptions);

    return new IosSimctlDriver(options, deviceRoot, rootOptions);
  }

  get deviceRoot(): string {
    return this.#deviceRoot;
  }

  /**
   * The checks `create` made, minus the one thing a re-proof must never do: create. It is
   * asked for immediately before Simlock destroys anything inside this set, since between
   * then and startup the path can have become a symlink, or a `mv` can have left the user's
   * own device set standing where this one was -- and a set that has simply gone (an
   * `rm -rf`, an unmounted volume) refuses here rather than being rebuilt empty under a
   * device list that describes what used to be in it.
   */
  async revalidateRoot(): Promise<void> {
    await validateOwnedRoot(this.#rootOptions);
  }

  async resolveSpec(
    request: DeviceRequest,
    _options: { readonly allowDownload: boolean },
  ): Promise<DeviceSpec> {
    this.#requireIosPlatform(request.platform);
    const catalog = await this.#loadCatalog();
    const deviceType = catalog.deviceTypes.find(
      (candidate) => candidate.name.toLocaleLowerCase() === request.model.toLocaleLowerCase(),
    );

    if (deviceType === undefined) {
      throw new UnknownModelError(this.platform, request.model);
    }

    const installedRuntimes = catalog.runtimes.filter((runtime) => runtime.isAvailable);
    const runtime =
      request.osVersion === undefined
        ? newestRuntime(installedRuntimes)
        : installedRuntimes.find((candidate) => candidate.version === request.osVersion);

    if (runtime === undefined) {
      throw new IosRuntimeMissingError(request.osVersion ?? "default");
    }

    const spec: DeviceSpec = {
      model: deviceType.name,
      osVersion: runtime.version,
      platform: this.platform,
    };
    this.#resolvedSpecs.set(specKey(spec), { deviceType, runtime, spec });
    return spec;
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    this.#requireIosPlatform(spec.platform);
    const resolved = await this.#resolvedSpec(spec);
    // Cosmetic, and deliberately so: what proves this device is Simlock's is that it
    // lives in the device set every call below is scoped to, never what it is called
    // (safety rule 8). The name exists because it is what a human reads in `simctl list`
    // and in the simulator's window title.
    const name = `simlock-${this.#idGenerator.generate()}`;
    const result = await this.#simctl(
      ["create", name, resolved.deviceType.identifier, resolved.runtime.identifier],
      COMMAND_TIMEOUT_MS,
    );
    const udid = result.stdout.trim();

    if (udid === "") {
      throw new DriverCrashError("simctl create returned no device UDID");
    }

    await this.#writeMark(udid);

    return {
      address: udid,
      deviceId: udid,
      driverData: {
        deviceTypeId: resolved.deviceType.identifier,
        name,
        runtimeId: resolved.runtime.identifier,
        udid,
      } satisfies IosDriverData,
    };
  }

  /** The UDID never changes across a boot -- unlike Android's port, there is nothing to re-derive. */
  async makeReady(device: DriverDevice): Promise<DriverDevice> {
    const data = iosDriverData(device);
    const boot = await this.#invokeSimctl(["boot", data.udid], COMMAND_TIMEOUT_MS);
    if (boot.kind === "timed-out") {
      throw new BootTimeoutError(device.deviceId);
    }
    if (boot.result.code !== 0 && !alreadyBooted(boot.result.stderr)) {
      this.#assertSuccessful(["boot", data.udid], boot.result);
    }
    const outcome = await this.#invokeSimctl(
      ["bootstatus", data.udid, "-b"],
      BOOTSTATUS_TIMEOUT_MS,
    );

    if (outcome.kind === "timed-out") {
      await this.#bestEffortShutdown(data.udid);
      throw new BootTimeoutError(device.deviceId);
    }

    this.#assertSuccessful(["bootstatus", data.udid, "-b"], outcome.result);
    return { address: data.udid, deviceId: device.deviceId, driverData: device.driverData };
  }

  async reclaim(
    device: DriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): Promise<{ readonly state: "shutdown"; readonly strategy: "erase" }> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["erase", data.udid], COMMAND_TIMEOUT_MS);
    await this.#writeMark(data.udid);

    return { state: "shutdown", strategy: "erase" };
  }

  reclaimStrategy(_options: { readonly clean: "standard" | "full" }): "erase" {
    return "erase";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#shutdown(iosDriverData(device).udid);
  }

  async destroy(device: DriverDevice): Promise<void> {
    const data = iosDriverData(device);
    await this.#shutdown(data.udid);
    await this.#simctl(["delete", data.udid], COMMAND_TIMEOUT_MS);
  }

  /**
   * The machine's default device set, where every simulator Simlock created before it owned
   * one still lives. One listing per reconcile, not one per missing device: `simctl list` is
   * a subprocess with a 30s timeout and its answer is the same for every UDID asked about.
   * It reads and nothing more -- `list` is the one unscoped call that mutates nothing -- and
   * the entries are candidates, never findings: only the ones a registry record names ever
   * reach a destroy.
   */
  async listLegacy(): Promise<readonly LegacyDevice[]> {
    const result = await this.#legacySimctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);

    return parseManagedDevices(JSON.parse(result.stdout) as unknown).map((found) => ({
      device: {
        address: found.udid,
        deviceId: found.udid,
        driverData: {
          deviceTypeId: "",
          name: found.name,
          runtimeId: "",
          udid: found.udid,
        } satisfies IosDriverData,
      },
      // CoreSimulator lays every set out as `<set>/<UDID>`, data container included, so the
      // container's parent is the device directory -- and where the *old* set is is exactly
      // what this driver no longer knows any other way (ADR 0001, consequences).
      ...(found.dataPath === undefined ? {} : { path: dirname(found.dataPath) }),
    }));
  }

  /**
   * Destroys a pre-root simulator through the unscoped path it actually sits on. Permitted
   * despite living outside this driver's root because the registry names it: registry-only
   * destruction (safety rule 1) is satisfied by the record, not by the root. `doctor --fix`
   * is the only caller, and it checks the lease guard before asking.
   *
   * It stops the device first, where Android's `destroyLegacy` refuses a running one
   * outright, and the asymmetry is deliberate: there is one CoreSimulator service per user
   * and Simlock is already talking to it, so shutting a simulator down here uses no
   * privilege the scoped path does not already have. Android's pre-root emulators answer to
   * the user's own adb server instead, which Simlock does not own and will not drive.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { udid } = iosDriverData(device);
    // Best effort, exactly as the scoped `#shutdown` is: a device that is already shut down
    // reports a failure that says nothing about whether the delete can proceed.
    await this.#invokeLegacySimctl(["shutdown", udid], COMMAND_TIMEOUT_MS);
    await this.#legacySimctl(["delete", udid], COMMAND_TIMEOUT_MS);
  }

  async listManaged(): Promise<DriverReality> {
    const result = await this.#simctl(["list", "-j", "devices"], COMMAND_TIMEOUT_MS);
    const parsed = parseManagedDevices(JSON.parse(result.stdout) as unknown);
    const devices: ObservedDevice[] = await Promise.all(
      parsed.map(async (device) => {
        const mark = await this.#readMark(device.udid);
        return {
          address: device.udid,
          deviceId: device.udid,
          driverData: {
            deviceTypeId: "",
            name: device.name,
            runtimeId: "",
            udid: device.udid,
          } satisfies IosDriverData,
          runState: device.runState,
          ...(mark !== undefined ? { mark } : {}),
        };
      }),
    );
    const processes = devices.filter((device) => device.runState === "running");
    return { devices, processes };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const catalog = await this.#loadCatalog();
    const installedRuntimes = catalog.runtimes.filter((runtime) => runtime.isAvailable);
    return {
      defaultRuntime: newestRuntime(installedRuntimes)?.version,
      models: catalog.deviceTypes.map((deviceType) => deviceType.name),
      runtimes: installedRuntimes.map((runtime) => runtime.version),
    };
  }

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    switch (estimate.operation) {
      case "provision":
        return PROVISION_ESTIMATE_MS;
      case "boot":
        return COLD_BOOT_ESTIMATE_MS;
      case "reclaim":
        // `reclaimStrategy` returns `erase` for both clean levels, so there is nothing to
        // branch on here -- the clean level only matters to a driver that has a fast path.
        return ERASE_ESTIMATE_MS;
    }
  }

  /**
   * The device-set path a lease holder needs to address its simulator at all: inside a
   * custom set a UDID resolves to nothing without it. `docs/CLI.md` publishes the variable
   * name, and `simlock simctl` reads it back.
   */
  leaseEnvironment(): Readonly<Record<string, string>> {
    return { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
  }

  readonly passthroughTool = IOS_PASSTHROUGH_TOOL;

  /**
   * `xcrun simctl --set <root> <args...>`: the same insertion `#invokeSimctl` makes, for a
   * command the caller runs itself. This is still an accident boundary and not a security
   * one (ADR 0001, "Not a security boundary") -- someone who wants to can run
   * `xcrun simctl --set` themselves -- but the wrapper must never be the thing that hands
   * over the set path, so the two globals that could disguise a refused verb are refused
   * before the verb is resolved at all.
   */
  passthrough(args: readonly string[]): PassthroughCommand {
    this.#assertProxyable(args);
    // No environment: on iOS the device set only ever reaches simctl on the command line
    // (ADR 0001 records that every candidate variable was tried and ignored).
    return { args: ["simctl", "--set", this.#deviceRoot, ...args], command: "xcrun", env: {} };
  }

  #assertProxyable(args: readonly string[]): void {
    const [verb, ...operands] = this.#subcommand(args);
    if (verb === undefined) return;
    if (REFUSED_SIMCTL_VERBS.has(verb)) {
      this.#refuse(
        verb,
        `it changes a device's lifecycle behind Simlock's registry, which would report the device as drifted on the next reconcile. ${RECLAIM_INSTEAD}`,
      );
    }
    if (verb === "shutdown" && operands.includes(SHUTDOWN_ALL_TARGET)) {
      this.#refuse(
        `shutdown ${SHUTDOWN_ALL_TARGET}`,
        `it stops every device in Simlock's set at once -- every agent's, not just yours -- and each interrupted lease spends its recovery budget rebooting, so one that runs out ends as \`lease_lost\`. Shutting a single device down by udid is still allowed. ${RECLAIM_INSTEAD}`,
      );
    }
    // A bare `simctl` reaches this too, so refusing it takes no capability away. The
    // wrapper is advertised as the safe path, and being the convenient route to an
    // unrecoverable multi-gigabyte deletion is not that.
    if (verb === "runtime" && operands.find((operand) => !operand.startsWith("-")) === "delete") {
      this.#refuse(
        "runtime delete",
        "it deletes a runtime shared with Xcode, and Simlock will not download one back (`--allow-download` cannot install iOS runtimes). Delete it through Xcode if that is really what you meant.",
      );
    }
  }

  #refuse(command: string, guidance: string): never {
    throw new PassthroughRefusedError(
      this.passthroughTool,
      `Refusing \`simlock simctl ${command}\`: ${guidance}`,
    );
  }

  /**
   * The subcommand and its operands, refusing on the way anything that could be mistaken
   * for a subcommand. A caller-supplied `--set`/`--profiles` (any spelling, `--set=<path>`
   * included) is the only way a non-flag argument can precede the subcommand, so once
   * those are gone the first non-flag argument *is* the subcommand.
   */
  #subcommand(args: readonly string[]): readonly string[] {
    for (const [index, argument] of args.entries()) {
      if (!argument.startsWith("-")) return args.slice(index);
      const flag = /^-+([^=]*)/.exec(argument)?.[1];
      if (flag !== undefined && CALLER_SUPPLIED_SCOPE_FLAGS.has(flag)) {
        throw new PassthroughRefusedError(
          this.passthroughTool,
          `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and a caller-supplied \`--${flag}\` would point simctl somewhere Simlock does not manage. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
        );
      }
    }
    return [];
  }

  /** CoreSimulator lays a set out as `<set>/<UDID>`, so no subprocess can tell us more. */
  #deviceDirectory(udid: string): string {
    return join(this.#deviceRoot, udid);
  }

  /**
   * Data-container path for a device, derived rather than looked up. The driver used to
   * learn it from a `simctl list` (~260ms, on `reclaim`, which runs on every release)
   * because it did not know where its devices lived; owning the set means it does.
   */
  #dataPathFor(udid: string): string {
    return join(this.#deviceDirectory(udid), "data");
  }

  /**
   * Writes the same provenance token into both regions of a device: the
   * device root (durable -- survives `simctl erase`) and the data container
   * (erasable -- destroyed by it).
   *
   * The erasable half goes first, and the two are not written concurrently, because a
   * half-written pair is read by `Doctor` as tampering: durable-without-erasable is
   * exactly the signature of a foreign erase. Writing the fragile half first means a
   * failure (`<root>/<udid>/data` is not there, so `writeFileAtomic` -- which creates no
   * parents -- cannot land) leaves *neither* mark, which reads as "never marked" and
   * produces no finding at all. The write still throws, so the caller learns something
   * was wrong with the device; what it must never do is accuse the user of erasing a
   * device Simlock itself just erased.
   */
  async #writeMark(udid: string): Promise<void> {
    const token = this.#idGenerator.generate();
    const contents = JSON.stringify({
      token,
      udid,
      writtenAt: new Date(this.#clock.now()).toISOString(),
    });

    await this.#filesystem.writeFileAtomic(join(this.#dataPathFor(udid), MARK_FILE_NAME), contents);
    await this.#filesystem.writeFileAtomic(
      join(this.#deviceDirectory(udid), MARK_FILE_NAME),
      contents,
    );
  }

  /**
   * Reads both provenance regions for a managed device. Both regions are
   * host-side files readable while the device is shut down, so
   * `erasableReadable` is always `true` on iOS -- the field only ever goes
   * `false` for Android, where the erasable mark lives on-device and is
   * unreachable while the emulator isn't running. A device this driver never
   * marked (both regions absent, e.g. provisioned before this feature
   * shipped) reports `undefined` rather than a half-empty mark, so it stays
   * quiet instead of classifying as tampered on every tick.
   */
  async #readMark(udid: string): Promise<ObservedMark | undefined> {
    const durable = await this.#readToken(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    const erasable = await this.#readToken(join(this.#dataPathFor(udid), MARK_FILE_NAME));

    if (durable === undefined && erasable === undefined) {
      return undefined;
    }

    return { durable, erasable, erasableReadable: true };
  }

  /**
   * A missing file and a corrupt one both read as an absent mark -- the core
   * classifies "absent" from "present but wrong" itself, and a read must
   * never throw out of `listManaged`.
   */
  async #readToken(path: string): Promise<string | undefined> {
    try {
      const contents = await this.#filesystem.readFile(path);
      const parsed = JSON.parse(contents) as unknown;
      return isRecord(parsed) && typeof parsed.token === "string" && parsed.token !== ""
        ? parsed.token
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #resolvedSpec(spec: DeviceSpec): Promise<ResolvedIosSpec> {
    const existing = this.#resolvedSpecs.get(specKey(spec));
    if (existing !== undefined) {
      return existing;
    }

    await this.resolveSpec(spec, { allowDownload: false });
    const resolved = this.#resolvedSpecs.get(specKey(spec));
    if (resolved === undefined) {
      throw new DriverCrashError("simctl did not resolve the requested device specification");
    }

    return resolved;
  }

  async #loadCatalog(): Promise<SimctlCatalog> {
    const result = await this.#simctl(
      ["list", "-j", "devicetypes", "runtimes"],
      COMMAND_TIMEOUT_MS,
    );

    try {
      return parseCatalog(JSON.parse(result.stdout) as unknown);
    } catch (error: unknown) {
      if (error instanceof DriverCrashError) {
        throw error;
      }

      throw new DriverCrashError(`Could not parse simctl device catalog: ${errorMessage(error)}`);
    }
  }

  async #shutdown(udid: string): Promise<void> {
    const outcome = await this.#invokeSimctl(["shutdown", udid], COMMAND_TIMEOUT_MS);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl shutdown ${udid} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }
    if (outcome.result.code !== 0 && !alreadyShutdown(outcome.result.stderr)) {
      this.#assertSuccessful(["shutdown", udid], outcome.result);
    }
  }

  async #bestEffortShutdown(udid: string): Promise<void> {
    try {
      await this.#shutdown(udid);
    } catch {
      // Boot failure cleanup must not obscure the timeout that triggered it.
    }
  }

  async #simctl(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return this.#checked(args, timeoutMs, await this.#invokeSimctl(args, timeoutMs));
  }

  async #legacySimctl(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return this.#checked(args, timeoutMs, await this.#invokeLegacySimctl(args, timeoutMs));
  }

  #checked(args: readonly string[], timeoutMs: number, outcome: ProcessOutcome): ProcessResult {
    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }

    this.#assertSuccessful(args, outcome.result);
    return outcome.result;
  }

  /**
   * The single insertion point for `--set`, which scopes every subcommand to the root this
   * driver owns and must therefore precede the subcommand. Every call in this file is
   * spawned through here or through `#invokeLegacySimctl`, and nothing else: a scoped call
   * that slipped past both would address the machine's default set, where Simlock can prove
   * nothing about what it touches.
   */
  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(["simctl", "--set", this.#deviceRoot, ...args], timeoutMs);
  }

  /**
   * Deliberately unscoped, and the only thing in Simlock that is: the pre-root devices
   * `listLegacy` / `destroyLegacy` deal with are in the machine's default set, which is
   * where a `--set` would stop reaching them. Only those two may call it, and only for a
   * UDID a registry record names -- registry-only destruction (safety rule 1) is satisfied
   * by that record, not by the root.
   */
  async #invokeLegacySimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    return this.#invokeXcrun(["simctl", ...args], timeoutMs);
  }

  async #invokeXcrun(argv: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    let process;
    try {
      process = this.#processRunner.spawn("xcrun", [...argv], { timeoutMs });
    } catch (error: unknown) {
      throw new DriverCrashError(`Could not start ${argv.join(" ")}: ${errorMessage(error)}`);
    }

    let resolveTimeout: (() => void) | undefined;
    const timedOut = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    const timer = this.#clock.setTimer(timeoutMs, () => {
      resolveTimeout?.();
      try {
        process.kill("SIGTERM");
      } catch {
        // A process that has already exited needs no timeout cleanup.
      }
    });

    try {
      return await Promise.race([
        process.wait().then((result) => ({ kind: "finished" as const, result })),
        timedOut.then(() => ({ kind: "timed-out" as const })),
      ]);
    } catch (error: unknown) {
      throw new DriverCrashError(`${argv.join(" ")} failed: ${errorMessage(error)}`);
    } finally {
      this.#clock.cancel(timer);
    }
  }

  #assertSuccessful(args: readonly string[], result: ProcessResult): void {
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      const suffix = stderr === "" ? "" : `: ${stderr}`;
      throw new DriverCrashError(
        `simctl ${args.join(" ")} exited with code ${String(result.code)}${suffix}`,
      );
    }
  }

  #requireIosPlatform(platform: string): void {
    if (platform !== this.platform) {
      throw new DriverCrashError(`iOS simctl driver cannot handle ${platform} device requests`);
    }
  }
}

class IosRuntimeMissingError extends RuntimeMissingError {
  constructor(osVersion: string) {
    super("ios", osVersion);
    this.message = `iOS runtime ${osVersion} is not installed; install it via Xcode`;
  }
}

/**
 * The configured root, or the per-home default. The default is computed here and not in
 * the core because what `drivers.ios.deviceRoot` means is this module's business
 * (architecture rule 2); the core only hands over the block and `SIMLOCK_HOME`.
 */
function configuredDeviceRoot(options: IosSimctlDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    // A `deviceRoot` that is not a usable path refuses this platform's *configuration*,
    // which costs iOS and nothing else -- the same as every other refusal here. It is not
    // a daemon-fatal error: `"deviceRoot": true` and `"deviceRoot": "devices/ios"` are one
    // keystroke apart, and killing the process over the first would take Android down with
    // it and leave the reason unreachable, since `doctor` -- where `docs/CLI.md` promises
    // it appears -- needs a daemon to answer. `not-absolute` is the vocabulary term the
    // docs already publish for "this names no usable directory"; nothing new is invented.
    throw new OwnedRootError(
      `Refusing the ios device root: drivers.ios.deviceRoot must be an absolute path, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "not-absolute",
      String(configured),
      "ios",
    );
  }

  return configured ?? join(options.simlockHome, "devices", "ios");
}

interface ParsedManagedDevice {
  /** Only `listLegacy` reads this; a scoped listing already knows where its devices are. */
  readonly dataPath?: string;
  readonly name: string;
  readonly runState: ObservedRunState;
  readonly udid: string;
}

function parseManagedDevices(value: unknown): ParsedManagedDevice[] {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  return Object.values(value.devices).flatMap((runtimeDevices) =>
    Array.isArray(runtimeDevices) ? runtimeDevices.flatMap(parseManagedDevice) : [],
  );
}

/** An entry simctl reports without a name or a udid is not addressable, so it is skipped. */
function parseManagedDevice(value: unknown): readonly ParsedManagedDevice[] {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.udid !== "string") {
    return [];
  }

  return [
    {
      name: value.name,
      runState: simctlRunState(value.state),
      udid: value.udid,
      ...(typeof value.dataPath === "string" ? { dataPath: value.dataPath } : {}),
    },
  ];
}

/** `simctl` reports `Booting` / `Shutting Down` mid-transition; both must read as `transitioning`, never as drift. */
function simctlRunState(state: unknown): ObservedRunState {
  if (state === "Booted") return "running";
  if (state === "Shutdown") return "stopped";
  return "transitioning";
}

function parseCatalog(value: unknown): SimctlCatalog {
  if (!isRecord(value) || !Array.isArray(value.devicetypes) || !Array.isArray(value.runtimes)) {
    throw new DriverCrashError(
      "Invalid simctl list JSON: expected devicetypes and runtimes arrays",
    );
  }

  const deviceTypes = value.devicetypes.flatMap(parseDeviceType);
  const runtimes = value.runtimes.flatMap(parseRuntime);

  if (deviceTypes.length === 0 || runtimes.length === 0) {
    throw new DriverCrashError("Invalid simctl list JSON: no usable device types or runtimes");
  }

  return { deviceTypes, runtimes };
}

function parseDeviceType(value: unknown): readonly DeviceType[] {
  if (!isRecord(value) || typeof value.identifier !== "string" || typeof value.name !== "string") {
    return [];
  }

  return [{ identifier: value.identifier, name: value.name }];
}

function parseRuntime(value: unknown): readonly Runtime[] {
  if (
    !isRecord(value) ||
    typeof value.identifier !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.isAvailable !== "boolean" ||
    !value.name.toLocaleLowerCase().startsWith("ios ")
  ) {
    return [];
  }

  return [
    {
      identifier: value.identifier,
      isAvailable: value.isAvailable,
      name: value.name,
      version: value.version,
    },
  ];
}

function newestRuntime(runtimes: readonly Runtime[]): Runtime | undefined {
  return [...runtimes].sort((left, right) => compareVersions(left.version, right.version)).at(-1);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(versionPart);
  const rightParts = right.split(".").map(versionPart);
  const partCount = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.localeCompare(right);
}

function versionPart(part: string): number {
  const parsed = Number.parseInt(part, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function iosDriverData(device: DriverDevice): IosDriverData {
  const value = device.driverData;
  if (
    !isRecord(value) ||
    typeof value.udid !== "string" ||
    typeof value.deviceTypeId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new DriverCrashError(`Invalid iOS driver data for device ${device.deviceId}`);
  }

  return {
    deviceTypeId: value.deviceTypeId,
    name: value.name,
    runtimeId: value.runtimeId,
    udid: value.udid,
  };
}

function alreadyShutdown(stderr: string): boolean {
  return /Unable to shutdown.*current state:\s*Shutdown/i.test(stderr);
}

function alreadyBooted(stderr: string): boolean {
  return /current state:\s*Booted|already booted/i.test(stderr);
}

function specKey(spec: DeviceSpec): string {
  return `${spec.model.toLocaleLowerCase()}\u0000${spec.osVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
