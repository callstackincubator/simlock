import { join } from "node:path";

import {
  ensureOwnedRoot,
  type EnsureOwnedRootOptions,
  type Driver,
  type DriverDevice,
  type DriverReality,
  type DriverCatalogEntry,
  type DriverEstimate,
  type DeviceSpec,
  type ExactDeviceRequest,
  type VirtualSpec,
  type VirtualDriverDevice,
  type PhysicalDriverDevice,
  type PassthroughContext,
  type PassthroughCommand,
  type InstalledComponent,
  type DriverComponent,
  type DriverSource,
  type PhysicalInspection,
  type PresentPhysical,
  type ReclaimResult,
  type PrerequisiteCheck,
  type MissingPrerequisite,
  type DeviceTcp,
  type ScreenCapture,
  type DeviceInputFactory,
  type ObservedDevice,
  DriverCrashError,
  BadDeviceRequestError,
  UnknownModelError,
  RuntimeMissingError,
  UnsupportedRequestOptionError,
} from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  HttpJsonRequester,
  IdGenerator,
  Logger,
  ProcessRunner,
  ProcessSupervisor,
  SqliteDatabase,
  TcpListenerFactory,
  TcpProbe,
  TcpStreamConnector,
  WebSocketClientConnector,
} from "../../ports/index.js";
import { AdbServerSupervisor } from "./adb-server.js";
import { CloudApi, CloudApiError, type CloudLease } from "./cloud-api.js";
import { CloudAllocations, cloudData, type CloudAllocation } from "./cloud-data.js";
import { CloudAdbRelay, type CloudAdbConnection } from "./cloud-relay.js";
import { createAndroidDeviceTcp, type AndroidDeviceTcp } from "./device-tcp.js";
import { createAndroidDeviceInput } from "./input/index.js";
import { ANDROID_PASSTHROUGH_TOOLS, PassthroughRules } from "./passthrough-rules.js";
import { createAndroidScreenCapture, type ScreenTarget } from "./screen/index.js";

const MODEL = "ReDroid";
const API_LEVEL = "34";
const MAX_LEASE_SECONDS = 28_800;
const ADB_TIMEOUT_MS = 15_000;

export interface CloudAndroidDriverOptions {
  readonly clock: Clock;
  readonly database: SqliteDatabase;
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly simlockHome: string;
  readonly tcpProbe: TcpProbe;
  readonly tcpListener: TcpListenerFactory;
  readonly tcpStreamConnector: TcpStreamConnector;
  readonly http: HttpJsonRequester;
  readonly webSockets: WebSocketClientConnector;
  readonly adbPath?: string;
  readonly scrcpyServerPath?: string;
  readonly logger?: Logger;
  readonly uid?: number;
  readonly pid?: number;
}

