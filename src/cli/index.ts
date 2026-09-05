import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig, type ConfigOverrides } from "../core/index.js";
import {
  IpcError,
  MemoryFilesystem,
  NodeDaemonLauncher,
  NodeFilesystem,
  NodeIpcTransport,
  NodeParentWatch,
  NodeSystemStats,
  resolveSimlockHome,
  SystemClock,
  type Clock,
  type DaemonLauncher,
  type Filesystem,
  type IpcConnection,
  type IpcConnector,
  type ParentWatch,
  type ParentWatchHandle,
  type SystemStats,
} from "../ports/index.js";
import { connectSimlockAdmin } from "../admin/index.js";
import {
  isSimlockError,
  type CatalogGetOutput,
  type DoctorReport,
  type LeaseGrant,
  type SimlockAdminClient,
  type StatusGetOutput,
} from "../admin/index.js";
import type { Role } from "../contract/index.js";
import type { PassthroughCommand } from "../client/index.js";
import { startLeaseRenewal } from "../lease-policy/index.js";
import { spawnPassthrough } from "./passthrough.js";
import { ERROR_TABLE } from "../contract/index.js";

const USAGE = `Usage: simlock <command> [options]

Commands:
  lease, release, status, list, catalog, cleanup, doctor, nuke, events,
  daemon, config, token
  simctl <args...>            Run xcrun simctl against Simlock's iOS device set
  adb <args...>               Run adb against Simlock's adb server
  mcp                         Start the stdio MCP server
Run 'simlock <command> --help' for command usage.

Pass --token <secret> anywhere on the command line to connect as admin
explicitly; see docs/CLI.md#admin-credential-resolution for the default
resolution order.`;

/**
 * Held mode ends with the lease already gone: the daemon released it without
 * the holder asking (a TTL backstop, an operator `release`, or a leased device
 * that could not be recovered). Distinct from 0, which means the holder ended
 * its own lease.
 */
const LEASE_LOST_EXIT_CODE = 14;

/**
 * A key that is safe to the left of `=` in a shell `export`. Anything else is a command
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

/**
 * Points a human at `--help` from inside the single structured stderr line,
 * for the two usage errors most likely to strand someone at a terminal: an
 * unrecognized command and a missing required argument. The full command
 * banner is no longer dumped to stderr on every failure; it is one flag away.
 */
function withHelpHint(message: string): string {
  return `${message} (run \`simlock --help\` for usage)`;
}

interface Output {
  write(value: string): unknown;
}

interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

type McpStdioRunner = () => Promise<void>;

/**
 * ADR 0003 §11: the CLI renders the contract, and nothing else. Every daemon-touching command
 * goes through `connectAdmin`/`connectExistingAdmin` -- both always hand back a
 * `SimlockAdminClient` (ADR §5: "the CLI connects as admin whenever the local file is
 * readable, falling back to an agent session ... when it is not"). Whether the connection
 * actually *is* admin is entirely the daemon's call (`client.role`); an unauthenticated
 * connection still gets an admin-shaped client back, and simply gets `FORBIDDEN` from the
 * daemon on any operation that requires more than agent. This is what lets `lease`/`release`
 * (agent-role operations) and `list`/`cleanup`/`nuke`/`token`/... (admin-role operations) share
 * one connection helper instead of two.
 */
