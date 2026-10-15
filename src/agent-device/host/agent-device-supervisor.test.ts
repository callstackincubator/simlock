import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
  type ProcessResult,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { FakeAgentDeviceHealth } from "../testing.js";
import {
  AgentDeviceSupervisor,
  type AgentDeviceAvailability,
  type AgentDevicePlatform,
} from "./agent-device-supervisor.js";

const home = "/home/simlock/.simlock";
const stateDir = `${home}/agent-device`;
const recordPath = `${home}/agent-device-daemon.json`;
const policyPath = `${stateDir}/policy.json`;
const daemonJsonPath = `${stateDir}/daemon.json`;
const nodePath = "/opt/node/bin/node";
const packageRoot = "/opt/ad/node_modules/agent-device";
const realCli = `${packageRoot}/bin/agent-device.mjs`;
const internalEntry = `${packageRoot}/dist/src/internal/daemon.js`;
const fallbackEntry = `${packageRoot}/dist/src/daemon.js`;
const httpPort = 4310;
const token = "daemon-token";
const healthyBody = { rpcProtocolVersion: 2, service: "agent-device-daemon" };
const restartCommand = ["simlock daemon stop", "simlock daemon start"];

type Behaviour = "dies" | "ignores-sigterm" | "immortal";
type DaemonJson = "ready" | "none" | "other-pid";

class ProcessTable extends FakeProcessSupervisor {
  readonly behaviours = new Map<number, Behaviour>();
  readonly onDeath = new Map<number, () => void>();

  override signal(pid: number, signal: NodeJS.Signals): void {
    super.signal(pid, signal);
    this.apply(pid, signal);
  }

  apply(pid: number, signal: NodeJS.Signals): void {
    const behaviour = this.behaviours.get(pid) ?? "dies";
    if (behaviour === "immortal") return;
    if (behaviour === "ignores-sigterm" && signal !== "SIGKILL") return;
    this.markDead(pid);
    this.onDeath.get(pid)?.();
  }
}

interface Child {
  readonly pid: number;
  readonly args: readonly string[];
  exit(code: number | null): void;
}

interface Options {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly command?: string;
  readonly daemonJson?: (startIndex: number) => DaemonJson;
  readonly driverEnvironment?: Readonly<Record<string, string>>;
  readonly expectations?: readonly ScriptedProcessExpectation[];
  readonly filesystem?: MemoryFilesystem;
  readonly home?: string;
  readonly layout?: (filesystem: MemoryFilesystem) => Promise<void>;
  readonly leaseMaxTtlMs?: number;
  readonly listening?: boolean;
  readonly livePids?: readonly number[];
  readonly nodeVersion?: string;
  readonly platforms?: readonly AgentDevicePlatform[];
  readonly record?: { readonly pid: number; readonly entry: string; readonly startedAt: number };
  readonly spawnThrows?: Error;
  readonly stateDirContents?: (filesystem: MemoryFilesystem) => Promise<void>;
  readonly behaviours?: ReadonlyMap<number, Behaviour>;
}

async function arrange(options: Options = {}) {
  const clock = new FakeClock(1_000_000);
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  const simlockHome = options.home ?? home;
  const sink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  const probe = new FakeTcpProbe();
  const health = new FakeAgentDeviceHealth();
  const processes = new ProcessTable(options.livePids ?? []);
  for (const [pid, behaviour] of options.behaviours ?? []) processes.behaviours.set(pid, behaviour);
  const runner = new ScriptedProcessRunner(options.expectations ?? [versionRun(), daemonSpawn()]);
  const children: Child[] = [];
  const events: string[] = [];
  let starts = 0;

  health.respondWith(healthyBody);
  await installAgentDevice(filesystem, simlockHome, options);
  if (options.record !== undefined) {
    await filesystem.writeFileAtomic(
      `${simlockHome}/agent-device-daemon.json`,
      JSON.stringify(options.record),
    );
  }
  await options.stateDirContents?.(filesystem);

  const spawn = runner.spawn.bind(runner);
  vi.spyOn(runner, "spawn").mockImplementation((command, args, spawnOptions) => {
    const handle = spawn(command, args, spawnOptions);
    if (command !== nodePath || !isDaemonEntry(args[0])) return handle;
    if (options.spawnThrows !== undefined) throw options.spawnThrows;
    const pid = handle.pid;
    let exit!: (result: ProcessResult) => void;
    const exited = new Promise<ProcessResult>((resolve) => {
      exit = resolve;
    });
    const child: Child = {
      args: [...args],
      exit(code) {
        events.push(`exit ${pid}`);
        processes.markDead(pid);
        exit({ code, stderr: "", stdout: "" });
      },
      pid,
    };
    children.push(child);
    processes.markAlive(pid);
    processes.onDeath.set(pid, () => child.exit(null));
    events.push(`spawn ${pid}`);
    const startIndex = starts;
    starts += 1;
    const mode = options.daemonJson?.(startIndex) ?? "ready";
    if (mode !== "none") {
      void filesystem.writeFileAtomic(
        `${simlockHome}/agent-device/daemon.json`,
        JSON.stringify({
          httpPort,
          pid: mode === "ready" ? pid : pid + 1_000,
          token,
          version: "0.21.28",
        }),
      );
    }
    if (mode === "ready" && options.listening !== false) probe.startListening(httpPort);
    return {
      kill(signal = "SIGTERM") {
        processes.signals.push({ pid, signal });
        processes.apply(pid, signal);
        handle.kill(signal);
      },
      pid,
      stderr: handle.stderr,
      stdout: handle.stdout,
      unref: () => handle.unref(),
      wait: () => Promise.race([handle.wait(), exited]),
    };
  });

  const agentDevice = new AgentDeviceSupervisor({
    baseEnvironment: options.baseEnvironment ?? {
      HOME: "/home/operator",
      PATH: "/usr/local/bin:/usr/bin",
    },
    clock,
    config: { command: options.command ?? "agent-device" },
    driverEnvironment: options.driverEnvironment ?? {},
    filesystem,
    healthProbe: health,
    home: simlockHome,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? 4 * 60 * 60_000,
    logger,
    nodePath,
    nodeVersion: options.nodeVersion ?? "22.14.0",
    platforms: options.platforms ?? ["ios", "android"],
    processRunner: runner,
    processSupervisor: processes,
    tcpProbe: probe,
  });
  const harness = {
    agentDevice,
    children,
    clock,
    events,
    filesystem,
    health,
    probe,
    processes,
    runner,
    sink,
    started: undefined as Promise<void> | undefined,
    begin(): Promise<void> {
      const started = agentDevice.start();
      started.catch(() => undefined);
      harness.started = started;
      return started;
    },
    availability: () => agentDevice.availability(),
  };
  return harness;
}

