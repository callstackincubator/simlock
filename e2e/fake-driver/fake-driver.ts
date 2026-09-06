import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BootTimeoutError,
  DriverCrashError,
  RuntimeMissingError,
  UnknownModelError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type ObservedMark,
  type ObservedRunState,
  type PassthroughCommand,
  type PassthroughContext,
  PassthroughRefusedError,
} from "../../dist/core/driver.js";
import type { DeviceSpec, Platform } from "../../dist/core/domain.js";
import type {
  FakeDriverErrorSpec,
  FakeDriverOperation,
  FakeDriverPlatformScript,
  FakeDriverScript,
  ScriptedObservedDevice,
  ScriptedProcessEntry,
} from "./types.js";

/** Minimal clock contract this driver needs -- kept local so it stays type-only-decoupled. */
export interface FakeDriverClock {
  now(): number;
  setTimer(delayMs: number, callback: () => void): unknown;
}

export interface OutOfProcessFakeDriverOptions {
  readonly clock: FakeDriverClock;
  readonly logPath: string | undefined;
  readonly platform: Platform;
  readonly scriptPath: string | undefined;
}

const DEFAULT_SCRIPT: FakeDriverPlatformScript = {
  availableOsVersions: ["18.0"],
};

/** The `simlock <tool>` name each fake platform stands in for, matching the real drivers. */
/**
 * Deliberately fake scoping variables every fake-driver grant carries unless a script overrides
 * them. Nothing reads these -- they exist to be *recognised*: `environment` is built by a driver,
 * forwarded verbatim by the core, validated at the contract boundary, and rendered by the CLI,
 * MCP and HTTP. A test that finds these exact values at the far end has proved the map survived
 * every one of those layers untouched, which no assertion on a plausible-looking real value can
 * (a real-looking path could just as easily have been reconstructed somewhere downstream).
 *
 * The keys mirror the shape the real drivers contribute so nothing downstream is special-cased.
 * `SIMLOCK_FAKE_TRACER` is the sentinel proper. `SIMLOCK_FAKE_AWKWARD` carries a space and an
 * apostrophe on purpose: `simlock lease --export-env` emits shell `export` lines for `eval`, so
 * a value that survives that round trip byte for byte proves the quoting as well as the routing.
 */
export const FAKE_LEASE_ENVIRONMENT: Readonly<Record<Platform, Readonly<Record<string, string>>>> =
  {
    ios: {
      SIMLOCK_IOS_DEVICE_SET: "/fake/ios/device-set",
      SIMLOCK_FAKE_TRACER: "ios-lease-env-tracer-7f3a2c",
      SIMLOCK_FAKE_AWKWARD: "/fake/o'brien/My Devices/ios",
    },
    android: {
      ANDROID_ADB_SERVER_PORT: "15037",
      ANDROID_AVD_HOME: "/fake/android/avd-home",
      SIMLOCK_FAKE_TRACER: "android-lease-env-tracer-7f3a2c",
      SIMLOCK_FAKE_AWKWARD: "/fake/o'brien/My Devices/android",
    },
  };

const PASSTHROUGH_TOOLS: Readonly<Record<Platform, string>> = {
  android: "adb",
  ios: "simctl",
};

const IOS_REFUSED_VERBS = ["create", "erase", "delete"];

/** iOS refuses a lifecycle verb in first non-flag position, where a subcommand sits. */
function refusedSimctlVerb(args: readonly string[]): string | undefined {
  const verb = args.find((argument) => !argument.startsWith("-"));
  return IOS_REFUSED_VERBS.find((candidate) => candidate === verb);
}

/** Android refuses either form anywhere in the arguments, `-s <serial> emu kill` included. */
function refusedAdbVerb(args: readonly string[]): string | undefined {
  if (args.includes("kill-server")) return "kill-server";
  const pair = args.some((argument, index) => argument === "emu" && args[index + 1] === "kill");
  return pair ? "emu kill" : undefined;
}

