import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { z } from "zod";

import { EVENT_FILE_NAME, type EventEnvelope, eventKey, readEventFile } from "../bus/index.js";
import { loadConfig, type ConfigOverrides } from "../core/index.js";
import { optionalModules } from "../module-registry/index.js";
import {
  IpcError,
  MemoryFilesystem,
  NodeDaemonLauncher,
  NodeFilesystem,
  NodeIpcTransport,
  NodeParentWatch,
  NodeSystemStats,
  resolveDaemonSocketPath,
  resolveSimlockHome,
  SocketPathTooLongError,
  SystemClock,
  DAEMON_STARTUP_TIMEOUT_MS,
  type Clock,
  type DaemonLauncher,
  type Filesystem,
  type IpcConnection,
  type IpcConnector,
  type ParentWatch,
  type ParentWatchHandle,
  type SystemStats,
} from "../ports/index.js";
import { resolveRequesterId } from "../agent-identity/index.js";
import { connectSimlockAdmin } from "../admin/index.js";
import {
  isSimlockError,
  SimlockError,
  type CatalogGetOutput,
  type AnySimlockError,
  type DoctorReport,
  type EventPush,
  type LeaseGrant,
  type SimlockAdminClient,
  type StatusGetOutput,
  type WorkerView,
} from "../admin/index.js";
import {
  type DeviceClass,
  deviceClassSchema,
  parseDurationMs,
  requestedClass,
  type Role,
  waitingRequestSchema,
} from "../contract/index.js";
import type { PassthroughCommand } from "../client/index.js";
import {
  awaitWithin,
  RELEASE_TIMEOUT_MS,
  startLeaseRenewal,
  type LeaseRenewal,
} from "../lease-policy/index.js";
import { followLog, type Signals } from "./follow-log.js";
import { spawnPassthrough } from "./passthrough.js";
import { ERROR_TABLE } from "../contract/index.js";

type WaitingRequestEntry = z.infer<typeof waitingRequestSchema>;

const USAGE = `Usage: simlock <command> [options]

Commands:
  lease, release, status, list, catalog, cleanup, doctor, nuke, events,
  daemon, config, token
  worker <list|drain|undrain|remove>
                              Inspect and manage the workers of a gateway; on a
                              single host, list shows the host itself
  component install <ios|android> <version> [--worker <id>... | --all-workers]
                              Install a simulator runtime or system image
  component list [--platform <ios|android>]
                              List installed runtimes and system images
  component remove <ios|android> <version> [--dry-run] [--yes]
                              Remove a runtime or system image Simlock installed
  device add --platform <ios|android> <id> [--json]
                              Enrol a physical device plugged into this host
  device remove <id> [--json] Forget an enrolled physical device; the device is untouched
  simctl <args...>            Run xcrun simctl against Simlock's iOS device set
  adb <args...>               Run adb against Simlock's adb server
  mcp                         Start the stdio MCP server
Run 'simlock <command> --help' for command usage.

Pass --token <secret> anywhere on the command line to connect as admin
explicitly; see https://github.com/callstackincubator/simlock for the default
resolution order.`;

const LEASE_LOST_EXIT_CODE = 14;

const WORKER_INSTALL_INCOMPLETE_EXIT_CODE = 15;

/**
 * why: A key that is safe to the left of `=` in a shell `export`. Anything else is a command
 * waiting for `eval` to run it, and escaping the value alone defends the half an attacker
 * does not need. Not reachable through the shipped drivers (their keys are literals), but
 * `SIMLOCK_DRIVERS_MODULE` and the wire both accept whatever a driver returns.
 */
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function withHelpHint(message: string): string {
  return `${message} (run \`simlock --help\` for usage)`;
}

interface Output {
  write(value: string): unknown;
}

type McpStdioRunner = () => Promise<void>;

export interface CliEnvironment {
  readonly clock: Clock;
  readonly configPath: string;
  readonly requesterId: string;
  readonly connectAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  readonly connectExistingAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  readonly adminTokenFromEnv?: string;
  readonly readAdminTokenFile: () => Promise<string | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
  readonly validateConfig: (merged: Record<string, unknown>) => Promise<void>;
  readonly readLogFile?: () => Promise<string>;
  readonly followLogFile?: () => Promise<void>;
  readonly readEventFile: (sinceTs: number) => Promise<readonly EventEnvelope[]>;
  readonly loadMcpStdio?: () => Promise<McpStdioRunner>;
  readonly runMcpStdio?: () => Promise<void>;
  readonly signals: Signals;
  readonly parentPid?: number;
  readonly parentWatch?: ParentWatch;
  readonly stderr: Output;
  readonly stdout: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string | undefined>;
}

const ADMIN_TOKEN_FILE_READ_ATTEMPTS = 3;
const ADMIN_TOKEN_FILE_RETRY_DELAY_MS = 50;

