import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  NodeDaemonLauncher,
  NodeFilesystem,
  NodeIpcTransport,
  SystemClock,
  type Filesystem,
} from "../ports/index.js";
import { connectDaemon, connectExistingDaemon } from "../daemon-client/client.js";
import { parseRawLeaseGrant } from "../daemon-client/contracts.js";
import { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";

export { DaemonClientError, type DaemonConnection } from "../daemon-client/protocol.js";

const USAGE = `Usage: pitlane <command> [options]

Commands:
  lease, release, status, list, catalog, cleanup, doctor, nuke, events,
  daemon, config
  mcp                         Start the stdio MCP server
Run 'pitlane <command> --help' for command usage.`;

const DAEMON_ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  BAD_FRAME: 2,
  BAD_REQUEST: 2,
  NO_CAPACITY: 11,
  NO_DRIVER: 12,
  QUEUE_TIMEOUT: 10,
  REQUESTER_ALREADY_LEASED: 13,
  RUNTIME_MISSING: 12,
  UNKNOWN_MODEL: 12,
};

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
  return `${message} (run \`pitlane --help\` for usage)`;
}

interface Output {
  write(value: string): unknown;
}

interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

type McpStdioRunner = () => Promise<void>;

export interface CliEnvironment {
  readonly configPath: string;
  readonly connect: () => Promise<DaemonConnection>;
  readonly connectExisting?: () => Promise<DaemonConnection>;
  readonly now?: () => number;
  readonly requesterId: string;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly readLogFile?: () => Promise<string>;
  /** Loads the MCP frontend only when the `mcp` command is dispatched. */
  readonly loadMcpStdio?: () => Promise<McpStdioRunner>;
  readonly runMcpStdio?: () => Promise<void>;
  readonly signals: Signals;
  readonly stderr: Output;
  readonly stdout: Output;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
}

/**
 * Resolves the fallback requester identity from the environment: `PITLANE_AGENT_ID`
 * when set, else a pid-derived value so callers that never configure a stable id
 * keep today's behavior. The per-invocation `--agent-id` flag on `lease` (parsed at
 * that command's own boundary) takes precedence over this default.
 */
export function fallbackRequesterId(env: NodeJS.ProcessEnv): string {
  return env.PITLANE_AGENT_ID ?? String(process.pid);
}

