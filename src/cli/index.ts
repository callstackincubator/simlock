import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { confirm as clackConfirm, isCancel, log } from "@clack/prompts";
import pc from "picocolors";

import { NodeFilesystem } from "../ports/index.js";
import { connectDaemon, connectExistingDaemon } from "./client.js";
import { DaemonClientError, type DaemonConnection } from "./protocol.js";
import {
  HumanRenderer,
  JsonRenderer,
  requireArray,
  requireObject,
  type LeaseGrant,
  type Renderer,
} from "./render.js";

export { DaemonClientError, type DaemonConnection } from "./protocol.js";

const USAGE = `Usage: pitlane <command> [options]

Commands:
  lease, release, status, list, cleanup, doctor, nuke, events, daemon, config
Run 'pitlane <command> --help' for command usage.`;

const DAEMON_ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  BAD_FRAME: 2,
  BAD_REQUEST: 2,
  NO_CAPACITY: 11,
  NO_DRIVER: 12,
  QUEUE_TIMEOUT: 10,
  RUNTIME_MISSING: 12,
  UNKNOWN_MODEL: 12,
};

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface Output {
  write(value: string): unknown;
}

interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface CliEnvironment {
  readonly configPath: string;
  readonly connect: () => Promise<DaemonConnection>;
  readonly connectExisting?: () => Promise<DaemonConnection>;
  readonly now?: () => number;
  readonly requesterId: string;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly readLogFile?: () => Promise<string>;
  readonly interactive?: boolean;
  readonly signals: Signals;
  readonly stderr: Output;
  readonly stdout: Output;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
}

function defaultCliEnvironment(): CliEnvironment {
  const dataDirectory = join(homedir(), ".pitlane");
  const filesystem = new NodeFilesystem();
  const socketPath = join(dataDirectory, "daemon.sock");
  const configPath = join(dataDirectory, "config.json");
  const logPath = join(dataDirectory, "daemon.log");
  return {
    configPath,
    connect: () => connectDaemon({ dataDirectory, socketPath }),
    connectExisting: () => connectExistingDaemon(socketPath),
    now: () => Date.now(),
    requesterId: String(process.pid),
    interactive: process.stdout.isTTY === true,
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    readLogFile: async () => filesystem.readFile(logPath),
    signals: process,
    stderr: process.stderr,
    stdout: process.stdout,
    confirm: process.stdout.isTTY === true ? confirmInteractive : confirmTerminal,
    writeConfigFile: async (contents) => {
      await filesystem.mkdirp(dataDirectory);
      await filesystem.writeFileAtomic(configPath, `${JSON.stringify(contents, null, 2)}\n`);
    },
  };
}

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment = defaultCliEnvironment(),
): Promise<number> {
  // Output-mode policy: `--json` always wins; otherwise human rendering only
  // in an interactive terminal, JSON everywhere else (piped/redirected — the
  // agent case). See docs/CLI.md "Output modes".
  const useHuman = environment.interactive === true && !argv.includes("--json");
  const renderer: Renderer = useHuman
    ? new HumanRenderer(environment)
    : new JsonRenderer(environment);
  try {
    if (argv.length === 0 || isHelp(argv[0])) {
      renderer.info(USAGE);
      return 0;
    }
    switch (argv[0]) {
      case "lease":
        return await runLease(argv.slice(1), environment, renderer);
      case "release":
        return await runRelease(argv.slice(1), environment, renderer);
      case "status":
        return await runStatus(argv.slice(1), environment, renderer);
      case "list":
        return await runList(argv.slice(1), environment, renderer);
      case "cleanup":
        return await runCleanup(argv.slice(1), environment, renderer);
      case "doctor":
        return await runDoctor(argv.slice(1), environment, renderer);
      case "nuke":
        return await runNuke(argv.slice(1), environment, renderer);
      case "events":
        return await runEvents(argv.slice(1), environment, renderer);
      case "daemon":
        return await runDaemon(argv.slice(1), environment, renderer);
      case "config":
        return await runConfig(argv.slice(1), environment, renderer);
      default:
        throw new UsageError(`Unknown command: ${argv[0]}`);
    }
  } catch (error: unknown) {
    renderer.error(errorMessage(error));
    if (error instanceof UsageError) renderer.usage(USAGE);
    return errorExitCode(error);
  }
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

async function runLease(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  if (argv[0] === "renew") return runRenew(argv.slice(1), environment, renderer);
  const values = commandArgs(argv, {
    "allow-download": { type: "boolean" },
    detach: { type: "boolean" },
    device: { type: "string" },
    help: { type: "boolean", short: "h" },
    "no-wait": { type: "boolean" },
    os: { type: "string" },
    platform: { type: "string" },
    json: { type: "boolean" },
    timeout: { type: "string" },
  });
  if (values.help) {
    renderer.info(
      "Usage: pitlane lease --platform <ios|android> --device <model> [--os <version>]",
    );
    return 0;
  }
  if (values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("lease requires --platform <ios|android>");
  if (typeof values.device !== "string" || values.device === "")
    throw new UsageError("lease requires --device <model>");
  const detached = values.detach ?? false;
  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined;
  const termination = detached ? undefined : waitForTermination(environment.signals);
  const connection = await environment.connect();
  const unsubscribe = connection.onPush((kind, payload) => {
    if (kind === "progress") renderer.progress(payload);
  });
  try {
    const response = await connection.request("lease.request", {
      allowDownload: values["allow-download"] ?? false,
      mode: detached ? "detached" : "held",
      noWait: values["no-wait"] ?? false,
      requesterId: environment.requesterId,
      request: {
        model: values.device,
        ...(typeof values.os === "string" ? { osVersion: values.os } : {}),
        platform: values.platform,
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const result = leaseResult(response);
    renderer.leaseGranted(result, { held: !detached });
    if (detached) return 0;
    await termination;
    try {
      await connection.request("lease.release", { leaseId: result.lease });
      renderer.leaseReleased();
    } catch (error: unknown) {
      renderer.error(`Lease release failed after signal: ${errorMessage(error)}`);
    }
    return 0;
  } finally {
    unsubscribe();
    await connection.close();
  }
}

async function runRenew(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    ttl: { type: "string" },
  });
  const { positionals } = values;
  if (values.help) {
    renderer.info("Usage: pitlane lease renew <lease-id> [--ttl <duration>]");
    return 0;
  }
  const leaseId = requiredPositional(positionals, "lease-id");
  renderer.result(
    await requestOnce(environment, "lease.renew", {
      leaseId,
      ...(typeof values.ttl === "string" ? { ttlMs: parseDuration(values.ttl) } : {}),
    }),
  );
  return 0;
}

async function runRelease(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    yes: { type: "boolean" },
  });
  const { positionals } = values;
  if (values.help) {
    renderer.info("Usage: pitlane release <lease-id> | --all [--yes]");
    return 0;
  }
  if (values.all) {
    if (positionals.length > 0)
      throw new UsageError("release accepts either a lease id or --all, not both");
    const confirmed =
      values.yes ?? (await environment.confirm?.("This will force-release every active lease."));
    if (!confirmed) throw new UsageError("release --all requires confirmation or --yes");
    renderer.result(await requestOnce(environment, "lease.release-all", {}));
    return 0;
  }
  renderer.result(
    await requestOnce(environment, "lease.release", {
      leaseId: requiredPositional(positionals, "lease-id"),
    }),
  );
  return 0;
}

async function runStatus(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane status [--json]");
    return 0;
  }
  const status = await requestOnce(environment, "status.get", {});
  if (values.json) renderer.result(status);
  else renderer.status(status);
  return 0;
}