export interface CliEnvironment {
  /**
   * The `Clock` port (architecture rule 9). Held mode's renew timer runs on it, so a test can
   * drive the cadence by hand instead of waiting out a real TTL.
   */
  readonly clock: Clock;
  readonly configPath: string;
  /** ADR §4's requester default and this connection's fixed principal -- see §9's
   * "SIMLOCK_AGENT_ID and --agent-id still set the requester id ... they are not the
   * principal": `--agent-id` overrides `lease.request`'s `requesterId` field, never this. */
  readonly requesterId: string;
  readonly now?: () => number;
  /**
   * Connects (auto-launching the daemon if it is not already running) and completes `hello`
   * with whatever `resolveCredential` resolves to.
   *
   * `resolveCredential` is called only *after* the raw connection is established -- which is
   * also where auto-launch happens (ADR §5: "written atomically after the socket claim
   * succeeds"). A caller resolving the local `admin.token` file before the connection exists
   * (the pre-fix bug: B2) races the whole daemon spawn instead of just the narrow
   * claim-to-persist window the file-retry loop is meant for. See `readAdminTokenFileWithRetry`.
   */
  readonly connectAdmin: (
    resolveCredential: () => Promise<string | undefined>,
    options?: { readonly heartbeat?: boolean },
  ) => Promise<SimlockAdminClient>;
  /** Same as `connectAdmin` but never auto-launches -- `daemon stop`/`daemon status` must not
   * start a daemon just to ask whether one is running. */
  readonly connectExistingAdmin: (
    resolveCredential: () => Promise<string | undefined>,
    options?: { readonly heartbeat?: boolean },
  ) => Promise<SimlockAdminClient>;
  /** `SIMLOCK_ADMIN_TOKEN`, ADR §5's second resolution source. */
  readonly adminTokenFromEnv?: string;
  /** One read attempt at the local `admin.token` file, ADR §5's third resolution source.
   * `undefined` for "missing, unreadable, or empty" -- callers retry, not this. */
  readonly readAdminTokenFile: () => Promise<string | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
  /** `config set` (ADR §11 part D): validates the merged file through the config loader before
   * `writeConfigFile` is ever called. Throws (any error) for an invalid merged config. */
  readonly validateConfig: (merged: Record<string, unknown>) => Promise<void>;
  readonly readLogFile?: () => Promise<string>;
  /** Loads the MCP frontend only when the `mcp` command is dispatched. */
  readonly loadMcpStdio?: () => Promise<McpStdioRunner>;
  readonly runMcpStdio?: () => Promise<void>;
  readonly signals: Signals;
  /** The pid `lease` held mode watches by default -- the parent captured at CLI startup. */
  readonly parentPid?: number;
  readonly parentWatch?: ParentWatch;
  readonly stderr: Output;
  readonly stdout: Output;
  /** `| undefined` explicitly: under `exactOptionalPropertyTypes` that is what lets a caller
   * (and a test) say "there is no terminal to ask" rather than merely omitting the field. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /**
   * Runs a daemon-resolved passthrough command and resolves with its exit code. A hook
   * rather than a direct spawn so the `simctl` / `adb` wrappers are testable without a
   * child process, the same way every other external effect here is injected.
   */
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
}

/**
 * Resolves the fallback requester identity from the environment: `SIMLOCK_AGENT_ID`
 * when set, else a pid-derived value so callers that never configure a stable id
 * keep today's behavior. The per-invocation `--agent-id` flag on `lease` (parsed at
 * that command's own boundary) takes precedence over this default.
 */
export function fallbackRequesterId(env: NodeJS.ProcessEnv): string {
  return env.SIMLOCK_AGENT_ID ?? String(process.pid);
}

/**
 * ADR §5: "a daemon still writing the file" is a real race between the daemon claiming its
 * socket (reachable) and `admin.token` landing on disk (`DaemonServer#start` awaits the socket
 * claim, *then* `adminSecret.persist()`). A CLI invocation that races a fresh `daemon start`
 * retries a few times, briefly, rather than either blocking indefinitely or giving up on the
 * first empty read. This only ever runs *after* the connection is already established (see
 * `connectAdmin`'s doc) -- so the race it covers is the narrow claim-to-persist window, not the
 * whole daemon spawn.
 */
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

/** Where a resolved admin credential came from -- distinguishes an explicit-but-wrong
 * credential (flag/env) from a stale local file (B1) for the fallback notice, and "none" for
 * "every source came up empty" (unchanged from before). */
type CredentialSource = "flag" | "env" | "file" | "none";

function isAdminAuthFailure(error: unknown): boolean {
  return isSimlockError(error) && error.code === "ADMIN_AUTHENTICATION_FAILED";
}

/** ADR §5's fallback: "an agent session with a stderr notice." B1 extends this to a credential
 * the daemon actively rejected (not just one that was never found), and calls out a stale
 * `admin.token` by name -- the actionable case a generic notice would otherwise bury. */
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

/**
 * The one connection helper every daemon-touching command uses (ADR §5's "the CLI is the
 * operator interface").
 *
 * ADR §5's resolution order -- `--token`, then `SIMLOCK_ADMIN_TOKEN`, then the local
 * `admin.token` file (briefly retried, see `readAdminTokenFileWithRetry`) -- is implemented as
 * a resolver passed to `connectAdmin`/`connectExistingAdmin`, not resolved up front: the file
 * source must not be read until the connection (and any auto-launch it triggers) has already
 * settled (B2), since the daemon only writes it after claiming its socket.
 *
 * B1: a credential the daemon actively rejects (`ADMIN_AUTHENTICATION_FAILED` -- most commonly
 * a stale `admin.token` left behind by an unclean shutdown) degrades to a fresh agent-role
 * connection with a stderr notice, exactly like "no credential found" does, instead of failing
 * the whole invocation. Retried at most once, and only when a credential was actually offered --
 * an agent connection legitimately failing `hello` for an unrelated reason still propagates.
 */
