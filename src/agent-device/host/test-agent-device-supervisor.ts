import { vi } from "vitest";
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
  type AgentDeviceIosSigning,
  type AgentDevicePlatform,
  type AgentDeviceRole,
} from "./agent-device-supervisor.js";

export const home = "/home/simlock/.simlock";

export const stateDir = `${home}/agent-device`;

export const recordPath = `${home}/agent-device-daemon.json`;

export const policyPath = `${stateDir}/policy.json`;

export const daemonJsonPath = `${stateDir}/daemon.json`;

export const nodePath = "/opt/node/bin/node";

export const packageRoot = "/opt/ad/node_modules/agent-device";

export const realCli = `${packageRoot}/bin/agent-device.mjs`;

export const internalEntry = `${packageRoot}/dist/src/internal/daemon.js`;

export const fallbackEntry = `${packageRoot}/dist/src/daemon.js`;

export const httpPort = 4310;

export const token = "daemon-token";

export const healthyBody = { rpcProtocolVersion: 2, service: "agent-device-daemon" };

export const restartCommand = ["simlock daemon stop", "simlock daemon start"];

export type Behaviour = "dies" | "ignores-sigterm" | "immortal";

export type DaemonJson = "ready" | "none" | "other-pid";

export class ProcessTable extends FakeProcessSupervisor {
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

export interface Child {
  readonly pid: number;
  readonly args: readonly string[];
  exit(code: number | null): void;
}

export interface Options {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly command?: string;
  readonly commandLines?: readonly (readonly [number, readonly (string | undefined)[]])[];
  readonly daemonJson?: (startIndex: number) => DaemonJson;
  readonly driverEnvironment?: Readonly<Record<string, string>>;
  readonly expectations?: readonly ScriptedProcessExpectation[];
  readonly filesystem?: MemoryFilesystem;
  readonly home?: string;
  readonly ios?: AgentDeviceIosSigning;
  readonly layout?: (filesystem: MemoryFilesystem) => Promise<void>;
  readonly leaseMaxTtlMs?: number;
  readonly listening?: boolean;
  readonly livePids?: readonly number[];
  readonly nodeVersion?: string;
  readonly platforms?: readonly AgentDevicePlatform[];
  readonly role?: AgentDeviceRole;
  readonly record?: { readonly pid: number; readonly entry: string; readonly startedAt: number };
  readonly spawnThrows?: Error;
  readonly stateDirContents?: (filesystem: MemoryFilesystem) => Promise<void>;
  readonly behaviours?: ReadonlyMap<number, Behaviour>;
}

export function stemOf(role: AgentDeviceRole | undefined): string {
  return role === "phones" ? "agent-device-phones" : "agent-device";
}

export function supervisorRole(options: Options): {
  readonly ios?: AgentDeviceIosSigning;
  readonly role: AgentDeviceRole;
} {
  return {
    ...(options.ios === undefined ? {} : { ios: options.ios }),
    role: options.role ?? "simulators",
  };
}

export async function arrange(options: Options = {}) {
  const clock = new FakeClock(1_000_000);
  const stem = stemOf(options.role);
  const filesystem = options.filesystem ?? new MemoryFilesystem();
  const simlockHome = options.home ?? home;
  const sink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  const probe = new FakeTcpProbe();
  const health = new FakeAgentDeviceHealth();
  const processes = new ProcessTable(options.livePids ?? []);
  for (const [pid, behaviour] of options.behaviours ?? []) processes.behaviours.set(pid, behaviour);
  for (const [pid, lines] of options.commandLines ?? []) processes.answerCommandLine(pid, ...lines);
  const runner = new ScriptedProcessRunner(options.expectations ?? [versionRun(), daemonSpawn()]);
  const children: Child[] = [];
  const events: string[] = [];
  let starts = 0;

  health.respondWith(healthyBody);
  await installAgentDevice(filesystem, simlockHome, options);
  if (options.record !== undefined) {
    await filesystem.writeFileAtomic(
      `${simlockHome}/${stem}-daemon.json`,
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
        `${simlockHome}/${stem}/daemon.json`,
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
    hostPlatform: "linux",
    ...supervisorRole(options),
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

export type Harness = Awaited<ReturnType<typeof arrange>>;

export async function run(options: Options = {}): Promise<Harness> {
  const harness = await arrange(options);
  await advancing(harness, harness.begin());
  return harness;
}

export function isDaemonEntry(arg: string | undefined): boolean {
  return arg === internalEntry || arg === fallbackEntry;
}

export async function installAgentDevice(
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

export function versionRun(output = "0.21.28\n", extra: Partial<ScriptedProcessExpectation> = {}) {
  return {
    match: { args: [realCli, "--version"], command: nodePath },
    result: { code: 0, stderr: "", stdout: output },
    ...extra,
  } satisfies ScriptedProcessExpectation;
}

export function daemonSpawn(
  entry = internalEntry,
  extra: Partial<ScriptedProcessExpectation> = {},
  simlockHome = home,
  marker: readonly string[] = [],
): ScriptedProcessExpectation {
  return {
    hangs: true,
    match: { args: [entry, `--simlock-home=${simlockHome}`, ...marker], command: nodePath },
    ...extra,
  };
}

export function phoneSpawn(simlockHome = home): ScriptedProcessExpectation {
  return daemonSpawn(internalEntry, {}, simlockHome, ["--simlock-role=phones"]);
}

export function ownLine(entry = internalEntry, simlockHome = home, role?: "phones"): string {
  const suffix = role === undefined ? "" : " --simlock-role=phones";
  return `${nodePath} ${entry} --simlock-home=${simlockHome}${suffix}`;
}

export function record(pid: number, entry = internalEntry) {
  return { entry, pid, startedAt: 1 };
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function advanceBy(harness: Harness, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await flush();
    harness.clock.advance(100);
  }
  await flush();
}

export async function advancing<T>(harness: Harness, work: Promise<T>): Promise<T> {
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

export async function advanceUntil(
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

export function stateOf(harness: Harness): AgentDeviceAvailability["state"] {
  return harness.availability().state;
}

export function unavailable(harness: Harness) {
  const availability = harness.availability();
  if (availability.state !== "unavailable") {
    throw new Error(`expected unavailable, got ${availability.state}`);
  }
  return availability;
}

export function running(harness: Harness) {
  const availability = harness.availability();
  if (availability.state !== "running") {
    throw new Error(`expected running, got ${availability.state}`);
  }
  return availability;
}

export function commandsRun(harness: Harness): string[][] {
  return harness.runner.calls.map((call) => [call.command, ...call.args]);
}

export function daemonSpawns(harness: Harness): string[][] {
  return commandsRun(harness).filter((call) => call[0] === nodePath && isDaemonEntry(call[1]));
}

export function warnings(harness: Harness): string[] {
  return harness.sink.records
    .filter((entry) => entry.level === "warn")
    .map((entry) => JSON.stringify(entry));
}

export async function readJson(harness: Harness, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await harness.filesystem.readFile(path)) as Record<string, unknown>;
}