async function runList(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    devices: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    leases: { type: "boolean" },
    rules: { type: "boolean" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane list [--devices|--leases|--rules] [--json]");
    return 0;
  }
  if ([values.devices, values.leases, values.rules].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, or --rules");
  const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
  renderer.list(kind, await requestOnce(environment, "list.get", { kind }));
  return 0;
}

async function runCleanup(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    rule: { type: "string" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane cleanup [--dry-run] [--rule <name>] [--json]");
    return 0;
  }
  const dryRun = values["dry-run"] === true;
  const actions = await requestOnce(environment, "cleanup.run", {
    dryRun,
    ...(typeof values.rule === "string" ? { rule: values.rule } : {}),
  });
  renderer.cleanup(actions, { dryRun });
  return 0;
}

async function runDoctor(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    fix: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane doctor [--fix] [--json]");
    return 0;
  }
  const fix = values.fix === true;
  const report = await requestOnce(environment, "doctor.run", { fix });
  renderer.doctor(report, { fix });
  return 0;
}

async function runNuke(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    "delete-devices": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane nuke [--delete-devices] [--yes] [--json]");
    return 0;
  }
  const deleteDevices = values["delete-devices"] ?? false;
  const warning = deleteDevices
    ? "This will force-release every active lease, shut down every Pitlane-managed device, and delete them from the registry."
    : "This will force-release every active lease and shut down every Pitlane-managed device.";
  const confirmed = values.yes ?? (await environment.confirm?.(warning));
  if (!confirmed) throw new UsageError("nuke requires confirmation or --yes");
  renderer.nuke(await requestOnce(environment, "nuke.run", { deleteDevices }));
  return 0;
}