async function connectDaemonClient(
  environment: CliEnvironment,
  tokenFlag: string | undefined,
  options: { readonly launch?: boolean; readonly heartbeat?: boolean } = {},
): Promise<SimlockAdminClient> {
  const connect =
    options.launch === false ? environment.connectExistingAdmin : environment.connectAdmin;
  const connectOptions = options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat };

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
    const client = await connect(resolveCredential, connectOptions);
    if (source === "none") writeAgentFallbackNotice(environment, "none");
    return client;
  } catch (error: unknown) {
    if (!isAdminAuthFailure(error) || source === "none") throw error;
    writeAgentFallbackNotice(environment, source);
    return connect(async () => undefined, connectOptions);
  }
}

/** Auto-launches the daemon on a refused/missing socket, at the raw `IpcConnector` level:
 * `simlock/admin`'s `connector` option accepts any `IpcConnector`, so this is the entire seam
 * needed to keep `lease`'s "start the daemon if it isn't running" behaviour with a typed client
 * that deliberately does no starting of its own (ADR §10). MCP has its own copy in
 * `src/mcp/connect.ts`; the two differ in launch policy and are kept separate on purpose. */
class AutoLaunchIpcConnector implements IpcConnector {
  constructor(
    private readonly ipc: IpcConnector,
    private readonly clock: Clock,
    private readonly launcher: DaemonLauncher,
  ) {}

  async connect(endpoint: string): Promise<IpcConnection> {
    try {
      return await this.ipc.connect(endpoint);
    } catch (error: unknown) {
      if (!isUnavailable(error)) throw error;
    }
    await this.launcher.launch();
    const deadline = this.clock.now() + 5_000;
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
    throw new Error(`Timed out starting simlock daemon: ${errorMessage(lastError)}`);
  }
}

/** True only for "nothing is listening yet" -- a refused/missing socket -- never for a `hello`
 * rejection (ADR §6: the client never restarts the daemon on mismatch). */
function isUnavailable(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "connection-refused" || error.code === "endpoint-not-found")
  );
}

/** The infrastructure `defaultCliEnvironment` wires up. Factored out so tests can build the
 * exact same environment logic (credential-resolution ordering, `config set` validation)
 * against in-memory ports instead of the real filesystem/socket/subprocess -- see
 * `src/cli/index.test.ts`'s cold-start and stale-token suites. */
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
  /** `| undefined` explicitly: under `exactOptionalPropertyTypes` that is what lets a caller
   * (and a test) say "there is no terminal to ask" rather than merely omitting the field. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** Injected so the `simctl` / `adb` wrappers are testable without spawning a child. */
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly parentPid?: number;
}

/**
 * Builds a `CliEnvironment` from an explicit set of ports (see `CliEnvironmentPorts`) plus the
 * bits still read straight from `env`/`process` (the requester id default, `SIMLOCK_ADMIN_TOKEN`,
 * `process.ppid`). `defaultCliEnvironment` is this with real Node ports; tests call it directly
 * with in-memory ones.
 */