/**
 * The refusal rules, restated rather than imported: this one driver stands in for both
 * platforms, and the e2e lane is exactly where the published behaviour -- exit 2 with a
 * USAGE line naming what to run instead -- has to be exercised end to end.
 *
 * Because they are restated, these are a *mirror* of the real rules and never evidence
 * for them: deleting the refusal branch from `src/drivers/ios/index.ts` would leave every
 * e2e case here green. What the shipped drivers refuse is pinned in
 * `src/drivers/ios/index.test.ts` and `src/drivers/android/index.test.ts`; this pair only
 * has to be refusable, not complete.
 */
const PASSTHROUGH_REFUSALS: Readonly<
  Record<Platform, (args: readonly string[]) => string | undefined>
> = {
  android: refusedAdbVerb,
  ios: refusedSimctlVerb,
};

/**
 * The command a permitted passthrough resolves to: a node one-liner that prints the argv it
 * was handed and exits with `SIMLOCK_FAKE_PASSTHROUGH_EXIT`. Deliberately reads that from
 * its own environment rather than from the script file, so a test controls the exit code
 * through the CLI invocation it is already making and this stays synchronous.
 *
 * It also answers two flags of its own -- `--fake-exec-stderr=<text>` and
 * `--fake-exec-exit=<n>` -- because `device.exec` (ADR 0005 §19a) runs this program in the
 * *daemon's* process, where a per-invocation environment variable cannot reach it: an HTTP
 * caller has only the argument list. They are the minimum needed to observe the two things a
 * streamed exec must get right and a local passthrough never showed: output on the second
 * stream, and an exit code that is not zero.
 */
const PASSTHROUGH_PROGRAM =
  "const argv = process.argv.slice(1);" +
  "const flag = (name) => {" +
  "const found = argv.find((value) => value.startsWith(name + '='));" +
  "return found === undefined ? undefined : found.slice(name.length + 1);" +
  "};" +
  "const stderrText = flag('--fake-exec-stderr');" +
  "if (stderrText !== undefined) process.stderr.write(stderrText);" +
  // `device.exec`'s `stdin` is a one-shot string written to the process and then closed, which
  // is only observable from the far end if the tool reads it back out. Opt-in, so every other
  // flow's command still exits without waiting on a stdin nobody wrote to.
  "const echoStdin = argv.includes('--fake-exec-echo-stdin');" +
  "const report = (stdin) => process.stdout.write(JSON.stringify({" +
  "argv," +
  "platform: process.env.SIMLOCK_FAKE_PASSTHROUGH_PLATFORM ?? null," +
  "...(stdin === undefined ? {} : { stdin })," +
  "}));" +
  "if (echoStdin) {" +
  "let buffered = '';" +
  "process.stdin.setEncoding('utf8');" +
  "process.stdin.on('data', (chunk) => { buffered += chunk; });" +
  "process.stdin.on('end', () => report(buffered));" +
  // `report` echoes `platform` back so a flow can prove the driver-built environment reached
  // the tool's own process, not merely that the daemon returned it in the resolved command --
  // the half of ADR 0001 decision 7 the wrapper exists for: handing back the scoping that
  // containment removed.
  "} else report(undefined);" +
  // `exitCode` rather than `exit()`: over a pipe (which is how `device.exec` reads it, unlike
  // the CLI's inherited stdio) an immediate `exit()` can truncate a write that has not
  // flushed. Setting the code lets the process end once its streams have drained.
  "process.exitCode = Number(flag('--fake-exec-exit') ?? process.env.SIMLOCK_FAKE_PASSTHROUGH_EXIT ?? 0);";

/**
 * Driver implementation for the daemon-spawned process the e2e suite drives out of
 * band. Every behaviour lives in a JSON script file re-read on each operation (env
 * var `SIMLOCK_FAKE_DRIVER_SCRIPT`), and every call is appended as a JSON line to a
 * log file (env var `SIMLOCK_FAKE_DRIVER_LOG`) so a test can assert what the daemon
 * did and did not do. A missing script file falls back to permissive defaults --
 * never a crash, per the safety rule that a broken test harness should not look like
 * a broken daemon.
 */
