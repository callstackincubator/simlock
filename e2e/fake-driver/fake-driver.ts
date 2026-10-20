import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import {
  BootTimeoutError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type ComponentReceipt,
  type ComponentRemoval,
  DriverCrashError,
  type InstalledComponent,
  RuntimeMissingError,
  UnknownModelError,
  type ExactDeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type DriverComponent,
  type DriverDevice,
  type DriverEstimate,
  type DriverReality,
  type DriverToolVersion,
  type PhysicalDriverDevice,
  type ObservedMark,
  type ObservedRunState,
  type PassthroughCommand,
  type PassthroughContext,
  type PhysicalInspection,
  type PresentPhysical,
  uninstallPlan,
  PassthroughRefusedError,
  removeListedComponent,
  type DeviceClass,
  type DeviceSpec,
  type VirtualSpec,
  type Platform,
  type ScreenCapture,
  ScreenNotSupportedError,
  ScreenUnavailableError,
} from "../../dist/core/index.js";
import { NodeBytePipeLauncher } from "../../dist/ports/index.js";
import type {
  FakeDriverErrorSpec,
  FakeDriverOperation,
  FakeDriverPlatformScript,
  FakeDriverScript,
  ScriptedObservedDevice,
  ScriptedProcessEntry,
} from "./types.js";

type VirtualDriverDevice = DriverDevice & { readonly physical: false };

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
 * Recognisable sentinels, so a test can prove the environment map survived every layer untouched.
 * `SIMLOCK_FAKE_AWKWARD` has a space and an apostrophe to prove `--export-env` quoting.
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

const PASSTHROUGH_TOOLS: Readonly<Record<Platform, readonly string[]>> = {
  android: ["adb"],
  ios: ["simctl", "devicectl"],
};

const IOS_REFUSED_VERBS = ["create", "erase", "delete"];

// why: a mirror of ADR 0022 §5, never evidence for the real drivers: devicectl serves only a physical lease and simctl only a virtual one.
function assertToolServesLease(tool: string, physical: boolean): void {
  if (tool === "devicectl" && !physical) {
    throw new PassthroughRefusedError(
      tool,
      "Refusing `devicectl`: it serves a physical iOS device, and this lease holds a simulator.",
    );
  }
  if (tool === "simctl" && physical) {
    throw new PassthroughRefusedError(
      tool,
      "Refusing `simctl`: it serves simulators, and this lease holds a physical device. Use `devicectl`.",
    );
  }
}