type Harness = Awaited<ReturnType<typeof arrange>>;

async function run(options: Options = {}): Promise<Harness> {
  const harness = await arrange(options);
  await advancing(harness, harness.begin());
  return harness;
}

function isDaemonEntry(arg: string | undefined): boolean {
  return arg === internalEntry || arg === fallbackEntry;
}

async function installAgentDevice(
  filesystem: MemoryFilesystem,
  simlockHome: string,
  options: Options,
): Promise<void> {
  if (!(await filesystem.exists(simlockHome))) await filesystem.mkdirp(simlockHome);
  if (options.command?.includes("/") !== true) {
    await filesystem.mkdirp("/usr/local/bin");
  }
  await filesystem.mkdirp(`${packageRoot}/bin`);
  await filesystem.mkdirp(`${packageRoot}/dist/src/internal`);
  await filesystem.writeFileAtomic(realCli, "#!/usr/bin/env node\n");
  filesystem.defineAttributes(realCli, { mode: 0o755 });
  await filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"agent-device"}');
  await filesystem.writeFileAtomic(internalEntry, "");
  filesystem.defineSymlink("/usr/local/bin/agent-device", realCli);
  await options.layout?.(filesystem);
}

function versionRun(output = "0.21.28\n", extra: Partial<ScriptedProcessExpectation> = {}) {
  return {
    match: { args: [realCli, "--version"], command: nodePath },
    result: { code: 0, stderr: "", stdout: output },
    ...extra,
  } satisfies ScriptedProcessExpectation;
}

function daemonSpawn(
  entry = internalEntry,
  extra: Partial<ScriptedProcessExpectation> = {},
  simlockHome = home,
): ScriptedProcessExpectation {
  return {
    hangs: true,
    match: { args: [entry, `--simlock-home=${simlockHome}`], command: nodePath },
    ...extra,
  };
}

function psRun(pid: number, line: string, code = 0): ScriptedProcessExpectation {
  return {
    match: { args: ["-ww", "-o", "args=", "-p", String(pid)], command: "ps" },
    result: { code, stderr: "", stdout: line === "" ? "" : `${line}\n` },
  };
}

function ownLine(entry = internalEntry, simlockHome = home): string {
  return `${nodePath} ${entry} --simlock-home=${simlockHome}`;
}

function record(pid: number, entry = internalEntry) {
  return { entry, pid, startedAt: 1 };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advanceBy(harness: Harness, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await flush();
    harness.clock.advance(100);
  }
  await flush();
}

async function advancing<T>(harness: Harness, work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  for (let tick = 0; tick < 4_000 && !settled; tick += 1) {
    await flush();
    harness.clock.advance(100);
  }
  return tracked;
}

async function advanceUntil(
  harness: Harness,
  done: () => boolean,
  limitMs = 120_000,
): Promise<void> {
  for (let elapsed = 0; elapsed < limitMs && !done(); elapsed += 100) {
    await flush();
    harness.clock.advance(100);
  }
  await flush();
}

function stateOf(harness: Harness): AgentDeviceAvailability["state"] {
  return harness.availability().state;
}

function unavailable(harness: Harness) {
  const availability = harness.availability();
  if (availability.state !== "unavailable") {
    throw new Error(`expected unavailable, got ${availability.state}`);
  }
  return availability;
}

function running(harness: Harness) {
  const availability = harness.availability();
  if (availability.state !== "running") {
    throw new Error(`expected running, got ${availability.state}`);
  }
  return availability;
}

function commandsRun(harness: Harness): string[][] {
  return harness.runner.calls.map((call) => [call.command, ...call.args]);
}

function daemonSpawns(harness: Harness): string[][] {
  return commandsRun(harness).filter((call) => call[0] === nodePath && isDaemonEntry(call[1]));
}

function warnings(harness: Harness): string[] {
  return harness.sink.records
    .filter((entry) => entry.level === "warn")
    .map((entry) => JSON.stringify(entry));
}

async function readJson(harness: Harness, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await harness.filesystem.readFile(path)) as Record<string, unknown>;
}

describe("AgentDeviceSupervisor off and starting", () => {
  it("enabled, availability is starting before start() settles", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    expect(stateOf(harness)).toBe("starting");

    harness.begin();
    await advanceBy(harness, 1_000);

    expect(stateOf(harness)).toBe("starting");
    expect(harness.children).toHaveLength(1);
  });
});