async function readAdminTokenFileWithRetry(
  environment: CliEnvironment,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < ADMIN_TOKEN_FILE_READ_ATTEMPTS; attempt++) {
    const token = await environment.readAdminTokenFile();
    if (token !== undefined) return token;
    if (attempt < ADMIN_TOKEN_FILE_READ_ATTEMPTS - 1) {
      await environment.sleep(ADMIN_TOKEN_FILE_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

type CredentialSource = "flag" | "env" | "file" | "none";

function isAdminAuthFailure(error: unknown): boolean {
  return isSimlockError(error) && error.code === "ADMIN_AUTHENTICATION_FAILED";
}

function writeAgentFallbackNotice(environment: CliEnvironment, source: CredentialSource): void {
  const notice =
    source === "file"
      ? "local admin.token credential was rejected by the daemon (stale after an unclean " +
        "shutdown or restart?); connecting as agent (admin-only commands will fail with FORBIDDEN)"
      : source === "none"
        ? "admin credential unavailable; connecting as agent (admin-only commands will fail with FORBIDDEN)"
        : "admin credential was rejected by the daemon; connecting as agent (admin-only " +
          "commands will fail with FORBIDDEN)";
  environment.stderr.write(`${JSON.stringify({ notice })}\n`);
}

async function connectDaemonClient(
  environment: CliEnvironment,
  tokenFlag: string | undefined,
  options: { readonly launch?: boolean } = {},
): Promise<SimlockAdminClient> {
  const connect =
    options.launch === false ? environment.connectExistingAdmin : environment.connectAdmin;

  let source: CredentialSource = "none";
  const resolveCredential = async (): Promise<string | undefined> => {
    if (tokenFlag !== undefined && tokenFlag !== "") {
      source = "flag";
      return tokenFlag;
    }
    if (environment.adminTokenFromEnv !== undefined && environment.adminTokenFromEnv !== "") {
      source = "env";
      return environment.adminTokenFromEnv;
    }
    const fileToken = await readAdminTokenFileWithRetry(environment);
    source = fileToken === undefined ? "none" : "file";
    return fileToken;
  };

  try {
    const client = await connect(resolveCredential);
    if (source === "none") writeAgentFallbackNotice(environment, "none");
    return client;
  } catch (error: unknown) {
    if (!isAdminAuthFailure(error) || source === "none") throw error;
    writeAgentFallbackNotice(environment, source);
    return connect(async () => undefined);
  }
}

class AutoLaunchIpcConnector implements IpcConnector {
  constructor(
    private readonly ipc: IpcConnector,
    private readonly clock: Clock,
    private readonly launcher: DaemonLauncher,
    private readonly checkConfig: () => Promise<void>,
    private readonly startupTimeoutMs: number,
  ) {}

  async connect(endpoint: string): Promise<IpcConnection> {
    try {
      return await this.ipc.connect(endpoint);
    } catch (error: unknown) {
      if (!isUnavailable(error)) throw error;
    }
    await this.checkConfig();
    await this.launcher.launch();
    const deadline = this.clock.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (this.clock.now() < deadline) {
      try {
        return await this.ipc.connect(endpoint);
      } catch (error: unknown) {
        if (!isUnavailable(error)) throw error;
        lastError = error;
        await new Promise<void>((resolve) => this.clock.setTimer(50, resolve));
      }
    }
    throw new SimlockError(
      "DAEMON_STARTUP_FAILED",
      "transport",
      `Timed out starting simlock daemon: ${errorMessage(lastError)}`,
      {},
    );
  }
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "connection-refused" || error.code === "endpoint-not-found")
  );
}

export interface CliEnvironmentPorts {
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly systemStats: SystemStats;
  readonly ipc: IpcConnector;
  readonly launcher: DaemonLauncher;
  readonly dataDirectory: string;
  readonly parentWatch?: ParentWatch;
  readonly signals?: Signals;
  readonly stderr?: Output;
  readonly stdout?: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string | undefined>;
  readonly parentPid?: number;
}

const moduleConfigEntries = optionalModules.map(({ config, name }) => ({ name, ...config }));

export function buildCliEnvironment(
  ports: CliEnvironmentPorts,
  env: NodeJS.ProcessEnv = process.env,
): CliEnvironment {
  const { clock, dataDirectory, filesystem, ipc, launcher, systemStats } = ports;
  const configPath = join(dataDirectory, "config.json");
  const logPath = join(dataDirectory, "daemon.log");
  const adminTokenPath = join(dataDirectory, "admin.token");
  const requesterId = resolveRequesterId(env, String(process.pid));
  // why: the daemon refuses to boot on a config `loadConfig` rejects and only its log says so;
  // loading the same file before the launch puts the `ConfigError` on the CLI's stderr.
  const autoLaunchIpc = new AutoLaunchIpcConnector(
    ipc,
    clock,
    launcher,
    async () => {
      await loadConfig({ configPath, filesystem, modules: moduleConfigEntries, systemStats });
    },
    DAEMON_STARTUP_TIMEOUT_MS,
  );

  const connect = async (
    connector: IpcConnector,
    resolveCredential: () => Promise<string | undefined>,
  ): Promise<SimlockAdminClient> => {
    // why: Resolved here rather than once during construction, because it can throw: a
    // `SIMLOCK_HOME` whose socket path exceeds the platform limit is a `SocketPathTooLongError`.
    // `runCli` takes its environment as a *default parameter*, and a default initializer runs
    // before the function body -- so resolving eagerly put that throw outside `runCli`'s own
    // try/catch, where it escaped as an uncaught rejection with a raw stack trace instead of
    // the single structured error line `docs/CLI.md` promises, and took `simlock --help` (which
    // needs no socket at all) down with it. Every consumer of this path is behind a command
    // that is already inside that try.
    const connection = await connector.connect(resolveDaemonSocketPath(dataDirectory));
    const credential = await resolveCredential();
    return connectSimlockAdmin({
      connection,
      principal: requesterId,
      ...(credential === undefined ? {} : { credential }),
    });
  };

  return {
    clock,
    configPath,
    requesterId,
    connectAdmin: (resolveCredential) => connect(autoLaunchIpc, resolveCredential),
    connectExistingAdmin: (resolveCredential) => connect(ipc, resolveCredential),
    ...(env.SIMLOCK_ADMIN_TOKEN === undefined
      ? {}
      : { adminTokenFromEnv: env.SIMLOCK_ADMIN_TOKEN }),
    readAdminTokenFile: () => readAdminTokenFile(filesystem, adminTokenPath),
    sleep: (milliseconds) => new Promise<void>((resolve) => clock.setTimer(milliseconds, resolve)),
    parentPid: ports.parentPid ?? process.ppid,
    parentWatch: ports.parentWatch ?? new NodeParentWatch(),
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    runPassthrough: ports.runPassthrough ?? spawnPassthrough,
    readStdin: ports.readStdin ?? readPipedStdin,
    writeConfigFile: async (contents) => {
      await filesystem.mkdirp(dataDirectory);
      // why: Owner-only on every write: the file can hold `gateway.token`, and the atomic rename
      // replaces the old file, so a mode the user set by hand would not survive otherwise.
      await filesystem.writeFileAtomic(configPath, `${JSON.stringify(contents, null, 2)}\n`, {
        mode: 0o600,
      });
    },
    validateConfig: async (merged) => {
      const unknownKeyWarnings: string[] = [];
      await loadConfig({
        configPath: "/config-set-validation.json",
        filesystem: new MemoryFilesystem(),
        modules: moduleConfigEntries,
        overrides: merged as ConfigOverrides,
        systemStats,
        warn: (message) => {
          if (message.startsWith("Unknown config key:")) unknownKeyWarnings.push(message);
        },
      });
      if (unknownKeyWarnings.length > 0) throw new Error(unknownKeyWarnings.join("; "));
    },
    readLogFile: async () => readLogFile(filesystem, logPath),
    followLogFile: () =>
      followLog({
        clock,
        filesystem,
        path: logPath,
        signals: ports.signals ?? process,
        write: (text) => (ports.stdout ?? process.stdout).write(text),
      }),
    readEventFile: (sinceTs) =>
      readEventFile(filesystem, join(dataDirectory, EVENT_FILE_NAME), { sinceTs }),
    signals: ports.signals ?? process,
    stderr: ports.stderr ?? process.stderr,
    stdout: ports.stdout ?? process.stdout,
    confirm: ports.confirm ?? confirmTerminal,
  };
}

export async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY === true) return undefined;
  process.stdin.setEncoding("utf8");
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk as string;
  return contents;
}

