// why: this file imports no component for a value -- the command's modules load on a tree hit
// and the default environment builds only once a command runs -- so `--help` and a usage error
// are answered without loading the control plane (see `lazy-loading.test.ts`).
import { COMMANDS, resolveCommand } from "./tree.js";
import { errorExitCode, UsageError, withHelpHint, writeError } from "./errors.js";
import type { DaemonFlag } from "../ports/index.js";
import type { CliEnvironment, RemoteFarm } from "./types.js";

export type { CliEnvironment, CliEnvironmentPorts } from "./types.js";
/** why: re-exported, not re-implemented, so another edge enters the CLI through its index;
 * `environment.js` loads only the identity resolver and the CLI's own cheap helpers, measured
 * against the same fast path, so this costs `simlock --help` nothing. */
export { buildCliEnvironment } from "./environment.js";

const USAGE = `Usage: simlock <command> [options]

Commands:
  lease, release, status, list, catalog, cleanup, doctor, nuke, events, stats,
  update, daemon, config, token, whoami
  worker <list|drain|undrain|remove>
                              Inspect and manage the workers of a gateway; on a
                              single host, list shows the host itself
  alerts test <destination> [--json]
                              Send one sample message to a gateway's alert destination
  seed <ios|android> <model> [--os <version|range>] [--image-tag <tag>] [--json]
                              Make and settle a kind's seed before anyone leases it
  warm forget <ios|android> <model> [<os>] [--mode <slim|full>] [--image-tag <tag>] [--json]
                              Forget a kind the warm pool learned from a lease
  component install <ios|android> <version> [--worker <id>... | --all-workers]
                              Install a simulator runtime or system image
  component list [--platform <ios|android>]
                              List installed runtimes and system images
  component remove <ios|android> <version> [--dry-run] [--yes]
                              Remove a runtime or system image Simlock installed
  baseline save <name> --lease <id> [--note <text>]
                              Keep a held simulator or emulator as a named baseline; ends the lease
  baseline list [--json]      List the baselines on this worker
  baseline remove <name> [--yes]
                              Delete a baseline nobody uses
  device add --platform <ios|android> <id> [--json]
                              Enrol a physical device plugged into this host
  device remove <id> [--json] Forget an enrolled physical device; the device is untouched
  rotate <orientation> [--lease <id>]
                              Turn the leased iOS simulator: portrait, portrait-upside-down,
                              landscape-left or landscape-right
  tunnel reverse <device-port>[:<caller-port>] [reverse ...] [--lease <id>] [--url <url>]
                              Reach this machine's ports from a leased Android device
  files put <file> [--name <name>] [--lease <id>]
                              Upload a file to the lease's folder on its worker (needs --url)
  files get <name> [-o <file>] [--lease <id>]
                              Download a file from the lease's folder; stdout without -o
  files list [--lease <id>]   List the files in the lease's folder
  files rm <name> [--lease <id>]
                              Delete a file from the lease's folder
  simctl <args...>            Run xcrun simctl against Simlock's iOS device set
  adb <args...>               Run adb against Simlock's adb server
  mcp                         Start the stdio MCP server
  instructions [--json]       Print the rules an agent must follow, for its prompt
  setup [--user | --project] [--tool <claude-code|codex>] [--mcp | --no-mcp] [--json]
                              Install the Simlock skill into Claude Code and Codex
Run 'simlock <command> --help' for command usage.
Run 'simlock --version' (or -v) to print the installed version.

Pass --token <secret> anywhere on the command line to set the credential a command
sends; the CLI reference lists the default resolution order.

Pass --url <url> anywhere on the command line (or set SIMLOCK_URL and SIMLOCK_TOKEN) to run
the command on a remote worker or gateway instead of this machine's daemon.

Pass --gateway anywhere on the command line to reach this machine's gateway in place of its worker.
Pass --local anywhere on the command line to reach this machine's worker even when only a gateway has run here.`;

function daemonFlagNamed(arg: string): "gateway" | "local" | undefined {
  for (const name of ["gateway", "local"] as const) {
    if (arg === `--${name}`) return name;
    if (arg.startsWith(`--${name}=`)) throw new UsageError(`--${name} takes no value`);
  }
  return undefined;
}

// why: `--name value` and `--name=value` are one flag; `next` is the index of the argument after it.
function takeValueFlag(
  argv: readonly string[],
  index: number,
  name: string,
): { readonly value: string; readonly next: number } | undefined {
  const arg = argv[index] as string;
  if (arg === `--${name}`) {
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    return { next: index + 2, value };
  }
  if (arg.startsWith(`--${name}=`)) return { next: index + 1, value: arg.slice(name.length + 3) };
  return undefined;
}

