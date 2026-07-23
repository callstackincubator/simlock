/**
 * The citty command tree: one `defineCommand` per leaf, declaring every flag
 * with its type/alias/description (sourced from docs/CLI.md), plus the thin
 * business-logic handler that used to live in a hand-rolled `switch` in
 * index.ts. Parent commands (`lease`, `daemon`, `config`) exist only so their
 * `subCommands` show up in generated `--help` output — routing to nested
 * subcommands is still done explicitly by the small dispatcher functions at
 * the bottom of this file, because citty's own recursive dispatch (a) has no
 * unknown-flag rejection and (b) re-invokes a parent's own `run` after a
 * matched subcommand returns, which would double-execute the default `lease`
 * action after `lease renew`. See docs/CLI.md for the flag reference this
 * mirrors.
 */

import { defineCommand, renderUsage, runCommand, type ArgsDef, type CommandDef } from "citty";

import { parseDuration } from "./duration.js";
import { UsageError } from "./errors.js";
import type { CliEnvironment } from "./index.js";
import { requireArray, requireObject, type LeaseGrant, type Renderer } from "./render.js";

interface CommandData {
  readonly environment: CliEnvironment;
  readonly renderer: Renderer;
}

type Args = Record<string, unknown> & { readonly _: string[] };

function argsOf(context: { readonly args: unknown }): Args {
  return context.args as Args;
}

function dataOf(context: { readonly data?: unknown }): CommandData {
  return context.data as CommandData;
}

/**
 * Renders a command's generated usage (description + per-flag help) as plain
 * text. Takes `CommandDef<any>` — like citty's own `SubCommandsDef` — because
 * a specific command's literal args type is not assignable to the generic
 * `CommandDef` alias under `exactOptionalPropertyTypes`.
 */
export async function renderHelp(cmd: CommandDef<any>): Promise<string> {
  return (await renderUsage(cmd)).trimEnd();
}

async function showHelp(cmd: CommandDef<any>, renderer: Renderer): Promise<number> {
  renderer.info(await renderHelp(cmd));
  return 0;
}

function toCamelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toAliasArray(alias: string | readonly string[] | undefined): readonly string[] {
  if (alias === undefined) return [];
  if (typeof alias === "string") return [alias];
  return alias;
}

/**
 * citty does not reject unknown flags by default (unlike the strict
 * `node:util` `parseArgs` this replaces) — undeclared flags simply land in
 * the parsed args object. This restores the old strictness: any parsed key
 * that isn't a declared arg name, its auto-derived camelCase alias, or an
 * explicit alias, is an unknown option.
 */