function defaultCliEnvironment(env: NodeJS.ProcessEnv = process.env): CliEnvironment {
  const dataDirectory = resolveSimlockHome(env);
  const logPath = join(dataDirectory, "daemon.log");
  return buildCliEnvironment(
    {
      filesystem: new NodeFilesystem(),
      clock: new SystemClock(),
      systemStats: new NodeSystemStats(),
      ipc: new NodeIpcTransport(),
      launcher: new NodeDaemonLauncher({
        args: [join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js")],
        command: process.execPath,
        logPath,
        simlockHome: dataDirectory,
      }),
      dataDirectory,
    },
    env,
  );
}

async function readAdminTokenFile(
  filesystem: Filesystem,
  path: string,
): Promise<string | undefined> {
  try {
    if (!(await filesystem.exists(path))) return undefined;
    const contents = (await filesystem.readFile(path)).trim();
    return contents === "" ? undefined : contents;
  } catch {
    return undefined;
  }
}

async function loadDefaultMcpStdio(): Promise<McpStdioRunner> {
  return (await import("../mcp/main.js")).runMcpStdio;
}

function extractGlobalToken(argv: readonly string[]): {
  readonly token: string | undefined;
  readonly rest: string[];
} {
  const rest: string[] = [];
  let token: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--token") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--token requires a value");
      token = value;
      index++;
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    rest.push(arg);
  }
  return { token, rest };
}

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment = defaultCliEnvironment(),
): Promise<number> {
  try {
    if (argv.length === 0 || isHelp(argv[0])) {
      environment.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const { token, rest } = extractGlobalToken(argv);
    switch (rest[0]) {
      case "lease":
        return await runLease(rest.slice(1), environment, token);
      case "release":
        return await runRelease(rest.slice(1), environment, token);
      case "status":
        return await runStatus(rest.slice(1), environment, token);
      case "list":
        return await runList(rest.slice(1), environment, token);
      case "catalog":
        return await runCatalog(rest.slice(1), environment, token);
      case "cleanup":
        return await runCleanup(rest.slice(1), environment, token);
      case "doctor":
        return await runDoctor(rest.slice(1), environment, token);
      case "nuke":
        return await runNuke(rest.slice(1), environment, token);
      case "events":
        return await runEvents(rest.slice(1), environment, token);
      case "daemon":
        return await runDaemon(rest.slice(1), environment, token);
      case "config":
        return await runConfig(rest.slice(1), environment, token);
      case "token":
        return await runToken(rest.slice(1), environment, token);
      case "worker":
        return await runWorker(rest.slice(1), environment, token);
      case "component":
        return await runComponent(rest.slice(1), environment, token);
      case "device":
        return await runDevice(rest.slice(1), environment, token);
      case "simctl":
      case "adb":
        return await runPassthrough(
          rest[0] === "adb" ? "adb" : "simctl",
          rest.slice(1),
          environment,
          token,
        );
      case "mcp":
        return await runMcp(rest.slice(1), environment);
      default:
        throw new UsageError(withHelpHint(`Unknown command: ${rest[0]}`));
    }
  } catch (error: unknown) {
    writeError(environment, error);
    return errorExitCode(error);
  }
}

function writeError(environment: CliEnvironment, error: unknown): void {
  environment.stderr.write(
    `${JSON.stringify({ error: { code: cliErrorCode(error), message: errorMessage(error) } })}\n`,
  );
}

function cliErrorCode(error: unknown): string {
  if (error instanceof UsageError || error instanceof SocketPathTooLongError) return "USAGE";
  if (isSimlockError(error)) return error.code;
  return "INTERNAL";
}

async function runPassthrough(
  tool: "simctl" | "adb",
  args: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const { leaseFlag, rest } = extractLeaseFlag(args);
  const client = await connectDaemonClient(environment, token);
  let daemon;
  try {
    ({ daemon } = await client.getStatus());
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
  if (daemon.mode === "gateway") {
    try {
      return await runRemotePassthrough(tool, rest, environment, client, leaseFlag);
    } finally {
      await client.close();
    }
  }
  const run = environment.runPassthrough;
  if (run === undefined) {
    await client.close();
    throw new Error("Tool passthrough is unavailable");
  }
  let command;
  try {
    command = await client.resolvePassthrough({ args: [...rest], tool });
  } catch (error: unknown) {
    throw asUsageIfRefused(error);
  } finally {
    await client.close();
  }
  return run(command);
}

async function runRemotePassthrough(
  tool: "simctl" | "adb",
  args: readonly string[],
  environment: CliEnvironment,
  client: SimlockAdminClient,
  leaseFlag: string | undefined,
): Promise<number> {
  try {
    const leaseId = leaseFlag ?? (await resolveRemoteLeaseId(client, environment));
    const stdin = await environment.readStdin?.();
    const requesterId = client.role === "admin" ? environment.requesterId : undefined;
    const { exitCode } = await client.exec(
      {
        args: [...args],
        leaseId,
        tool,
        ...(requesterId === undefined ? {} : { requesterId }),
        ...(stdin === undefined ? {} : { stdin }),
      },
      {
        onOutput: (chunk) => {
          const sink = chunk.stream === "stdout" ? environment.stdout : environment.stderr;
          sink.write(chunk.chunk);
        },
      },
    );
    return exitCode;
  } catch (error: unknown) {
    throw asUsageIfRefused(error);
  }
}

function asUsageIfRefused(error: unknown): unknown {
  if (
    isSimlockError(error) &&
    (error.code === "PASSTHROUGH_REFUSED" || error.code === "UNKNOWN_PASSTHROUGH_TOOL")
  ) {
    return new UsageError(error.message);
  }
  return error;
}

function extractLeaseFlag(args: readonly string[]): {
  readonly leaseFlag: string | undefined;
  readonly rest: readonly string[];
} {
  let leaseFlag: string | undefined;
  let index = 0;
  while (index < args.length) {
    const argument = args[index] as string;
    if (argument === "--lease") {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError("--lease requires a lease id");
      leaseFlag = value;
      index += 2;
      continue;
    }
    if (argument.startsWith("--lease=")) {
      leaseFlag = argument.slice("--lease=".length);
      if (leaseFlag === "") throw new UsageError("--lease requires a lease id");
      index += 1;
      continue;
    }
    break;
  }
  return { leaseFlag, rest: args.slice(index) };
}

async function resolveRemoteLeaseId(
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<string> {
  const { leases } = await client.listLeases();
  const own =
    client.role === "admin"
      ? leases.filter((lease) => lease.requesterId === environment.requesterId)
      : leases;
  if (own.length === 0) {
    throw new UsageError(
      `No lease is held by ${environment.requesterId}: run \`simlock lease\` first, or set SIMLOCK_AGENT_ID to the id that holds it`,
    );
  }
  if (own.length > 1) {
    throw new UsageError(
      `${environment.requesterId} holds more than one lease (${own.map((lease) => lease.id).join(", ")}); pass --lease <id> to name the device you mean`,
    );
  }
  return (own[0] as { readonly id: string }).id;
}

function errorExitCode(error: unknown): number {
  if (error instanceof UsageError || error instanceof SocketPathTooLongError) return 2;
  if (isSimlockError(error)) return ERROR_TABLE[error.code].cliExitCode;
  return 1;
}

async function runMcp(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  if (argv.length === 1 && isHelp(argv[0])) {
    environment.stdout.write("Usage: simlock mcp\n");
    return 0;
  }
  if (argv.length > 0) throw new UsageError("mcp accepts no arguments");
  const runMcpStdio =
    environment.runMcpStdio ?? (await (environment.loadMcpStdio ?? loadDefaultMcpStdio)());
  await runMcpStdio();
  return 0;
}

export function parseDuration(value: string): number {
  const milliseconds = parseDurationMs(value);
  if (milliseconds === undefined) throw new UsageError(`Invalid duration: ${value}`);
  return milliseconds;
}

function parseBindPid(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const pid = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(pid) || pid <= 0)
    throw new UsageError("lease --bind-pid must be a positive integer");
  return pid;
}

// fallow-ignore-next-line complexity -- CLI command parsing remains intentionally local to its rendering boundary.
async function runLease(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  if (argv[0] === "renew") return runRenew(argv.slice(1), environment, token);
  const values = commandArgs(argv, {
    "agent-id": { type: "string" },
    "allow-download": { type: "boolean" },
    "bind-pid": { type: "string" },
    class: { type: "string" },
    detach: { type: "boolean" },
    device: { type: "string" },
    "export-env": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "image-tag": { type: "string" },
    "lease-id": { type: "string" },
    mode: { type: "string" },
    "no-wait": { type: "boolean" },
    os: { type: "string" },
    physical: { type: "boolean" },
    platform: { type: "string" },
    timeout: { type: "string" },
    ttl: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock lease --platform <ios|android> [--device <model> | --class <class>]\n" +
        "                     [--os <version|range>] [--mode <slim|full>] [--image-tag <tag>] [--agent-id <id>]\n" +
        "                     [--timeout <duration>] [--lease-id <id>] [--physical]\n" +
        "                     [--no-wait] [--detach] [--ttl <duration>] [--allow-download]\n" +
        "                     [--export-env] [--bind-pid <pid>]\n",
    );
    return 0;
  }
  if (values.platform !== "ios" && values.platform !== "android")
    throw new UsageError(withHelpHint("lease requires --platform <ios|android>"));
  const platform = values.platform as "ios" | "android";
  if (values.device === "") throw new UsageError("lease --device must not be empty");
  if (values.class === "") throw new UsageError("lease --class must not be empty");
  if (values["agent-id"] === "") throw new UsageError("lease --agent-id must not be empty");
  const requesterId = (values["agent-id"] as string | undefined) ?? environment.requesterId;
  const detached = values.detach ?? false;
  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined;
  const ttlMs = typeof values.ttl === "string" ? parseDuration(values.ttl) : undefined;
  // why: A reparented holder keeps renewing, so a TTL cannot bound it; watching the parent does.
  const bindPid = parseBindPid(values["bind-pid"]);
  const watchedPid = bindPid ?? environment.parentPid;
  const termination = detached
    ? undefined
    : waitForTermination(environment.signals, environment.parentWatch, watchedPid);

  const client = await connectDaemonClient(environment, token);
  let leaseLost = false;
  let ourLeaseId: string | undefined;
  let ourLeaseDeadline: number | undefined;
  let notifyLeaseLost: (() => void) | undefined;
  const leaseLostSignal = new Promise<void>((resolve) => {
    notifyLeaseLost = resolve;
  });
  let wroteLeaseLost = false;
  const markLeaseLost = (notice: {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly reason: string;
  }): void => {
    if (!wroteLeaseLost) {
      wroteLeaseLost = true;
      environment.stderr.write(`${JSON.stringify({ push: "lease-lost", ...notice })}\n`);
    }
    leaseLost = true;
    notifyLeaseLost?.();
  };
  const offLeaseLost = client.onLeaseLost((push) => {
    if (push.leaseId !== ourLeaseId) return;
    markLeaseLost(push);
  });
  let connectionLost = false;
  let notifyConnectionLost: (() => void) | undefined;
  const connectionLostSignal = new Promise<void>((resolve) => {
    notifyConnectionLost = resolve;
  });
  const offConnectionLost = client.onConnectionLost(() => {
    connectionLost = true;
    if (ourLeaseId !== undefined) {
      environment.stderr.write(
        `${JSON.stringify({
          error: {
            code: "DAEMON_CONNECTION_LOST",
            message: `lost the daemon connection; lease ${ourLeaseId} is still yours until its ttlDeadline ${String(ourLeaseDeadline)} -- renew it with \`simlock lease renew ${ourLeaseId}\` or let it expire`,
          },
        })}\n`,
      );
    }
    notifyConnectionLost?.();
  });
  const offUnhealthy = client.onDeviceUnhealthy((push) => {
    environment.stderr.write(`${JSON.stringify({ push: "device-unhealthy", ...push })}\n`);
  });
  const offRecovered = client.onDeviceRecovered((push) => {
    environment.stderr.write(`${JSON.stringify({ push: "device-recovered", ...push })}\n`);
  });
  let heldLeaseId: string | undefined;
  const releaseHeldLease = async (): Promise<void> => {
    // why: A dead connection can neither carry the release nor needs to: the lease outlives this
    // process either way, and `client.releaseLease` would only reject `DAEMON_CONNECTION_LOST`
    // a second time.
    if (heldLeaseId === undefined || leaseLost || connectionLost) return;
    const leaseId = heldLeaseId;
    heldLeaseId = undefined;
    try {
      // why: Bounded like MCP's farewell release: a daemon that accepts the frame and never answers
      // must not leave `simlock lease` hanging after a Ctrl-C.
      await awaitWithin(
        environment.clock,
        RELEASE_TIMEOUT_MS,
        client.releaseLease({ leaseId }),
        `Timed out releasing lease ${leaseId}`,
      );
    } catch (error: unknown) {
      writeError(environment, error);
    }
  };
  let renewal: LeaseRenewal | undefined;
  try {
    const grant = await client.requestLease(
      {
        allowDownload: values["allow-download"] === true,
        noWait: values["no-wait"] === true,
        requesterId,
        ...(typeof values.device === "string" ? { model: values.device } : {}),
        ...(typeof values.class === "string" ? { class: values.class as DeviceClass } : {}),
        ...(typeof values.os === "string" ? { osVersion: values.os } : {}),
        ...(values.physical === true ? { physical: true } : {}),
        platform,
        ...(typeof values.mode === "string" ? { mode: values.mode as "slim" | "full" } : {}),
        ...(typeof values["image-tag"] === "string" ? { imageTag: values["image-tag"] } : {}),
        ...(typeof values["lease-id"] === "string" ? { leaseId: values["lease-id"] } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      },
      {
        onProgress: (progress) => {
          environment.stderr.write(`${JSON.stringify({ push: "progress", ...progress })}\n`);
        },
      },
    );
    ourLeaseId = grant.lease.id;
    ourLeaseDeadline = grant.lease.ttlDeadline;
    if (!detached) heldLeaseId = grant.lease.id;
    const result = { ...grant, role: client.role };
    if (values["export-env"] === true) writeExportEnv(environment, result);
    else writeResult(environment, result);
    if (termination === undefined) return 0;
    if (connectionLost) return ERROR_TABLE.DAEMON_CONNECTION_LOST.cliExitCode;
    renewal = startLeaseRenewal({
      clock: environment.clock,
      leaseId: grant.lease.id,
      ttlMs: grant.lease.ttlMs,
      ttlDeadline: grant.lease.ttlDeadline,
      renew: (leaseId) => client.renewLease({ leaseId }),
      onRenewed: (renewed) => {
        ourLeaseDeadline = renewed.ttlDeadline;
      },
      onError: (error) => {
        if (connectionLost) return;
        writeError(environment, error);
      },
      onLeaseGone: (reason, error) => {
        markLeaseLost({ deviceId: grant.lease.deviceId, leaseId: grant.lease.id, reason });
        writeError(environment, error);
      },
    });
    await Promise.race([termination.settled, leaseLostSignal, connectionLostSignal]);
    if (leaseLost) return LEASE_LOST_EXIT_CODE;
    if (connectionLost) return ERROR_TABLE.DAEMON_CONNECTION_LOST.cliExitCode;
    return 0;
  } finally {
    // why: Stopped before the release, always: a renew must never race the release of the lease it
    // is renewing, and no timer may outlive this command.
    renewal?.stop();
    await releaseHeldLease();
    termination?.dispose();
    offLeaseLost();
    offUnhealthy();
    offRecovered();
    offConnectionLost();
    await client.close();
  }
}

async function runRenew(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    ttl: { type: "string" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: simlock lease renew <lease-id> [--ttl <duration>]\n");
    return 0;
  }
  const leaseId = requiredPositional(positionals, "lease-id");
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      environment,
      await client.renewLease({
        leaseId,
        ...(typeof values.ttl === "string" ? { ttlMs: parseDuration(values.ttl) } : {}),
      }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runRelease(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: simlock release <lease-id> | --all [--yes]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.all) {
      if (positionals.length > 0)
        throw new UsageError("release accepts either a lease id or --all, not both");
      const confirmed = values.yes ?? (await environment.confirm?.("Release every lease? [y/N] "));
      if (!confirmed) throw new UsageError("release --all requires confirmation or --yes");
      writeResult(environment, await client.releaseAllLeases());
      return 0;
    }
    writeResult(
      environment,
      await client.releaseLease({ leaseId: requiredPositional(positionals, "lease-id") }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runStatus(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock status [--json]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const status = await client.getStatus();
    if (values.json) writeResult(environment, status);
    else environment.stdout.write(`${formatStatus(status, environment.clock.now())}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function runList(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    devices: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    leases: { type: "boolean" },
    requests: { type: "boolean" },
    rules: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock list [--devices|--leases|--rules|--requests]\n");
    return 0;
  }
  if ([values.devices, values.leases, values.rules, values.requests].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, --rules, or --requests");
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.requests) {
      const requests = waitingRequestSchema.array().parse(await client.list({ kind: "requests" }));
      environment.stdout.write(`${formatWaitingRequests(requests, environment.clock.now())}\n`);
      return 0;
    }
    const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
    writeResult(environment, await client.list({ kind }));
    return 0;
  } finally {
    await client.close();
  }
}

function formatWaitingRequests(requests: readonly WaitingRequestEntry[], now: number): string {
  if (requests.length === 0) return "No requests are waiting.";
  return requests
    .map((request) => {
      const { spec } = request;
      const device = [
        spec.platform,
        spec.physical === true ? "physical" : undefined,
        spec.model ?? `class ${String(requestedClass(spec))}`,
        spec.osVersion,
        spec.mode === undefined ? undefined : `mode ${spec.mode}`,
        spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      const where = request.workerId === undefined ? "" : ` on ${request.workerId}`;
      const stage =
        request.queuePosition === undefined
          ? request.stage
          : `${request.stage} at ${String(request.queuePosition)}`;
      const waited = Math.max(0, Math.round((now - request.createdAt) / 1000));
      return `Request ${request.id}: ${request.requesterId}${where}, ${device}, ${stage}, waiting ${String(waited)}s`;
    })
    .join("\n");
}

async function runCatalog(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    platform: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock catalog [--platform <ios|android>] [--json]\n");
    return 0;
  }
  if (values.platform !== undefined && values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("catalog --platform must be ios or android");
  const platform = values.platform as "ios" | "android" | undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    const response = await client.getCatalog(platform === undefined ? {} : { platform });
    if (values.json) writeResult(environment, response);
    else environment.stdout.write(`${formatCatalog(response)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function runCleanup(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    rule: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock cleanup [--dry-run] [--rule <name>]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      environment,
      await client.runCleanup({
        dryRun: values["dry-run"] === true,
        ...(typeof values.rule === "string" ? { rule: values.rule } : {}),
      }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runDoctor(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    fix: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "purge-orphans": { type: "boolean" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock doctor [--fix] [--purge-orphans] [--yes]\n");
    return 0;
  }
  const purgeOrphans = values["purge-orphans"] === true;
  if (purgeOrphans) {
    const confirmed =
      values.yes ?? (await environment.confirm?.("Destroy every orphaned device? [y/N] "));
    if (!confirmed) throw new UsageError("doctor --purge-orphans requires confirmation or --yes");
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const response = await client.runDoctor({ fix: values.fix === true, purgeOrphans });
    writeDriverAdvisoryWarnings(environment, response);
    writeMissingPrerequisites(environment, response);
    writeUnreachableWarmTargets(environment, response);
    writeModuleUnavailable(environment, response);
    writeResult(environment, response);
    return 0;
  } finally {
    await client.close();
  }
}

function writeDriverAdvisoryWarnings(environment: CliEnvironment, report: DoctorReport): void {
  for (const finding of report.findings) {
    if (finding.kind !== "driver-advisory") continue;
    environment.stderr.write(`Warning [${finding.platform}] ${finding.code}: ${finding.message}\n`);
  }
}

function writeMissingPrerequisites(environment: CliEnvironment, report: DoctorReport): void {
  for (const finding of report.findings) {
    if (finding.kind !== "prerequisite-missing") continue;
    environment.stderr.write(
      `Missing [${finding.platform}] ${finding.prerequisite}: ${finding.message} ${finding.remedy}\n`,
    );
  }
}

function writeUnreachableWarmTargets(environment: CliEnvironment, report: DoctorReport): void {
  for (const finding of report.findings) {
    if (finding.kind !== "warm-pool-target-unreachable") continue;
    environment.stderr.write(
      `${finding.kind}  ${finding.target}: ${finding.message}; ${finding.remedy}\n`,
    );
  }
}

function writeModuleUnavailable(environment: CliEnvironment, report: DoctorReport): void {
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").slice(0, 500);
  for (const finding of report.findings) {
    if (finding.kind !== "module-unavailable") continue;
    environment.stderr.write(
      `${finding.module}  fail  ${oneLine(finding.message)}; ${oneLine(finding.remedy)}\n`,
    );
  }
}

async function runNuke(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    "delete-devices": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock nuke [--delete-devices] [--yes]\n");
    return 0;
  }
  const confirmed =
    values.yes ?? (await environment.confirm?.("Nuke Simlock-managed devices? [y/N] "));
  if (!confirmed) throw new UsageError("nuke requires confirmation or --yes");
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      environment,
      await client.runNuke({ deleteDevices: values["delete-devices"] === true }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runEvents(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    since: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock events [--follow] [--since <duration>]\n");
    return 0;
  }
  const sinceTs =
    typeof values.since === "string"
      ? environment.clock.now() - parseDuration(values.since)
      : undefined;
  const follow = values.follow === true;
  const client = await connectForEvents(environment, token, follow ? undefined : sinceTs);
  if (client === undefined) return 0;
  const replayInput = sinceTs === undefined ? {} : { sinceTs };
  try {
    if (follow) {
      await followEvents(client, replayInput, environment);
    } else {
      for (const event of await client.replayEvents(replayInput)) writeResult(environment, event);
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function connectForEvents(
  environment: CliEnvironment,
  token: string | undefined,
  historySinceTs: number | undefined,
): Promise<SimlockAdminClient | undefined> {
  if (historySinceTs === undefined) return connectDaemonClient(environment, token);
  try {
    return await connectDaemonClient(environment, token, { launch: false });
  } catch (error: unknown) {
    if (daemonRefusal(error) !== undefined) throw error;
    for (const event of await environment.readEventFile(historySinceTs)) {
      writeResult(environment, event);
    }
    return undefined;
  }
}

async function followEvents(
  client: SimlockAdminClient,
  replayInput: { readonly sinceTs?: number },
  environment: CliEnvironment,
): Promise<void> {
  let buffered: EventPush[] | undefined = [];
  const unsubscribe = await client.subscribeEvents((event) => {
    if (buffered === undefined) writeResult(environment, event);
    else buffered.push(event);
  });
  const replayed = await client.replayEvents(replayInput);
  for (const event of replayed) writeResult(environment, event);
  const printed = new Set(replayed.map(eventKey));
  const pending = buffered;
  buffered = undefined;
  for (const push of pending) {
    if (!printed.has(eventKey(push.event))) writeResult(environment, push);
  }
  await waitForTermination(environment.signals).settled;
  await unsubscribe();
}

function daemonRefusal(error: unknown): AnySimlockError | undefined {
  return isSimlockError(error) && error.kind !== "transport" ? error : undefined;
}

// fallow-ignore-next-line complexity -- daemon subcommand parsing is a single CLI boundary.
async function runDaemon(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  const values = commandArgs(argv.slice(1), {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (command === undefined || isHelp(command) || values.help) {
    environment.stdout.write("Usage: simlock daemon <start|stop|status|logs [--follow]>\n");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (values.follow && command !== "logs") throw new UsageError("--follow applies only to logs");
  if (command === "start") {
    const client = await connectDaemonClient(environment, token, { launch: true });
    let status: StatusGetOutput;
    try {
      status = await client.getStatus();
    } finally {
      await client.close();
    }
    if (values.json) writeResult(environment, { status: "running" });
    else {
      const lines = ["Daemon running", ...consoleLines(status.daemon)];
      environment.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (command === "stop") {
    const client = await connectDaemonClient(environment, token, { launch: false });
    try {
      await client.stopDaemon();
    } finally {
      await client.close();
    }
    if (values.json) writeResult(environment, { status: "stopping" });
    else environment.stdout.write("Daemon stopping\n");
    return 0;
  }
  if (command === "status") {
    try {
      const client = await connectDaemonClient(environment, token, { launch: false });
      try {
        const status = await client.getStatus();
        if (values.json) writeResult(environment, status);
        else environment.stdout.write(`${formatStatus(status, environment.clock.now())}\n`);
      } finally {
        await client.close();
      }
      return 0;
    } catch (error: unknown) {
      const refusal = daemonRefusal(error);
      if (refusal !== undefined) {
        if (values.json) {
          writeResult(environment, {
            status: "handshake-refused",
            error: { code: refusal.code, message: refusal.message },
          });
        } else {
          environment.stdout.write(
            `Daemon handshake refused: ${refusal.code}: ${refusal.message}\n`,
          );
        }
        return 1;
      }
      if (values.json) writeResult(environment, { status: "stopped" });
      else environment.stdout.write("Daemon stopped\n");
      return 0;
    }
  }
  if (command === "logs" && values.follow) {
    if (values.json) throw new UsageError("--follow cannot be combined with --json");
    if (environment.followLogFile === undefined) {
      throw new Error("Daemon log reader is unavailable");
    }
    await environment.followLogFile();
    return 0;
  }
  if (command === "logs") {
    if (environment.readLogFile === undefined) throw new Error("Daemon log reader is unavailable");
    const lines = (await environment.readLogFile()).trimEnd().split("\n");
    const output = lines.slice(-100).join("\n");
    if (values.json) writeResult(environment, { logs: output });
    else environment.stdout.write(`${output}\n`);
    return 0;
  }
  throw new UsageError(`Unknown daemon command: ${command}`);
}

// fallow-ignore-next-line complexity -- config subcommand parsing is a single CLI boundary.
async function runConfig(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    const client = await connectDaemonClient(environment, token);
    try {
      writeResult(environment, await client.getConfig());
      return 0;
    } finally {
      await client.close();
    }
  }
  if (command === "get") {
    const values = commandArgs(argv.slice(1), {});
    const key = requiredPositional(values.positionals, "key");
    const client = await connectDaemonClient(environment, token);
    let config: Record<string, unknown>;
    try {
      config = await client.getConfig();
    } finally {
      await client.close();
    }
    const value = readConfigValue(config, key);
    if (value === undefined) throw new UsageError(`Unknown config key: ${key}`);
    writeResult(environment, value);
    return 0;
  }
  if (command === "set") {
    const values = commandArgs(argv.slice(1), {});
    const [key, rawValue, ...extra] = values.positionals;
    if (key === undefined || rawValue === undefined || extra.length > 0)
      throw new UsageError("Usage: simlock config set <key> <value>");
    const config = await environment.readConfigFile();
    writeConfigValue(config, key, parseConfigValue(rawValue));
    try {
      await environment.validateConfig(config);
    } catch (error: unknown) {
      throw new UsageError(`Invalid config after setting ${key}: ${errorMessage(error)}`);
    }
    await environment.writeConfigFile(config);
    environment.stdout.write(
      `Updated ${key} in ${environment.configPath}; takes effect on daemon restart.\n`,
    );
    return 0;
  }
  if (isHelp(command)) {
    environment.stdout.write("Usage: simlock config [get <key>|set <key> <value>]\n");
    return 0;
  }
  throw new UsageError(`Unknown config command: ${command}`);
}

async function runToken(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || isHelp(command)) {
    environment.stdout.write(
      "Usage: simlock token create --role <agent|operator|worker> [--label <text>]\n" +
        "       simlock token list\n" +
        "       simlock token revoke <token-id>\n",
    );
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    if (command === "create") return await runTokenCreate(argv.slice(1), client, environment);
    if (command === "list") return await runTokenList(argv.slice(1), client, environment);
    if (command === "revoke") return await runTokenRevoke(argv.slice(1), client, environment);
    throw new UsageError(withHelpHint(`Unknown token command: ${command}`));
  } finally {
    await client.close();
  }
}

async function runTokenCreate(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    label: { type: "string" },
    role: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock token create --role <agent|operator|worker> [--label <text>]\n",
    );
    return 0;
  }
  const role = parseTokenRole(values.role);
  const label = typeof values.label === "string" ? values.label : undefined;
  if (label === "") throw new UsageError("token create --label must not be empty");
  writeResult(
    environment,
    await client.createToken({ role, ...(label === undefined ? {} : { label }) }),
  );
  return 0;
}

async function runTokenList(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write("Usage: simlock token list\n");
    return 0;
  }
  writeResult(environment, await client.listTokens());
  return 0;
}

async function runTokenRevoke(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write("Usage: simlock token revoke <token-id>\n");
    return 0;
  }
  const id = requiredPositional(values.positionals, "token-id");
  writeResult(environment, await client.revokeToken({ id }));
  return 0;
}

function parseTokenRole(value: unknown): "agent" | "operator" | "worker" {
  if (value !== "agent" && value !== "operator" && value !== "worker")
    throw new UsageError(withHelpHint("token create requires --role <agent|operator|worker>"));
  return value;
}

async function runWorker(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || isHelp(command)) {
    environment.stdout.write(
      "Usage: simlock worker list [--json]\n" +
        "       simlock worker drain <worker-id>\n" +
        "       simlock worker undrain <worker-id>\n" +
        "       simlock worker remove <worker-id>\n",
    );
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    if (command === "list") return await runWorkerList(argv.slice(1), client, environment);
    if (command === "drain" || command === "undrain" || command === "remove") {
      return await runWorkerAction(command, argv.slice(1), client, environment);
    }
    throw new UsageError(withHelpHint(`Unknown worker command: ${command}`));
  } finally {
    await client.close();
  }
}

async function runWorkerList(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock worker list [--json]\n");
    return 0;
  }
  const result = await client.listWorkers();
  if (values.json) writeResult(environment, result);
  else
    environment.stdout.write(
      `${formatWorkers(result.workers, { installs: true, now: environment.clock.now() })}\n`,
    );
  return 0;
}

async function runWorkerAction(
  command: "drain" | "undrain" | "remove",
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CliEnvironment,
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write(`Usage: simlock worker ${command} <worker-id>\n`);
    return 0;
  }
  const workerId = requiredPositional(values.positionals, "worker-id");
  const result =
    command === "drain"
      ? await client.drainWorker({ workerId })
      : command === "undrain"
        ? await client.undrainWorker({ workerId })
        : await client.removeWorker({ workerId });
  writeResult(environment, result);
  return 0;
}

const DEVICE_USAGE =
  "Usage: simlock device add --platform <ios|android> <id> [--json]\n" +
  "       simlock device remove <id> [--json]\n";

async function runDevice(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || isHelp(command)) {
    environment.stdout.write(DEVICE_USAGE);
    return 0;
  }
  if (command !== "add" && command !== "remove") {
    throw new UsageError(withHelpHint(`Unknown device command: ${command}`));
  }
  const parsed = parseDeviceArgs(command, argv.slice(1));
  if (parsed === "help") {
    environment.stdout.write(DEVICE_USAGE);
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const { line, result } =
      parsed.platform === undefined
        ? await removeDevice(client, parsed.id)
        : await addDevice(client, parsed.id, parsed.platform);
    environment.stdout.write(`${parsed.json ? JSON.stringify(result) : line}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

function parseDeviceArgs(
  command: "add" | "remove",
  argv: readonly string[],
):
  | {
      readonly id: string;
      readonly json: boolean;
      readonly platform: "ios" | "android" | undefined;
    }
  | "help" {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    ...(command === "add" ? { platform: { type: "string" as const } } : {}),
  });
  if (values.help) return "help";
  const [id, ...extra] = values.positionals;
  if (id === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint(`device ${command} takes exactly one <id>`));
  }
  const json = values.json === true;
  if (command === "remove") return { id, json, platform: undefined };
  if (values.platform !== "ios" && values.platform !== "android") {
    throw new UsageError(
      withHelpHint(
        "device add needs --platform ios or --platform android, to say which driver reads the device",
      ),
    );
  }
  return { id, json, platform: values.platform };
}

async function addDevice(
  client: SimlockAdminClient,
  id: string,
  platform: "ios" | "android",
): Promise<{ readonly line: string; readonly result: unknown }> {
  const result = await client.addDevice({ id, platform });
  return { line: describeEnrolled(result), result };
}

async function removeDevice(
  client: SimlockAdminClient,
  id: string,
): Promise<{ readonly line: string; readonly result: unknown }> {
  const result = await client.removeDevice({ id });
  return { line: describeRemoved(result), result };
}

function describeRemoved(result: { readonly driverDeviceId: string }): string {
  return `Removed ${result.driverDeviceId}. It is no longer enrolled; nothing on the device changed.`;
}

function describeEnrolled(result: {
  readonly appCount: number;
  readonly driverDeviceId: string;
  readonly model: string;
  readonly osVersion: string;
  readonly platform: "ios" | "android";
  readonly reenrolled: boolean;
}): string {
  const os = `${result.platform === "ios" ? "iOS" : "Android"} ${result.osVersion}`;
  const apps = `${String(result.appCount)} user app${result.appCount === 1 ? "" : "s"}`;
  return `Enrolled ${result.model} (${os}) as ${result.driverDeviceId}${result.reenrolled ? " again" : ""}, ${apps} recorded.`;
}

const COMPONENT_USAGE =
  "Usage: simlock component install <ios|android> <version> [--worker <id>... | --all-workers]\n" +
  "       simlock component list [--platform <ios|android>]\n" +
  "       simlock component remove <ios|android> <version> [--dry-run] [--yes]\n";

async function runComponent(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || isHelp(command)) {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  if (command === "list") return runComponentList(argv.slice(1), environment, token);
  if (command === "remove") return runComponentRemove(argv.slice(1), environment, token);
  if (command !== "install") {
    throw new UsageError(withHelpHint(`Unknown component command: ${command}`));
  }
  const input = parseComponentInstallArgs(argv.slice(1));
  if (input === "help") {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  const onProgress = (progress: unknown): void => {
    environment.stderr.write(`${JSON.stringify(progress)}\n`);
  };
  try {
    if (input.workers === undefined) {
      writeResult(environment, await client.installComponent(input, { onProgress }));
      return 0;
    }
    const { platform, version, workers } = input;
    const result = await client.installComponentOnWorkers(
      { platform, version, workers },
      { onProgress },
    );
    writeResult(environment, result);
    return result.results.every(
      (entry) => entry.outcome === "installed" || entry.outcome === "already-installed",
    )
      ? 0
      : WORKER_INSTALL_INCOMPLETE_EXIT_CODE;
  } finally {
    await client.close();
  }
}

async function runComponentList(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    platform: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  if (values.positionals.length > 0) {
    throw new UsageError(withHelpHint("component list takes no positional arguments"));
  }
  if (values.platform !== undefined && values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("component list --platform must be ios or android");
  const platform = values.platform as "ios" | "android" | undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      environment,
      await client.listComponents(platform === undefined ? {} : { platform }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runComponentRemove(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const parsed = parseComponentRemoveArgs(argv);
  if (parsed === "help") {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  const { dryRun, platform, version } = parsed;
  if (!dryRun) {
    const confirmed =
      parsed.yes || (await environment.confirm?.(`Remove ${platform} ${version}? [y/N] `));
    if (confirmed !== true) {
      throw new UsageError("component remove requires confirmation or --yes");
    }
  }
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      environment,
      await client.removeComponent({ platform, version, ...(dryRun ? { dryRun } : {}) }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

function parseComponentRemoveArgs(argv: readonly string[]):
  | {
      readonly platform: "ios" | "android";
      readonly version: string;
      readonly dryRun: boolean;
      readonly yes: boolean;
    }
  | "help" {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  if (values.help) return "help";
  const [platform, version, ...extra] = values.positionals;
  if (platform === undefined || version === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("Expected <ios|android> <version>"));
  }
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError("component remove <platform> must be ios or android");
  }
  return { dryRun: values["dry-run"] === true, platform, version, yes: values.yes === true };
}

function parseComponentInstallArgs(argv: readonly string[]):
  | {
      readonly platform: "ios" | "android";
      readonly version: string;
      readonly workers?: "all" | string[];
    }
  | "help" {
  const values = commandArgs(argv, {
    "all-workers": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    worker: { type: "string", multiple: true },
  });
  if (values.help) return "help";
  const workers = installTargets(values.worker as string[] | undefined, values["all-workers"]);
  const [platform, version, ...extra] = values.positionals;
  if (platform === undefined || version === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("Expected <ios|android> <version>"));
  }
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError("component install <platform> must be ios or android");
  }
  return workers === undefined ? { platform, version } : { platform, version, workers };
}

function installTargets(named: string[] | undefined, all: unknown): "all" | string[] | undefined {
  if (all !== true) return named;
  if (named !== undefined) {
    throw new UsageError("component install takes --worker or --all-workers, not both");
  }
  return "all";
}

function formatWorkers(
  workers: WorkerView[],
  options: { readonly installs?: boolean; readonly now: number },
): string {
  if (workers.length === 0) return "No workers have connected to this gateway.";
  const { installs: showInstalls, now } = options;
  return workers
    .map((worker) => {
      const installs =
        showInstalls === true
          ? (worker.installs ?? []).map((install) => `\n  ${formatInstall(install, now)}`).join("")
          : "";
      const load = workerLoadLine(worker, now);
      const label = worker.label === undefined ? worker.id : `${worker.id} (${worker.label})`;
      const state = workerState(worker);
      const capacity =
        worker.capacity === undefined
          ? "capacity unknown"
          : `ios ${worker.capacity.ios.running}/${worker.capacity.ios.limit}, ` +
            `android ${worker.capacity.android.running}/${worker.capacity.android.limit}`;
      const skew =
        worker.protocol === undefined
          ? ""
          : ` protocol ${worker.protocol.worker.min}-${worker.protocol.worker.max}` +
            ` vs gateway ${worker.protocol.gateway.min}-${worker.protocol.gateway.max}`;
      const host = worker.host === undefined ? "" : ` -- ${formatHost(worker.host)}`;
      const capabilities = (worker.capabilities ?? [])
        .map((entry) =>
          entry.state === "unavailable"
            ? ` -- ${entry.name} unavailable: ${entry.reason ?? "unknown"}`
            : ` -- ${entry.name} ${entry.state}`,
        )
        .join("");
      return `${label}: ${state} -- ${capacity}, ${leaseCount(worker)}${skew}${host}${capabilities}${load}${installs}`;
    })
    .join("\n");
}

function workerLoadLine(worker: WorkerView, now: number): string {
  if (worker.connection === "disconnected") return "\n  Load: no reading while disconnected";
  if (worker.load === undefined) return "";
  const { readAt, ...parts } = worker.load;
  return `\n  ${formatLoadLine(parts, Math.ceil(Math.max(0, now - readAt) / 1000))}`;
}

function workerState(worker: WorkerView): string {
  return [
    worker.connection,
    ...(worker.health === "starting" ? ["starting"] : []),
    ...(worker.drained ? ["drained"] : []),
  ].join(", ");
}

function leaseCount(worker: WorkerView): string {
  if (worker.leases === undefined) return "leases unknown";
  return `${String(worker.leases.length)} lease(s)`;
}

function formatInstall(
  install: NonNullable<StatusGetOutput["installs"]>[number],
  now: number,
): string {
  const where = install.workerId === undefined ? "" : ` on ${install.workerId}`;
  const ageSeconds = Math.max(0, Math.round((now - install.since) / 1000));
  const waiters = `${String(install.waiters)} waiter${install.waiters === 1 ? "" : "s"}`;
  return `Install ${install.platform} ${install.component}${where}: ${install.state} for ${String(ageSeconds)}s, ${waiters}`;
}

function formatGibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatHost(host: StatusGetOutput["host"]): string {
  const system = `${host.os} ${host.osVersion} ${host.arch}`;
  const tools = host.tools.map(
    (tool) => `${tool.name} ${tool.version}${tool.build === undefined ? "" : ` (${tool.build})`}`,
  );
  return tools.length === 0 ? system : `${system}; ${tools.join(", ")}`;
}

function commandArgs(
  argv: readonly string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>["options"],
): ReturnType<typeof parseArgs>["values"] & { readonly positionals: string[] } {
  try {
    const parsed = parseArgs({ allowPositionals: true, args: argv, options, strict: true });
    return { ...parsed.values, positionals: parsed.positionals };
  } catch (error: unknown) {
    throw new UsageError(errorMessage(error));
  }
}

/**
 * why: Writes the export lines, and -- when there are none -- one line to stderr saying so.
 * Silence would be worse than it looks: the lease is committed and TTL-bound either way,
 * and a caller that was told neither its id nor that anything was missing can neither
 * renew nor release it, and has no scoping to reach the device with. stdout stays clean so
 * `eval "$(...)"` is unaffected. An older daemon, which sends no `environment` at all, is
 * the case that actually produces this.
 */
function writeExportEnv(
  environment: CliEnvironment,
  result: LeaseGrant & { readonly role: Role },
): void {
  environment.stdout.write(exportEnvLines(result.environment));
  if (Object.keys(result.environment).length > 0) return;
  environment.stderr.write(
    `simlock: lease ${result.lease.id} carries no environment, so there is nothing to export and the device may be unreachable from a bare simctl or adb. Release it with \`simlock release ${result.lease.id}\`.\n`,
  );
}

/**
 * why: Shell `export` lines for `eval "$(simlock lease ... --export-env)"`. Single quotes because
 * they are the only shell quoting that takes every byte literally, and `'\''` is the one way
 * to get a literal quote back inside them -- a device-set path is a user-configurable path
 * and may hold a space or an apostrophe. Sorted so repeated runs produce identical output.
 *
 * A key that is not a shell identifier fails the command rather than being skipped: the
 * driver that produced it is broken, and dropping it silently would leave the holder with
 * a lease it cannot reach and no idea why.
 */
function exportEnvLines(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!SHELL_IDENTIFIER.test(key)) {
        throw new Error(
          `Refusing to export ${JSON.stringify(key)}: a lease environment key must be a shell identifier, and this one would change what \`eval\` runs.`,
        );
      }
      return `export ${key}='${value.replaceAll("'", "'\\''")}'\n`;
    })
    .join("");
}

function requiredPositional(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined)
    throw new UsageError(withHelpHint(`Expected ${label}`));
  return positionals[0];
}