describe("AgentDeviceSupervisor finding agent-device", () => {
  const pathLayout = async (filesystem: MemoryFilesystem) => {
    await filesystem.mkdirp("/dir-bin/agent-device");
    await filesystem.mkdirp("/noexec");
    await filesystem.writeFileAtomic("/noexec/agent-device", "not executable");
    filesystem.defineAttributes("/noexec/agent-device", { mode: 0o644 });
    await filesystem.mkdirp("/exec");
    filesystem.defineSymlink("/exec/agent-device", realCli);
    await filesystem.mkdirp("/later");
    await filesystem.writeFileAtomic("/later/agent-device", "later");
    filesystem.defineAttributes("/later/agent-device", { mode: 0o755 });
  };

  it("finds a name in the first PATH entry holding an executable file of that name, skipping an earlier directory, non-executable file and missing entry", async () => {
    const harness = await run({
      baseEnvironment: { PATH: "/missing:/dir-bin:/noexec:/exec:/later" },
      layout: pathLayout,
    });

    expect(commandsRun(harness)[0]).toEqual([nodePath, realCli, "--version"]);
    expect(stateOf(harness)).toBe("running");
  });

  it("uses a command with a slash as given and resolves its real path, with the package root two levels above", async () => {
    const harness = await run({
      command: "/opt/custom/agent-device",
      layout: async (filesystem) => {
        await filesystem.mkdirp("/opt/custom");
        filesystem.defineSymlink("/opt/custom/agent-device", realCli);
      },
    });

    expect(commandsRun(harness)[0]).toEqual([nodePath, realCli, "--version"]);
    expect(daemonSpawns(harness)[0]?.[1]).toBe(internalEntry);
  });

  it("reports a command found nowhere as not-found with the PATH message, and runs nothing", async () => {
    const harness = await run({
      baseEnvironment: { PATH: "/nowhere" },
      expectations: [],
    });

    expect(unavailable(harness)).toMatchObject({
      message: 'agent-device not found: "agent-device" is not on PATH',
      reason: "not-found",
    });
    expect(unavailable(harness).remedy).toContain("capabilities.agent-device.command");
    expect(unavailable(harness).remedy).toContain("0.21.28 or later");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(harness.runner.calls).toEqual([]);
  });

  it.each([
    ["a missing path", async () => undefined],
    [
      "a directory",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/opt/x/agent-device");
      },
    ],
    [
      "a file with no execute bit",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/opt/x");
        await filesystem.writeFileAtomic("/opt/x/agent-device", "plain");
        filesystem.defineAttributes("/opt/x/agent-device", { mode: 0o644 });
      },
    ],
  ])(
    "reports a command with a slash that is %s as not-found and runs nothing",
    async (_case, layout) => {
      const harness = await run({ command: "/opt/x/agent-device", expectations: [], layout });

      expect(unavailable(harness)).toMatchObject({
        message: "agent-device not found: /opt/x/agent-device is not an executable file",
        reason: "not-found",
      });
      expect(harness.runner.calls).toEqual([]);
    },
  );
});

describe("AgentDeviceSupervisor checking the install", () => {
  it.each([
    [
      "a missing package.json",
      async (filesystem: MemoryFilesystem) => filesystem.rm(`${packageRoot}/package.json`),
      "package.json",
    ],
    [
      "a package.json naming another package",
      async (filesystem: MemoryFilesystem) =>
        filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"other-tool"}'),
      "package.json",
    ],
    [
      "neither daemon entry",
      async (filesystem: MemoryFilesystem) => filesystem.rm(internalEntry),
      "daemon",
    ],
  ])("treats %s as not-agent-device and spawns nothing", async (_case, layout, word) => {
    const harness = await run({ expectations: [versionRun()], layout });

    expect(unavailable(harness).reason).toBe("not-agent-device");
    expect(unavailable(harness).message).toContain(word);
    expect(unavailable(harness).remedy).toContain("capabilities.agent-device.command");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(daemonSpawns(harness)).toEqual([]);
  });

  it("treats a --version that exits non-zero, prints nothing, or runs past 10 s as three distinct not-agent-device answers, and spawns nothing", async () => {
    const messages: string[] = [];
    for (const expectation of [
      versionRun("", { result: { code: 3, stderr: "boom", stdout: "" } }),
      versionRun(""),
      versionRun("", { hangs: true }),
    ]) {
      const harness = await arrange({ expectations: [expectation] });
      const started = Date.now();
      await advancing(harness, harness.begin());

      expect(unavailable(harness).reason).toBe("not-agent-device");
      expect(daemonSpawns(harness)).toEqual([]);
      messages.push(unavailable(harness).message);
      if (expectation.hangs === true) {
        expect(unavailable(harness).message).toContain("timed out");
        expect(harness.clock.now()).toBeGreaterThanOrEqual(1_000_000 + 10_000);
      }
      expect(Date.now() - started).toBeLessThan(60_000);
    }
    expect(messages[0]).toContain("3");
    expect(new Set(messages).size).toBe(3);
  });

  it("reports 0.20.3 as wrong-version with the found-and-need message", async () => {
    const harness = await run({ expectations: [versionRun("0.20.3\n")] });

    expect(unavailable(harness)).toMatchObject({
      message: "found 0.20.3, need 0.21.28 or later",
      reason: "wrong-version",
    });
    expect(unavailable(harness).remedy).toContain("0.21.28 or later");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
  });

  it.each(["abc", "0.21", "0.9.100", "0.21.27", "0.21.28-nightly.20261013.49"])(
    "reports %s as wrong-version",
    async (printed) => {
      const harness = await run({ expectations: [versionRun(`${printed}\n`)] });

      expect(unavailable(harness).reason).toBe("wrong-version");
      expect(daemonSpawns(harness)).toEqual([]);
    },
  );

  it.each(["0.21.28", "0.21.28+build.7", "0.21.29-dev", "0.22.0", "0.100.0", "1.0.0+build.7"])(
    "starts a daemon for the version %s",
    async (printed) => {
      const harness = await run({ expectations: [versionRun(`${printed}\n`), daemonSpawn()] });

      expect(daemonSpawns(harness)).toHaveLength(1);
      expect(stateOf(harness)).toBe("running");
    },
  );

  it("reports Node 22.3.0 as wrong-version naming both Node versions, and starts on Node 22.12.0", async () => {
    const old = await run({ expectations: [versionRun()], nodeVersion: "22.3.0" });

    expect(unavailable(old)).toMatchObject({
      message: "agent-device needs Node 22.12.0 or later, simlock runs on Node 22.3.0",
      reason: "wrong-version",
    });
    expect(unavailable(old).remedy).toContain("Node 22.12.0 or later");
    for (const phrase of restartCommand) expect(unavailable(old).remedy).toContain(phrase);
    expect(daemonSpawns(old)).toEqual([]);

    const exact = await run({ nodeVersion: "22.12.0" });
    expect(stateOf(exact)).toBe("running");
  });
});

