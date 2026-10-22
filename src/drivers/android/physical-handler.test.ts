import { describe, expect, it } from "vitest";

import {
  OWNED_ROOT_MARKER_FILE,
  PassthroughRefusedError,
  ScreenUnavailableError,
} from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type Filesystem,
  MemoryFilesystem,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  ProcessSpawnError,
  ScriptedProcessRunner,
  type StreamingProcessHandle,
} from "../../ports/index.js";
import { AndroidDriver } from "./index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import type { ScreenTarget } from "./screen/index.js";

const sdk = "/android-sdk";
const home = "/home/simlock";
const simlockHome = "/home/simlock/.simlock";
const instanceId = "instance-1";
const adb = `${sdk}/platform-tools/adb`;
const avdDirectory = `${simlockHome}/devices/android`;

const PHONE = "R58M123ABC";
const VERSION_REPLY_41 = "OKAY00040029";
const VERSION_REPLY_40 = "OKAY00040028";
const HOST_VERSION = "000chost:version";
const ADB_VERSION_41 =
  "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /android-sdk/platform-tools/adb\n";
const ADB_VERSION_40 = "Android Debug Bridge version 1.0.40\nVersion 34.0.0-9570255\n";

const USB_LINE = `${PHONE} device usb:1-1 product:o1s model:SM_G991B device:o1s transport_id:3`;
const PHYSICAL = {
  address: PHONE,
  deviceId: PHONE,
  driverData: {},
  enrolledApps: ["com.example.kept", "com.example.gone"],
  physical: true,
} as const;
const EMULATOR_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;
const PHYSICAL_SPEC = {
  model: "SM-G991B",
  osVersion: "34",
  physical: true,
  platform: "android",
} as never;
const VIRTUAL_SPEC = {
  model: "Pixel 8",
  osVersion: "34",
  physical: false,
  platform: "android",
} as never;

const REFUSED_SUBCOMMANDS = [
  "kill-server",
  "start-server",
  "server",
  "nodaemon",
  "connect",
  "disconnect",
  "pair",
  "reconnect",
  "tcpip",
  "usb",
  "detach",
  "reboot-bootloader",
];
const REFUSED_REBOOT_TARGETS = [
  "bootloader",
  "sideload",
  "sideload-auto-reboot",
  "recovery",
  "fastboot",
];
const REFUSED_LEADING_FLAGS = [
  "-s",
  "-t",
  "-d",
  "-e",
  "-P",
  "-H",
  "-L",
  "--one-device",
  "--reply-fd",
];

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

type Override = (rest: readonly string[]) => ProcessResult | "hang" | undefined;

const OK = (stdout = ""): ProcessResult => ({ code: 0, stderr: "", stdout });
const FAILED: ProcessResult = { code: 1, stderr: "error: closed", stdout: "" };
const TIMED_OUT: ProcessResult = { code: null, stderr: "", stdout: "" };

class PhoneAdb implements ProcessRunner {
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

class SplitRunner implements ProcessRunner {
  constructor(
    private readonly phone: PhoneAdb,
    private readonly emulator: ScriptedProcessRunner,
  ) {}

  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return this.#isPhone(args)
      ? this.phone.run(command, args, options)
      : this.emulator.run(command, args, options);
  }

  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle {
    return this.#isPhone(args)
      ? this.phone.spawn(command, args, options)
      : this.emulator.spawn(command, args, options);
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    return this.emulator.spawnStreaming(command, args, options);
  }

  #isPhone(args: readonly string[]): boolean {
    return args[0] === "version" || (args[0] === "-P" && args[1] === "5037");
  }
}

interface World {
  readonly driver: AndroidDriver;
  readonly runner: PhoneAdb;
  readonly probe: LoggingTcpProbe;
  readonly log: string[];
  readonly filesystem: Filesystem;
}

async function world(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly runner?: PhoneAdb;
    readonly filesystem?: Filesystem;
    readonly processRunner?: (phone: PhoneAdb) => ProcessRunner;
    readonly serverReply?: string;
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
    driverConfig: {},
    env: { ANDROID_HOME: sdk, ...options.env },
    filesystem,
    homeDirectory: home,
    hostAbi: "arm64-v8a",
    idGenerator: { generate: () => "one" },
    instanceId,
    processRunner: options.processRunner?.(runner) ?? runner,
    processSupervisor: new FakeProcessSupervisor([4242]),
    simlockHome,
    tcpProbe: probe,
  });
  return { driver, filesystem, log: runner.log, probe, runner };
}

