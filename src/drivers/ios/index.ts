import { join } from "node:path";

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
  type ObservedDevice,
  type ObservedRunState,
  RuntimeMissingError,
  UnknownModelError,
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

  private constructor(options: IosSimctlDriverOptions, deviceRoot: string) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#processRunner = options.processRunner;
    this.#deviceRoot = deviceRoot;
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
    const deviceRoot = await ensureOwnedRoot({
      filesystem: options.filesystem,
      idGenerator: options.idGenerator,
      instanceId: options.instanceId,
      path: configuredDeviceRoot(options),
      platform: "ios",
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    });

    return new IosSimctlDriver(options, deviceRoot);
  }

  // fallow-ignore-next-line unused-class-member -- Driver.deviceRoot contract; read by doctor --purge-orphans to say which root an orphan came from.
  get deviceRoot(): string {
    return this.#deviceRoot;
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
  // fallow-ignore-next-line unused-class-member -- Driver.leaseEnvironment contract; read by the lease path when it builds a grant.
  leaseEnvironment(): Readonly<Record<string, string>> {
    return { SIMLOCK_IOS_DEVICE_SET: this.#deviceRoot };
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
   * (erasable -- destroyed by it). Both halves are written together so a
   * partial write never reads as drift.
   */
  async #writeMark(udid: string): Promise<void> {
    const token = this.#idGenerator.generate();
    const contents = JSON.stringify({
      token,
      udid,
      writtenAt: new Date(this.#clock.now()).toISOString(),
    });
    const durablePath = join(this.#deviceDirectory(udid), MARK_FILE_NAME);
    const erasablePath = join(this.#dataPathFor(udid), MARK_FILE_NAME);

    await Promise.all([
      this.#filesystem.writeFileAtomic(durablePath, contents),
      this.#filesystem.writeFileAtomic(erasablePath, contents),
    ]);
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
    const outcome = await this.#invokeSimctl(args, timeoutMs);

    if (outcome.kind === "timed-out") {
      throw new DriverCrashError(`simctl ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }

    this.#assertSuccessful(args, outcome.result);
    return outcome.result;
  }

  async #invokeSimctl(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
    let process;
    try {
      // The single insertion point for `--set`, which scopes every subcommand to the root
      // this driver owns and must therefore precede the subcommand. Nothing in this file
      // spawns simctl any other way: a call that slipped past here would address the
      // machine's default set, where Simlock can prove nothing about what it touches.
      process = this.#processRunner.spawn("xcrun", ["simctl", "--set", this.#deviceRoot, ...args], {
        timeoutMs,
      });
    } catch (error: unknown) {
      throw new DriverCrashError(
        `Could not start simctl ${args.join(" ")}: ${errorMessage(error)}`,
      );
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
      throw new DriverCrashError(`simctl ${args.join(" ")} failed: ${errorMessage(error)}`);
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
    // Not an `OwnedRootError`: that one skips a platform and keeps the daemon up, which is
    // right for a root that failed validation but wrong for a value that is not a path at
    // all. Nothing here can guess what was meant, and defaulting would quietly put tens of
    // gigabytes somewhere the user did not choose.
    throw new DriverCrashError(
      `drivers.ios.deviceRoot must be a path, but it is a ${typeof configured}`,
    );
  }

  return configured ?? join(options.simlockHome, "devices", "ios");
}

interface ParsedManagedDevice {
  readonly name: string;
  readonly runState: ObservedRunState;
  readonly udid: string;
}

function parseManagedDevices(value: unknown): ParsedManagedDevice[] {
  if (!isRecord(value) || !isRecord(value.devices)) {
    throw new DriverCrashError("Invalid simctl device list JSON");
  }
  const devices: ParsedManagedDevice[] = [];
  for (const runtimeDevices of Object.values(value.devices)) {
    if (!Array.isArray(runtimeDevices)) continue;
    for (const device of runtimeDevices) {
      if (!isRecord(device) || typeof device.name !== "string" || typeof device.udid !== "string") {
        continue;
      }
      devices.push({
        name: device.name,
        runState: simctlRunState(device.state),
        udid: device.udid,
      });
    }
  }
  return devices;
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