describe("AgentDeviceSupervisor spawning", () => {
  it("runs --version then spawns the internal daemon entry with the home marker, stdio ignored and the handle unreffed", async () => {
    const harness = await run();

    expect(commandsRun(harness)).toEqual([
      [nodePath, realCli, "--version"],
      [nodePath, internalEntry, `--simlock-home=${home}`],
    ]);
    expect(harness.runner.calls[1]?.options.stdio).toBe("ignore");
    expect(harness.runner.handles[1]?.unreffed).toBe(true);
  });

  it("spawns dist/src/daemon.js when the internal entry does not exist", async () => {
    const harness = await run({
      expectations: [versionRun(), daemonSpawn(fallbackEntry)],
      layout: async (filesystem) => {
        await filesystem.rm(internalEntry);
        await filesystem.writeFileAtomic(fallbackEntry, "");
      },
    });

    expect(daemonSpawns(harness)).toEqual([[nodePath, fallbackEntry, `--simlock-home=${home}`]]);
  });

  it("gives the child no AGENT_DEVICE_ key from the base environment, keeps PATH and HOME, and sets the state, claims, mode, idle, policy and lease keys", async () => {
    const harness = await run({
      baseEnvironment: {
        AGENT_DEVICE_CLAIMS_DIR: "/operator/claims",
        AGENT_DEVICE_SESSION: "operator-session",
        AGENT_DEVICE_STATE_DIR: "/operator/state",
        HOME: "/home/operator",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(harness.runner.calls[1]?.options.env).toEqual({
      AGENT_DEVICE_CLAIMS_DIR: `${stateDir}/device-claims`,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_DAEMON_POLICY: policyPath,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      AGENT_DEVICE_LEASE_MAX_TTL_MS: String(24 * 60 * 60_000),
      AGENT_DEVICE_STATE_DIR: stateDir,
      HOME: "/home/operator",
      PATH: "/usr/local/bin:/usr/bin",
    });
  });

  it.each([
    [4 * 60 * 60_000, 24 * 60 * 60_000],
    [12 * 60 * 60_000, 24 * 60 * 60_000],
    [20 * 60 * 60_000, 40 * 60 * 60_000],
  ])(
    "sets the lease ceiling for lease.maxTtlMs %i to %i and reports the same in running",
    async (maxTtlMs, ceiling) => {
      const harness = await run({ leaseMaxTtlMs: maxTtlMs });

      expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_LEASE_MAX_TTL_MS"]).toBe(
        String(ceiling),
      );
      expect(running(harness).leaseMaxTtlMs).toBe(ceiling);
    },
  );

  it("passes every key and value of the drivers' environment unchanged, and copies the iOS device set to the agent-device key", async () => {
    const harness = await run({
      driverEnvironment: {
        ANDROID_ADB_SERVER_PORT: "5199",
        CUSTOM_DRIVER_KEY: "custom value",
        SIMLOCK_IOS_DEVICE_SET: "/devices/ios",
      },
    });
    const env = harness.runner.calls[1]?.options.env ?? {};

    expect(env).toMatchObject({
      AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET: "/devices/ios",
      ANDROID_ADB_SERVER_PORT: "5199",
      CUSTOM_DRIVER_KEY: "custom value",
      SIMLOCK_IOS_DEVICE_SET: "/devices/ios",
    });
    expect(env["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBeUndefined();
    expect(running(harness).platforms).toEqual(["ios", "android"]);
  });

  it("points the daemon at an empty private directory when the iOS driver is off", async () => {
    const harness = await run({
      driverEnvironment: { ANDROID_ADB_SERVER_PORT: "5199" },
      platforms: ["android"],
    });

    expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET"]).toBe(
      `${stateDir}/no-ios-devices`,
    );
    await expect(harness.filesystem.readdir(`${stateDir}/no-ios-devices`)).resolves.toEqual([]);
    await expect(harness.filesystem.lstat(`${stateDir}/no-ios-devices`)).resolves.toMatchObject({
      kind: "directory",
      mode: 0o700,
    });
    expect(running(harness).platforms).toEqual(["android"]);
  });

  it("allows only a serial no device has when the Android driver is off", async () => {
    const harness = await run({
      driverEnvironment: { SIMLOCK_IOS_DEVICE_SET: "/devices/ios" },
      platforms: ["ios"],
    });

    expect(harness.runner.calls[1]?.options.env?.["AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST"]).toBe(
      "simlock-no-android-device",
    );
    expect(running(harness).platforms).toEqual(["ios"]);
  });

  it("writes exactly the policy file before the spawn", async () => {
    const harness = await arrange();
    const atSpawn: string[] = [];
    const arranged = vi.mocked(harness.runner.spawn).getMockImplementation();
    if (arranged === undefined) throw new Error("arrange installs the spawn spy");
    vi.mocked(harness.runner.spawn).mockImplementation((command, args, options) => {
      if (isDaemonEntry(args[0])) {
        void harness.filesystem.readFile(policyPath).then((contents) => atSpawn.push(contents));
      }
      return arranged(command, args, options);
    });

    await advancing(harness, harness.begin());

    const expected =
      '{"version":1,"commands":{"deny":["boot","shutdown"]},"capabilities":{"deny":["device-shutdown"]}}';
    expect(atSpawn).toEqual([expected]);
    await expect(harness.filesystem.readFile(policyPath)).resolves.toBe(expected);
  });
});

describe("AgentDeviceSupervisor state directory", () => {
  it("creates a missing state directory with mode 0700", async () => {
    const harness = await run();

    await expect(harness.filesystem.lstat(stateDir)).resolves.toMatchObject({
      kind: "directory",
      mode: 0o700,
    });
  });

  it("sets an existing state directory to mode 0700", async () => {
    const harness = await run({
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o755 });
      },
    });

    await expect(harness.filesystem.lstat(stateDir)).resolves.toMatchObject({ mode: 0o700 });
    expect(stateOf(harness)).toBe("running");
  });

  it.each([
    [
      "a symlink",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/elsewhere");
        filesystem.defineSymlink(stateDir, "/elsewhere");
      },
    ],
    [
      "a file",
      async (filesystem: MemoryFilesystem) =>
        filesystem.writeFileAtomic(stateDir, "not a directory"),
    ],
    [
      "a directory owned by another user",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        filesystem.defineAttributes(stateDir, { uid: (process.getuid?.() ?? 0) + 1 });
      },
    ],
  ])(
    "treats %s as the state directory as state-dir, naming the path, and spawns nothing",
    async (_case, stateDirContents) => {
      const harness = await run({ expectations: [versionRun()], stateDirContents });

      expect(unavailable(harness).reason).toBe("state-dir");
      expect(unavailable(harness).message).toContain(stateDir);
      expect(unavailable(harness).remedy).toContain(stateDir);
      for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
      expect(daemonSpawns(harness)).toEqual([]);
    },
  );

  it("treats a chmod that throws on an existing state directory as state-dir naming the path and the cause", async () => {
    const filesystem = new MemoryFilesystem();
    vi.spyOn(filesystem, "chmod").mockRejectedValue(new Error("EPERM: operation not permitted"));
    const harness = await run({
      expectations: [versionRun()],
      filesystem,
      stateDirContents: async (memory) => {
        await memory.mkdir(stateDir, { mode: 0o755 });
      },
    });

    expect(unavailable(harness).reason).toBe("state-dir");
    expect(unavailable(harness).message).toContain(stateDir);
    expect(unavailable(harness).message).toContain("EPERM");
    expect(daemonSpawns(harness)).toEqual([]);
  });
});