// why: a physical lease's argv names the leased device, so a test can see the tool was aimed at it.
function aimedAt(
  tool: string,
  device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
  args: readonly string[],
): readonly string[] {
  if (device === undefined || !device.physical) return args;
  return tool === "devicectl"
    ? [...args, "--device", device.deviceId]
    : ["-s", device.deviceId, ...args];
}

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
 * It also answers three flags of its own -- `--fake-exec-stderr=<text>`, `--fake-exec-exit=<n>`
 * and `--fake-exec-silent` -- because `device.exec` (ADR 0005 §19a) runs this program in the
 * *daemon's* process, where a per-invocation environment variable cannot reach it: an HTTP
 * caller has only the argument list. They are the minimum needed to observe the three things a
 * streamed exec must get right and a local passthrough never showed: output on the second
 * stream, an exit code that is not zero, and a process that produces **no output at all**.
 *
 * `--fake-exec-silent` and `--fake-exec-sleep=<ms>` exist for that last one, together. What
 * §19a's `started` push buys a transport is *timing*, not status: `http/app.ts` races the
 * command settling against `started`, and a command that merely succeeds reaches the same
 * committed `200` either way -- just not until it exits. Only a command that is both silent and
 * slow separates them, because only then is there a stretch where the route must already have
 * answered and has nothing else to answer on. That is what makes "a silent long-running command
 * gets its `200` and its keepalives immediately" (the route's own words) an assertion rather
 * than a claim.
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
  "const silent = argv.includes('--fake-exec-silent');" +
  // Keeps the event loop alive without writing anything, so the process genuinely exists and is
  // running while the route has to decide what to answer.
  "const sleepMs = Number(flag('--fake-exec-sleep') ?? 0);" +
  "if (sleepMs > 0) setTimeout(() => {}, sleepMs);" +
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
  "} else if (!silent) report(undefined);" +
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
  readonly passthroughTools: readonly string[];
  readonly screenCapture: ScreenCapture;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly #clock: FakeDriverClock;
  /** Versions `installComponent` put in place, with each one's receipt. */
  readonly #installed = new Map<string, Readonly<Record<string, string>>>();
  #installCount = 0;
  readonly #logPath: string | undefined;
  readonly #scriptPath: string | undefined;
  readonly #devices = new Map<string, "provisioned" | "ready" | "shutdown">();
  #lastKnownEstimateMs: FakeDriverPlatformScript["estimateMs"];
  #lastKnownLeaseEnvironment: FakeDriverPlatformScript["leaseEnvironment"];
  #nextDeviceNumber = 1;

  constructor(options: OutOfProcessFakeDriverOptions) {
    this.platform = options.platform;
    this.deviceRoot = `/fake/${options.platform}`;
    this.passthroughTools = PASSTHROUGH_TOOLS[options.platform];
    // A real directory: the installer measures its free space before every install.
    this.componentFootprint = { bytes: 0, path: tmpdir() };
    this.#clock = options.clock;
    this.#logPath = options.logPath;
    this.#scriptPath = options.scriptPath;
    this.screenCapture = {
      open: async (device) => {
        if (device.physical)
          throw new ScreenNotSupportedError("A physical phone cannot be streamed");
        const command = (await this.#readScript()).screenCaptureCommand;
        if (command === undefined) throw new ScreenUnavailableError("No screen capture program");
        const child = new NodeBytePipeLauncher().start(command, [device.deviceId], {
          env: process.env,
        });
        let closing: Promise<void> | undefined;
        return {
          body: child.stdout,
          close: () =>
            (closing ??= (async () => {
              child.closeStdin();
              await child.exited;
            })()),
        };
      },
      unavailable: async () =>
        (await this.#readScript()).screenCaptureCommand === undefined
          ? "No screen capture program"
          : undefined,
    };
  }

  /**
   * The script's `defaultModels`, `{}` when unset. Read from the file on each access, as every
   * operation re-reads it, but synchronously: the port reads this as a property, once at start.
   */
  get defaultModels(): Readonly<Partial<Record<DeviceClass, readonly string[]>>> {
    if (this.#scriptPath === undefined) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.#scriptPath, "utf8")) as FakeDriverScript;
      return parsed[this.platform]?.defaultModels ?? {};
    } catch {
      // The same fallback as `readPlatformScript`: a missing or half-written file reads as unset.
      return {};
    }
  }

  /**
   * Logged like every other call, so a flow can assert the purge re-proved the root before
   * it destroyed anything -- and refusable through `failures.revalidateRoot`, which is how
   * a flow stages the root going bad under a running daemon.
   */
  async revalidateRoot(): Promise<void> {
    await this.#beforeCall("revalidateRoot", []);
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    const script = await this.#beforeCall("resolveSpec", [request]);
    this.#assertKnownModel(request.model, script);
    const osVersion =
      request.imageTag === undefined
        ? this.#resolveOsVersion(request.osVersion, script)
        : this.#resolveTaggedOsVersion(request.osVersion, request.imageTag, script);
    const slim = request.mode === "slim" && script.slimmableOsVersions?.includes(osVersion);
    return {
      model: request.model,
      osVersion,
      physical: false,
      platform: this.platform,
      ...(request.imageTag === undefined ? {} : { imageTag: request.imageTag }),
      ...(slim === true ? { mode: "slim" as const } : {}),
    };
  }

  #assertKnownModel(model: string, script: FakeDriverPlatformScript): void {
    if (script.knownModels !== undefined && !script.knownModels.includes(model)) {
      throw new UnknownModelError(this.platform, model);
    }
  }

  /** Defaults to the newest available runtime; a missing one fails, naming it as the component. */
  #resolveOsVersion(requested: string | undefined, script: FakeDriverPlatformScript): string {
    const available = this.#available(script);
    const osVersion = requested ?? newestVersion(available);
    if (osVersion === undefined) {
      throw new RuntimeMissingError(this.platform, "default");
    }
    if (!available.includes(osVersion)) {
      throw new RuntimeMissingError(this.platform, osVersion, { component: osVersion });
    }
    return osVersion;
  }

  /**
   * A runtime with a scripted image (`images`) of `imageTag`: the requested one, or else the
   * newest. None fails naming no component, so a tagged request is never offered a download.
   */
  #resolveTaggedOsVersion(
    requested: string | undefined,
    imageTag: string,
    script: FakeDriverPlatformScript,
  ): string {
    const tagged = (script.images ?? [])
      .filter((image) => image.tag === imageTag)
      .map((image) => image.runtime);
    const osVersion = requested ?? newestVersion(tagged);
    if (osVersion === undefined || !tagged.includes(osVersion)) {
      throw new RuntimeMissingError(this.platform, osVersion ?? "default");
    }
    return osVersion;
  }

  /** The scripted versions plus every one an install put in place. */
  #available(script: FakeDriverPlatformScript): string[] {
    return [
      ...new Set([
        ...(script.availableOsVersions ?? DEFAULT_SCRIPT.availableOsVersions ?? []),
        ...this.#installed.keys(),
      ]),
    ];
  }

  async findComponent(component: string): Promise<InstalledComponent | undefined> {
    const script = await this.#beforeCall("findComponent", [component]);
    return this.#find(component, script);
  }

  /** Logged, then scripted by `installProgress`, `latencyMs` and `failures` like any call. */
  async installComponent(
    component: string,
    options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    const script = await this.#beforeCall("installComponent", [component]);
    for (const percent of script.installProgress ?? []) {
      options.onProgress({ percent, stage: "downloading" });
    }
    if (options.signal.aborted) throw new DriverCrashError("Fake install aborted");
    const existing = this.#find(component, script);
    if (existing !== undefined) return { ...existing, outcome: "already-installed" };
    this.#installCount += 1;
    const receipt = { install: String(this.#installCount) };
    this.#installed.set(component, receipt);
    return { outcome: "installed", receipt, version: component };
  }

  /**
   * One entry per available version, with the receipt `findComponent` reports for it; sizes and
   * foreign devices come from `componentSizes` and `foreignDevices`.
   */
  async listComponents(): Promise<readonly DriverComponent[]> {
    const script = await this.#beforeCall("listComponents", []);
    return this.#listed(script);
  }

  /**
   * Removes an installed version through the steps every driver takes (`removeListedComponent`),
   * reading the listing `listComponents` answers. Scripted by `latencyMs.removeComponent`,
   * `failures.removeComponent` and `removalResidue` like any call. Only a version an install put
   * in place goes: a scripted one stays in `availableOsVersions`, as the user's own would.
   */
  async removeComponent(
    receipt: ComponentReceipt,
    options: { readonly signal: AbortSignal },
  ): Promise<ComponentRemoval> {
    const script = await this.#beforeCall("removeComponent", [receipt]);
    if (options.signal.aborted) throw new DriverCrashError("Fake removal aborted");
    return removeListedComponent({
      list: async () => this.#listed(script),
      platform: this.platform,
      receipt,
      remove: async ({ version }) => {
        this.#installed.delete(version);
        return script.removalResidue === undefined ? {} : { residue: script.removalResidue };
      },
    });
  }

  #listed(script: FakeDriverPlatformScript): DriverComponent[] {
    return this.#available(script).flatMap((version): DriverComponent[] => {
      const found = this.#find(version, script);
      if (found === undefined) return [];
      const sizeBytes = script.componentSizes?.[version];
      return [
        {
          ...found,
          foreignDevices: script.foreignDevices?.[version] ?? 0,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        },
      ];
    });
  }

  #find(component: string, script: FakeDriverPlatformScript): InstalledComponent | undefined {
    if (!this.#available(script).includes(component)) return undefined;
    return {
      receipt: this.#installed.get(component) ?? { preinstalled: component },
      version: component,
    };
  }

  async provision(spec: VirtualSpec): Promise<DriverDevice> {
    await this.#beforeCall("provision", [spec]);
    const deviceId = `fake-${this.platform}-${this.#nextDeviceNumber}`;
    this.#nextDeviceNumber += 1;
    this.#devices.set(deviceId, "provisioned");
    return { address: defaultAddress(deviceId), deviceId, driverData: { fakeDeviceId: deviceId } };
  }

  async makeReady(
    device: DriverDevice,
    options: { readonly purpose: "prepare" | "recover"; readonly mode: "slim" | "full" },
  ): Promise<DriverDevice> {
    const script = await this.#beforeCall("makeReady", [device, options]);
    this.#devices.set(device.deviceId, "ready");
    const slims = script.slimmableOsVersions !== undefined;
    const slimmed =
      options.mode === "slim" && options.purpose === "prepare" && script.slimPassFails !== true;
    return {
      address: script.address ?? defaultAddress(device.deviceId),
      deviceId: device.deviceId,
      driverData: device.driverData,
      ...(slims ? { mode: slimmed ? "slim" : "full" } : {}),
    } satisfies DriverDevice;
  }

  async reclaim(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    options: { readonly clean: "standard" | "full" },
  ): Promise<{
    readonly state: "ready" | "shutdown";
    readonly strategy: "erase" | "snapshot" | "wipe" | "uninstall";
    readonly missingApps?: readonly string[];
  }> {
    const script = await this.#beforeCall("reclaim", [device, options]);
    if (device.physical) return this.#reclaimPhysical(device, script);
    const state = script.reclaimResult ?? "ready";
    const strategy = script.reclaimStrategy ?? "erase";
    this.#devices.set(device.deviceId, state);
    return { state, strategy };
  }

  async #reclaimPhysical(
    device: PhysicalDriverDevice,
    script: FakeDriverPlatformScript,
  ): Promise<{
    readonly state: "ready";
    readonly strategy: "uninstall";
    readonly missingApps: readonly string[];
  }> {
    const scripted = script.physicalDevices?.find((candidate) =>
      candidate.ids.includes(device.deviceId),
    );
    const installed = scripted?.installedApps ?? scripted?.apps ?? [];
    const plan = uninstallPlan(installed, device.enrolledApps);
    for (const app of plan.uninstall) {
      await this.#appendLog("uninstall", [device.deviceId, app]);
    }
    if (plan.uninstall.length > 0) {
      await this.#writeInstalledApps(device.deviceId, installed, plan.uninstall);
    }
    return {
      missingApps: plan.missing,
      state: "ready",
      strategy: "uninstall",
    };
  }

  async #writeInstalledApps(
    deviceId: string,
    installed: readonly string[],
    removed: readonly string[],
  ): Promise<void> {
    if (this.#scriptPath === undefined) return;
    const parsed = JSON.parse(await readFile(this.#scriptPath, "utf8")) as FakeDriverScript;
    const platformScript = parsed[this.platform];
    if (platformScript === undefined) return;
    const physicalDevices = (platformScript.physicalDevices ?? []).map((candidate) =>
      candidate.ids.includes(deviceId)
        ? { ...candidate, installedApps: installed.filter((app) => !removed.includes(app)) }
        : candidate,
    );
    const next: FakeDriverScript = {
      ...parsed,
      [this.platform]: { ...platformScript, physicalDevices },
    };
    await writeFile(this.#scriptPath, JSON.stringify(next, null, 2), "utf8");
  }

  reclaimStrategy(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    _options: { readonly clean: "standard" | "full" },
  ): "erase" | "snapshot" | "wipe" | "uninstall" {
    return device.physical ? "uninstall" : "erase";
  }

  async shutdown(device: VirtualDriverDevice): Promise<void> {
    await this.#beforeCall("shutdown", [device]);
    this.#devices.set(device.deviceId, "shutdown");
  }

  async destroy(device: VirtualDriverDevice): Promise<void> {
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

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    const script = await this.#beforeCall("listPresentPhysical", [enrolledIds]);
    return enrolledIds.map((driverDeviceId) => {
      const scripted = script.physicalDevices?.find((candidate) =>
        candidate.ids.includes(driverDeviceId),
      );
      if (scripted !== undefined && scripted.present !== false) {
        return { driverDeviceId, osVersion: scripted.osVersion ?? "1.0", present: true };
      }
      return { driverDeviceId, present: false, reason: scripted?.absentReason ?? "not-present" };
    });
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    const script = await this.#beforeCall("inspectPhysical", [id]);
    const device = script.physicalDevices?.find((candidate) => candidate.ids.includes(id));
    if (device === undefined) {
      return { enrollable: false, message: `${id} is not connected`, reason: "not-connected" };
    }
    if (device.refusal !== undefined) return { enrollable: false, ...device.refusal };
    const [canonical] = device.ids;
    return {
      apps: [...(device.apps ?? [])],
      class: device.class ?? "phone",
      driverDeviceId: canonical ?? id,
      enrollable: true,
      model: device.model ?? "Fake Phone",
      osVersion: device.osVersion ?? "1.0",
    };
  }

  /** Not through `#beforeCall`, so a test's call log holds only what the test caused. */
  async toolVersions(): Promise<readonly DriverToolVersion[]> {
    return (await this.#readScript()).toolVersions ?? [];
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    const script = await this.#beforeCall("listCatalog", []);
    const runtimes = this.#available(script).sort(compareVersions);
    const models = script.knownModels === undefined ? [] : [...script.knownModels];
    return {
      defaultRuntime: newestVersion(runtimes),
      ...(script.images === undefined ? {} : { images: [...script.images] }),
      ...(script.customModels === undefined ? {} : { customModels: [...script.customModels] }),
      modelAliases: { ...script.modelAliases },
      modelClasses: { ...script.modelClasses },
      modelRuntimes: Object.fromEntries(
        models.map((model) => [model, [...(script.modelRuntimes?.[model] ?? runtimes)]]),
      ),
      models,
      runtimes,
    };
  }

  estimate(estimate: DriverEstimate, _spec: DeviceSpec): number {
    // estimate() is synchronous in the Driver interface, so it reads the script
    // synchronously best-effort; a stale/missing read just falls back to 0.
    return this.#lastKnownEstimateMs?.[estimate.operation] ?? 0;
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    return {};
  }

  leaseEnvironment(
    device: VirtualDriverDevice | PhysicalDriverDevice,
  ): Readonly<Record<string, string>> {
    if (device.physical && this.#lastKnownLeaseEnvironment === undefined) {
      return this.platform === "ios"
        ? { SIMLOCK_DEVICE_UDID: device.deviceId }
        : { ANDROID_ADB_SERVER_PORT: "5037", ANDROID_SERIAL: device.deviceId };
    }
    // Not `{}`: an empty grant would look the same as an environment that never reached the CLI.
    return this.#lastKnownLeaseEnvironment ?? FAKE_LEASE_ENVIRONMENT[this.platform];
  }

  /** Script-free: a rule that depended on a prior script read would not hold for a test's first command. */
  async passthrough(
    requested: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    const platformTools = PASSTHROUGH_TOOLS[this.platform];
    const tool = platformTools.includes(requested) ? requested : (platformTools[0] ?? requested);
    const physical = device?.physical === true;
    assertToolServesLease(tool, physical);
    // A mirror of the Android no-terminal rule, never evidence for the real driver's own rule.
    if (context?.hasTerminal === false && this.platform === "android" && isBareShell(args)) {
      throw new PassthroughRefusedError(
        tool,
        "Refusing `simlock adb shell` with no command: an interactive shell needs a terminal.",
      );
    }
    const refused = tool === "devicectl" ? undefined : PASSTHROUGH_REFUSALS[this.platform](args);
    if (refused !== undefined) {
      throw new PassthroughRefusedError(
        tool,
        `Refusing \`simlock ${tool} ${refused}\`: use \`simlock release\` or \`simlock cleanup\` instead.`,
      );
    }
    return {
      args: ["-e", PASSTHROUGH_PROGRAM, this.deviceRoot, ...aimedAt(tool, device, args)],
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
    return readPlatformScript(this.#scriptPath, this.platform);
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

/** One platform's part of the script file, read fresh; the defaults when there is none. */
export async function readPlatformScript(
  scriptPath: string | undefined,
  platform: Platform,
): Promise<FakeDriverPlatformScript> {
  if (scriptPath === undefined) {
    return DEFAULT_SCRIPT;
  }
  try {
    const raw = await readFile(scriptPath, "utf8");
    const parsed = JSON.parse(raw) as FakeDriverScript;
    return parsed[platform] ?? DEFAULT_SCRIPT;
  } catch {
    // Missing file, invalid JSON, or a race with a test rewriting it mid-flight:
    // fall back to defaults rather than making the fake driver itself flaky.
    return DEFAULT_SCRIPT;
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

/**
 * Whether `args` is the bare interactive `adb shell` -- `shell` as the *subcommand*, with no
 * command after it. `args.at(-1) === "shell"` is not that test: it also matches
 * `adb shell input text shell` and `adb push ./x shell`, where `shell` is an operand, which is
 * the defect round 4 fixed in the real Android driver (`walkGlobals`/`isBareShell`). A mirror
 * that mirrors the bug is worse than no mirror, because the e2e's only refusal assertion runs
 * through this driver.
 *
 * Deliberately smaller than the real grammar: it skips flags and the value of the few globals
 * that take one, which is all the fleet e2e ever passes. It is still never evidence for the
 * real driver's own rule -- see the note at the call site.
 */
const VALUE_TAKING_GLOBALS = ["-s", "-t", "-H", "-P", "-L", "--server-port"];

function isBareShell(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("-")) {
      return argument === "shell" && index === args.length - 1;
    }
    if (VALUE_TAKING_GLOBALS.includes(argument)) index += 1;
  }
  return false;
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