async function runEvents(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const values = commandArgs(argv, {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    since: { type: "string" },
  });
  if (values.help) {
    renderer.info("Usage: pitlane events [--follow] [--since <duration>] [--json]");
    return 0;
  }
  const connection = await environment.connect();
  const unsubscribe = connection.onPush((kind, payload) => {
    if (kind === "event") renderer.event(payload);
  });
  try {
    const sinceTs =
      typeof values.since === "string"
        ? (environment.now ?? Date.now)() - parseDuration(values.since)
        : undefined;
    const replayPayload = sinceTs === undefined ? {} : { sinceTs };
    for (const event of requireArray(await connection.request("events.replay", replayPayload)))
      renderer.event(event);
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

async function runDaemon(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const command = argv[0];
  const values = commandArgs(argv.slice(1), {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (command === undefined || isHelp(command) || values.help) {
    renderer.info("Usage: pitlane daemon <start|stop|status|logs>");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (command === "start") {
    await requestOnce(environment, "status.get", {});
    renderer.daemonState("running", { status: "running" });
    return 0;
  }
  if (command === "stop") {
    const connection = await (environment.connectExisting ?? environment.connect)();
    try {
      await connection.request("daemon.stop", {});
    } finally {
      await connection.close();
    }
    renderer.daemonState("stopping", { status: "stopping" });
    return 0;
  }
  if (command === "status") {
    try {
      const connection = await (environment.connectExisting ?? environment.connect)();
      try {
        const status = await connection.request("status.get", {});
        const health =
          typeof status === "object" && status !== null && !Array.isArray(status)
            ? (status as Record<string, unknown>).health
            : undefined;
        renderer.daemonState(typeof health === "string" ? health : "running", status);
      } finally {
        await connection.close();
      }
    } catch {
      renderer.daemonState("stopped", { status: "stopped" });
    }
    return 0;
  }
  if (command === "logs") {
    if (environment.readLogFile === undefined) throw new Error("Daemon log reader is unavailable");
    const lines = (await environment.readLogFile()).trimEnd().split("\n");
    const output = lines.slice(-100).join("\n");
    if (values.json) renderer.result({ logs: output });
    else renderer.info(output);
    return 0;
  }
  throw new UsageError(`Unknown daemon command: ${command}`);
}

async function runConfig(
  argv: readonly string[],
  environment: CliEnvironment,
  renderer: Renderer,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--json") {
    renderer.config(await requestOnce(environment, "config.get", {}));
    return 0;
  }
  if (command === "get") {
    const values = commandArgs(argv.slice(1), { json: { type: "boolean" } });
    const key = requiredPositional(values.positionals, "key");
    const value = readConfigValue(
      requireObject(await requestOnce(environment, "config.get", {})),
      key,
    );
    if (value === undefined) throw new UsageError(`Unknown config key: ${key}`);
    renderer.config(value);
    return 0;
  }
  if (command === "set") {
    const values = commandArgs(argv.slice(1), { json: { type: "boolean" } });
    const [key, rawValue, ...extra] = values.positionals;
    if (key === undefined || rawValue === undefined || extra.length > 0)
      throw new UsageError("Usage: pitlane config set <key> <value>");
    const config = await environment.readConfigFile();
    const value = parseConfigValue(rawValue);
    writeConfigValue(config, key, value);
    await environment.writeConfigFile(config);
    renderer.configSet(
      {
        configPath: environment.configPath,
        effectiveAt: "next daemon restart",
        key,
        updated: true,
      },
      { key, value },
    );
    return 0;
  }
  if (isHelp(command)) {
    renderer.info("Usage: pitlane config [get <key>|set <key> <value>]");
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

function leaseResult(value: unknown): LeaseGrant {
  const grant = requireObject(value);
  const lease = requireObject(grant.lease);
  const device = requireObject(grant.device);
  const spec = requireObject(device.spec);
  if (
    typeof lease.id !== "string" ||
    typeof device.driverDeviceId !== "string" ||
    typeof spec.model !== "string" ||
    typeof spec.osVersion !== "string" ||
    (spec.platform !== "ios" && spec.platform !== "android")
  )
    throw new Error("Daemon returned an invalid lease grant");
  return {
    device: spec.model,
    lease: lease.id,
    os: spec.osVersion,
    platform: spec.platform,
    state: "leased",
    udid: device.driverDeviceId,
  };
}

function requiredPositional(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined)
    throw new UsageError(`Expected ${label}`);
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
    return (await prompt.question(`${question} [y/N] `)).trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}
/**
 * Default `confirm` implementation when interactive: a red warning line stating
 * exactly what will be destroyed, then a clack confirm prompt. A clack cancel
 * (Ctrl+C / Esc) resolves to `false`, the same as answering "no".
 */
async function confirmInteractive(question: string): Promise<boolean> {
  const colors = pc.createColors(!process.env.NO_COLOR);
  log.warn(colors.red(question), { output: process.stderr });
  const answer = await clackConfirm({ message: "Proceed?", output: process.stderr });
  return !isCancel(answer) && answer === true;
}
function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
