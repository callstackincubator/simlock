import { resolve } from "node:path";
import { OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  type Filesystem,
  MemoryFilesystem,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
} from "../../ports/index.js";
import type { AndroidDriverConfig } from "./definition.js";
import { AndroidDriver } from "./index.js";
import { binaries, memoryAndroidSourceDatabase } from "./testing.js";

export const sdk = "/android-sdk";

const home = "/home/simlock";

const simlockHome = "/home/simlock/.simlock";

const instanceId = "instance-1";

export const adb = binaries.adb;

// why: `ensureOwnedRoot` resolves the configured root, so on Windows the driver reads `D:\home\...`.
export const avdDirectory = resolve(simlockHome, "devices", "android");

export const PHONE = "R58M123ABC";

export const VERSION_REPLY_41 = "OKAY00040029";

export const VERSION_REPLY_40 = "OKAY00040028";

export const ADB_VERSION_41 =
  "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /android-sdk/platform-tools/adb\n";

export const USB_LINE = `${PHONE} device usb:1-1 product:o1s model:SM_G991B device:o1s transport_id:3`;

export const PHYSICAL = {
  address: PHONE,
  deviceId: PHONE,
  driverData: {},
  enrolledApps: ["com.example.kept", "com.example.gone"],
  physical: true,
} as const;

export const PHYSICAL_SPEC = {
  model: "SM-G991B",
  osVersion: "34",
  physical: true,
  platform: "android",
} as never;

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

export type Override = (
  rest: readonly string[],
) => ProcessResult | Promise<ProcessResult> | "hang" | undefined;

export const OK = (stdout = ""): ProcessResult => ({ code: 0, stderr: "", stdout });

export const FAILED: ProcessResult = { code: 1, stderr: "error: closed", stdout: "" };

export const TIMED_OUT: ProcessResult = { code: null, stderr: "", stdout: "" };

export class PhoneAdb implements ProcessRunner {
  readonly calls: Call[] = [];
  readonly log: string[];
  readonly installed: string[] = ["com.example.kept", "com.example.stray", "com.example.other"];
  versionOutput = ADB_VERSION_41;
  versionCode: number | null = 0;
  versionFailure: Error | undefined;
  devicesOutput = `List of devices attached\n${USB_LINE}\n\n`;
  userOutput = "0\n";
  packagesOutput: string | undefined;
  model = "SM-G991B";
  sdkLevel = "34";
  hardwareSerial = "R58Y61A60HN";
  qemuBoot = "";
  qemuKernel = "0";
  onCall: ((rest: readonly string[]) => void) | undefined;
  readonly #overrides: Override[] = [];

  constructor(log: string[] = []) {
    this.log = log;
  }

  override(answer: Override): void {
    this.#overrides.push(answer);
  }

  get commands(): Call[] {
    return this.calls.filter((call) => call.args[0] !== "version");
  }

  get rests(): string[][] {
    return this.commands.map((call) => restOf(call));
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({ args: [...args], command, options });
    this.log.push(`adb:${args.join(" ")}`);
    if (args[0] === "version") {
      if (this.versionFailure !== undefined) throw this.versionFailure;
      return { code: this.versionCode, stderr: "", stdout: this.versionOutput };
    }
    if (args[0] === "devices") {
      return OK("List of devices attached\n");
    }
    const rest = args[0] === "-P" ? args.slice(2) : args;
    this.onCall?.(rest);
    for (const answer of this.#overrides) {
      const result = answer(rest);
      if (result === "hang") return new Promise<ProcessResult>(() => undefined);
      if (result !== undefined) return result;
    }
    return this.#answer(rest);
  }

  #answer(rest: readonly string[]): ProcessResult {
    const line = rest.join(" ");
    if (line === "devices -l") return OK(this.devicesOutput);
    // why: only a command scoped with -s <serial> reaches the phone; an unscoped one is unexpected.
    const body = rest[0] === "-s" ? rest.slice(2).join(" ") : "";
    const fixed = new Map<string, string>([
      ["shell am get-current-user", this.userOutput],
      ["shell getprop ro.build.version.sdk", `${this.sdkLevel}\n`],
      ["shell getprop ro.product.model", `${this.model}\n`],
      ["shell getprop ro.serialno", `${this.hardwareSerial}\n`],
      ["shell getprop ro.boot.qemu", `${this.qemuBoot}\n`],
      ["shell getprop ro.kernel.qemu", `${this.qemuKernel}\n`],
    ]);
    const answered = fixed.get(body);
    if (answered !== undefined) return OK(answered);
    if (body.startsWith("shell pm list packages -3 --user ")) return OK(this.#packageListing());
    const uninstall = /^shell pm uninstall --user \d+ (\S+)$/.exec(body);
    if (uninstall === null) return { code: 1, stderr: `fake adb: unexpected ${line}`, stdout: "" };
    this.installed.splice(
      0,
      this.installed.length,
      ...this.installed.filter((n) => n !== uninstall[1]),
    );
    return OK("Success\n");
  }