function assertKnownArgs(cmd: CommandDef<any>, args: Args): void {
  const argsDef = (cmd.args ?? {}) as ArgsDef;
  const allowed = new Set<string>(["_"]);
  for (const [name, def] of Object.entries(argsDef)) {
    allowed.add(name);
    allowed.add(toCamelCase(name));
    if ("alias" in def) for (const alias of toAliasArray(def.alias)) allowed.add(alias);
  }
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new UsageError(`Unknown option: --${key}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredPositional(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined)
    throw new UsageError(`Expected ${label}`);
  return positionals[0];
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

function waitForTermination(signals: CliEnvironment["signals"]): Promise<void> {
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

const helpArg = {
  alias: "h",
  description: "Show command help",
  type: "boolean",
} as const;

const jsonArg = {
  description: "Force JSON output, even in an interactive terminal",
  type: "boolean",
} as const;

/**
 * Citty accepts assignments to boolean options (for example `--json=true`).
 * Pitlane's established flag surface is strict: booleans are presence flags,
 * so reject assignments before output mode selection can misclassify them.
 */
const booleanOptionNames = new Set([
  "all",
  "allow-download",
  "delete-devices",
  "detach",
  "devices",
  "dry-run",
  "fix",
  "follow",
  "help",
  "json",
  "leases",
  "no-wait",
  "rules",
  "wait",
  "yes",
]);

export function assertStrictBooleanFlagSyntax(argv: readonly string[]): void {
  for (const argument of argv) {
    const match = /^--([^=]+)=/.exec(argument);
    if (match !== null && booleanOptionNames.has(match[1] as string)) {
      throw new UsageError(`Boolean option does not accept a value: --${match[1] as string}`);
    }
  }
}

// --- lease ------------------------------------------------------------

interface LeaseRequest {
  readonly allowDownload: boolean;
  readonly detached: boolean;
  readonly device: string;
  readonly noWait: boolean;
  readonly os: string | undefined;
  readonly platform: "android" | "ios";
  readonly timeoutMs: number | undefined;
}

function parseLeaseArgs(args: Args): LeaseRequest {
  if (args.platform !== "ios" && args.platform !== "android")
    throw new UsageError("lease requires --platform <ios|android>");
  if (typeof args.device !== "string" || args.device === "")
    throw new UsageError("lease requires --device <model>");
  return {
    allowDownload: args["allow-download"] === true,
    detached: args.detach === true,
    device: args.device,
    noWait: args.wait === false,
    os: typeof args.os === "string" ? args.os : undefined,
    platform: args.platform,
    timeoutMs: typeof args.timeout === "string" ? parseDuration(args.timeout) : undefined,
  };
}

type Connection = Awaited<ReturnType<CliEnvironment["connect"]>>;

/** Requests the lease, reports the grant, and — in held mode — blocks until termination then releases. */
async function holdOrDetachLease(
  connection: Connection,
  environment: CliEnvironment,
  renderer: Renderer,
  request: LeaseRequest,
): Promise<number> {
  const termination = request.detached ? undefined : waitForTermination(environment.signals);
  const response = await connection.request("lease.request", {
    allowDownload: request.allowDownload,
    mode: request.detached ? "detached" : "held",
    noWait: request.noWait,
    requesterId: environment.requesterId,
    request: {
      model: request.device,
      ...(request.os === undefined ? {} : { osVersion: request.os }),
      platform: request.platform,
    },
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const result = leaseResult(response);
  renderer.leaseGranted(result, { held: !request.detached });
  if (request.detached) return 0;
  await termination;
  await releaseAfterSignal(connection, renderer, result.lease);
  return 0;
}

async function releaseAfterSignal(
  connection: Connection,
  renderer: Renderer,
  leaseId: string,
): Promise<void> {
  try {
    await connection.request("lease.release", { leaseId });
    renderer.leaseReleased();
  } catch (error: unknown) {
    renderer.error(`Lease release failed after signal: ${errorMessage(error)}`);
  }
}

const leaseCommand = defineCommand({
  args: {
    "allow-download": {
      description: "Permit downloading a missing runtime / system image (multi-GB; never implicit)",
      type: "boolean",
    },
    detach: {
      description:
        "Detached mode: print the lease result and exit; renew with `pitlane lease renew`",
      type: "boolean",
    },
    device: { description: "Device model (required)", type: "string" },
    help: helpArg,
    json: jsonArg,
    os: { description: "OS version (defaults to the newest installed)", type: "string" },
    platform: {
      description: "Target platform (required)",
      options: ["ios", "android"],
      type: "enum",
    },
    timeout: { description: "Max time to wait in the queue, e.g. 90s, 5m", type: "string" },
    wait: {
      default: true,
      description: "Wait in the queue for capacity",
      negativeDescription: "Fail immediately with exit 11 instead of queueing",
      type: "boolean",
    },
  },
  meta: {
    description: "Acquire a device, blocking while it is provisioned and booted",
    name: "pitlane lease",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(leaseCommand, renderer);
    assertKnownArgs(leaseCommand, args);
    const request = parseLeaseArgs(args);
    const connection = await environment.connect();
    const unsubscribe = connection.onPush((kind, payload) => {
      if (kind === "progress") renderer.progress(payload);
    });
    try {
      return await holdOrDetachLease(connection, environment, renderer, request);
    } finally {
      unsubscribe();
      await connection.close();
    }
  },
});

const leaseRenewCommand = defineCommand({
  args: {
    help: helpArg,
    json: jsonArg,
    "lease-id": {
      description: "Lease to renew",
      required: false,
      type: "positional",
    },
    ttl: { description: "New TTL, e.g. 1m, 90s", type: "string" },
  },
  meta: {
    description: "Detached mode only: extend a lease's TTL",
    name: "pitlane lease renew",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(leaseRenewCommand, renderer);
    assertKnownArgs(leaseRenewCommand, args);
    const leaseId = requiredPositional(args._, "lease-id");
    renderer.result(
      await requestOnce(environment, "lease.renew", {
        leaseId,
        ...(typeof args.ttl === "string" ? { ttlMs: parseDuration(args.ttl) } : {}),
      }),
    );
    return 0;
  },
});

// --- release ------------------------------------------------------------

const releaseCommand = defineCommand({
  args: {
    all: {
      description: "Force-release every active lease (requires confirmation or --yes)",
      type: "boolean",
    },
    help: helpArg,
    json: jsonArg,
    "lease-id": { description: "Lease to release", required: false, type: "positional" },
    yes: { description: "Skip the confirmation prompt for --all", type: "boolean" },
  },
  meta: {
    description: "Explicitly release a lease (or every lease with --all)",
    name: "pitlane release",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(releaseCommand, renderer);
    assertKnownArgs(releaseCommand, args);
    if (args.all === true) {
      if (args._.length > 0)
        throw new UsageError("release accepts either a lease id or --all, not both");
      const confirmed =
        args.yes === true ||
        (await environment.confirm?.("This will force-release every active lease."));
      if (!confirmed) throw new UsageError("release --all requires confirmation or --yes");
      renderer.result(await requestOnce(environment, "lease.release-all", {}));
      return 0;
    }
    renderer.result(
      await requestOnce(environment, "lease.release", {
        leaseId: requiredPositional(args._, "lease-id"),
      }),
    );
    return 0;
  },
});

// --- status ------------------------------------------------------------

const statusCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: {
    description: "Show daemon health, managed capacity, devices, leases, and queue depth",
    name: "pitlane status",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(statusCommand, renderer);
    assertKnownArgs(statusCommand, args);
    const status = await requestOnce(environment, "status.get", {});
    if (args.json === true) renderer.result(status);
    else renderer.status(status);
    return 0;
  },
});

// --- list ------------------------------------------------------------

const listCommand = defineCommand({
  args: {
    devices: { description: "List managed devices (default)", type: "boolean" },
    help: helpArg,
    json: jsonArg,
    leases: { description: "List active leases", type: "boolean" },
    rules: { description: "List registered cleanup rules", type: "boolean" },
  },
  meta: {
    description: "Scriptable listing of managed devices, active leases, or cleanup rules",
    name: "pitlane list",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(listCommand, renderer);
    assertKnownArgs(listCommand, args);
    if ([args.devices, args.leases, args.rules].filter((flag) => flag === true).length > 1)
      throw new UsageError("list accepts only one of --devices, --leases, or --rules");
    const kind = args.leases === true ? "leases" : args.rules === true ? "rules" : "devices";
    renderer.list(kind, await requestOnce(environment, "list.get", { kind }));
    return 0;
  },
});

// --- cleanup ------------------------------------------------------------

const cleanupCommand = defineCommand({
  args: {
    "dry-run": {
      description: "Print the actions each rule would take, without executing",
      type: "boolean",
    },
    help: helpArg,
    json: jsonArg,
    rule: { description: "Restrict to a single cleanup rule", type: "string" },
  },
  meta: {
    description: "Run the cleanup reconciliation immediately",
    name: "pitlane cleanup",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(cleanupCommand, renderer);
    assertKnownArgs(cleanupCommand, args);
    const dryRun = args["dry-run"] === true;
    const actions = await requestOnce(environment, "cleanup.run", {
      dryRun,
      ...(typeof args.rule === "string" ? { rule: args.rule } : {}),
    });
    renderer.cleanup(actions, { dryRun });
    return 0;
  },
});

// --- doctor ------------------------------------------------------------

const doctorCommand = defineCommand({
  args: {
    fix: { description: "Apply the safe corrections", type: "boolean" },
    help: helpArg,
    json: jsonArg,
  },
  meta: {
    description: "Reconcile the daemon's state with reality (orphans, stale leases, ...)",
    name: "pitlane doctor",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(doctorCommand, renderer);
    assertKnownArgs(doctorCommand, args);
    const fix = args.fix === true;
    const report = await requestOnce(environment, "doctor.run", { fix });
    renderer.doctor(report, { fix });
    return 0;
  },
});

// --- nuke ------------------------------------------------------------

const nukeCommand = defineCommand({
  args: {
    "delete-devices": {
      description: "Also destroy every registry-managed device",
      type: "boolean",
    },
    help: helpArg,
    json: jsonArg,
    yes: { description: "Skip the confirmation prompt", type: "boolean" },
  },
  meta: {
    description: "Emergency reset: force-release all leases and shut down managed devices",
    name: "pitlane nuke",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(nukeCommand, renderer);
    assertKnownArgs(nukeCommand, args);
    const deleteDevices = args["delete-devices"] === true;
    const warning = deleteDevices
      ? "This will force-release every active lease and permanently destroy every registry-managed simulator and emulator device."
      : "This will force-release every active lease and shut down every Pitlane-managed device.";
    const confirmed = args.yes === true || (await environment.confirm?.(warning));
    if (!confirmed) throw new UsageError("nuke requires confirmation or --yes");
    renderer.nuke(await requestOnce(environment, "nuke.run", { deleteDevices }));
    return 0;
  },
});

// --- events ------------------------------------------------------------

const eventsCommand = defineCommand({
  args: {
    follow: { description: "Keep streaming new events", type: "boolean" },
    help: helpArg,
    json: jsonArg,
    since: { description: "Replay recent history, e.g. --since 1h", type: "string" },
  },
  meta: {
    description: "Stream the business-event ring buffer as JSON lines",
    name: "pitlane events",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(eventsCommand, renderer);
    assertKnownArgs(eventsCommand, args);
    const connection = await environment.connect();
    const unsubscribe = connection.onPush((kind, payload) => {
      if (kind === "event") renderer.event(payload);
    });
    try {
      const sinceTs =
        typeof args.since === "string"
          ? (environment.now ?? Date.now)() - parseDuration(args.since)
          : undefined;
      const replayPayload = sinceTs === undefined ? {} : { sinceTs };
      for (const event of requireArray(await connection.request("events.replay", replayPayload)))
        renderer.event(event);
      if (args.follow === true) {
        await connection.request("events.subscribe", {});
        await waitForTermination(environment.signals);
        await connection.request("events.unsubscribe", {});
      }
      return 0;
    } finally {
      unsubscribe();
      await connection.close();
    }
  },
});

// --- daemon ------------------------------------------------------------

const daemonStartCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: {
    description: "Start the daemon (auto-started on demand otherwise)",
    name: "pitlane daemon start",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(daemonStartCommand, renderer);
    assertKnownArgs(daemonStartCommand, args);
    if (args._.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
    await requestOnce(environment, "status.get", {});
    renderer.daemonState("running", { status: "running" });
    return 0;
  },
});

const daemonStopCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: { description: "Stop the daemon", name: "pitlane daemon stop" },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(daemonStopCommand, renderer);
    assertKnownArgs(daemonStopCommand, args);
    if (args._.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
    const connection = await (environment.connectExisting ?? environment.connect)();
    try {
      await connection.request("daemon.stop", {});
    } finally {
      await connection.close();
    }
    renderer.daemonState("stopping", { status: "stopping" });
    return 0;
  },
});

const daemonStatusCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: { description: "Report whether the daemon is running", name: "pitlane daemon status" },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(daemonStatusCommand, renderer);
    assertKnownArgs(daemonStatusCommand, args);
    if (args._.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
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
  },
});

const daemonLogsCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: { description: "Tail the daemon log", name: "pitlane daemon logs" },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(daemonLogsCommand, renderer);
    assertKnownArgs(daemonLogsCommand, args);
    if (args._.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
    if (environment.readLogFile === undefined) throw new Error("Daemon log reader is unavailable");
    const lines = (await environment.readLogFile()).trimEnd().split("\n");
    const output = lines.slice(-100).join("\n");
    if (args.json === true) renderer.result({ logs: output });
    else renderer.info(output);
    return 0;
  },
});

const daemonCommand = defineCommand({
  args: { help: helpArg },
  meta: {
    description: "Manage the daemon explicitly (start, stop, status, logs)",
    name: "pitlane daemon",
  },
  subCommands: {
    logs: daemonLogsCommand,
    start: daemonStartCommand,
    status: daemonStatusCommand,
    stop: daemonStopCommand,
  },
});

// --- config ------------------------------------------------------------

const configGetCommand = defineCommand({
  args: {
    help: helpArg,
    json: jsonArg,
    key: {
      description: "Dotted config key, e.g. limits.maxRunning",
      required: false,
      type: "positional",
    },
  },
  meta: { description: "Show a single effective configuration value", name: "pitlane config get" },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(configGetCommand, renderer);
    assertKnownArgs(configGetCommand, args);
    const key = requiredPositional(args._, "key");
    const value = readConfigValue(
      requireObject(await requestOnce(environment, "config.get", {})),
      key,
    );
    if (value === undefined) throw new UsageError(`Unknown config key: ${key}`);
    renderer.config(value);
    return 0;
  },
});

const configSetCommand = defineCommand({
  args: {
    help: helpArg,
    json: jsonArg,
    key: {
      description: "Dotted config key, e.g. limits.maxRunning",
      required: false,
      type: "positional",
    },
    value: {
      description: "New value (parsed as JSON when possible, else a string)",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Set a configuration value (effective on next daemon restart)",
    name: "pitlane config set",
  },
  async run(context) {
    const args = argsOf(context);
    const { environment, renderer } = dataOf(context);
    if (args.help === true) return showHelp(configSetCommand, renderer);
    assertKnownArgs(configSetCommand, args);
    const [key, rawValue, ...extra] = args._;
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
  },
});

const configCommand = defineCommand({
  args: { help: helpArg, json: jsonArg },
  meta: {
    description: "Show or set the effective configuration (defaults + config file + overrides)",
    name: "pitlane config",
  },
  subCommands: { get: configGetCommand, set: configSetCommand },
});

// --- root ------------------------------------------------------------

export const rootCommand = defineCommand({
  args: { help: helpArg },
  meta: {
    description: "Control plane for iOS simulators and Android emulators",
    name: "pitlane",
  },
  subCommands: {
    cleanup: cleanupCommand,
    config: configCommand,
    daemon: daemonCommand,
    doctor: doctorCommand,
    events: eventsCommand,
    lease: leaseCommand,
    list: listCommand,
    nuke: nukeCommand,
    release: releaseCommand,
    status: statusCommand,
  },
});

// --- dispatch ------------------------------------------------------------

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

async function runLeaseGroup(argv: readonly string[], data: CommandData): Promise<number> {
  if (argv[0] === "renew") {
    const { result } = await runCommand(leaseRenewCommand, { data, rawArgs: argv.slice(1) });
    return result as number;
  }
  const { result } = await runCommand(leaseCommand, { data, rawArgs: [...argv] });
  return result as number;
}

async function runDaemonGroup(argv: readonly string[], data: CommandData): Promise<number> {
  const command = argv[0];
  if (command === undefined || isHelp(command)) return showHelp(daemonCommand, data.renderer);
  const leaf =
    command === "start"
      ? daemonStartCommand
      : command === "stop"
        ? daemonStopCommand
        : command === "status"
          ? daemonStatusCommand
          : command === "logs"
            ? daemonLogsCommand
            : undefined;
  if (leaf === undefined) throw new UsageError(`Unknown daemon command: ${command}`);
  const { result } = await runCommand(leaf, { data, rawArgs: argv.slice(1) });
  return result as number;
}

async function runConfigGroup(argv: readonly string[], data: CommandData): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--json") {
    const { environment, renderer } = data;
    renderer.config(await requestOnce(environment, "config.get", {}));
    return 0;
  }
  if (command === "get") {
    const { result } = await runCommand(configGetCommand, { data, rawArgs: argv.slice(1) });
    return result as number;
  }
  if (command === "set") {
    const { result } = await runCommand(configSetCommand, { data, rawArgs: argv.slice(1) });
    return result as number;
  }
  if (isHelp(command)) return showHelp(configCommand, data.renderer);
  throw new UsageError(`Unknown config command: ${command}`);
}

/** Routes a top-level command name to its citty command(s). Throws `UsageError` for unknown commands. */
export async function runTopCommand(
  name: string,
  argv: readonly string[],
  data: CommandData,
): Promise<number> {
  switch (name) {
    case "lease":
      return runLeaseGroup(argv, data);
    case "release": {
      const { result } = await runCommand(releaseCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "status": {
      const { result } = await runCommand(statusCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "list": {
      const { result } = await runCommand(listCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "cleanup": {
      const { result } = await runCommand(cleanupCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "doctor": {
      const { result } = await runCommand(doctorCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "nuke": {
      const { result } = await runCommand(nukeCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "events": {
      const { result } = await runCommand(eventsCommand, { data, rawArgs: [...argv] });
      return result as number;
    }
    case "daemon":
      return runDaemonGroup(argv, data);
    case "config":
      return runConfigGroup(argv, data);
    default:
      throw new UsageError(`Unknown command: ${name}`);
  }
}