export class OutOfProcessFakeDriver implements Driver {
  readonly platform: Platform;
  /** Synthetic: this driver owns no real devices, and nothing validates or creates it. */
  readonly deviceRoot: string;
  readonly passthroughTool: string;
  readonly #clock: FakeDriverClock;
  readonly #logPath: string | undefined;
  readonly #scriptPath: string | undefined;
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  #lastKnownEstimateMs: FakeDriverPlatformScript["estimateMs"];
  #lastKnownLeaseEnvironment: FakeDriverPlatformScript["leaseEnvironment"];
  #nextDeviceNumber = 1;

  constructor(options: OutOfProcessFakeDriverOptions) {
    this.platform = options.platform;
    this.deviceRoot = `/fake/${options.platform}`;
    this.passthroughTool = PASSTHROUGH_TOOLS[options.platform];
    this.#clock = options.clock;
    this.#logPath = options.logPath;
    this.#scriptPath = options.scriptPath;
  }

  /**
   * Logged like every other call, so a flow can assert the purge re-proved the root before
   * it destroyed anything -- and refusable through `failures.revalidateRoot`, which is how
   * a flow stages the root going bad under a running daemon.
   */
  async revalidateRoot(): Promise<void> {
    await this.#beforeCall("revalidateRoot", []);
  }

  async resolveSpec(
    request: DeviceRequest,
    options: { readonly allowDownload: boolean; readonly requesterId?: string },
  ): Promise<DeviceSpec> {
    const script = await this.#beforeCall("resolveSpec", [request, options]);
    this.#assertKnownModel(request.model, script);
    const osVersion = this.#resolveOsVersion(request.osVersion, script, options.allowDownload);
    return { model: request.model, osVersion, platform: this.platform };
  }