function readConfigValue(value: Record<string, unknown>, key: string): unknown {
  let current: unknown = value;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writeConfigValue(config: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split(".");
  if (segments.some((segment) => segment === ""))
    throw new UsageError(`Invalid config key: ${key}`);
  let target = config;
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1) as string] = value;
}

function parseConfigValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function readLogFile(filesystem: Filesystem, logPath: string): Promise<string> {
  const rotatedPath = `${logPath}.1`;
  const segments: string[] = [];
  if (await filesystem.exists(rotatedPath)) {
    segments.push(await filesystem.readFile(rotatedPath));
  }
  segments.push(await filesystem.readFile(logPath));
  return segments.join("");
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Daemon returned an invalid response");
  return value as Record<string, unknown>;
}

function writeResult(environment: CliEnvironment, value: unknown): void {
  environment.stdout.write(`${JSON.stringify(value)}\n`);
}

function roundHalfUp(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 0.5) / scale;
}

function formatLoadBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const mebibytes = Math.floor(bytes / 2 ** 20 + 0.5);
  if (mebibytes < 1024) return `${mebibytes} MiB`;
  return `${roundHalfUp(bytes / 2 ** 30, 1).toFixed(1)} GiB`;
}

function formatLoadCores(cores: number): string {
  if (cores < 0.005) return "<0.01";
  return String(roundHalfUp(cores, cores < 0.1 ? 2 : 1));
}