function extractGlobalFlags(argv: readonly string[]): {
  readonly token: string | undefined;
  readonly url: string | undefined;
  readonly daemonFlag: DaemonFlag;
  readonly rest: string[];
} {
  const rest: string[] = [];
  const values: Record<"token" | "url", string | undefined> = { token: undefined, url: undefined };
  let daemonFlag: DaemonFlag;
  let index = 0;
  while (index < argv.length) {
    const taken = (["token", "url"] as const)
      .map((name) => ({ name, flag: takeValueFlag(argv, index, name) }))
      .find(({ flag }) => flag !== undefined);
    if (taken?.flag !== undefined) {
      values[taken.name] = taken.flag.value;
      index = taken.flag.next;
      continue;
    }
    const named = daemonFlagNamed(argv[index] as string);
    if (named === undefined) rest.push(argv[index] as string);
    else if (daemonFlag !== undefined && daemonFlag !== named) {
      throw new UsageError("--gateway and --local cannot be used together");
    } else daemonFlag = named;
    index++;
  }
  if (values.url !== undefined && daemonFlag !== undefined) {
    throw new UsageError("--url cannot be used with --local or --gateway");
  }
  return { daemonFlag, rest, token: values.token, url: values.url };
}

/** why: the ports barrel is loaded here, not statically, so `simlock --help` answers without
 * touching it; only a real command builds an environment. A `SIMLOCK_HOME` whose socket path
 * exceeds the platform limit throws `SocketPathTooLongError`, and this runs inside `runCli`'s
 * try, where that throw becomes the single structured error line the CLI reference promises instead
 * of a raw stack trace. */
async function buildDefaultEnvironment(flag: DaemonFlag): Promise<CliEnvironment> {
  const [
    { join, dirname },
    { fileURLToPath },
    ports,
    { buildCliEnvironment },
    { homedir, userInfo },
  ] = await Promise.all([
    import("node:path"),
    import("node:url"),
    import("../ports/index.js"),
    import("./environment.js"),
    import("node:os"),
  ]);
  const {
    launcherFor,
    NodeFilesystem,
    NodeIpcTransport,
    NodeProcessRunner,
    NodeSystemStats,
    SystemClock,
    productionServiceManager,
    resolveDaemonHome,
    resolveSimlockHome,
  } = ports;
  const root = resolveSimlockHome(process.env);
  const filesystem = new NodeFilesystem();
  const daemonHome = await resolveDaemonHome({ root, flag, filesystem });
  const mainPath = join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js");
  const serviceManager = productionServiceManager(process.platform, {
    runner: new NodeProcessRunner(),
    filesystem,
    uid: process.getuid?.() ?? 0,
  });
  return buildCliEnvironment(
    {
      filesystem,
      clock: new SystemClock(),
      systemStats: new NodeSystemStats(),
      ipc: new NodeIpcTransport(),
      launcher: launcherFor({
        role: daemonHome.role,
        root,
        dataDirectory: daemonHome.dataDirectory,
        mainPath,
        serviceManager,
        notify: (line) => process.stderr.write(`${line}\n`),
      }),
      daemonHome,
      homeDirectory: homedir(),
      workingDirectory: process.cwd(),
      codexHome: process.env.CODEX_HOME,
      hostPlatform: process.platform,
      processRunner: new NodeProcessRunner(),
      runTool: async (bin, args, options) => {
        const { toolRunner } = await import("../instructions/index.js");
        return toolRunner(new NodeProcessRunner())(bin, args, options);
      },
      service: {
        manager: serviceManager,
        platform: process.platform,
        home: homedir(),
        user: () => userInfo().username,
        root,
        nodePath: process.execPath,
        mainPath,
      },
    },
    process.env,
  );
}