  #packageListing(): string {
    return this.packagesOutput ?? this.installed.map((name) => `package:${name}\n`).join("");
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    const result = this.run(command, args, options);
    async function* none(): AsyncIterable<string> {
      yield* [] as string[];
    }
    return {
      kill: () => undefined,
      pid: 1,
      stderr: none(),
      stdout: none(),
      unref: () => undefined,
      wait: () => result,
    };
  }

  spawnStreaming(
    command: string,
    _args: readonly string[],
    _options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    throw new Error(`fake adb: spawnStreaming ${command} is not used by a driver`);
  }
}

class LoggingTcpProbe extends FakeTcpProbe {
  readonly #log: string[];

  constructor(log: string[], listening: readonly number[]) {
    super(listening);
    this.#log = log;
  }

  override async send(port: number, payload: string, timeoutMs?: number): Promise<string> {
    this.#log.push(`send:${String(port)}:${payload}`);
    return super.send(port, payload, timeoutMs);
  }
}

export interface World {
  readonly driver: AndroidDriver;
  readonly runner: PhoneAdb;
  readonly probe: LoggingTcpProbe;
  readonly log: string[];
  readonly filesystem: Filesystem;
}

export async function world(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly runner?: PhoneAdb;
    readonly filesystem?: Filesystem;
    readonly processRunner?: (phone: PhoneAdb) => ProcessRunner;
    readonly serverReply?: string;
    readonly listeners?: FakeTcpListenerFactory;
    readonly config?: Partial<AndroidDriverConfig>;
  } = {},
): Promise<World> {
  const log: string[] = [];
  const runner = options.runner ?? new PhoneAdb(log);
  const probe = new LoggingTcpProbe(runner.log, [5038]);
  probe.replyWith(options.serverReply ?? VERSION_REPLY_41);
  const filesystem = options.filesystem ?? (await androidFilesystem());
  await filesystem.mkdirp(simlockHome);
  await filesystem.writeFileAtomic(
    `${simlockHome}/adb-server.json`,
    JSON.stringify({ pid: 4242, port: 5038, startedAt: 1 }),
  );
  const driver = await AndroidDriver.create({
    clock: new FakeClock(),
    database: await memoryAndroidSourceDatabase(),
    driverConfig: {},
    ...(options.config === undefined ? {} : { config: options.config }),
    env: { ANDROID_HOME: sdk, ...options.env },
    filesystem,
    homeDirectory: home,
    hostAbi: "arm64-v8a",
    idGenerator: { generate: () => "one" },
    instanceId,
    processRunner: options.processRunner?.(runner) ?? runner,
    processSupervisor: new FakeProcessSupervisor([4242]),
    simlockHome,
    ...(options.listeners === undefined ? {} : { tcpListener: options.listeners }),
    tcpProbe: probe,
  });
  return { driver, filesystem, log: runner.log, probe, runner };
}

export async function androidFilesystem(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(`${sdk}/platform-tools`);
  await filesystem.writeFileAtomic(adb, "binary");
  for (const binary of [binaries.avdmanager, binaries.sdkmanager, binaries.emulator]) {
    await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
    await filesystem.writeFileAtomic(binary, "binary");
  }
  await filesystem.mkdirp(avdDirectory);
  await filesystem.writeFileAtomic(
    `${avdDirectory}/${OWNED_ROOT_MARKER_FILE}`,
    JSON.stringify({ instanceId, owner: "simlock", platform: "android", schemaVersion: 1 }),
  );
  await filesystem.mkdirp(`${sdk}/system-images/android-34/google_apis/arm64-v8a`);
  return filesystem;
}

export function restOf(call: Call): string[] {
  return call.args[0] === "-P" ? call.args.slice(2) : [...call.args];
}

export function devicesListing(...lines: string[]): string {
  return `List of devices attached\n${lines.join("\n")}\n\n`;
}

export function isDevicesListing(rest: readonly string[]): boolean {
  return rest.join(" ") === "devices -l";
}

export function isGetprop(rest: readonly string[]): boolean {
  return rest.includes("getprop");
}

export function isUserRead(rest: readonly string[]): boolean {
  return rest.includes("get-current-user");
}

export function isPackageList(rest: readonly string[]): boolean {
  return rest.includes("list") && rest.includes("packages");
}

export function defaultServerSends(probe: FakeTcpProbe) {
  return probe.sends.filter((send) => send.port === 5037);
}

export const NO_DEVICE = Symbol("no device");

export interface PassthroughResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
}

export function passthroughOf(
  driver: AndroidDriver,
  args: readonly string[],
  device: unknown = PHYSICAL,
  context: { readonly hasTerminal: boolean } = { hasTerminal: false },
): Promise<PassthroughResult> {
  // why: an explicit `undefined` would take the default, so "no device" is a named value.
  const target = device === NO_DEVICE ? undefined : device;
  return (
    driver as unknown as {
      passthrough(
        tool: string,
        device: unknown,
        args: readonly string[],
        context: { readonly hasTerminal: boolean },
      ): Promise<PassthroughResult>;
    }
  ).passthrough("adb", target, args, context);
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );
}