function formatLoadLine(
  load: Pick<NonNullable<StatusGetOutput["load"]>, "cpu" | "disk" | "memory">,
  ageSeconds: number,
): string {
  const { cpu, disk, memory } = load;
  const unread = (text: string): string[] => [text];
  const cpuPart =
    cpu === undefined
      ? unread("CPU unavailable")
      : [
          `CPU ${roundHalfUp(cpu.busyPercent, 0)}% busy (${formatLoadCores(cpu.cores)} ${
            cpu.cores === 1 ? "core" : "cores"
          }${cpu.limited ? ", limit" : ""})`,
        ];
  const memoryParts =
    memory === undefined
      ? unread("memory unavailable")
      : [
          `memory ${formatLoadBytes(memory.availableBytes)} of ${formatLoadBytes(memory.totalBytes)} available${memory.limited ? " (limit)" : ""}`,
          `swap ${formatLoadBytes(memory.swapUsedBytes)} used`,
          ...(memory.pressure === undefined ? [] : [`pressure ${memory.pressure}`]),
        ];
  const diskPart =
    disk === undefined
      ? unread("disk unavailable")
      : [`disk ${formatLoadBytes(disk.freeBytes)} of ${formatLoadBytes(disk.totalBytes)} free`];
  const age = `read ${String(ageSeconds)}s ago`;
  return `Load: ${[...cpuPart, ...memoryParts, ...diskPart, age].join(" · ")}`;
}