// why: remote mode is the URL without an explicit `--local` or `--gateway`, which beats a `SIMLOCK_URL` left over in the shell.
function remoteFarm(
  url: string | undefined,
  token: string | undefined,
  daemonFlag: DaemonFlag,
): RemoteFarm | undefined {
  return url !== undefined && daemonFlag === undefined ? { token, url } : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

const GATEWAY_EXEMPT_PATHS: readonly (readonly string[])[] = [
  ["daemon", "start"],
  ["daemon", "install"],
  ["daemon", "uninstall"],
  ["config", "set"],
  ["mcp"],
  ["instructions"],
  ["setup"],
];

// why: these commands act on the machine they run on (ADR 0081 §3), so with a farm's URL they have no machine to act on and stop before any connect.
const REMOTE_REFUSED_PATHS: readonly (readonly string[])[] = [
  ["daemon", "start"],
  ["daemon", "stop"],
  ["daemon", "status"],
  ["daemon", "logs"],
  ["daemon", "install"],
  ["daemon", "uninstall"],
  ["config", "set"],
  ["setup"],
];

function refuseInRemoteMode(path: readonly string[], rest: readonly string[]): void {
  if (!REMOTE_REFUSED_PATHS.some((refused) => refused.join(" ") === path.join(" "))) return;
  if (rest.some(isHelp)) return;
  throw new UsageError(
    `\`simlock ${path.join(" ")}\` acts on this machine; it does not run with --url or SIMLOCK_URL. Run it on the daemon's machine, or unset SIMLOCK_URL.`,
  );
}

const GATEWAY_ALSO_HERE_HINT =
  "A gateway also runs on this machine: run the command again with --gateway.";

async function gatewayHintFor(
  environment: CliEnvironment | undefined,
  daemonFlag: DaemonFlag,
  remote: RemoteFarm | undefined,
  error: unknown,
): Promise<string | undefined> {
  // why: in remote mode the refusal came from the farm, so a gateway on this machine is not the one to run the command again on.
  if (environment === undefined || daemonFlag === "gateway" || remote !== undefined) {
    return undefined;
  }
  if (environment.daemonHome.role !== "worker" || !environment.daemonHome.gatewayPresent) {
    return undefined;
  }
  const { isSimlockError } = await import("../contract/index.js");
  return isSimlockError(error) && error.code === "UNSUPPORTED_IN_WORKER_MODE"
    ? GATEWAY_ALSO_HERE_HINT
    : undefined;
}

async function refuseWhenNoGateway(
  environment: CliEnvironment,
  path: readonly string[],
  rest: readonly string[],
): Promise<void> {
  if (environment.daemonHome.gatewayPresent) return;
  if (GATEWAY_EXEMPT_PATHS.some((exempt) => exempt.join(" ") === path.join(" "))) return;
  // why: `adb` and `simctl` have no help of their own and hand every argument to the tool, so a `-h` after them is never a help request.
  const passthrough = path[0] === "adb" || path[0] === "simctl";
  if (!passthrough && rest.some(isHelp)) return;
  const { gatewayNotPresentError } = await import("../contract/index.js");
  throw gatewayNotPresentError();
}

export async function runCli(
  argv: readonly string[],
  environment?: CliEnvironment,
): Promise<number> {
  let resolved = environment;
  let flag: DaemonFlag;
  let remote: RemoteFarm | undefined;
  try {
    const { token, url: urlFlag, daemonFlag, rest } = extractGlobalFlags(argv);
    flag = daemonFlag;
    if (rest[0] === "--version" || rest[0] === "-v") {
      // why: loaded here, not statically, so only this request pays for the ports barrel, as a real command does.
      const { readPackageVersion } = await import("../ports/index.js");
      (environment?.stdout ?? process.stdout).write(`${readPackageVersion()}\n`);
      return 0;
    }
    if (rest.length === 0 || isHelp(rest[0])) {
      (environment?.stdout ?? process.stdout).write(`${USAGE}\n`);
      return 0;
    }
    const command = await resolveCommand(COMMANDS, rest);
    if (command === undefined)
      throw new UsageError(withHelpHint(`Unknown command: ${String(rest[0])}`));
    resolved = environment ?? (await buildDefaultEnvironment(daemonFlag));
    if (daemonFlag === "gateway") await refuseWhenNoGateway(resolved, command.path, command.rest);
    const url = urlFlag ?? nonEmpty(resolved.tunnelUrl);
    remote = remoteFarm(url, token ?? resolved.tunnelToken, daemonFlag);
    if (remote !== undefined) refuseInRemoteMode(command.path, command.rest);
    return await command.module.run(command.rest, {
      path: command.path,
      environment: remote === undefined ? resolved : { ...resolved, remote },
      token,
      url,
      daemonFlag,
    });
  } catch (error: unknown) {
    await writeError(
      (value) => (environment?.stderr ?? process.stderr).write(value),
      error,
      await gatewayHintFor(resolved, flag, remote, error),
    );
    return await errorExitCode(error);
  }
}
