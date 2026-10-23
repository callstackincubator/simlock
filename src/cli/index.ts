// why: this file imports no component for a value -- the command's modules load on a tree hit
// and the default environment builds only once a command runs -- so `--help` and a usage error
// are answered without loading the control plane (see `lazy-loading.test.ts`).
import { COMMANDS, resolveCommand } from "./tree.js";
import { errorExitCode, UsageError, withHelpHint, writeError } from "./errors.js";
import type { DaemonFlag } from "../ports/index.js";
import type { CliEnvironment } from "./types.js";

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
  instructions [--json]       Print the rules an agent must follow, for its prompt
Run 'simlock <command> --help' for command usage.

Pass --token <secret> anywhere on the command line to connect as admin
explicitly; see https://github.com/callstackincubator/simlock for the default
resolution order.

Pass --gateway anywhere on the command line to reach this machine's gateway in place of its worker.
Pass --local anywhere on the command line to reach this machine's worker even when only a gateway has run here.`;

function daemonFlagNamed(arg: string): "gateway" | "local" | undefined {
  for (const name of ["gateway", "local"] as const) {
    if (arg === `--${name}`) return name;
    if (arg.startsWith(`--${name}=`)) throw new UsageError(`--${name} takes no value`);
  }
  return undefined;
}

function extractGlobalFlags(argv: readonly string[]): {
  readonly token: string | undefined;
  readonly daemonFlag: DaemonFlag;
  readonly rest: string[];
} {
  const rest: string[] = [];
  let token: string | undefined;
  let daemonFlag: DaemonFlag;
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
    const named = daemonFlagNamed(arg);
    if (named !== undefined) {
      if (daemonFlag !== undefined && daemonFlag !== named) {
        throw new UsageError("--gateway and --local cannot be used together");
      }
      daemonFlag = named;
      continue;
    }
    rest.push(arg);
  }
  return { token, daemonFlag, rest };
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
];

const GATEWAY_ALSO_HERE_HINT =
  "A gateway also runs on this machine: run the command again with --gateway.";

async function gatewayHintFor(
  environment: CliEnvironment | undefined,
  daemonFlag: DaemonFlag,
  error: unknown,
): Promise<string | undefined> {
  if (environment === undefined || daemonFlag === "gateway") return undefined;
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
  try {
    const { token, daemonFlag, rest } = extractGlobalFlags(argv);
    flag = daemonFlag;
    if (rest.length === 0 || isHelp(rest[0])) {
      (environment?.stdout ?? process.stdout).write(`${USAGE}\n`);
      return 0;
    }
    const command = await resolveCommand(COMMANDS, rest);
    if (command === undefined)
      throw new UsageError(withHelpHint(`Unknown command: ${String(rest[0])}`));
    resolved = environment ?? (await buildDefaultEnvironment(daemonFlag));
    if (daemonFlag === "gateway") await refuseWhenNoGateway(resolved, command.path, command.rest);
    return await command.module.run(command.rest, {
      path: command.path,
      environment: resolved,
      token,
      daemonFlag,
    });
  } catch (error: unknown) {
    await writeError(
      (value) => (environment?.stderr ?? process.stderr).write(value),
      error,
      await gatewayHintFor(resolved, flag, error),
    );
    return await errorExitCode(error);
  }
}