function loadLines(status: StatusGetOutput): string[] {
  return status.load === undefined
    ? []
    : [formatLoadLine(status.load, Math.ceil(status.load.ageMs / 1000))];
}

function consoleLines(daemon: StatusGetOutput["daemon"]): string[] {
  return daemon.consoleUrl === undefined ? [] : [`Console: ${daemon.consoleUrl}`];
}

// fallow-ignore-next-line complexity -- stable human status rendering is intentionally a single formatter.
function formatStatus(status: StatusGetOutput, now: number): string {
  const { capacity, daemon, devices, host, installs, leases, queueDepth, workers } = status;
  if (
    capacity === undefined ||
    devices === undefined ||
    leases === undefined ||
    queueDepth === undefined
  ) {
    return [
      `Daemon: ${daemon.health} (${daemon.mode})`,
      ...consoleLines(daemon),
      `Host: ${formatHost(host)}`,
      ...loadLines(status),
      "Devices, leases and capacity appear once startup finishes.",
    ].join("\n");
  }
  const globalLine = `Running global: ${capacity.global.running} + ${capacity.global.reserved} reserved/${capacity.global.maxRunning}, warm ${capacity.global.warm}${capacity.global.overLimit ? " (over limit)" : ""}`;
  const capacityLines = (["ios", "android"] as const).map((platform) => {
    const usage = capacity[platform];
    return `Capacity ${platform}: managed ${usage.used}/${usage.limit}, running ${usage.running} + ${usage.reserved} reserved/${usage.maxRunning}, warm ${usage.warm}${usage.overLimit ? " (over limit)" : ""}${usage.atRamBudget ? " (at RAM budget)" : ""}`;
  });
  const ramBudget = capacity.ramBudget;
  const ramLines =
    ramBudget === undefined
      ? []
      : [
          `RAM budget: ${formatGibibytes(ramBudget.usedBytes)}/${formatGibibytes(ramBudget.limitBytes)} used${ramBudget.overLimit ? " (over limit)" : ""}`,
        ];
  const workerLines =
    workers === undefined
      ? []
      : [formatWorkers(workers, { now }), ""].filter((line) => line !== "");
  const warmPoolLines =
    status.warmPool === undefined || daemon.mode === "gateway"
      ? []
      : formatWarmPool(status.warmPool);
  const deviceLines = devices.map((device) => {
    const markers = [
      device.foreignStateDetectedAt === undefined ? undefined : "foreign state change",
      device.foreignProvenanceDetectedAt === undefined ? undefined : "foreign provenance change",
      device.state === "quarantined" ? quarantineMarker(device) : undefined,
      device.transitionAgeMs === undefined
        ? undefined
        : `mid-transition ${device.transitionAgeMs}ms`,
      device.stalled === true ? "stalled" : undefined,
    ].filter((marker) => marker !== undefined);
    const suffix = markers.length === 0 ? "" : ` (${markers.join(", ")})`;
    const where = device.workerId === undefined ? "" : ` on ${device.workerId}`;
    return `Device ${device.id}${where}: ${stateLabel(device)}, ${deviceKind(device)}${suffix}`;
  });
  const leaseLines = leases.map(
    (lease) =>
      `Lease ${lease.id}: ${lease.requesterId}${lease.workerId === undefined ? "" : ` on ${lease.workerId}`} since ${lease.grantedAt}, last renewed ${lease.lastRenewedAt}`,
  );
  return [
    `Daemon: ${daemon.health} (${daemon.mode})`,
    ...consoleLines(daemon),
    `Host: ${formatHost(host)}`,
    ...loadLines(status),
    globalLine,
    ...capacityLines,
    ...ramLines,
    ...warmPoolLines,
    ...workerLines,
    ...deviceLines,
    ...leaseLines,
    ...(installs ?? []).map((install) => formatInstall(install, now)),
    `Queue depth: ${queueDepth}`,
  ].join("\n");
}