describe("AgentDeviceSupervisor pid record", () => {
  it("records the child's pid and entry while daemon.json is not yet written", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);

    expect(await readJson(harness, recordPath)).toMatchObject({
      entry: internalEntry,
      pid: harness.children[0]?.pid,
    });
    expect(typeof (await readJson(harness, recordPath))["startedAt"]).toBe("number");
  });

  it("kills the child and reports start-failed naming the error when the record write throws", async () => {
    const harness = await arrange();
    const write = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, ...rest) => {
      if (path === recordPath) throw new Error("ENOSPC: no space left");
      return write(path, ...rest);
    });

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("ENOSPC");
    expect(harness.processes.signals).toEqual([
      { pid: harness.children[0]?.pid, signal: "SIGTERM" },
    ]);
  });
});

describe("AgentDeviceSupervisor readiness", () => {
  it("is running with the version, base URL, token and generation 1 once daemon.json names the child, the port listens and /health answers protocol 2", async () => {
    const harness = await run();

    expect(harness.availability()).toEqual({
      baseUrl: `http://127.0.0.1:${httpPort}`,
      generation: 1,
      leaseMaxTtlMs: 24 * 60 * 60_000,
      platforms: ["ios", "android"],
      state: "running",
      token,
      version: "0.21.28",
    });
    expect(harness.health.reads).toContain(`http://127.0.0.1:${httpPort}`);
  });

  it("is not ready while daemon.json names another pid, and ready once it names the child", async () => {
    const harness = await arrange({ daemonJson: () => "other-pid" });
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    const pid = harness.children[0]?.pid;
    await harness.filesystem.writeFileAtomic(
      daemonJsonPath,
      JSON.stringify({ httpPort, pid, token, version: "0.21.28" }),
    );
    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("is not ready while the port is not listening, and ready once it is", async () => {
    const harness = await arrange({ listening: false });
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("is not ready while a health read rejects, and ready once it answers", async () => {
    const harness = await arrange();
    harness.health.rejectWith(new Error("ECONNREFUSED"));
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    harness.health.respondWith(healthyBody);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("stops the child and reports wrong-version naming both protocols when /health answers protocol 3", async () => {
    const harness = await arrange();
    harness.health.respondWith({ rpcProtocolVersion: 3, service: "agent-device-daemon" });

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({
      message: "agent-device 0.21.28 speaks RPC protocol 3, need 2",
      reason: "wrong-version",
    });
    expect(unavailable(harness).remedy).toContain("RPC protocol 2");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(harness.processes.signals).toEqual([
      { pid: harness.children[0]?.pid, signal: "SIGTERM" },
    ]);
  });

  it.each([
    ["another service", { rpcProtocolVersion: 2, service: "something-else" }],
    ["no numeric protocol", { rpcProtocolVersion: "2", service: "agent-device-daemon" }],
  ])(
    "stops the child and reports not-agent-device without retrying when /health answers with %s",
    async (_case, body) => {
      const harness = await arrange();
      harness.health.respondWith(body);

      await advancing(harness, harness.begin());

      expect(unavailable(harness)).toMatchObject({
        message: "/health did not answer as agent-device",
        reason: "not-agent-device",
      });
      expect(harness.processes.signals).toEqual([
        { pid: harness.children[0]?.pid, signal: "SIGTERM" },
      ]);
      await advanceBy(harness, 120_000);
      expect(daemonSpawns(harness)).toHaveLength(1);
      expect(stateOf(harness)).toBe("unavailable");
    },
  );
});

describe("AgentDeviceSupervisor failed starts", () => {
  it("kills the child after 15 s without readiness, removes the record only after it exits, and reports start-failed naming the timeout", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    const remove = harness.filesystem.rm.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "rm").mockImplementation(async (path) => {
      if (path === recordPath) harness.events.push("record removed");
      return remove(path);
    });
    const spawnedAt = harness.clock.now();

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("timed out");
    expect(unavailable(harness).remedy).toContain("30 s");
    expect(unavailable(harness).remedy).toContain("simlock daemon logs");
    expect(harness.clock.now() - spawnedAt).toBeGreaterThanOrEqual(15_000);
    expect(harness.clock.now() - spawnedAt).toBeLessThan(16_000);
    const pid = harness.children[0]?.pid;
    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(harness.events.slice(-2)).toEqual([`exit ${pid}`, "record removed"]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("reports start-failed naming the exit code when the child exits before readiness", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);

    harness.children[0]?.exit(7);
    await advancing(harness, harness.started as Promise<void>);

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("7");
  });

  it("reports start-failed and writes no record when the spawn throws", async () => {
    const harness = await run({ spawnThrows: new Error("EACCES: permission denied") });

    expect(warnings(harness).some((line) => line.includes("EACCES"))).toBe(true);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("EACCES");
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("keeps the record and names the pid when the child is still alive 2 s after SIGKILL", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 500);
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.started as Promise<void>);

    expect(harness.processes.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain(String(pid));
    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
  });

  it("resolves start() with start-failed carrying the message when the filesystem throws unexpectedly while writing the policy file", async () => {
    const harness = await arrange();
    const write = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, ...rest) => {
      if (path === policyPath) throw new Error("disk on fire");
      return write(path, ...rest);
    });

    await expect(advancing(harness, harness.begin())).resolves.toBeUndefined();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("disk on fire");
    expect(daemonSpawns(harness)).toEqual([]);
  });
});

describe("AgentDeviceSupervisor reaping a daemon a killed simlock left", () => {
  const recorded = { livePids: [900], record: record(900) };

  it("sends SIGTERM to a live recorded pid whose line ends with the marker and holds the entry, removes the record once it is gone, and starts a new daemon", async () => {
    const harness = await run({
      ...recorded,
      expectations: [psRun(900, ownLine()), versionRun(), daemonSpawn()],
    });

    expect(harness.processes.signals).toEqual([{ pid: 900, signal: "SIGTERM" }]);
    expect(harness.processes.isAlive(900)).toBe(false);
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: harness.children[0]?.pid });
    expect(stateOf(harness)).toBe("running");
  });

  it("escalates to SIGKILL after 10 s when the recorded pid ignores SIGTERM and is still identified", async () => {
    const harness = await arrange({
      ...recorded,
      behaviours: new Map([[900, "ignores-sigterm"]]),
      expectations: [psRun(900, ownLine()), psRun(900, ownLine()), versionRun(), daemonSpawn()],
    });
    const startedAt = harness.clock.now();

    await advancing(harness, harness.begin());

    expect(harness.processes.signals).toEqual([
      { pid: 900, signal: "SIGTERM" },
      { pid: 900, signal: "SIGKILL" },
    ]);
    expect(harness.clock.now() - startedAt).toBeGreaterThanOrEqual(10_000);
    expect(stateOf(harness)).toBe("running");
  });

  it("sends no SIGKILL to a pid whose second ps line no longer passes the identity check", async () => {
    const harness = await run({
      ...recorded,
      behaviours: new Map([[900, "ignores-sigterm"]]),
      expectations: [
        psRun(900, ownLine()),
        psRun(900, "/usr/bin/vim notes.txt"),
        versionRun(),
        daemonSpawn(),
      ],
    });

    expect(harness.processes.signals).toEqual([{ pid: 900, signal: "SIGTERM" }]);
  });

  it("keeps the record and reports start-failed naming the pid when it is still alive 2 s after SIGKILL", async () => {
    const harness = await run({
      ...recorded,
      behaviours: new Map([[900, "immortal"]]),
      expectations: [psRun(900, ownLine()), psRun(900, ownLine())],
    });

    expect(harness.processes.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("900");
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: 900 });
    expect(daemonSpawns(harness)).toEqual([]);
  });

  it("spawns with the resolved home as the marker when SIMLOCK_HOME is reached through a symlink, and a later start reaps that child", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/private/tmp/x");
    await filesystem.mkdirp("/tmp");
    filesystem.defineSymlink("/tmp/x", "/private/tmp/x");
    const first = await run({
      expectations: [versionRun(), daemonSpawn(internalEntry, {}, "/private/tmp/x")],
      filesystem,
      home: "/tmp/x",
    });
    const childPid = first.children[0]?.pid as number;
    expect(first.children[0]?.args).toEqual([internalEntry, "--simlock-home=/private/tmp/x"]);

    const second = await run({
      expectations: [
        psRun(childPid, ownLine(internalEntry, "/private/tmp/x")),
        versionRun(),
        daemonSpawn(internalEntry, {}, "/private/tmp/x"),
      ],
      filesystem,
      home: "/tmp/x",
      livePids: [childPid],
    });

    expect(second.processes.signals).toEqual([{ pid: childPid, signal: "SIGTERM" }]);
  });

  it("reaps the live pid daemon.json names when there is no record and the line ends with the marker", async () => {
    const harness = await run({
      expectations: [psRun(901, ownLine()), versionRun(), daemonSpawn()],
      livePids: [901],
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(
          daemonJsonPath,
          JSON.stringify({ httpPort, pid: 901, token }),
        );
      },
    });

    expect(harness.processes.signals).toEqual([{ pid: 901, signal: "SIGTERM" }]);
  });

  it("does not read daemon.json and signals nothing when the state directory is a symlink", async () => {
    const harness = await run({
      expectations: [versionRun()],
      livePids: [901],
      stateDirContents: async (filesystem) => {
        await filesystem.mkdirp("/elsewhere");
        await filesystem.writeFileAtomic("/elsewhere/daemon.json", JSON.stringify({ pid: 901 }));
        filesystem.defineSymlink(stateDir, "/elsewhere");
      },
    });

    expect(harness.processes.signals).toEqual([]);
    expect(commandsRun(harness).filter((call) => call[0] === "ps")).toEqual([]);
    expect(unavailable(harness).reason).toBe("state-dir");
  });

  it.each([
    ["a dead recorded pid", [], []],
    ["a ps line of another command", [900], [psRun(900, "/usr/bin/vim notes.txt")]],
    ["a line holding the entry but no marker", [900], [psRun(900, `${nodePath} ${internalEntry}`)]],
    [
      "a line with another home's marker",
      [900],
      [psRun(900, ownLine(internalEntry, "/other/home"))],
    ],
    [
      "a line with this home's marker but another entry than the recorded one",
      [900],
      [psRun(900, ownLine("/elsewhere/daemon.js"))],
    ],
  ] as const)("removes the record and signals nothing for %s", async (_case, livePids, ps) => {
    // why: the spawn throws, so no new record can stand in for the old one: only a removal empties it.
    const harness = await run({
      expectations: [...ps, versionRun(), daemonSpawn()],
      livePids,
      record: record(900),
      spawnThrows: new Error("no spawn"),
    });

    expect(harness.processes.signals).toEqual([]);
    expect(await harness.filesystem.exists(recordPath)).toBe(false);
  });

  it("signals nothing when daemon.json names another pid than the recorded one", async () => {
    const harness = await run({
      expectations: [psRun(900, ownLine()), versionRun(), daemonSpawn()],
      livePids: [900],
      record: record(900),
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(daemonJsonPath, JSON.stringify({ pid: 777 }));
      },
    });

    expect(harness.processes.signals).toEqual([]);
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: harness.children[0]?.pid });
    expect(stateOf(harness)).toBe("running");
  });

  it("removes the record when daemon.json names another pid than the recorded one", async () => {
    const harness = await run({
      expectations: [psRun(900, ownLine()), versionRun(), daemonSpawn()],
      livePids: [900],
      record: record(900),
      spawnThrows: new Error("no spawn"),
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(daemonJsonPath, JSON.stringify({ pid: 777 }));
      },
    });

    expect(await harness.filesystem.exists(recordPath)).toBe(false);
  });

  it.each([
    ["fails", [psRun(900, "", 1)]],
    ["prints nothing", [psRun(900, "")]],
    ["runs past 5 s", [{ ...psRun(900, ""), hangs: true }]],
  ] as const)(
    "signals nothing, keeps the record, starts nothing and reports start-failed naming the pid when ps %s",
    async (_case, expectations) => {
      const harness = await run({ expectations, livePids: [900], record: record(900) });

      expect(harness.processes.signals).toEqual([]);
      expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
      expect(unavailable(harness).message).toContain("900");
      expect(await readJson(harness, recordPath)).toMatchObject({ pid: 900 });
      expect(commandsRun(harness).filter((call) => call[0] === nodePath)).toEqual([]);
    },
  );
});