export function buildCliEnvironment(
  ports: CliEnvironmentPorts,
  env: NodeJS.ProcessEnv = process.env,
): CliEnvironment {
  const { clock, dataDirectory, filesystem, ipc, launcher, systemStats } = ports;
  const socketPath = join(dataDirectory, "daemon.sock");
  const configPath = join(dataDirectory, "config.json");
  const logPath = join(dataDirectory, "daemon.log");
  const adminTokenPath = join(dataDirectory, "admin.token");
  const requesterId = fallbackRequesterId(env);
  const autoLaunchIpc = new AutoLaunchIpcConnector(ipc, clock, launcher);

  // ADR §5 / B2: the raw connection (and, for `connectAdmin`, any auto-launch it triggers) is
  // established *before* `resolveCredential` is ever called -- `admin.token` is written only
  // after the daemon claims its socket, so reading it any earlier races the whole daemon spawn
  // instead of the narrow claim-to-persist window `readAdminTokenFileWithRetry` covers.
  const connect = async (
    connector: IpcConnector,
    resolveCredential: () => Promise<string | undefined>,
    options?: { readonly heartbeat?: boolean },
  ): Promise<SimlockAdminClient> => {
    const connection = await connector.connect(socketPath);
    const credential = await resolveCredential();
    return connectSimlockAdmin({
      connection,
      principal: requesterId,
      ...(credential === undefined ? {} : { credential }),
      ...(options?.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
    });
  };

  return {
    clock,
    configPath,
    requesterId,
    now: () => clock.now(),
    connectAdmin: (resolveCredential, options) =>
      connect(autoLaunchIpc, resolveCredential, options),
    connectExistingAdmin: (resolveCredential, options) => connect(ipc, resolveCredential, options),
    ...(env.SIMLOCK_ADMIN_TOKEN === undefined
      ? {}
      : { adminTokenFromEnv: env.SIMLOCK_ADMIN_TOKEN }),
    readAdminTokenFile: () => readAdminTokenFile(filesystem, adminTokenPath),
    sleep: (milliseconds) => new Promise<void>((resolve) => clock.setTimer(milliseconds, resolve)),
    // Captured once at process startup, before anything can reparent this
    // process -- `--bind-pid` overrides it per invocation.
    parentPid: ports.parentPid ?? process.ppid,
    parentWatch: ports.parentWatch ?? new NodeParentWatch(),
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    runPassthrough: ports.runPassthrough ?? spawnPassthrough,
    writeConfigFile: async (contents) => {
      await filesystem.mkdirp(dataDirectory);
      await filesystem.writeFileAtomic(configPath, `${JSON.stringify(contents, null, 2)}\n`);
    },
    // ADR §11 part D: "validates the merged file through the config loader before writing."
    // B9: two things the pre-fix version got wrong --
    //  - `warn` was never passed, so `validateConfigLayer`'s default no-op silently dropped
    //    unknown/mistyped keys instead of rejecting them. Collected here and thrown when any
    //    "Unknown config key" warning fires -- but not for a legacy-spelling warning (still
    //    valid config, just deprecated), so a legitimate legacy `config set` keeps working.
    //  - `configPath` pointed at a sentinel file inside the *real* data directory, which a
    //    stray file there could turn into a false pass or fail, despite the comment's claim
    //    that the path was "never read" -- `loadConfig`'s `readConfigFile` does read it when it
    //    exists. A fresh `MemoryFilesystem` makes that literally true: nothing can ever exist
    //    at this path.
    validateConfig: async (merged) => {
      const unknownKeyWarnings: string[] = [];
      await loadConfig({
        configPath: "/config-set-validation.json",
        filesystem: new MemoryFilesystem(),
        overrides: merged as ConfigOverrides,
        systemStats,
        warn: (message) => {
          if (message.startsWith("Unknown config key:")) unknownKeyWarnings.push(message);
        },
      });
      if (unknownKeyWarnings.length > 0) throw new Error(unknownKeyWarnings.join("; "));
    },
    readLogFile: async () => readLogFile(filesystem, logPath),
    signals: ports.signals ?? process,
    stderr: ports.stderr ?? process.stderr,
    stdout: ports.stdout ?? process.stdout,
    confirm: ports.confirm ?? confirmTerminal,
  };
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

/** `--token <secret>` is a global flag (ADR §5's first credential source), recognized anywhere
 * on the command line rather than per-command, since almost every command can use it. Stripped
 * before the remaining argv reaches that command's own `parseArgs` call. */
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
      case "simctl":
      case "adb":
        // Named here rather than discovered from the drivers on purpose: these are
        // user-facing command names published in `docs/CLI.md`, and the CLI never builds a
        // simctl or adb argument -- it forwards the name and spawns whatever the daemon
        // hands back, so which flags scope the tool and which verbs it refuses still live
        // entirely in the driver (architecture rule 2 is about knowledge, not about names).
        // Every argument after the tool name is the tool's, verbatim -- including `--help`,
        // which belongs to `simctl`/`adb` and not to Simlock. `simlock --help` lists these.
        return await runPassthrough(rest[0] ?? "", rest.slice(1), environment, token);
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

/**
 * Every CLI failure writes exactly one structured line to stderr so agents
 * can branch on `error.code` instead of parsing prose. `code` is the
 * daemon's own error code where the failure came from the daemon, and a
 * stable CLI-level code otherwise (`USAGE` for bad flags/arguments,
 * `INTERNAL` for anything unexpected).
 */
function writeError(environment: CliEnvironment, error: unknown): void {
  environment.stderr.write(
    `${JSON.stringify({ error: { code: cliErrorCode(error), message: errorMessage(error) } })}\n`,
  );
}

function cliErrorCode(error: unknown): string {
  if (error instanceof UsageError) return "USAGE";
  if (isSimlockError(error)) return error.code;
  return "INTERNAL";
}

/**
 * Asks the daemon which command reaches Simlock's devices for this tool, then runs it here.
 * The split is architecture rule 8 in one function: the daemon owns the scoping (it is the
 * process that knows which root and which adb port), and the CLI owns the terminal, so an
 * interactive `adb shell` gets a tty and its exit code travels back to the caller's shell.
 */
async function runPassthrough(
  tool: string,
  args: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const run = environment.runPassthrough;
  if (run === undefined) throw new Error("Tool passthrough is unavailable");
  const client = await connectDaemonClient(environment, token);
  let command;
  try {
    command = await client.resolvePassthrough({ args: [...args], tool });
  } catch (error: unknown) {
    // A verb the driver refuses is the caller getting it wrong, not a daemon fault, so it
    // surfaces as usage rather than as an internal error.
    if (isSimlockError(error) && error.code === "PASSTHROUGH_REFUSED") {
      throw new UsageError(error.message);
    }
    throw error;
  } finally {
    // Resolved before the command runs, so an interactive `adb shell` does not hold a daemon
    // connection open for its whole session.
    await client.close();
  }
  return run(command);
}

/** ADR §7: "CLI exit codes and HTTP status codes are columns of the same error table, not
 * second mappings" -- driven from `ERROR_TABLE`'s `cliExitCode` column rather than a second,
 * CLI-maintained map. */
export function errorExitCode(error: unknown): number {
  if (error instanceof UsageError) return 2;
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

/** Parses user-facing durations only at the CLI boundary. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (match === null) throw new UsageError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new UsageError(`Invalid duration: ${value}`);
  return milliseconds;
}

/** Parses `--bind-pid` only at the CLI boundary. `undefined` input means the flag was not given. */
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
    detach: { type: "boolean" },
    device: { type: "string" },
    "export-env": { type: "boolean" },
    full: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "no-wait": { type: "boolean" },
    os: { type: "string" },
    platform: { type: "string" },
    timeout: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock lease --platform <ios|android> --device <model> [--os <version>]\n" +
        "                     [--agent-id <id>] [--timeout <duration>] [--no-wait] [--detach]\n" +
        "                     [--allow-download] [--full] [--export-env] [--bind-pid <pid>]\n",
    );
    return 0;
  }
  if (values.platform !== "ios" && values.platform !== "android")
    throw new UsageError(withHelpHint("lease requires --platform <ios|android>"));
  const platform = values.platform as "ios" | "android";
  if (typeof values.device !== "string" || values.device === "")
    throw new UsageError(withHelpHint("lease requires --device <model>"));
  if (values["agent-id"] === "") throw new UsageError("lease --agent-id must not be empty");
  const requesterId = (values["agent-id"] as string | undefined) ?? environment.requesterId;
  const detached = values.detach ?? false;
  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined;
  // Held mode watches its parent so a crashed agent's backgrounded holder
  // self-terminates instead of surviving reparenting (docs/known-pitfalls.md).
  // `--bind-pid` overrides which pid that is, for a holder spawned from a
  // short-lived subshell whose immediate parent dies before the agent does.
  const bindPid = parseBindPid(values["bind-pid"]);
  const watchedPid = bindPid ?? environment.parentPid;
  const termination = detached
    ? undefined
    : waitForTermination(environment.signals, environment.parentWatch, watchedPid);

  // ADR 0004 §2/§4: held mode is a client policy now -- this process renews on its own timer
  // (below) instead of ponging the daemon's push, so neither mode declares the heartbeat
  // capability any more. The daemon still has the push, and still slides a lease for any
  // connection that asks for it; this one no longer asks.
  const client = await connectDaemonClient(environment, token, { heartbeat: false });
  // Set once the daemon says this connection's lease ended without us asking. ADR 0003 §8:
  // lease-scoped pushes go to every live connection sharing the lease's owner, in either mode
  // -- filtered below against this connection's own granted lease id, the same way the
  // pre-typed-client CLI did, since a second CLI invocation sharing this principal (e.g. a
  // detached lease from an earlier `--detach`) can otherwise deliver a push for a lease this
  // process never held.
  let leaseLost = false;
  let ourLeaseId: string | undefined;
  let notifyLeaseLost: (() => void) | undefined;
  const leaseLostSignal = new Promise<void>((resolve) => {
    notifyLeaseLost = resolve;
  });
  const offLeaseLost = client.onLeaseLost((push) => {
    if (push.leaseId !== ourLeaseId) return;
    environment.stderr.write(`${JSON.stringify({ push: "lease-lost", ...push })}\n`);
    leaseLost = true;
    notifyLeaseLost?.();
  });
  const offUnhealthy = client.onDeviceUnhealthy((push) => {
    environment.stderr.write(`${JSON.stringify({ push: "device-unhealthy", ...push })}\n`);
  });
  const offRecovered = client.onDeviceRecovered((push) => {
    environment.stderr.write(`${JSON.stringify({ push: "device-recovered", ...push })}\n`);
  });
  try {
    const grant = await client.requestLease(
      {
        allowDownload: values["allow-download"] === true,
        mode: detached ? "detached" : "held",
        noWait: values["no-wait"] === true,
        requesterId,
        model: values.device,
        ...(typeof values.os === "string" ? { osVersion: values.os } : {}),
        platform,
        ...(values.full === true ? { full: true } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      {
        onProgress: (progress) => {
          environment.stderr.write(`${JSON.stringify({ push: "progress", ...progress })}\n`);
        },
      },
    );
    ourLeaseId = grant.lease.id;
    // ADR §5: "simlock lease output includes the resolved role" -- the one field this CLI
    // adds on top of the contract's `LeaseGrant` shape, everything else passed through as-is.
    const result = { ...grant, role: client.role };
    // Held mode still holds after this line, whichever shape it took: `--export-env` only
    // changes what stdout carries, never how long the lease lives.
    if (values["export-env"] === true) writeExportEnv(environment, result);
    else writeResult(environment, result);
    if (detached || termination === undefined) return 0;
    // ADR 0004 §2: what a held holder does while alive is renew on a timer at a third of the
    // TTL -- computed from the deadline the daemon just returned, not from a config value this
    // process does not have. `--detach` returned above: it stays exactly as it was, printing
    // and exiting with no timer at all.
    const renewal = startLeaseRenewal({
      clock: environment.clock,
      leaseId: grant.lease.id,
      ttlDeadline: grant.lease.ttlDeadline,
      renew: (leaseId) => client.renewLease({ leaseId }),
      // A renewal that fails has ended this holder's claim (see `startLeaseRenewal`); it is
      // diagnostic output, on the same structured stderr channel as a failed release, and it
      // does not by itself end the process -- the lease-lost push or the daemon's own expiry
      // is what decides that.
      onError: (error) => writeError(environment, error),
    });
    try {
      await Promise.race([termination.settled, leaseLostSignal]);
    } finally {
      // Before the release below, and before any early return: a renew must never race the
      // release of the lease it is renewing.
      renewal.stop();
    }
    if (leaseLost) {
      // The daemon already released it; asking again would only raise UNKNOWN_LEASE.
      return LEASE_LOST_EXIT_CODE;
    }
    try {
      // ADR 0004 §2/§3: the release a held holder owes on exit, parent death, or a catchable
      // signal is this call -- not the socket closing in the `finally` below. The daemon still
      // releases on close today (PR B removes that), so this is the path that will still be
      // here when nothing else is.
      await client.releaseLease({ leaseId: grant.lease.id });
    } catch (error: unknown) {
      // Non-fatal: the process still exits 0 after a signal, but the release
      // failure is still diagnostic output, so it stays a structured stderr
      // line rather than reverting to prose.
      writeError(environment, error);
    }
    return 0;
  } finally {
    termination?.dispose();
    offLeaseLost();
    offUnhealthy();
    offRecovered();
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
    else environment.stdout.write(`${formatStatus(status)}\n`);
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
    rules: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock list [--devices|--leases|--rules]\n");
    return 0;
  }
  if ([values.devices, values.leases, values.rules].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, or --rules");
  const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(environment, await client.list({ kind }));
    return 0;
  } finally {
    await client.close();
  }
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
    // Destructive, so it confirms exactly as `release --all` and `nuke` do (safety rule 5),
    // and a missing confirm hook refuses rather than proceeds: a non-interactive caller
    // that meant it says `--yes`.
    const confirmed =
      values.yes ?? (await environment.confirm?.("Destroy every orphaned device? [y/N] "));
    if (!confirmed) throw new UsageError("doctor --purge-orphans requires confirmation or --yes");
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const response = await client.runDoctor({ fix: values.fix === true, purgeOrphans });
    writeDriverAdvisoryWarnings(environment, response);
    writeResult(environment, response);
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * `driver-advisory` findings (`src/core/doctor.ts`) are configuration-level information, not
 * drift -- `--fix` never acts on them (see `Doctor#applySafeFixes`). Surfaced as plain warning
 * lines on stderr, distinct from every drift-finding kind, so a human running `doctor`
 * interactively notices them without having to parse the JSON report; stdout keeps carrying
 * every finding kind unmodified via `writeResult`, matching the JSON-passthrough convention
 * `list`/`cleanup`/`nuke` already use, so a scripted consumer of stdout sees no behavior change.
 */
function writeDriverAdvisoryWarnings(environment: CliEnvironment, report: DoctorReport): void {
  for (const finding of report.findings) {
    if (finding.kind !== "driver-advisory") continue;
    environment.stderr.write(`Warning [${finding.platform}] ${finding.code}: ${finding.message}\n`);
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
  const client = await connectDaemonClient(environment, token);
  try {
    const sinceTs =
      typeof values.since === "string"
        ? (environment.now ?? Date.now)() - parseDuration(values.since)
        : undefined;
    for (const event of await client.replayEvents(sinceTs === undefined ? {} : { sinceTs })) {
      writeResult(environment, event);
    }
    if (values.follow) {
      const unsubscribe = await client.subscribeEvents((event) => writeResult(environment, event));
      await waitForTermination(environment.signals).settled;
      await unsubscribe();
    }
    return 0;
  } finally {
    await client.close();
  }
}

// fallow-ignore-next-line complexity -- daemon subcommand parsing is a single CLI boundary.
async function runDaemon(
  argv: readonly string[],
  environment: CliEnvironment,
  token: string | undefined,
): Promise<number> {
  const command = argv[0];
  const values = commandArgs(argv.slice(1), {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (command === undefined || isHelp(command) || values.help) {
    environment.stdout.write("Usage: simlock daemon <start|stop|status|logs>\n");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (command === "start") {
    const client = await connectDaemonClient(environment, token, { launch: true });
    try {
      await client.getStatus();
    } finally {
      await client.close();
    }
    if (values.json) writeResult(environment, { status: "running" });
    else environment.stdout.write("Daemon running\n");
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
        else environment.stdout.write(`${formatStatus(status)}\n`);
      } finally {
        await client.close();
      }
      return 0;
    } catch (error: unknown) {
      // ADR §11: distinguish socket-absent from handshake-refused using the error `kind`,
      // instead of reporting "stopped" on any error. A `SimlockError` whose `kind` is not
      // `"transport"` means the socket was reachable and a daemon answered, but the
      // connection was refused at or after `hello` (bad credential, version mismatch, ...);
      // anything else (a raw `IpcError`, or a `transport`-kind `SimlockError` such as
      // `DAEMON_CONNECTION_LOST`) means nothing is listening -- the pre-existing "stopped"
      // outcome.
      if (isSimlockError(error) && error.kind !== "transport") {
        if (values.json) {
          writeResult(environment, {
            status: "handshake-refused",
            error: { code: error.code, message: error.message },
          });
        } else {
          environment.stdout.write(`Daemon handshake refused: ${error.code}: ${error.message}\n`);
        }
        return 1;
      }
      if (values.json) writeResult(environment, { status: "stopped" });
      else environment.stdout.write("Daemon stopped\n");
      return 0;
    }
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
    // ADR §11 part D: "config set stays a file write ... but validates the merged file through
    // the config loader before writing." Any failure here is bad input, same class as a bad
    // flag -- surfaced as a usage error (exit 2) rather than a new CLI-level error code.
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
      "Usage: simlock token create --role <agent|operator> [--label <text>]\n" +
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
      "Usage: simlock token create --role <agent|operator> [--label <text>]\n",
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

function parseTokenRole(value: unknown): "agent" | "operator" {
  if (value !== "agent" && value !== "operator")
    throw new UsageError(withHelpHint("token create requires --role <agent|operator>"));
  return value;
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
 * Writes the export lines, and -- when there are none -- one line to stderr saying so.
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
 * Shell `export` lines for `eval "$(simlock lease ... --export-env)"`. Single quotes because
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

/**
 * Reads the rotated generation (if present) followed by the current log, so a fatal
 * crash written just before rotation is never silently lost. `NodeFileLogSink` keeps
 * at most one rotated generation at `<logPath>.1`.
 */
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

// fallow-ignore-next-line complexity -- stable human status rendering is intentionally a single formatter.
function formatStatus(status: StatusGetOutput): string {
  const { capacity, devices, health, leases, queueDepth } = status;
  const globalLine = `Running global: ${capacity.global.running} + ${capacity.global.reserved} reserved/${capacity.global.maxRunning}, warm ${capacity.global.warm}${capacity.global.overLimit ? " (over limit)" : ""}`;
  const capacityLines = (["ios", "android"] as const).map((platform) => {
    const usage = capacity[platform];
    return `Capacity ${platform}: managed ${usage.used}/${usage.limit}, running ${usage.running} + ${usage.reserved} reserved/${usage.maxRunning}, warm ${usage.warm}${usage.overLimit ? " (over limit)" : ""}`;
  });
  const deviceLines = devices.map((device) => {
    const markers = [
      device.foreignStateDetectedAt === undefined ? undefined : "foreign state change",
      device.foreignProvenanceDetectedAt === undefined ? undefined : "foreign provenance change",
      device.state === "quarantined" ? quarantineMarker(device) : undefined,
      device.transitionAgeMs === undefined
        ? undefined
        : `mid-transition ${device.transitionAgeMs}ms`,
    ].filter((marker) => marker !== undefined);
    const suffix = markers.length === 0 ? "" : ` (${markers.join(", ")})`;
    return `Device ${device.id}: ${device.state}${suffix}`;
  });
  const leaseLines = leases.map((lease) => {
    const heartbeatSuffix =
      lease.lastHeartbeatAt === undefined ? "" : `, last heartbeat ${lease.lastHeartbeatAt}`;
    return `Lease ${lease.id}: ${lease.requesterId} since ${lease.grantedAt}${heartbeatSuffix}`;
  });
  return [
    `Daemon: ${health}`,
    globalLine,
    ...capacityLines,
    ...deviceLines,
    ...leaseLines,
    `Queue depth: ${queueDepth}`,
  ].join("\n");
}

/** Surfaces retry progress for a quarantined device instead of leaving it as a bare state name. */
function quarantineMarker(device: StatusGetOutput["devices"][number]): string {
  const attempts = device.quarantineAttempts ?? 0;
  const nextRetryAt =
    device.quarantineNextRetryAt === undefined
      ? ""
      : `, next retry at ${device.quarantineNextRetryAt}`;
  return `purge retry ${attempts}${nextRetryAt}`;
}

function formatCatalog(response: CatalogGetOutput): string {
  if (response.platforms.length === 0) return "No platforms available.";
  return response.platforms
    .map((entry) => {
      const defaultRuntime = entry.defaultRuntime ?? "(none)";
      return [
        `Platform: ${entry.platform}`,
        `  Models: ${entry.models.length > 0 ? entry.models.join(", ") : "(none)"}`,
        `  Runtimes: ${entry.runtimes.length > 0 ? entry.runtimes.join(", ") : "(none)"} (default: ${defaultRuntime})`,
      ].join("\n");
    })
    .join("\n");
}

/**
 * Resolves on SIGINT, SIGTERM, or (when `parentWatch`/`parentPid` are given)
 * the watched parent dying -- all three converge on the same `finish`, so a
 * dead parent is handled through the exact release-then-exit path in
 * `runLease` that a signal already takes, not a second shutdown path.
 * `parentPid` is skipped when unset or non-positive: nothing meaningful to
 * watch (e.g. an already-reparented process at startup) degrades to today's
 * signal-only behavior rather than failing to start.
 *
 * A registered signal listener keeps Node's event loop alive on its own, and so
 * does a pending parent poll, so any path that stops waiting *without* a signal
 * arriving -- the daemon taking the lease back -- has to detach both itself,
 * otherwise the CLI finishes its work, sets an exit code, and then hangs with
 * nothing left to do. Hence the disposer.
 */
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
  // Declared before `finish` closes over it: an adapter that reported an
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