function stateLabel(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  return device.state === "absent" && device.absentReason !== undefined
    ? `absent (${device.absentReason})`
    : device.state;
}

function deviceKind(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  if (device.physical) return `physical ${String(device.class)}`;
  return `mode ${String(device.mode)}, serves default mode: ${device.servesDefaultMode ? "yes" : "no"}`;
}

function formatWarmPool(warmPool: NonNullable<StatusGetOutput["warmPool"]>): string[] {
  const { enabled, reserveRunning, targets } = warmPool;
  return [
    `warm pool: ${enabled ? "enabled" : "disabled"}, reserve ios ${reserveRunning.ios} android ${reserveRunning.android}`,
    ...targets.map((target) => {
      const name = [target.model, target.osVersion, target.mode]
        .filter((part) => part !== undefined)
        .join(" / ");
      const short = target.short === undefined ? "" : `  short: ${target.short}`;
      return `  ${name}   wanted ${target.count}  ready ${target.ready}  booting ${target.booting}${short}`;
    }),
  ];
}

function quarantineMarker(device: NonNullable<StatusGetOutput["devices"]>[number]): string {
  const attempts = device.quarantineAttempts ?? 0;
  const nextRetryAt =
    device.quarantineNextRetryAt === undefined
      ? ""
      : `, next retry at ${device.quarantineNextRetryAt}`;
  return `purge retry ${attempts}${nextRetryAt}`;
}