export async function createCloudAndroidDriver(
  options: CloudAndroidDriverOptions,
): Promise<Driver> {
  const apiUrl = stringSetting(options.driverConfig, "apiUrl", "https://api.agentdevicecloud.xyz");
  const keyName = stringSetting(options.driverConfig, "apiKeyEnv", "ADC_API_KEY");
  const apiKey = options.env[keyName];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(`AgentDeviceCloud requires ${keyName} in the worker environment`);
  }
  const api = new CloudApi({ url: apiUrl, apiKey, http: options.http });
  const adb = options.adbPath ?? "adb";
  const environment: NodeJS.ProcessEnv = { ...options.env };
  delete environment[keyName];
  const version = await options.processRunner.run(adb, ["version"], {
    env: environment,
    timeoutMs: ADB_TIMEOUT_MS,
  });
  if (version.code !== 0)
    throw new Error("AgentDeviceCloud needs Android platform-tools (adb) on the worker");
  const defaultRoot = join(options.simlockHome, "devices", "android-cloud");
  const rootPath = stringSetting(options.driverConfig, "deviceRoot", defaultRoot);
  const rootOptions: EnsureOwnedRootOptions = {
    filesystem: options.filesystem,
    idGenerator: options.idGenerator,
    instanceId: options.instanceId,
    path: rootPath,
    platform: "android",
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
  };
  const deviceRoot = await ensureOwnedRoot(rootOptions);
  const adbServerPort = numberSetting(options.driverConfig, "adbServerPort", 5038);
  const logPath = join(options.simlockHome, "logs", "adb-server.log");
  const recordPath = join(options.simlockHome, "adb-server.json");
  const server = new AdbServerSupervisor({
    adbPath: adb,
    clock: options.clock,
    env: environment,
    filesystem: options.filesystem,
    logPath,
    port: adbServerPort,
    processRunner: options.processRunner,
    processSupervisor: options.processSupervisor,
    recordPath,
    tcpProbe: options.tcpProbe,
  });
  await server.start();
  const origin = new URL(apiUrl).origin;
  const allocations = new CloudAllocations(options.database, origin);
  const relay = new CloudAdbRelay({
    api,
    listeners: options.tcpListener,
    webSockets: options.webSockets,
  });
  return new CloudAndroidDriver(
    options,
    api,
    allocations,
    relay,
    server,
    rootOptions,
    deviceRoot,
    adb,
    adbServerPort,
    environment,
  );
}

class CloudAndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly supportsShutdown = false;
  readonly supportsBaselines = false;
  readonly defaultModels = { phone: [MODEL] };
  readonly passthroughTools = ANDROID_PASSTHROUGH_TOOLS;
  readonly componentFootprint: { readonly path: string; readonly bytes: number };
  readonly screenCapture: ScreenCapture | undefined;
  readonly input: DeviceInputFactory | undefined;
  readonly deviceTcp: DeviceTcp;
  readonly #connections = new Map<string, CloudAdbConnection>();
  readonly #connecting = new Map<string, Promise<CloudAdbConnection>>();
  readonly #retiring = new Set<string>();
  #disposed = false;
  readonly #passthrough: PassthroughRules;
  readonly #tcp: AndroidDeviceTcp;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    private readonly options: CloudAndroidDriverOptions,
    private readonly api: CloudApi,
    private readonly allocations: CloudAllocations,
    private readonly relay: CloudAdbRelay,
    private readonly server: AdbServerSupervisor,
    private readonly rootOptions: EnsureOwnedRootOptions,
    readonly deviceRoot: string,
    private readonly adb: string,
    private readonly adbServerPort: number,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#environment = { ...environment, ANDROID_ADB_SERVER_PORT: String(adbServerPort) };
    this.componentFootprint = { path: deviceRoot, bytes: 0 };
    const unsupportedPhysical = (): never => {
      throw new Error("AgentDeviceCloud does not enroll physical devices");
    };
    this.#passthrough = new PassthroughRules({
      adb,
      adbServerPort,
      adbTools: { env: () => this.#environment, dataFor: (device) => ({ serial: device.address }) },
      physical: { passthrough: unsupportedPhysical, runAdb: unsupportedPhysical },
      platform: "android",
      processRunner: options.processRunner,
    });
    const targetFor = async (
      device: VirtualDriverDevice | PhysicalDriverDevice,
    ): Promise<ScreenTarget> => {
      const connection = await this.#connectionFor(device);
      const argsFor = (args: readonly string[]): string[] => [
        "-P",
        String(adbServerPort),
        "-s",
        connection.serial,
        ...args,
      ];
      return {
        serial: connection.serial,
        connect: async (timeoutMs) =>
          await options.tcpStreamConnector.connect(adbServerPort, timeoutMs),
        run: async (args, timeoutMs) => {
          const scoped = argsFor(args);
          return await options.processRunner.run(adb, scoped, {
            env: this.#environment,
            timeoutMs,
          });
        },
        spawn: async (args) => {
          const scoped = argsFor(args);
          return options.processRunner.spawn(adb, scoped, { env: this.#environment });
        },
      };
    };
    this.#tcp = createAndroidDeviceTcp({
      clock: options.clock,
      connector: options.tcpStreamConnector,
      listeners: options.tcpListener,
      target: targetFor,
      isOwn: async (device) => {
        this.#allocation(device);
        return true;
      },
      runAdb: async (device, args, timeoutMs) => {
        const target = await targetFor(device);
        return await target.run(args, timeoutMs);
      },
      warn: (message, detail) => options.logger?.warn(message, detail),
    });
    this.deviceTcp = {
      supports: (device) => this.#tcp.supports(device),
      sweep: (devices) => this.#tcp.sweep(devices),
      reverse: (device, port, signal) => this.#tcp.reverse(device, port, signal),
      connect: (device, port, signal) => this.#tcp.connect(device, port, signal),
      supportsEmulatorPort: () => false,
    };
    if (options.scrcpyServerPath === undefined) {
      this.screenCapture = undefined;
      this.input = undefined;
    } else {
      this.screenCapture = createAndroidScreenCapture({
        clock: options.clock,
        filesystem: options.filesystem,
        serverPath: options.scrcpyServerPath,
        targetFor,
      });
      this.input = createAndroidDeviceInput({
        clock: options.clock,
        serverPath: options.scrcpyServerPath,
        targetFor,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    }
  }

  async revalidateRoot(): Promise<void> {
    await ensureOwnedRoot(this.rootOptions);
  }

  async resolveSpec(request: ExactDeviceRequest): Promise<VirtualSpec> {
    const model = request.model.toLowerCase();
    const supportedModel = MODEL.toLowerCase();
    if (model !== supportedModel) throw new UnknownModelError("android", request.model);
    if (request.imageTag !== undefined)
      throw new UnsupportedRequestOptionError("android", "imageTag");
    if (request.osVersion !== undefined && request.osVersion !== API_LEVEL)
      throw new RuntimeMissingError("android", request.osVersion);
    return { physical: false, platform: "android", model: MODEL, osVersion: API_LEVEL };
  }

  async listCatalog(): Promise<DriverCatalogEntry> {
    return {
      models: [MODEL],
      runtimes: [API_LEVEL],
      defaultRuntime: API_LEVEL,
      modelRuntimes: { [MODEL]: [API_LEVEL] },
      modelAliases: {},
      modelClasses: { [MODEL]: "phone" },
    };
  }

  async provision(
    _spec: VirtualSpec,
    options?: { readonly source?: string },
  ): Promise<DriverDevice> {
    if (options?.source !== undefined)
      throw new Error("AgentDeviceCloud does not support saved baselines");
    const id = this.options.idGenerator.generate();
    this.allocations.reserve(id);
    const lease = await this.api.createLease({
      name: `simlock-${id}`,
      purpose: "development",
      ttlSeconds: MAX_LEASE_SECONDS,
      idempotencyKey: id,
    });
    this.allocations.update(id, lease);
    return { deviceId: id, driverData: { allocationId: id }, address: "" };
  }

  async makeReady(
    device: VirtualDriverDevice,
    options: Parameters<Driver["makeReady"]>[1],
  ): Promise<DriverDevice> {
    const allocation = this.#allocation(device);
    const leaseId = this.#leaseId(allocation);
    const timeoutMs = numberSetting(this.options.driverConfig, "provisionTimeoutMs", 600_000);
    const deadline = this.options.clock.now() + timeoutMs;
    let lease = await this.api.get(leaseId);
    while (lease.status === "queued") {
      if (this.options.clock.now() >= deadline)
        throw new DriverCrashError("AgentDeviceCloud provisioning timed out");
      await this.#poll();
      lease = await this.api.get(leaseId);
    }
    this.#requireActive(lease);
    this.allocations.update(allocation.id, lease);
    if (options.purpose === "recover") await this.#closeConnection(allocation.id);
    const connection = await this.#connectionFor(device);
    const state = await this.#runAdb([
      "-s",
      connection.serial,
      "shell",
      "getprop",
      "sys.boot_completed",
    ]);
    if (state.stdout.trim() !== "1")
      throw new DriverCrashError("AgentDeviceCloud Android has not completed booting");
    await this.#runAdb(["-s", connection.serial, "shell", "pm", "path", "android"]);
    return { ...device, address: connection.serial };
  }

  maximumLeaseDeadline(device: VirtualDriverDevice | PhysicalDriverDevice): number {
    const allocation = this.#allocation(device);
    if (allocation.expiresAtMs === undefined)
      throw new Error("AgentDeviceCloud lease has no active deadline");
    return allocation.expiresAtMs;
  }

  async renewLease(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    ttlDeadline: number,
  ): Promise<number> {
    const allocation = this.#allocation(device);
    const remainingMs = ttlDeadline - this.options.clock.now();
    const roundedSeconds = Math.ceil(remainingMs / 1_000);
    if (roundedSeconds < 1 || roundedSeconds > MAX_LEASE_SECONDS)
      throw new BadDeviceRequestError(
        "AgentDeviceCloud lease duration must be between one second and eight hours",
      );
    // why: ADC truncates its clock to whole seconds, so a duration without this reserve can expire before the worker's millisecond deadline.
    const ttlSeconds = Math.min(roundedSeconds + 1, MAX_LEASE_SECONDS);
    if (
      allocation.startedAtMs !== undefined &&
      ttlDeadline > allocation.startedAtMs + MAX_LEASE_SECONDS * 1_000
    )
      throw new BadDeviceRequestError(
        "AgentDeviceCloud leases cannot exceed eight hours from activation",
      );
    const id = this.#leaseId(allocation);
    const lease = await this.api.renew(id, ttlSeconds);
    this.#requireActive(lease);
    this.allocations.update(allocation.id, lease);
    if (lease.expiresAtMs === undefined)
      throw new Error("AgentDeviceCloud renewed lease has no expiry");
    return lease.expiresAtMs;
  }

  async listManaged(): Promise<DriverReality> {
    const devices: ObservedDevice[] = [];
    for (const allocation of this.allocations.active()) {
      const observed = await this.#observeAllocation(allocation);
      if (observed !== undefined) devices.push(observed);
    }
    return { devices, processes: devices };
  }

  async #observeAllocation(allocation: CloudAllocation): Promise<ObservedDevice | undefined> {
    const id = this.#leaseId(allocation);
    let lease: CloudLease;
    try {
      lease = await this.api.get(id);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 404) {
        await this.#closeConnection(allocation.id);
        this.allocations.release(allocation.id);
        return undefined;
      }
      throw error;
    }
    if (lease.status !== "active" && lease.status !== "queued") {
      await this.#closeConnection(allocation.id);
      this.allocations.release(allocation.id);
      return undefined;
    }
    this.allocations.update(allocation.id, lease);
    const device = {
      deviceId: allocation.id,
      driverData: { allocationId: allocation.id },
      address: "",
      physical: false as const,
    };
    if (lease.status === "queued") return { ...device, runState: "transitioning" };
    return await this.#observeAdb(device);
  }

  async #observeAdb(device: VirtualDriverDevice): Promise<ObservedDevice> {
    const connection = await this.#connectionFor(device);
    const args = ["-P", String(this.adbServerPort), "-s", connection.serial, "get-state"];
    const state = await this.options.processRunner.run(this.adb, args, {
      env: this.#environment,
      timeoutMs: ADB_TIMEOUT_MS,
    });
    const status = state.stdout.trim();
    const running = state.code === 0 && status === "device";
    return { ...device, address: connection.serial, runState: running ? "running" : "stopped" };
  }

  async shutdown(): Promise<void> {
    throw new Error("AgentDeviceCloud devices cannot be stopped; release the lease instead");
  }

  async destroy(device: VirtualDriverDevice): Promise<void> {
    const allocation = this.#allocation(device);
    this.#retiring.add(allocation.id);
    const id = this.#leaseId(allocation);
    try {
      await this.#closeConnection(allocation.id);
      await this.#tcp.release(device);
    } finally {
      await this.api.release(id);
      this.allocations.release(allocation.id);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const pending = [...this.#connecting.values()];
    await Promise.allSettled(pending);
    for (const id of this.#connections.keys()) await this.#closeConnection(id);
    await this.server.stop();
  }

  leaseEnvironment(
    device: VirtualDriverDevice | PhysicalDriverDevice,
  ): Readonly<Record<string, string>> {
    this.#allocation(device);
    return { ...this.virtualLeaseEnvironment(), ANDROID_SERIAL: device.address };
  }

  virtualLeaseEnvironment(): Readonly<Record<string, string>> {
    return { ANDROID_ADB_SERVER_PORT: String(this.adbServerPort) };
  }

  async passthrough(
    tool: string,
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    if (tool !== "adb") throw new Error(`AgentDeviceCloud does not provide ${tool}`);
    if (device !== undefined) this.#allocation(device);
    return await this.#passthrough.passthrough(device, args, context);
  }

  estimate(_estimate: DriverEstimate, _spec: DeviceSpec): number {
    return 30_000;
  }
  async findComponent(): Promise<InstalledComponent | undefined> {
    return undefined;
  }
  async listComponents(): Promise<readonly DriverComponent[]> {
    return [];
  }
  async installComponent(): Promise<never> {
    throw new Error(
      "AgentDeviceCloud manages its Android runtime; local component installation is unavailable",
    );
  }
  async removeComponent(): Promise<never> {
    throw new Error(
      "AgentDeviceCloud manages its Android runtime; local component removal is unavailable",
    );
  }
  async listSources(): Promise<readonly DriverSource[]> {
    return [];
  }
  async destroySource(): Promise<never> {
    throw new Error("AgentDeviceCloud does not support saved sources");
  }
  async saveSource(): Promise<never> {
    throw new Error("AgentDeviceCloud does not support saved baselines");
  }
  async reclaim(): Promise<ReclaimResult> {
    throw new Error("AgentDeviceCloud devices are disposable; destroy the device instead");
  }
  reclaimStrategy(): ReturnType<Driver["reclaimStrategy"]> {
    throw new Error("AgentDeviceCloud devices are disposable");
  }
  async inspectPhysical(): Promise<PhysicalInspection> {
    return {
      enrollable: false,
      reason: "network-only",
      message: "AgentDeviceCloud devices are leased as virtual devices",
    };
  }
  async listPresentPhysical(): Promise<readonly PresentPhysical[]> {
    return [];
  }

  #allocation(device: DriverDevice): CloudAllocation {
    const data = cloudData(device.driverData);
    if (data.allocationId !== device.deviceId)
      throw new Error("AgentDeviceCloud allocation does not match this device");
    return this.allocations.get(data.allocationId);
  }

  #leaseId(allocation: CloudAllocation): string {
    if (allocation.leaseId === undefined)
      throw new Error("AgentDeviceCloud provisioning did not return a lease ID");
    return allocation.leaseId;
  }

  #requireActive(lease: CloudLease): void {
    if (lease.status !== "active")
      throw new DriverCrashError(lease.error ?? `AgentDeviceCloud lease is ${lease.status}`);
    if (lease.expiresAtMs === undefined || lease.expiresAtMs <= this.options.clock.now())
      throw new DriverCrashError("AgentDeviceCloud lease has expired");
  }

  async #connectionFor(device: DriverDevice): Promise<CloudAdbConnection> {
    const allocation = this.#allocation(device);
    if (this.#disposed || this.#retiring.has(allocation.id))
      throw new DriverCrashError("AgentDeviceCloud device connection is closing");
    const existing = this.#connections.get(allocation.id);
    if (existing !== undefined) return existing;
    const pending = this.#connecting.get(allocation.id);
    if (pending !== undefined) return await pending;
    const opening = this.#openConnection(allocation);
    this.#connecting.set(allocation.id, opening);
    try {
      return await opening;
    } finally {
      this.#connecting.delete(allocation.id);
    }
  }

  async #openConnection(allocation: CloudAllocation): Promise<CloudAdbConnection> {
    const id = this.#leaseId(allocation);
    const connection = await this.relay.open(id, allocation.adbPort ?? 0);
    try {
      this.allocations.setPort(allocation.id, connection.port);
      await this.#runAdb(["connect", connection.serial]);
      const state = await this.#runAdb(["-s", connection.serial, "get-state"]);
      if (state.stdout.trim() !== "device")
        throw new DriverCrashError("AgentDeviceCloud ADB transport is not ready");
      if (this.#disposed || this.#retiring.has(allocation.id))
        throw new DriverCrashError("AgentDeviceCloud device connection is closing");
      this.#connections.set(allocation.id, connection);
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async #closeConnection(id: string): Promise<void> {
    const pending = this.#connecting.get(id);
    if (pending !== undefined) await Promise.allSettled([pending]);
    const connection = this.#connections.get(id);
    if (connection === undefined) return;
    this.#connections.delete(id);
    try {
      await this.#runAdb(["disconnect", connection.serial]);
    } finally {
      await connection.close();
    }
  }

  async #runAdb(args: readonly string[]) {
    const scoped = ["-P", String(this.adbServerPort), ...args];
    const result = await this.options.processRunner.run(this.adb, scoped, {
      env: this.#environment,
      timeoutMs: ADB_TIMEOUT_MS,
    });
    if (result.code !== 0)
      throw new DriverCrashError(`AgentDeviceCloud adb failed: ${result.stderr || result.stdout}`);
    return result;
  }

  async #poll(): Promise<void> {
    await new Promise<void>((resolve) => this.options.clock.setTimer(1_000, resolve));
  }
}