describe("AgentDeviceSupervisor after the daemon is running", () => {
  async function runningFor(
    options: Options,
    ms: number,
  ): Promise<{ harness: Harness; readyAt: number }> {
    const harness = await run(options);
    expect(stateOf(harness)).toBe("running");
    const readyAt = harness.clock.now();
    await advanceBy(harness, ms);
    return { harness, readyAt };
  }

  it("starts a child that exited 60 s after ready again at once with the same environment, as generation 2, and warns with the exit code", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      60_000,
    );
    const firstEnv = harness.runner.calls[1]?.options.env;

    harness.children[0]?.exit(42);
    await flush();
    expect(stateOf(harness)).toBe("starting");
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);

    expect(daemonSpawns(harness)).toHaveLength(2);
    expect(harness.runner.calls[3]?.options.env).toEqual(firstEnv);
    expect(running(harness).generation).toBe(2);
    expect(warnings(harness).some((line) => line.includes("42"))).toBe(true);
  });

  it("reports start-failed for a child that exits 5 s after ready, and starts it again only 30 s later", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      5_000,
    );

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toMatch(
      /agent-device exited .*9.* 5 s after it was ready/,
    );
    await advanceBy(harness, 29_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);
    expect(daemonSpawns(harness)).toHaveLength(2);
  });

  it("times the stable uptime from ready, not from the spawn: a child ready 10 s after the spawn that exits 62 s after it is start-failed", async () => {
    const harness = await arrange({
      daemonJson: () => "none",
      expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()],
    });
    void harness.begin();
    await advanceUntil(harness, () => harness.children.length === 1, 5_000);
    const spawnedAt = harness.clock.now();
    await advanceBy(harness, 10_000);
    await harness.filesystem.writeFileAtomic(
      daemonJsonPath,
      JSON.stringify({ httpPort, pid: harness.children[0]?.pid, token }),
    );
    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);
    await advanceBy(harness, spawnedAt + 62_000 - harness.clock.now());

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(daemonSpawns(harness)).toHaveLength(1);
  });

  it("reports start-failed for a child that exits 59 s after ready instead of starting it at once", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      59_000,
    );

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(daemonSpawns(harness)).toHaveLength(1);
  });

  it("retries a failed first start 30 s later and is running when that succeeds", async () => {
    const harness = await arrange({
      daemonJson: (index) => (index === 0 ? "none" : "ready"),
      expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()],
    });
    await advancing(harness, harness.begin());
    expect(unavailable(harness).reason).toBe("start-failed");
    const failedAt = harness.clock.now();

    await advanceBy(harness, 29_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);

    expect(daemonSpawns(harness)).toHaveLength(2);
    expect(harness.clock.now() - failedAt).toBeGreaterThanOrEqual(30_000);
    expect(harness.clock.now() - failedAt).toBeLessThanOrEqual(30_500);
    expect(running(harness).generation).toBe(1);
  });

  it("retries a start that failed after a restart 30 s later", async () => {
    const harness = await arrange({
      daemonJson: (index) => (index === 1 ? "none" : "ready"),
      expectations: [
        versionRun(),
        daemonSpawn(),
        versionRun(),
        daemonSpawn(),
        versionRun(),
        daemonSpawn(),
      ],
    });
    await advancing(harness, harness.begin());
    await advanceBy(harness, 60_000);
    harness.children[0]?.exit(1);
    await advanceUntil(harness, () => unavailableState(harness), 30_000);
    expect(unavailable(harness).reason).toBe("start-failed");

    await advanceUntil(harness, () => stateOf(harness) === "running", 60_000);

    expect(daemonSpawns(harness)).toHaveLength(3);
    expect(stateOf(harness)).toBe("running");
  });

  function unavailableState(harness: Harness): boolean {
    return stateOf(harness) === "unavailable";
  }

  it.each([
    ["not-found", { baseEnvironment: { PATH: "/nowhere" }, expectations: [] }],
    [
      "not-agent-device",
      {
        expectations: [versionRun()],
        layout: async (filesystem: MemoryFilesystem) =>
          filesystem.rm(`${packageRoot}/package.json`),
      },
    ],
    ["wrong-version", { expectations: [versionRun("0.20.3\n")] }],
    [
      "state-dir",
      {
        expectations: [versionRun()],
        stateDirContents: async (filesystem: MemoryFilesystem) => {
          await filesystem.mkdirp("/elsewhere");
          filesystem.defineSymlink(stateDir, "/elsewhere");
        },
      },
    ],
  ] satisfies [string, Options][])("does not retry a %s", async (reason, options) => {
    const harness = await run(options);
    expect(unavailable(harness).reason).toBe(reason);
    const calls = harness.runner.calls.length;

    await advanceBy(harness, 120_000);

    expect(harness.runner.calls).toHaveLength(calls);
    expect(unavailable(harness).reason).toBe(reason);
  });
});