const DEVICE_CLASS_ORDER: readonly string[] = deviceClassSchema.options;

function formatCatalog(response: CatalogGetOutput): string {
  if (response.platforms.length === 0) return "No platforms available.";
  return response.platforms
    .map((entry) => {
      const defaultRuntime = entry.defaultRuntime ?? "(none)";
      const custom = new Set(entry.customModels ?? []);
      const modelLine = (model: string): string[] => {
        const paired =
          (Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined) ??
          [];
        const aliases =
          (Object.hasOwn(entry.modelAliases, model) ? entry.modelAliases[model] : undefined) ?? [];
        return [
          `      ${model}${custom.has(model) ? " (custom)" : ""}: ${paired.length > 0 ? paired.join(", ") : "(no paired runtime)"}`,
          ...(aliases.length > 0 ? [`        Other names: ${aliases.join(", ")}`] : []),
        ];
      };
      const classOf = (model: string): string | undefined =>
        Object.hasOwn(entry.modelClasses, model) ? entry.modelClasses[model] : undefined;
      const classLine = (deviceClass: string | undefined): string => {
        if (deviceClass === undefined) return "    (no class):";
        const model = Object.hasOwn(entry.classDefaults, deviceClass)
          ? entry.classDefaults[deviceClass as keyof typeof entry.classDefaults]
          : undefined;
        return `    ${deviceClass} (default: ${model ?? "none"}):`;
      };
      const models = [...DEVICE_CLASS_ORDER, undefined].flatMap((deviceClass) => {
        const members = entry.models.filter((model) => classOf(model) === deviceClass);
        return members.length === 0 ? [] : [classLine(deviceClass), ...members.flatMap(modelLine)];
      });
      const images = (entry.images ?? []).map(
        (image) => `    ${image.runtime} ${image.tag} ${image.abi}`,
      );
      return [
        `Platform: ${entry.platform}`,
        `  Runtimes: ${entry.runtimes.length > 0 ? entry.runtimes.join(", ") : "(none)"} (default: ${defaultRuntime})`,
        models.length > 0 ? "  Models:" : "  Models: (none)",
        ...models,
        ...(entry.images === undefined
          ? []
          : [images.length > 0 ? "  Images (runtime, tag, ABI):" : "  Images: (none)", ...images]),
      ].join("\n");
    })
    .join("\n");
}

interface TerminationWatch {
  readonly settled: Promise<void>;
  dispose(): void;
}

function waitForTermination(
  signals: Signals,
  parentWatch?: ParentWatch,
  parentPid?: number,
): TerminationWatch {
  let detach!: () => void;
  // why: Declared before `finish` closes over it: an adapter that reported an
  // already-dead parent synchronously from `watch()` would otherwise reach
  // this binding before its initialiser ran.
  let watchHandle: ParentWatchHandle | undefined;
  const settled = new Promise<void>((resolve) => {
    const finish = () => {
      detach();
      resolve();
    };
    detach = () => {
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      watchHandle?.stop();
    };
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
    watchHandle =
      parentWatch !== undefined && parentPid !== undefined && parentPid > 0
        ? parentWatch.watch(parentPid, finish)
        : undefined;
  });
  return { dispose: () => detach(), settled };
}

async function confirmTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompt.question(question)).trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}
function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