function stringSetting(
  config: CloudAndroidDriverOptions["driverConfig"],
  key: string,
  defaultValue: string,
): string {
  const value = config[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`drivers.android.${key} must be a non-empty string`);
  return value;
}

function numberSetting(
  config: CloudAndroidDriverOptions["driverConfig"],
  key: string,
  defaultValue: number,
): number {
  const value = config[key];
  if (value === undefined) return defaultValue;
  const finite = Number.isFinite(value);
  if (typeof value !== "number" || finite === false || value <= 0)
    throw new Error(`drivers.android.${key} must be a positive number`);
  return value;
}

export function cloudAndroidPrerequisites(
  options: Pick<CloudAndroidDriverOptions, "processRunner" | "env" | "driverConfig" | "adbPath">,
): PrerequisiteCheck {
  return {
    platform: "android",
    check: async () => {
      const missing: MissingPrerequisite[] = [];
      const keyName = stringSetting(options.driverConfig, "apiKeyEnv", "ADC_API_KEY");
      const apiKey = options.env[keyName];
      if (apiKey === undefined || apiKey === "")
        missing.push({
          prerequisite: "adc-api-key",
          message: `AgentDeviceCloud requires ${keyName}`,
          remedy: `Set ${keyName} in the worker environment and restart Simlock.`,
        });
      const adb = await missingCloudAdb(options);
      if (adb !== undefined) missing.push(adb);
      return missing;
    },
  };
}

async function missingCloudAdb(
  options: Pick<CloudAndroidDriverOptions, "processRunner" | "env" | "adbPath">,
): Promise<MissingPrerequisite | undefined> {
  const adb = options.adbPath ?? "adb";
  try {
    const result = await options.processRunner.run(adb, ["version"], {
      timeoutMs: ADB_TIMEOUT_MS,
      env: { ...options.env },
    });
    if (result.code === 0) return undefined;
  } catch (error) {
    if (isMissingExecutable(error) === false) throw error;
  }
  return {
    prerequisite: "android-platform-tools",
    message: "AgentDeviceCloud requires adb on the worker",
    remedy: "Install Android platform-tools and add adb to PATH.",
  };
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