async function androidFilesystem(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(`${sdk}/platform-tools`);
  await filesystem.writeFileAtomic(adb, "binary");
  for (const binary of [
    `${sdk}/cmdline-tools/latest/bin/avdmanager`,
    `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
    `${sdk}/emulator/emulator`,
  ]) {
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

function restOf(call: Call): string[] {
  return call.args[0] === "-P" ? call.args.slice(2) : [...call.args];
}

function econnrefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5037"), { code: "ECONNREFUSED" });
}

function devicesListing(...lines: string[]): string {
  return `List of devices attached\n${lines.join("\n")}\n\n`;
}

function isDevicesListing(rest: readonly string[]): boolean {
  return rest.join(" ") === "devices -l";
}

function isGetprop(rest: readonly string[]): boolean {
  return rest.includes("getprop");
}

function isUserRead(rest: readonly string[]): boolean {
  return rest.includes("get-current-user");
}

function isPackageList(rest: readonly string[]): boolean {
  return rest.includes("list") && rest.includes("packages");
}

function isUninstall(rest: readonly string[]): boolean {
  return rest.includes("uninstall");
}

function defaultServerSends(probe: FakeTcpProbe) {
  return probe.sends.filter((send) => send.port === 5037);
}

function hostVersionSends(probe: FakeTcpProbe) {
  return defaultServerSends(probe).filter((send) => send.payload === HOST_VERSION);
}

async function advisoriesOf(
  driver: AndroidDriver,
): Promise<readonly { readonly code: string; readonly message: string }[]> {
  return driver.advisories();
}

const NO_DEVICE = Symbol("no device");

interface PassthroughResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
}

function passthroughOf(
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

/** why: a refusal test starts from the same input accepted, so it cannot pass for another reason. */
async function expectReclaimAccepted(): Promise<void> {
  const accepted = await world();
  await expect(accepted.driver.reclaim(PHYSICAL, { clean: "standard" })).resolves.toMatchObject({
    strategy: "uninstall",
  });
}

async function expectPassthroughAccepted(driver: AndroidDriver): Promise<void> {
  const accepted = await passthroughOf(driver, ["shell", "getprop"]);
  expect(accepted.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );
}

describe("Android physical handler: the protocol gate", () => {
  it("sends one host:version to port 5037 with a 5000 ms limit right before every adb command a physical method sends, and nothing else to 5037", async () => {
    const { driver, runner, probe, log } = await world();

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([PHONE]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });
    const commandsBeforePassthrough = runner.commands.length;
    const sendsBeforePassthrough = defaultServerSends(probe).length;
    await passthroughOf(driver, ["shell", "getprop"]);

    expect(defaultServerSends(probe).length).toBe(commandsBeforePassthrough + 1);
    expect(defaultServerSends(probe).length).toBe(sendsBeforePassthrough + 1);
    for (const send of defaultServerSends(probe)) {
      expect(send).toMatchObject({ payload: HOST_VERSION, port: 5037, timeoutMs: 5000 });
    }
    const ordered = log.filter(
      (entry) => entry !== `adb:version` && !entry.startsWith("send:5038:"),
    );
    ordered.forEach((entry, index) => {
      if (entry.startsWith("adb:")) {
        expect(ordered[index - 1], `no host:version right before ${entry}`).toBe(
          `send:5037:${HOST_VERSION}`,
        );
      }
    });
  });

  it("estimate and leaseEnvironment on a physical device send nothing to 5037 and start no process", async () => {
    const { driver, runner, probe } = await world();

    driver.estimate({ clean: "standard", operation: "reclaim" }, PHYSICAL_SPEC);
    driver.leaseEnvironment(PHYSICAL);

    expect(defaultServerSends(probe)).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("a server that turns to another protocol after adb devices -l gets no getprop from inspectPhysical, which is refused not-connected naming both versions", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isDevicesListing(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
    expect((inspection as { message: string }).message).toMatch(/40/);
    expect((inspection as { message: string }).message).toMatch(/41/);
    expect(runner.rests.some(isGetprop)).toBe(false);
  });

  it("a server that turns to another protocol after adb devices -l answers that serial not present not-present, with no getprop", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isDevicesListing(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.rests.some(isGetprop)).toBe(false);
  });

  it("a server that turns to another protocol after the first uninstall makes reclaim reject with no second uninstall", async () => {
    const { driver, runner, probe } = await world();
    runner.onCall = (rest) => {
      if (isUninstall(rest)) probe.replyWith(VERSION_REPLY_40);
    };

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it("two passthrough calls on a physical device send two host:version: nothing keeps the server's answer", async () => {
    const { driver, probe } = await world();

    await passthroughOf(driver, ["shell", "getprop"]);
    await passthroughOf(driver, ["shell", "getprop"]);

    expect(hostVersionSends(probe)).toHaveLength(2);
  });

  it("after advisories() saw a mismatch, a passthrough whose own check matches returns its command", async () => {
    const { driver, probe } = await world({ serverReply: VERSION_REPLY_40 });
    expect(await advisoriesOf(driver)).toHaveLength(1);
    probe.replyWith(VERSION_REPLY_41);

    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(command.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
  });

  it("after advisories() saw a match, a passthrough whose own check sees another version is refused", async () => {
    const { driver, probe } = await world();
    expect(await advisoriesOf(driver)).toEqual([]);
    probe.replyWith(VERSION_REPLY_40);

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it("no physical method and no passthrough result runs kill-server or start-server, and dispose() sends nothing to 5037", async () => {
    const { driver, runner, probe } = await world();

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([PHONE]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });
    const command = await passthroughOf(driver, ["shell", "getprop"]);
    const sendsBefore = defaultServerSends(probe).length;
    await driver.dispose();

    const words = [...runner.calls.map((call) => call.args), command.args].flat();
    expect(words).not.toContain("kill-server");
    expect(words).not.toContain("start-server");
    expect(defaultServerSends(probe).every((send) => send.payload === HOST_VERSION)).toBe(true);
    expect(defaultServerSends(probe).slice(sendsBefore)).toEqual([]);
  });

  it("with a default server of another protocol, no physical method starts a process after adb version: every serial is not present, inspectPhysical is refused naming both protocol numbers, reclaim rejects", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const present = await driver.listPresentPhysical([PHONE, "SERIAL2"]);
    const inspection = await driver.inspectPhysical(PHONE);
    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(present).toEqual([
      { driverDeviceId: PHONE, present: false, reason: "not-present" },
      { driverDeviceId: "SERIAL2", present: false, reason: "not-present" },
    ]);
    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
    expect((inspection as { message: string }).message).toMatch(/40.*41|41.*40/s);
    expect(failure).toBeInstanceOf(Error);
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["not a version", "OKAY0004zzzz"],
    ["another status", "FAIL0004oops"],
    ["empty (a timeout)", ""],
    ["short", "OKAY0004"],
  ])(
    "a host:version reply that is %s blocks physical commands like a mismatch",
    async (_name, reply) => {
      const { driver, runner } = await world({ serverReply: reply });

      const present = await driver.listPresentPhysical([PHONE]);

      expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
      expect(runner.commands).toEqual([]);
    },
  );

  it("a send that rejects with an error other than ECONNREFUSED blocks physical commands like a mismatch", async () => {
    const { driver, runner, probe } = await world();
    probe.failSendsWith(Object.assign(new Error("reset"), { code: "ECONNRESET" }));

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("an adb version with no protocol number blocks physical commands", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("an adb version that exits non-zero blocks physical commands even when it printed a matching number", async () => {
    const { driver, runner } = await world();
    runner.versionCode = 1;

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("a send that rejects with ECONNREFUSED (nothing listens on 5037) lets physical commands run", async () => {
    const { driver, runner, probe } = await world();
    probe.failSendsWith(econnrefused());

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.some(isDevicesListing)).toBe(true);
  });

  it("an adb version with no protocol number blocks physical commands even when send rejects with ECONNREFUSED", async () => {
    const { driver, runner, probe } = await world();
    runner.versionOutput = "adb: not a version\n";
    probe.failSendsWith(econnrefused());

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
    expect(runner.commands).toEqual([]);
  });

  it("inspectPhysical is refused unreadable naming Simlock's adb version when adb version has no protocol number", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
    expect((inspection as { message: string }).message).toContain("Simlock's adb version");
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["is not a version", "OKAY0004zzzz", undefined],
    ["is empty", "", undefined],
    [
      "is a send that rejects with another error",
      "",
      Object.assign(new Error("x"), { code: "EPIPE" }),
    ],
  ])(
    "inspectPhysical is refused unreadable naming the adb server's version on port 5037 when the reply %s",
    async (_name, reply, failure) => {
      const { driver, runner, probe } = await world({ serverReply: reply });
      if (failure !== undefined) probe.failSendsWith(failure);

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect((inspection as { message: string }).message).toContain(
        "the adb server's version on port 5037",
      );
      expect(runner.commands).toEqual([]);
    },
  );

  it("a server that matched again after a mismatch gets commands on the next call, and nothing restarts it", async () => {
    const { driver, runner, probe } = await world({ serverReply: VERSION_REPLY_40 });
    expect(await driver.listPresentPhysical([PHONE])).toEqual([
      { driverDeviceId: PHONE, present: false, reason: "not-present" },
    ]);
    probe.replyWith(VERSION_REPLY_41);

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.flat()).not.toContain("kill-server");
    expect(runner.rests.flat()).not.toContain("start-server");
  });

  it("Simlock's adb version runs once across several physical calls", async () => {
    const { driver, runner } = await world();

    await driver.listPresentPhysical([PHONE]);
    await driver.listPresentPhysical([PHONE]);
    await driver.inspectPhysical(PHONE);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(1);
  });

  it("after a failed adb version, the next call runs adb version again", async () => {
    const { driver, runner } = await world();
    runner.versionOutput = "adb: not a version\n";
    await driver.listPresentPhysical([PHONE]);
    runner.versionOutput = ADB_VERSION_41;

    const present = await driver.listPresentPhysical([PHONE]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
  });

  it("after the adb binary's size changes, the next call runs adb version again and uses the new number", async () => {
    const { driver, runner, filesystem } = await world();
    expect(await driver.listPresentPhysical([PHONE])).toMatchObject([{ present: true }]);
    runner.versionOutput = ADB_VERSION_40;
    await filesystem.writeFileAtomic(adb, "a much bigger binary after a platform-tools update");

    const present = await driver.listPresentPhysical([PHONE]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });

  it("after the adb binary's modifiedAtMs changes, the next call runs adb version again and uses the new number", async () => {
    const base = await androidFilesystem();
    let modifiedAtMs = 1_000;
    const filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "stat") {
          return async (path: string) => ({ ...(await target.stat(path)), modifiedAtMs });
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const { driver, runner } = await world({ filesystem });
    expect(await driver.listPresentPhysical([PHONE])).toMatchObject([{ present: true }]);
    runner.versionOutput = ADB_VERSION_40;
    modifiedAtMs = 2_000;

    const present = await driver.listPresentPhysical([PHONE]);

    expect(runner.calls.filter((call) => call.args[0] === "version")).toHaveLength(2);
    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });
});

describe("Android physical handler: the gate on a failing adb version", () => {
  it("says Simlock's version is unreadable, and does not reject, when stat throws", async () => {
    const base = await androidFilesystem();
    let broken = false;
    const filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "stat" && broken) {
          return async () => {
            throw new Error("EACCES");
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const { driver } = await world({ filesystem });
    broken = true;

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });

  it("says Simlock's version is unreadable, and does not reject, when adb version cannot spawn", async () => {
    const { driver, runner } = await world();
    runner.versionFailure = new ProcessSpawnError(adb, ["version"]);

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });
});

describe("Android physical handler: advisories", () => {
  it("returns adb-protocol-mismatch naming both protocol numbers on a mismatch", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/40/);
    expect(advisories[0]?.message).toMatch(/41/);
    expect(runner.commands).toEqual([]);
  });

  it.each([
    ["is not a version", "OKAY0004zzzz", undefined],
    ["is empty", "", undefined],
    [
      "is a send that rejects with another error",
      "",
      Object.assign(new Error("x"), { code: "EPIPE" }),
    ],
  ])("says the server's version is unreadable when the reply %s", async (_name, reply, failure) => {
    const { driver, probe } = await world({ serverReply: reply });
    if (failure !== undefined) probe.failSendsWith(failure);

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/the adb server's version on port 5037 is unreadable/);
  });

  it("says Simlock's version is unreadable when adb version has no protocol number, with send rejecting ECONNREFUSED too", async () => {
    const { driver, runner, probe } = await world();
    runner.versionOutput = "adb: not a version\n";
    probe.failSendsWith(econnrefused());

    const advisories = await advisoriesOf(driver);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.code).toBe("adb-protocol-mismatch");
    expect(advisories[0]?.message).toMatch(/Simlock's adb version is unreadable/);
  });

  it("returns nothing on a match", async () => {
    const { driver } = await world();

    expect(await advisoriesOf(driver)).toEqual([]);
  });

  it("returns nothing when send rejects with ECONNREFUSED", async () => {
    const { driver, probe } = await world();
    probe.failSendsWith(econnrefused());

    expect(await advisoriesOf(driver)).toEqual([]);
  });
});

describe("Android physical handler: scope", () => {
  const POISON = {
    ADB_SERVER_SOCKET: "tcp:other:5037",
    ANDROID_ADB_SERVER_ADDRESS: "other-host",
    ANDROID_SERIAL: "someone-elses-phone",
  } as const;

  it("with ANDROID_ADB_SERVER_ADDRESS, ADB_SERVER_SOCKET and ANDROID_SERIAL in the base environment, every physical command runs adb -P 5037 with ANDROID_ADB_SERVER_PORT=5037 and none of the three, and every device command carries -s <serial>", async () => {
    const { driver, runner } = await world({ env: POISON });

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([PHONE]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(runner.commands.length).toBeGreaterThan(5);
    for (const call of runner.commands) {
      expect(call.command).toBe(adb);
      expect(call.args.slice(0, 2)).toEqual(["-P", "5037"]);
      expect(call.options.env).toMatchObject({ ANDROID_ADB_SERVER_PORT: "5037" });
      expect(call.options.env).not.toHaveProperty("ANDROID_ADB_SERVER_ADDRESS");
      expect(call.options.env).not.toHaveProperty("ADB_SERVER_SOCKET");
      expect(call.options.env).not.toHaveProperty("ANDROID_SERIAL");
      if (!isDevicesListing(restOf(call))) {
        expect(restOf(call).slice(0, 2)).toEqual(["-s", PHONE]);
      }
    }
  });
});

describe("Android physical handler: inspectPhysical", () => {
  it("returns the serial, ro.product.model, the API level, class phone and the packages pm list packages -3 --user <id> lists for the id am get-current-user prints", async () => {
    const { driver, runner } = await world();
    runner.userOutput = "10\n";
    runner.installed.splice(0, runner.installed.length, "com.example.kept", "com.example.stray");

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toEqual({
      apps: ["com.example.kept", "com.example.stray"],
      class: "phone",
      driverDeviceId: PHONE,
      enrollable: true,
      model: "SM-G991B",
      osVersion: "34",
    });
    expect(runner.rests).toContainEqual([
      "-s",
      PHONE,
      "shell",
      "pm",
      "list",
      "packages",
      "-3",
      "--user",
      "10",
    ]);
    expect(runner.rests).toContainEqual(["-s", PHONE, "shell", "getprop", "ro.product.model"]);
  });

  it("refuses a serial in state unauthorized as untrusted, and runs no command naming it", async () => {
    const { driver, runner } = await world();
    expect(await driver.inspectPhysical(PHONE)).toMatchObject({ enrollable: true });
    runner.calls.length = 0;
    runner.devicesOutput = devicesListing(`${PHONE} unauthorized usb:1-1 transport_id:3`);

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "untrusted" });
    expect(runner.commands.filter((call) => call.args.includes("-s"))).toEqual([]);
  });

  it.each([
    [
      "a network serial",
      "192.168.1.5:5555 device product:o1s model:SM_G991B transport_id:4",
      "192.168.1.5:5555",
    ],
    [
      "an mDNS name",
      "adb-R58M123ABC-xyz._adb-tls-connect._tcp device product:o1s model:SM_G991B transport_id:4",
      "adb-R58M123ABC-xyz._adb-tls-connect._tcp",
    ],
    [
      "a listed emulator",
      "emulator-5554 device product:sdk_gphone model:sdk transport_id:1",
      "emulator-5554",
    ],
    [
      "a USB-shaped serial on a network line",
      `${PHONE} device product:o1s model:SM_G991B transport_id:3`,
      PHONE,
    ],
  ])(
    "refuses %s as network-only with the USB-only message, and runs no command naming it",
    async (_name, line, id) => {
      const { driver, runner } = await world();
      runner.devicesOutput = devicesListing(line);

      const inspection = await driver.inspectPhysical(id);

      expect(inspection).toMatchObject({ enrollable: false, reason: "network-only" });
      expect((inspection as { message: string }).message).toContain(
        "only USB-connected devices can be enrolled",
      );
      expect(runner.commands.filter((call) => call.args.includes("-s"))).toEqual([]);
    },
  );

  it("inspects a host:port-shaped serial on a USB transport: the transport decides, not the shape", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(
      "192.168.1.5:5555 device usb:1-1 product:o1s model:SM_G991B transport_id:5",
    );

    const inspection = await driver.inspectPhysical("192.168.1.5:5555");

    expect(inspection).toMatchObject({ driverDeviceId: "192.168.1.5:5555", enrollable: true });
  });

  it.each([
    ["not listed", devicesListing()],
    ["listed offline", devicesListing(`${PHONE} offline usb:1-1 transport_id:3`)],
  ])("refuses a serial that is %s as not-connected", async (_name, listing) => {
    const { driver, runner } = await world();
    expect(await driver.inspectPhysical(PHONE)).toMatchObject({ enrollable: true });
    runner.devicesOutput = listing;

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
  });

  it.each([
    [
      "adb devices -l fails",
      (rest: readonly string[]) => (isDevicesListing(rest) ? FAILED : undefined),
      /could not read the device list \(adb devices -l\)/,
    ],
    [
      "adb devices -l passes 30 s",
      (rest: readonly string[]) => (isDevicesListing(rest) ? TIMED_OUT : undefined),
      /could not read the device list \(adb devices -l\)/,
    ],
    [
      "getprop fails",
      (rest: readonly string[]) => (isGetprop(rest) ? FAILED : undefined),
      /could not read the model/,
    ],
    [
      "the user id read fails",
      (rest: readonly string[]) => (isUserRead(rest) ? FAILED : undefined),
      /could not read the current user id/,
    ],
    [
      "the package list fails",
      (rest: readonly string[]) => (isPackageList(rest) ? FAILED : undefined),
      /could not read the user apps/,
    ],
  ])(
    "is refused unreadable naming the read, and does not reject, when %s",
    async (_name, override, named) => {
      const { driver, runner } = await world();
      runner.override(override);

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect((inspection as { message: string }).message).toMatch(named);
    },
  );

  it("is refused unreadable, and does not reject, when the process runner cannot spawn adb", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => {
      if (isDevicesListing(rest)) throw new ProcessSpawnError(adb, rest);
      return undefined;
    });

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it("lists nothing present, and does not reject, when the process runner cannot spawn adb", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => {
      if (isDevicesListing(rest)) throw new ProcessSpawnError(adb, rest);
      return undefined;
    });

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });

  it.each([
    ["a shell injection", "0; rm -r /sdcard\n"],
    ["nothing", ""],
    ["seven digits", "1234567\n"],
  ])(
    "is refused unreadable and runs no pm list packages when am get-current-user prints %s",
    async (_name, printed) => {
      const { driver, runner } = await world();
      runner.userOutput = printed;

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect(runner.rests.some(isPackageList)).toBe(false);
    },
  );
});

describe("Android physical handler: listPresentPhysical", () => {
  it("answers a USB serial in state device present with its API level, an unauthorized one not present untrusted, and an offline, network-only or missing one not present not-present", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(
      USB_LINE,
      "UNAUTH1 unauthorized usb:1-2 transport_id:4",
      "OFFLINE1 offline usb:1-3 transport_id:5",
      "192.168.1.5:5555 device product:o1s transport_id:6",
    );

    const present = await driver.listPresentPhysical([
      PHONE,
      "UNAUTH1",
      "OFFLINE1",
      "192.168.1.5:5555",
      "MISSING1",
    ]);

    expect(present).toEqual([
      { driverDeviceId: PHONE, osVersion: "34", present: true },
      { driverDeviceId: "UNAUTH1", present: false, reason: "untrusted" },
      { driverDeviceId: "OFFLINE1", present: false, reason: "not-present" },
      { driverDeviceId: "192.168.1.5:5555", present: false, reason: "not-present" },
      { driverDeviceId: "MISSING1", present: false, reason: "not-present" },
    ]);
  });

  it("gives no entry, and runs no command, for a USB phone that is not among the given serials", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(USB_LINE, "OTHER99 device usb:1-2 transport_id:4");

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.flat()).not.toContain("OTHER99");
  });

  it.each([
    ["fails", FAILED],
    ["has no exit code", TIMED_OUT],
  ])(
    "answers every given serial not present not-present, and does not reject, when adb devices -l %s",
    async (_name, result) => {
      const { driver, runner } = await world();
      runner.override((rest) => (isDevicesListing(rest) ? result : undefined));

      const present = await driver.listPresentPhysical([PHONE, "SERIAL2"]);

      expect(present).toEqual([
        { driverDeviceId: PHONE, present: false, reason: "not-present" },
        { driverDeviceId: "SERIAL2", present: false, reason: "not-present" },
      ]);
    },
  );

  it("answers a present serial whose getprop fails not present not-present", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => (isGetprop(rest) ? FAILED : undefined));

    const present = await driver.listPresentPhysical([PHONE]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });
});

describe("Android physical handler: reclaim", () => {
  it("uninstalls, for the current user, each package off the enrollment list, uninstalls no listed package, reports listed packages not installed as missingApps, and returns strategy uninstall", async () => {
    const { driver, runner } = await world();
    runner.userOutput = "10\n";

    const result = await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(result).toEqual({
      missingApps: ["com.example.gone"],
      state: "ready",
      strategy: "uninstall",
    });
    expect(runner.rests.filter(isUninstall)).toEqual([
      ["-s", PHONE, "shell", "pm", "uninstall", "--user", "10", "com.example.stray"],
      ["-s", PHONE, "shell", "pm", "uninstall", "--user", "10", "com.example.other"],
    ]);
    expect(runner.installed).toEqual(["com.example.kept"]);
  });

  it("with nothing off the list runs no uninstall", async () => {
    const { driver, runner } = await world();
    runner.installed.splice(0, runner.installed.length, "com.example.kept");

    const result = await driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(result).toMatchObject({ strategy: "uninstall" });
    expect(runner.rests.some(isUninstall)).toBe(false);
  });

  it.each([
    ["a shell injection", "0; rm -r /sdcard\n"],
    ["nothing", ""],
    ["seven digits", "1234567\n"],
  ])(
    "rejects, with no pm list packages and no pm uninstall, when am get-current-user prints %s",
    async (_name, printed) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.userOutput = printed;

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isPackageList)).toBe(false);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
  ])(
    "rejects, with no pm list packages and no pm uninstall, when the user id read %s",
    async (_name, result) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.override((rest) => (isUserRead(rest) ? result : undefined));

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isPackageList)).toBe(false);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
  ])(
    "rejects, runs no uninstall and never resolves with an empty list when the first pm list packages %s",
    async (_name, result) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.override((rest) => (isPackageList(rest) ? result : undefined));

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it.each([
    ["prints Failure […]", OK("Failure [DELETE_FAILED_INTERNAL_ERROR]\n")],
    ["exits non-zero", FAILED],
    ["has no exit code", TIMED_OUT],
  ])("rejects, and runs no later uninstall, when an uninstall %s", async (_name, result) => {
    const { driver, runner } = await world();
    runner.override((rest) => (isUninstall(rest) ? result : undefined));

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it.each([
    ["fails", FAILED],
    ["passes 30 s", TIMED_OUT],
    ["has a bad line", OK("package:com.example.kept\npackage:\n")],
  ])("rejects when the second listing %s", async (_name, result) => {
    const { driver, runner } = await world();
    let listings = 0;
    runner.override((rest) => {
      if (!isPackageList(rest)) return undefined;
      listings += 1;
      return listings === 2 ? result : undefined;
    });

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
    expect(listings).toBe(2);
  });

  it("rejects when the second listing still holds a package off the enrollment list", async () => {
    await expectReclaimAccepted();
    const { driver, runner } = await world();
    let listings = 0;
    runner.override((rest) => {
      if (!isPackageList(rest)) return undefined;
      listings += 1;
      return listings === 2
        ? OK("package:com.example.kept\npackage:com.example.stray\n")
        : undefined;
    });

    const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

    expect(failure).toBeInstanceOf(Error);
  });

  it.each([
    ["a character outside letters, digits, _ and .", "package:com.example;rm -rf\n"],
    ["a space", "package:com example\n"],
    ["a bare package:", "package:\n"],
    ["no package: prefix", "com.example.stray\n"],
  ])(
    "fails the listing, and runs no uninstall, for a package line with %s",
    async (_name, line) => {
      await expectReclaimAccepted();
      const { driver, runner } = await world();
      runner.packagesOutput = line;

      const failure = await rejectionOf(driver.reclaim(PHYSICAL, { clean: "standard" }));

      expect(failure).toBeInstanceOf(Error);
      expect(runner.rests.some(isUninstall)).toBe(false);
    },
  );

  it("reads a package listing with \\r\\n line ends and blank lines as the same packages as one with \\n and none", async () => {
    const plain = await world();
    plain.runner.installed.splice(0, 3, "com.example.kept", "com.example.stray");
    await plain.driver.reclaim(PHYSICAL, { clean: "standard" });
    const crlf = await world();
    crlf.runner.installed.splice(0, 3, "com.example.kept", "com.example.stray");
    crlf.runner.override((rest) =>
      isPackageList(rest)
        ? OK(crlf.runner.installed.map((name) => `package:${name}\r\n\r\n`).join(""))
        : undefined,
    );

    await crlf.driver.reclaim(PHYSICAL, { clean: "standard" });

    expect(crlf.runner.rests.filter(isUninstall)).toEqual(plain.runner.rests.filter(isUninstall));
    expect(crlf.runner.rests.filter(isUninstall)).toHaveLength(1);
  });

  it("passes a 30 000 ms limit with every read and a 60 000 ms limit with every uninstall to the process runner", async () => {
    const { driver, runner } = await world();

    await driver.inspectPhysical(PHONE);
    await driver.listPresentPhysical([PHONE]);
    await driver.reclaim(PHYSICAL, { clean: "standard" });

    const uninstalls = runner.commands.filter((call) => isUninstall(restOf(call)));
    const reads = runner.calls.filter((call) => !isUninstall(restOf(call)));
    expect(uninstalls).not.toHaveLength(0);
    expect(uninstalls.map((call) => call.options.timeoutMs)).toEqual(uninstalls.map(() => 60_000));
    expect(reads.map((call) => call.options.timeoutMs)).toEqual(reads.map(() => 30_000));
  });
});

describe("Android physical handler: independence from emulator calls", () => {
  it("while a physical adb devices -l hangs, listManaged for emulators resolves", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => (isDevicesListing(rest) ? "hang" : undefined));
    let physicalSettled = false;
    void driver.listPresentPhysical([PHONE]).then(() => (physicalSettled = true));

    const reality = await driver.listManaged();

    expect(reality.devices).toEqual([]);
    expect(physicalSettled).toBe(false);
  });

  it("while an emulator call holds the device lock and a PortAllocator port, listPresentPhysical and passthrough on a physical device resolve", async () => {
    const phone = new PhoneAdb();
    const emulatorExpectations = [
      scripted(sdkTool("avdmanager"), ["list", "device"], pixelDevices),
      scripted(sdkTool("avdmanager"), [
        "create",
        "avd",
        "-n",
        "simlock_one",
        "-k",
        /.+/,
        "-d",
        "pixel_8",
      ]),
      scripted(`${sdk}/emulator/emulator`, ["-version"], "Android emulator version 36.1.9"),
      scripted(adb, ["devices"], "List of devices attached\n"),
      {
        hangs: true,
        match: {
          args: [/^-avd$/, "simlock_one", /.*/, /.*/, /.*/, /.*/],
          command: `${sdk}/emulator/emulator`,
        },
      },
      {
        hangs: true,
        match: {
          args: ["-s", /^emulator-\d+$/, "shell", "getprop", "sys.boot_completed"],
          command: adb,
        },
      },
    ];
    const emulator = new ScriptedProcessRunner(emulatorExpectations);
    const filesystem = await androidFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
    await filesystem.writeFileAtomic(
      `${avdDirectory}/simlock_one.avd/config.ini`,
      "hw.ramSize=2048\n",
    );
    const { driver } = await world({
      filesystem,
      processRunner: () => new SplitRunner(phone, emulator),
      runner: phone,
    });
    const spec = await driver.resolveSpec({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    const provisioned = await driver.provision(spec);
    let emulatorSettled = false;
    void driver.makeReady(provisioned).then(
      () => (emulatorSettled = true),
      () => (emulatorSettled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const present = await driver.listPresentPhysical([PHONE]);
    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(emulatorSettled).toBe(false);
    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(command.args).toEqual(["-P", "5037", "-s", PHONE, "shell", "getprop"]);
  });
});

describe("Android physical handler: passthrough", () => {
  it("resolves passthrough of adb shell getprop on a physical device to adb -P 5037 -s <serial> shell getprop with ANDROID_ADB_SERVER_PORT=5037", async () => {
    const { driver } = await world();

    const command = await passthroughOf(driver, ["shell", "getprop"]);

    expect(command).toMatchObject({
      args: ["-P", "5037", "-s", PHONE, "shell", "getprop"],
      command: adb,
      env: { ANDROID_ADB_SERVER_PORT: "5037" },
    });
  });

  it.each(REFUSED_LEADING_FLAGS)(
    "refuses the caller argument %s before the subcommand",
    async (flag) => {
      const { driver } = await world();
      await expectPassthroughAccepted(driver);

      const failure = await rejectionOf(passthroughOf(driver, [flag, "x", "shell", "getprop"]));

      expect(failure).toBeInstanceOf(PassthroughRefusedError);
    },
  );

  it.each(REFUSED_SUBCOMMANDS)("refuses %s as the subcommand", async (subcommand) => {
    const { driver } = await world();
    await expectPassthroughAccepted(driver);

    const failure = await rejectionOf(passthroughOf(driver, [subcommand]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it.each(REFUSED_REBOOT_TARGETS)("refuses reboot followed by %s", async (target) => {
    const { driver } = await world();
    expect(await passthroughOf(driver, ["reboot"])).toBeDefined();

    const failure = await rejectionOf(passthroughOf(driver, ["reboot", target]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it("refuses a bare shell with no terminal", async () => {
    const { driver } = await world();
    await expectPassthroughAccepted(driver);

    const failure = await rejectionOf(passthroughOf(driver, ["shell"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
  });

  it.each([
    ["shell dumpsys usb", ["shell", "dumpsys", "usb"]],
    ["shell echo connect", ["shell", "echo", "connect"]],
    ["reboot", ["reboot"]],
  ])(
    "runs %s: a refused word after the subcommand is an operand, and a plain reboot is not refused",
    async (_name, args) => {
      const { driver } = await world();

      const command = await passthroughOf(driver, args);

      expect(command.args).toEqual(["-P", "5037", "-s", PHONE, ...args]);
    },
  );

  it("is refused with PassthroughRefusedError naming both versions when its check sees another version, and the process runner starts nothing", async () => {
    const { driver, runner } = await world({ serverReply: VERSION_REPLY_40 });

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
    expect((failure as Error).message).toMatch(/40.*41|41.*40/s);
    expect(runner.commands).toEqual([]);
  });

  it("is refused with PassthroughRefusedError naming which version it cannot read, and the process runner starts nothing", async () => {
    const { driver, runner } = await world({ serverReply: "" });

    const failure = await rejectionOf(passthroughOf(driver, ["shell", "getprop"]));

    expect(failure).toBeInstanceOf(PassthroughRefusedError);
    expect((failure as Error).message).toMatch(
      /the adb server's version on port 5037 is unreadable/,
    );
    expect(runner.commands).toEqual([]);
  });

  it("returns unsetEnv ANDROID_ADB_SERVER_ADDRESS, ADB_SERVER_SOCKET and ANDROID_SERIAL for a physical device, and none with no device", async () => {
    const { driver } = await world();

    const physical = await passthroughOf(driver, ["shell", "getprop"]);
    const none = await passthroughOf(driver, ["shell", "getprop"], NO_DEVICE);

    expect([...(physical.unsetEnv ?? [])].sort()).toEqual([
      "ADB_SERVER_SOCKET",
      "ANDROID_ADB_SERVER_ADDRESS",
      "ANDROID_SERIAL",
    ]);
    expect(none.unsetEnv ?? []).toEqual([]);
  });

  it("with no device, or with an emulator device, still runs on Simlock's own server and sends no host:version", async () => {
    const { driver, probe } = await world();

    const without = await passthroughOf(driver, ["shell", "getprop"], NO_DEVICE);
    const emulator = await passthroughOf(driver, ["shell", "getprop"], EMULATOR_DEVICE);

    expect(without).toEqual({
      args: ["-P", "5038", "shell", "getprop"],
      command: adb,
      env: { ANDROID_ADB_SERVER_PORT: "5038" },
    });
    expect(emulator).toEqual(without);
    expect(defaultServerSends(probe)).toEqual([]);
  });
});

describe("Android physical handler: the screen target", () => {
  // why: the target a phone's scrcpy session runs on, built straight from the handler: the capture
  // reaches it only through the driver, and what it must never see is the port or the check.
  async function screenWorld(options: { readonly reply?: string } = {}): Promise<{
    readonly runner: PhoneAdb;
    readonly target: ScreenTarget;
    readonly tcp: FakeTcpStreamConnector;
  }> {
    const runner = new PhoneAdb([]);
    const probe = new FakeTcpProbe([]);
    probe.replyWith(options.reply ?? VERSION_REPLY_41);
    const handler = new AndroidPhysicalHandler({
      adb,
      // why: an env that aims adb elsewhere on purpose — a target that leaked these to a child
      // would reach a server other than the one it just checked.
      baseEnv: {
        ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
        ANDROID_ADB_SERVER_ADDRESS: "10.0.0.5",
        ANDROID_HOME: sdk,
        ANDROID_SERIAL: "SOMEONE-ELSES-PHONE",
      },
      filesystem: await androidFilesystem(),
      isBareShell: () => false,
      processRunner: runner,
      tcpProbe: probe,
    });
    const tcp = new FakeTcpStreamConnector();
    return { runner, target: handler.screenTargetFor(PHYSICAL, tcp), tcp };
  }

  it("sends nothing and refuses with the check's own message when the check is closed, for run, spawn and connect, at a mismatch and an unreadable server", async () => {
    const closed = [
      { message: /speaks protocol 40/, name: "another protocol", reply: VERSION_REPLY_40 },
      { message: /unreadable/, name: "a server it cannot read", reply: "gibberish" },
    ] as const;
    const verbs = [
      {
        call: (target: ScreenTarget) => target.run(["shell", "dumpsys", "power"], 10_000),
        name: "run",
      },
      {
        call: (target: ScreenTarget) => target.spawn(["shell", "app_process"]),
        name: "spawn",
      },
      {
        call: (target: ScreenTarget) => target.connect(5_000),
        name: "connect",
      },
    ] as const;
    for (const refusal of closed) {
      for (const verb of verbs) {
        const world = await screenWorld({ reply: refusal.reply });

        const error = await rejectionOf(verb.call(world.target));

        expect(error, `${refusal.name} via ${verb.name}`).toBeInstanceOf(ScreenUnavailableError);
        expect((error as Error).message, `${refusal.name} via ${verb.name}`).toMatch(
          refusal.message,
        );
        expect(world.runner.commands, `${refusal.name} via ${verb.name}`).toEqual([]);
        expect(world.tcp.connections, `${refusal.name} via ${verb.name}`).toEqual([]);
      }
    }
  });

  it("runs adb -P 5037 with the shared server's env for run and spawn, and connects to 5037, when the check is open", async () => {
    const world = await screenWorld();

    await world.target.run(["shell", "dumpsys", "power"], 10_000);
    await world.target.spawn(["shell", "app_process"]);
    await world.target.connect(4_000);

    expect(world.runner.calls.map((call) => [...call.args])).toEqual([
      ["version"],
      ["-P", "5037", "-s", PHONE, "shell", "dumpsys", "power"],
      ["-P", "5037", "-s", PHONE, "shell", "app_process"],
    ]);
    for (const call of world.runner.commands) {
      expect(call.options.env).toEqual({
        ANDROID_ADB_SERVER_PORT: "5037",
        ANDROID_HOME: sdk,
      });
    }
    expect(world.runner.commands[0]?.options.timeoutMs).toBe(10_000);
    expect(world.tcp.connections.map((connection) => connection.port)).toEqual([5037]);
  });
});

describe("Android physical handler: estimate", () => {
  it("is 90 000 ms for a reclaim of a physical spec at both clean levels, and unchanged for an emulator spec", async () => {
    const { driver } = await world();

    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, PHYSICAL_SPEC)).toBe(
      90_000,
    );
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, PHYSICAL_SPEC)).toBe(90_000);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, VIRTUAL_SPEC)).toBe(6_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, VIRTUAL_SPEC)).toBe(32_000);
  });
});

const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;

function sdkTool(name: "avdmanager" | "sdkmanager"): string {
  return `${sdk}/cmdline-tools/latest/bin/${name}`;
}

function scripted(command: string, args: readonly (string | RegExp)[], stdout = "") {
  return { match: { args, command }, result: { code: 0, stderr: "", stdout } };
}