describe("AgentDeviceSupervisor.stop", () => {
  it("sends SIGTERM to the child, removes the record once it is gone, starts nothing more and leaves availability off", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid;
    const calls = harness.runner.calls.length;

    await advancing(harness, harness.agentDevice.stop());

    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
    expect(harness.events.slice(-1)).toEqual([`exit ${pid}`]);
    await advanceBy(harness, 120_000);
    expect(harness.runner.calls).toHaveLength(calls);
    expect(stateOf(harness)).toBe("off");
  });

  it("sends SIGKILL after 10 s when the child ignores SIGTERM", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "ignores-sigterm");
    const stoppedAt = harness.clock.now();

    await advancing(harness, harness.agentDevice.stop());

    expect(harness.processes.signals).toEqual([
      { pid, signal: "SIGTERM" },
      { pid, signal: "SIGKILL" },
    ]);
    expect(harness.clock.now() - stoppedAt).toBeGreaterThanOrEqual(10_000);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("keeps the record and warns naming the pid when the child is alive 2 s after SIGKILL, and availability still ends off", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.agentDevice.stop());

    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
    expect(warnings(harness).some((line) => line.includes(String(pid)))).toBe(true);
    expect(stateOf(harness)).toBe("off");
  });

  it("warns naming the pid and keeps the record when stop() ends a start whose child survives SIGKILL", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.agentDevice.stop());
    await advancing(harness, harness.started as Promise<void>);

    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
    expect(warnings(harness).some((line) => line.includes(String(pid)))).toBe(true);
    expect(stateOf(harness)).toBe("off");
  });

  it("spawns nothing when stop() is asked while the state directory is being prepared", async () => {
    const harness = await arrange();
    const writeFileAtomic = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    let stopping: Promise<void> | undefined;
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, data) => {
      if (path === `${stateDir}/policy.json`) stopping = harness.agentDevice.stop();
      await writeFileAtomic(path, data);
    });

    await advancing(harness, harness.begin());
    await advancing(harness, stopping as Promise<void>);

    expect(daemonSpawns(harness)).toHaveLength(0);
    expect(stateOf(harness)).toBe("off");
  });

  it("cancels a pending retry", async () => {
    const harness = await run({ daemonJson: () => "none" });
    expect(unavailable(harness).reason).toBe("start-failed");
    const calls = harness.runner.calls.length;

    await advancing(harness, harness.agentDevice.stop());
    await advanceBy(harness, 120_000);

    expect(harness.runner.calls).toHaveLength(calls);
    expect(stateOf(harness)).toBe("off");
  });

  it("ends a start in progress with the child killed and availability off", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);
    const pid = harness.children[0]?.pid;

    await advancing(harness, harness.agentDevice.stop());
    await advancing(harness, harness.started as Promise<void>);

    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(stateOf(harness)).toBe("off");
    await advanceBy(harness, 120_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    expect(stateOf(harness)).toBe("off");
  });

  it("logs no start-failed warning when stop() cancels a start", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);

    await advancing(harness, harness.agentDevice.stop());
    await advancing(harness, harness.started as Promise<void>);

    expect(warnings(harness).filter((line) => line.includes("start failed"))).toEqual([]);
    expect(stateOf(harness)).toBe("off");
  });

  it("leaves no unhandled rejection when a health read rejects after stop() was asked during the port check", async () => {
    const harness = await arrange();
    harness.health.rejectWith(new Error("ECONNREFUSED"));
    const isListening = harness.probe.isListening.bind(harness.probe);
    let stopping: Promise<void> | undefined;
    vi.spyOn(harness.probe, "isListening").mockImplementation(async (port) => {
      stopping = harness.agentDevice.stop();
      return isListening(port);
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      harness.begin();
      await advanceBy(harness, 5_000);
      await advancing(harness, stopping as Promise<void>);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
    expect(stateOf(harness)).toBe("off");
  });
});