function defaultCliEnvironment(env: NodeJS.ProcessEnv = process.env): CliEnvironment {
  const dataDirectory = join(homedir(), ".pitlane");
  const filesystem = new NodeFilesystem();
  const clock = new SystemClock();
  const ipc = new NodeIpcTransport();
  const socketPath = join(dataDirectory, "daemon.sock");
  const configPath = join(dataDirectory, "config.json");
  const logPath = join(dataDirectory, "daemon.log");
  return {
    configPath,
    connect: () =>
      connectDaemon({
        clock,
        ipc,
        launcher: new NodeDaemonLauncher({
          args: [join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js")],
          command: process.execPath,
          logPath,
        }),
        socketPath,
      }),
    connectExisting: () => connectExistingDaemon(socketPath, ipc),
    now: () => clock.now(),
    requesterId: fallbackRequesterId(env),
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    readLogFile: async () => readLogFile(filesystem, logPath),
    signals: process,
    stderr: process.stderr,
    stdout: process.stdout,
    confirm: confirmTerminal,
    writeConfigFile: async (contents) => {
      await filesystem.mkdirp(dataDirectory);
      await filesystem.writeFileAtomic(configPath, `${JSON.stringify(contents, null, 2)}\n`);
    },
  };
}

async function loadDefaultMcpStdio(): Promise<McpStdioRunner> {
  return (await import("../mcp/main.js")).runMcpStdio;
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
    switch (argv[0]) {
      case "lease":
        return await runLease(argv.slice(1), environment);
      case "release":
        return await runRelease(argv.slice(1), environment);
      case "status":
        return await runStatus(argv.slice(1), environment);
      case "list":
        return await runList(argv.slice(1), environment);
      case "catalog":
        return await runCatalog(argv.slice(1), environment);
      case "cleanup":
        return await runCleanup(argv.slice(1), environment);
      case "doctor":
        return await runDoctor(argv.slice(1), environment);
      case "nuke":
        return await runNuke(argv.slice(1), environment);
      case "events":
        return await runEvents(argv.slice(1), environment);
      case "daemon":
        return await runDaemon(argv.slice(1), environment);
      case "config":
        return await runConfig(argv.slice(1), environment);
      case "mcp":
        return await runMcp(argv.slice(1), environment);
      default:
        throw new UsageError(withHelpHint(`Unknown command: ${argv[0]}`));
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
  if (error instanceof DaemonClientError) return error.code;
  return "INTERNAL";
}

async function runMcp(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  if (argv.length === 1 && isHelp(argv[0])) {
    environment.stdout.write("Usage: pitlane mcp\n");
    return 0;
  }
  if (argv.length > 0) throw new UsageError("mcp accepts no arguments");
  const runMcpStdio =
    environment.runMcpStdio ?? (await (environment.loadMcpStdio ?? loadDefaultMcpStdio)());
  await runMcpStdio();
  return 0;
}

export function errorExitCode(error: unknown): number {
  if (error instanceof UsageError) return 2;
  if (error instanceof DaemonClientError) return DAEMON_ERROR_EXIT_CODES[error.code] ?? 1;
  return 1;
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

// fallow-ignore-next-line complexity -- CLI command parsing remains intentionally local to its rendering boundary.
async function runLease(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  if (argv[0] === "renew") return runRenew(argv.slice(1), environment);
  const values = commandArgs(argv, {
    "agent-id": { type: "string" },
    "allow-download": { type: "boolean" },
    detach: { type: "boolean" },
    device: { type: "string" },
    help: { type: "boolean", short: "h" },
    "no-wait": { type: "boolean" },
    os: { type: "string" },
    platform: { type: "string" },
    timeout: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: pitlane lease --platform <ios|android> --device <model> [--os <version>]\n" +
        "                     [--agent-id <id>] [--timeout <duration>] [--no-wait] [--detach]\n" +
        "                     [--allow-download]\n",
    );
    return 0;
  }
  if (values.platform !== "ios" && values.platform !== "android")
    throw new UsageError(withHelpHint("lease requires --platform <ios|android>"));
  if (typeof values.device !== "string" || values.device === "")
    throw new UsageError(withHelpHint("lease requires --device <model>"));
  if (values["agent-id"] === "") throw new UsageError("lease --agent-id must not be empty");
  const requesterId = values["agent-id"] ?? environment.requesterId;
  const detached = values.detach ?? false;
  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined;
  const termination = detached ? undefined : waitForTermination(environment.signals);
  const connection = await environment.connect();
  const unsubscribe = connection.onPush((kind, payload) => {
    if (kind === "progress") environment.stderr.write(`${JSON.stringify(progressLine(payload))}\n`);
  });
  try {
    const response = await connection.request("lease.request", {
      allowDownload: values["allow-download"] ?? false,
      mode: detached ? "detached" : "held",
      noWait: values["no-wait"] ?? false,
      requesterId,
      request: {
        model: values.device,
        ...(typeof values.os === "string" ? { osVersion: values.os } : {}),
        platform: values.platform,
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const result = leaseResult(response);
    environment.stdout.write(`${JSON.stringify(result)}\n`);
    if (detached) return 0;
    await termination;
    try {
      await connection.request("lease.release", { leaseId: result.lease });
    } catch (error: unknown) {
      // Non-fatal: the process still exits 0 after a signal, but the release
      // failure is still diagnostic output, so it stays a structured stderr
      // line rather than reverting to prose.
      writeError(environment, error);
    }
    return 0;
  } finally {
    unsubscribe();
    await connection.close();
  }
}

async function runRenew(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    ttl: { type: "string" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: pitlane lease renew <lease-id> [--ttl <duration>]\n");
    return 0;
  }
  const leaseId = requiredPositional(positionals, "lease-id");
  writeResult(
    environment,
    await requestOnce(environment, "lease.renew", {
      leaseId,
      ...(typeof values.ttl === "string" ? { ttlMs: parseDuration(values.ttl) } : {}),
    }),
  );
  return 0;
}

async function runRelease(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: pitlane release <lease-id> | --all [--yes]\n");
    return 0;
  }
  if (values.all) {
    if (positionals.length > 0)
      throw new UsageError("release accepts either a lease id or --all, not both");
    const confirmed = values.yes ?? (await environment.confirm?.("Release every lease? [y/N] "));
    if (!confirmed) throw new UsageError("release --all requires confirmation or --yes");
    writeResult(environment, await requestOnce(environment, "lease.release-all", {}));
    return 0;
  }
  writeResult(
    environment,
    await requestOnce(environment, "lease.release", {
      leaseId: requiredPositional(positionals, "lease-id"),
    }),
  );
  return 0;
}

async function runStatus(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane status [--json]\n");
    return 0;
  }
  const status = await requestOnce(environment, "status.get", {});
  if (values.json) writeResult(environment, status);
  else environment.stdout.write(`${formatStatus(requireObject(status))}\n`);
  return 0;
}

async function runList(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    devices: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    leases: { type: "boolean" },
    rules: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane list [--devices|--leases|--rules]\n");
    return 0;
  }
  if ([values.devices, values.leases, values.rules].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, or --rules");
  const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
  writeResult(environment, await requestOnce(environment, "list.get", { kind }));
  return 0;
}

async function runCatalog(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    platform: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane catalog [--platform <ios|android>] [--json]\n");
    return 0;
  }
  if (values.platform !== undefined && values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("catalog --platform must be ios or android");
  const response = await requestOnce(
    environment,
    "catalog.get",
    values.platform === undefined ? {} : { platform: values.platform },
  );
  if (values.json) writeResult(environment, response);
  else environment.stdout.write(`${formatCatalog(requireObject(response))}\n`);
  return 0;
}

async function runCleanup(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    rule: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane cleanup [--dry-run] [--rule <name>]\n");
    return 0;
  }
  writeResult(
    environment,
    await requestOnce(environment, "cleanup.run", {
      dryRun: values["dry-run"] ?? false,
      ...(typeof values.rule === "string" ? { rule: values.rule } : {}),
    }),
  );
  return 0;
}

async function runDoctor(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    fix: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane doctor [--fix]\n");
    return 0;
  }
  writeResult(
    environment,
    await requestOnce(environment, "doctor.run", { fix: values.fix ?? false }),
  );
  return 0;
}

async function runNuke(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    "delete-devices": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane nuke [--delete-devices] [--yes]\n");
    return 0;
  }
  const confirmed =
    values.yes ?? (await environment.confirm?.("Nuke Pitlane-managed devices? [y/N] "));
  if (!confirmed) throw new UsageError("nuke requires confirmation or --yes");
  writeResult(
    environment,
    await requestOnce(environment, "nuke.run", {
      deleteDevices: values["delete-devices"] ?? false,
    }),
  );
  return 0;
}

async function runEvents(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const values = commandArgs(argv, {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    since: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: pitlane events [--follow] [--since <duration>]\n");
    return 0;
  }
  const connection = await environment.connect();
  const unsubscribe = connection.onPush((kind, payload) => {
    if (kind === "event") writeResult(environment, payload);
  });
  try {
    const sinceTs =
      typeof values.since === "string"
        ? (environment.now ?? Date.now)() - parseDuration(values.since)
        : undefined;
    const replayPayload = sinceTs === undefined ? {} : { sinceTs };
    for (const event of requireArray(await connection.request("events.replay", replayPayload)))
      writeResult(environment, event);
    if (values.follow) {
      await connection.request("events.subscribe", {});
      await waitForTermination(environment.signals);
      await connection.request("events.unsubscribe", {});
    }
    return 0;
  } finally {
    unsubscribe();
    await connection.close();
  }
}

// fallow-ignore-next-line complexity -- daemon subcommand parsing is a single CLI boundary.
async function runDaemon(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const command = argv[0];
  const values = commandArgs(argv.slice(1), {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (command === undefined || isHelp(command) || values.help) {
    environment.stdout.write("Usage: pitlane daemon <start|stop|status|logs>\n");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (command === "start") {
    await requestOnce(environment, "status.get", {});
    if (values.json) writeResult(environment, { status: "running" });
    else environment.stdout.write("Daemon running\n");
    return 0;
  }
  if (command === "stop") {
    const connection = await (environment.connectExisting ?? environment.connect)();
    try {
      await connection.request("daemon.stop", {});
    } finally {
      await connection.close();
    }
    if (values.json) writeResult(environment, { status: "stopping" });
    else environment.stdout.write("Daemon stopping\n");
    return 0;
  }
  if (command === "status") {
    try {
      const connection = await (environment.connectExisting ?? environment.connect)();
      try {
        writeResult(environment, await connection.request("status.get", {}));
      } finally {
        await connection.close();
      }
    } catch {
      if (values.json) writeResult(environment, { status: "stopped" });
      else environment.stdout.write("Daemon stopped\n");
    }
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
async function runConfig(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    writeResult(environment, await requestOnce(environment, "config.get", {}));
    return 0;
  }
  if (command === "get") {
    const values = commandArgs(argv.slice(1), {});
    const key = requiredPositional(values.positionals, "key");
    const value = readConfigValue(
      requireObject(await requestOnce(environment, "config.get", {})),
      key,
    );
    if (value === undefined) throw new UsageError(`Unknown config key: ${key}`);
    writeResult(environment, value);
    return 0;
  }
  if (command === "set") {
    const values = commandArgs(argv.slice(1), {});
    const [key, rawValue, ...extra] = values.positionals;
    if (key === undefined || rawValue === undefined || extra.length > 0)
      throw new UsageError("Usage: pitlane config set <key> <value>");
    const config = await environment.readConfigFile();
    writeConfigValue(config, key, parseConfigValue(rawValue));
    await environment.writeConfigFile(config);
    environment.stdout.write(
      `Updated ${key} in ${environment.configPath}; takes effect on daemon restart.\n`,
    );
    return 0;
  }
  if (isHelp(command)) {
    environment.stdout.write("Usage: pitlane config [get <key>|set <key> <value>]\n");
    return 0;
  }
  throw new UsageError(`Unknown config command: ${command}`);
}

async function requestOnce(
  environment: CliEnvironment,
  type: string,
  payload: unknown,
): Promise<unknown> {
  const connection = await environment.connect();
  try {
    return await connection.request(type, payload);
  } finally {
    await connection.close();
  }
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

function leaseResult(value: unknown): Record<string, unknown> & { readonly lease: string } {
  const grant = parseRawLeaseGrant(value);
  return {
    device: grant.device.spec.model,
    lease: grant.lease.id,
    os: grant.device.spec.osVersion,
    platform: grant.device.spec.platform,
    state: "leased",
    udid: grant.device.driverDeviceId,
  };
}

function progressLine(value: unknown): {
  readonly event: string;
  readonly eta_seconds?: number;
  readonly queue_position?: number;
} {
  const progress = requireObject(value);
  if (progress.stage === "queued" && typeof progress.queuePosition === "number") {
    return { event: "queued", queue_position: progress.queuePosition };
  }
  if (
    (progress.stage === "provisioning" ||
      progress.stage === "booting" ||
      progress.stage === "reclaiming") &&
    typeof progress.etaMs === "number"
  ) {
    return { eta_seconds: Math.ceil(progress.etaMs / 1_000), event: progress.stage };
  }
  throw new Error("Daemon returned invalid progress");
}

// fallow-ignore-next-line complexity -- stable human status rendering is intentionally a single formatter.
function formatStatus(status: Record<string, unknown>): string {
  const devices = requireArray(status.devices);
  const leases = requireArray(status.leases);
  const queueDepth = typeof status.queueDepth === "number" ? status.queueDepth : 0;
  const capacity = requireObject(status.capacity ?? {});
  const global = requireObject(capacity.global ?? {});
  const globalLine = `Running global: ${String(global.running ?? 0)} + ${String(global.reserved ?? 0)} reserved/${String(global.maxRunning ?? 0)}, warm ${String(global.warm ?? 0)}${global.overLimit === true ? " (over limit)" : ""}`;
  const capacityLines = ["ios", "android"].map((platform) => {
    const usage = requireObject(capacity[platform] ?? {});
    return `Capacity ${platform}: managed ${String(usage.used ?? 0)}/${String(usage.limit ?? 0)}, running ${String(usage.running ?? 0)} + ${String(usage.reserved ?? 0)} reserved/${String(usage.maxRunning ?? 0)}, warm ${String(usage.warm ?? 0)}${usage.overLimit === true ? " (over limit)" : ""}`;
  });
  const deviceLines = devices.map((device) => {
    const record = requireObject(device);
    const markers = [
      record.foreignStateDetectedAt === undefined ? undefined : "foreign state change",
      record.foreignProvenanceDetectedAt === undefined ? undefined : "foreign provenance change",
    ].filter((marker) => marker !== undefined);
    const suffix = markers.length === 0 ? "" : ` (${markers.join(", ")})`;
    return `Device ${String(record.id)}: ${String(record.state)}${suffix}`;
  });
  const leaseLines = leases.map((lease) => {
    const record = requireObject(lease);
    const heartbeatSuffix =
      typeof record.lastHeartbeatAt === "number"
        ? `, last heartbeat ${String(record.lastHeartbeatAt)}`
        : "";
    return `Lease ${String(record.id)}: ${String(record.requesterId)} since ${String(record.grantedAt)}${heartbeatSuffix}`;
  });
  return [
    `Daemon: ${typeof status.health === "string" ? status.health : "running"}`,
    globalLine,
    ...capacityLines,
    ...deviceLines,
    ...leaseLines,
    `Queue depth: ${queueDepth}`,
  ].join("\n");
}

function formatCatalog(response: Record<string, unknown>): string {
  const platforms = requireArray(response.platforms);
  if (platforms.length === 0) return "No platforms available.";
  return platforms
    .map((entry) => {
      const record = requireObject(entry);
      const models = requireArray(record.models).map(String);
      const runtimes = requireArray(record.runtimes).map(String);
      const defaultRuntime =
        typeof record.defaultRuntime === "string" ? record.defaultRuntime : "(none)";
      return [
        `Platform: ${String(record.platform)}`,
        `  Models: ${models.length > 0 ? models.join(", ") : "(none)"}`,
        `  Runtimes: ${runtimes.length > 0 ? runtimes.join(", ") : "(none)"} (default: ${defaultRuntime})`,
      ].join("\n");
    })
    .join("\n");
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
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Daemon returned an invalid response");
  return value;
}
function writeResult(environment: CliEnvironment, value: unknown): void {
  environment.stdout.write(`${JSON.stringify(value)}\n`);
}
function waitForTermination(signals: Signals): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      resolve();
    };
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
  });
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