  #assertKnownModel(model: string, script: FakeDriverPlatformScript): void {
    if (script.knownModels !== undefined && !script.knownModels.includes(model)) {
      throw new UnknownModelError(this.platform, model);
    }
  }

  /** Defaults to the newest scripted runtime; a missing/undownloadable one fails loudly. */
  #resolveOsVersion(
    requested: string | undefined,
    script: FakeDriverPlatformScript,
    allowDownload: boolean,
  ): string {
    const available = script.availableOsVersions ?? DEFAULT_SCRIPT.availableOsVersions ?? [];
    const osVersion = requested ?? newestVersion(available);
    if (osVersion === undefined) {
      throw new RuntimeMissingError(this.platform, "default");
    }
    this.#assertOsVersionAvailable(osVersion, available, allowDownload);
    return osVersion;
  }

  #assertOsVersionAvailable(
    osVersion: string,
    available: readonly string[],
    allowDownload: boolean,
  ): void {
    if (!available.includes(osVersion) && !allowDownload) {
      throw new RuntimeMissingError(this.platform, osVersion);
    }
  }

  async provision(spec: DeviceSpec): Promise<DriverDevice> {
    await this.#beforeCall("provision", [spec]);
    const deviceId = `fake-${this.platform}-${this.#nextDeviceNumber}`;
    this.#nextDeviceNumber += 1;
    this.#devices.set(deviceId, "provisioned");
    return { address: defaultAddress(deviceId), deviceId, driverData: { fakeDeviceId: deviceId } };
  }

  /**
   * Re-reads the script's `address` on every boot -- see `FakeDriverPlatformScript.address`.
   * `options.purpose` is logged alongside the call but otherwise ignored -- this fake never
   * applies any configuration a `"recover"` boot would need to skip.
   */
  async makeReady(
    device: DriverDevice,
    options?: { readonly purpose: "prepare" | "recover" },
  ): Promise<DriverDevice> {
    const script = await this.#beforeCall("makeReady", [device, options]);
    this.#devices.set(device.deviceId, "ready");
    return {
      address: script.address ?? defaultAddress(device.deviceId),
      deviceId: device.deviceId,
      driverData: device.driverData,
    };
  }

  async reclaim(
    device: DriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<{
    readonly state: "ready" | "shutdown";
    readonly strategy: "erase" | "snapshot" | "wipe";
  }> {
    const script = await this.#beforeCall("reclaim", [device, options]);
    const state = script.reclaimResult ?? "ready";
    const strategy = script.reclaimStrategy ?? "erase";
    this.#devices.set(device.deviceId, state);
    return { state, strategy };
  }

  reclaimStrategy(_options: {
    readonly clean: "standard" | "full";
  }): "erase" | "snapshot" | "wipe" {
    return "erase";
  }

  async shutdown(device: DriverDevice): Promise<void> {
    await this.#beforeCall("shutdown", [device]);
    this.#devices.set(device.deviceId, "shutdown");
  }

  async destroy(device: DriverDevice): Promise<void> {
    await this.#beforeCall("destroy", [device]);
    this.#devices.delete(device.deviceId);
  }

  async listManaged(): Promise<DriverReality> {
    const script = await this.#beforeCall("listManaged", []);
    const overridden = script.managedReality;
    if (overridden !== undefined) {
      return {
        devices: (overridden.devices ?? []).map(toObservedDevice),
        processes: (overridden.processes ?? []).map(toManagedProcess),
      };
    }

    return {
      devices: [...this.#devices.entries()].map(([deviceId, status]) => ({
        address: defaultAddress(deviceId),
        deviceId,
        driverData: { fakeDeviceId: deviceId },
        runState: runStateFor(status),
      })),
      processes: [],
    };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const script = await this.#beforeCall("listCatalog", []);
    const runtimes = [...(script.availableOsVersions ?? DEFAULT_SCRIPT.availableOsVersions ?? [])];
    return {
      defaultRuntime: newestVersion(runtimes),
      models: script.knownModels === undefined ? [] : [...script.knownModels],
      runtimes: [...runtimes].sort(compareVersions),
    };
  }

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    // estimate() is synchronous in the Driver interface, so it reads the script
    // synchronously best-effort; a stale/missing read just falls back to 0.
    return this.#lastKnownEstimateMs?.[estimate.operation] ?? 0;
  }

  /** Synchronous like `estimate`, and cached the same way: the last script read wins. */
  leaseEnvironment(): Readonly<Record<string, string>> {
    // Defaults to the recognisable fakes rather than `{}`: a grant that carried nothing would
    // make "the environment reached the CLI" and "there was never anything to carry" look
    // identical at the far end. A script that sets `leaseEnvironment` still wins.
    return this.#lastKnownLeaseEnvironment ?? FAKE_LEASE_ENVIRONMENT[this.platform];
  }

  /**
   * Synchronous and script-free, unlike everything else here: the refusal rules are the
   * behaviour under test, and a rule that depended on a prior script read would not be
   * exercised by the very first command a test runs.
   */
  passthrough(args: readonly string[], context?: PassthroughContext): PassthroughCommand {
    // Mirrors the Android driver's no-terminal rule (ADR 0005 §19c) in the smallest form that
    // proves the fact travels: the daemon tells the driver there is no terminal, and the
    // driver -- not the daemon -- decides what that rules out. Like the refusal lists above,
    // this is a mirror and never evidence for the real driver's own rule.
    if (context?.hasTerminal === false && this.platform === "android" && args.at(-1) === "shell") {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        "Refusing `simlock adb shell` with no command: an interactive shell needs a terminal.",
      );
    }
    const refused = PASSTHROUGH_REFUSALS[this.platform](args);
    if (refused !== undefined) {
      throw new PassthroughRefusedError(
        this.passthroughTool,
        `Refusing \`simlock ${this.passthroughTool} ${refused}\`: use \`simlock release\` or \`simlock cleanup\` instead.`,
      );
    }
    return {
      args: ["-e", PASSTHROUGH_PROGRAM, this.deviceRoot, ...args],
      command: process.execPath,
      env: { SIMLOCK_FAKE_PASSTHROUGH_PLATFORM: this.platform },
    };
  }

  async #beforeCall(
    operation: FakeDriverOperation,
    arguments_: readonly unknown[],
  ): Promise<FakeDriverPlatformScript> {
    const script = await this.#readScript();
    this.#lastKnownEstimateMs = script.estimateMs;
    this.#lastKnownLeaseEnvironment = script.leaseEnvironment;
    await this.#appendLog(operation, arguments_);

    const latency = script.latencyMs?.[operation] ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve) => {
        this.#clock.setTimer(latency, resolve);
      });
    }

    const failure = script.failures?.[operation];
    if (failure !== undefined) {
      throw toError(this.platform, failure);
    }

    return script;
  }

  async #readScript(): Promise<FakeDriverPlatformScript> {
    if (this.#scriptPath === undefined) {
      return DEFAULT_SCRIPT;
    }
    try {
      const raw = await readFile(this.#scriptPath, "utf8");
      const parsed = JSON.parse(raw) as FakeDriverScript;
      return parsed[this.platform] ?? DEFAULT_SCRIPT;
    } catch {
      // Missing file, invalid JSON, or a race with a test rewriting it mid-flight:
      // fall back to defaults rather than making the fake driver itself flaky.
      return DEFAULT_SCRIPT;
    }
  }

  async #appendLog(operation: FakeDriverOperation, arguments_: readonly unknown[]): Promise<void> {
    if (this.#logPath === undefined) {
      return;
    }
    const line = `${JSON.stringify({
      timestampMs: this.#clock.now(),
      platform: this.platform,
      operation,
      arguments: arguments_,
    })}\n`;
    try {
      await appendFile(this.#logPath, line, "utf8");
    } catch {
      await mkdir(dirname(this.#logPath), { recursive: true });
      await appendFile(this.#logPath, line, "utf8");
    }
  }
}

function toObservedDevice(device: ScriptedObservedDevice): DriverReality["devices"][number] {
  return {
    address: defaultAddress(device.deviceId),
    deviceId: device.deviceId,
    driverData: { fakeDeviceId: device.deviceId },
    runState: device.runState as ObservedRunState,
    ...(device.mark === undefined ? {} : { mark: toObservedMark(device.mark) }),
  };
}

function toObservedMark(mark: NonNullable<ScriptedObservedDevice["mark"]>): ObservedMark {
  return {
    durable: mark.durable,
    erasable: mark.erasable,
    erasableReadable: mark.erasableReadable ?? true,
  };
}

function toManagedProcess(process: ScriptedProcessEntry): DriverDevice {
  return {
    address: defaultAddress(process.deviceId),
    deviceId: process.deviceId,
    driverData: { fakeDeviceId: process.deviceId },
  };
}

function defaultAddress(deviceId: string): string {
  return `${deviceId}-address`;
}

function runStateFor(status: "provisioned" | "ready" | "shutdown"): ObservedRunState {
  switch (status) {
    case "ready":
      return "running";
    case "shutdown":
      return "stopped";
    case "provisioned":
      return "transitioning";
  }
}

/** One factory per `FakeDriverErrorSpec["type"]` -- a lookup table instead of a
 *  branching switch, so adding an error kind never raises `toError`'s complexity. */
const ERROR_FACTORIES: {
  readonly [Type in FakeDriverErrorSpec["type"]]: (
    spec: Extract<FakeDriverErrorSpec, { readonly type: Type }>,
    platform: Platform,
  ) => Error;
} = {
  RuntimeMissingError: (spec, platform) =>
    new RuntimeMissingError(platform, spec.osVersion ?? "unknown"),
  UnknownModelError: (spec, platform) => new UnknownModelError(platform, spec.model ?? "unknown"),
  BootTimeoutError: (spec) => new BootTimeoutError(spec.deviceId ?? "unknown"),
  DriverCrashError: (spec) => new DriverCrashError(spec.message ?? "Scripted driver crash"),
  generic: (spec) => new Error(spec.message ?? "Scripted fake driver failure"),
};

function toError(platform: Platform, spec: FakeDriverErrorSpec): Error {
  const factory = ERROR_FACTORIES[spec.type] as (
    spec: FakeDriverErrorSpec,
    platform: Platform,
  ) => Error;
  return factory(spec, platform);
}

function newestVersion(versions: readonly string[]): string | undefined {
  return [...versions].sort(compareVersions).at(-1);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.localeCompare(right);
}
