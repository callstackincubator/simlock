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
  readonly #clock: FakeDriverClock;
  readonly #logPath: string | undefined;
  readonly #scriptPath: string | undefined;
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  #lastKnownEstimateMs: FakeDriverPlatformScript["estimateMs"];
  #nextDeviceNumber = 1;

  constructor(options: OutOfProcessFakeDriverOptions) {
    this.platform = options.platform;
    this.#clock = options.clock;
    this.#logPath = options.logPath;
    this.#scriptPath = options.scriptPath;
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

  async #beforeCall(
    operation: FakeDriverOperation,
    arguments_: readonly unknown[],
  ): Promise<FakeDriverPlatformScript> {
    const script = await this.#readScript();
    this.#lastKnownEstimateMs = script.estimateMs;
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
