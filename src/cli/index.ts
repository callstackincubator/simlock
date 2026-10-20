// why: this file imports no component for a value -- the command's modules load on a tree hit
// and the default environment builds only once a command runs -- so `--help` and a usage error
// are answered without loading the control plane (see `lazy-loading.test.ts`).
import { COMMANDS, resolveCommand } from "./tree.js";
import { errorExitCode, UsageError, withHelpHint, writeError } from "./errors.js";
import type { CliEnvironment } from "./types.js";

export type { CliEnvironment, CliEnvironmentPorts } from "./types.js";
/** why: re-exported, not re-implemented, so another edge enters the CLI through its index;
 * `environment.js` loads only the identity resolver and the CLI's own cheap helpers, measured
 * against the same fast path, so this costs `simlock --help` nothing. */
export { buildCliEnvironment } from "./environment.js";

const USAGE = `Usage: simlock <command> [options]

Commands:
  lease, release, status, list, catalog, cleanup, doctor, nuke, events, stats,
  daemon, config, token, whoami
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

/** why: the ports barrel is loaded here, not statically, so `simlock --help` answers without
 * touching it; only a real command builds an environment. A `SIMLOCK_HOME` whose socket path
 * exceeds the platform limit throws `SocketPathTooLongError`, and this runs inside `runCli`'s
 * try, where that throw becomes the single structured error line `docs/CLI.md` promises instead
 * of a raw stack trace. */
async function buildDefaultEnvironment(): Promise<CliEnvironment> {
  const [{ join, dirname }, { fileURLToPath }, ports, { buildCliEnvironment }] = await Promise.all([
    import("node:path"),
    import("node:url"),
    import("../ports/index.js"),
    import("./environment.js"),
  ]);
  const {
    NodeDaemonLauncher,
    NodeFilesystem,
    NodeIpcTransport,
    NodeSystemStats,
    SystemClock,
    resolveSimlockHome,
  } = ports;
  const dataDirectory = resolveSimlockHome(process.env);
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
    process.env,
  );
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

export async function runCli(
  argv: readonly string[],
  environment?: CliEnvironment,
): Promise<number> {
  try {
    if (argv.length === 0 || isHelp(argv[0])) {
      (environment?.stdout ?? process.stdout).write(`${USAGE}\n`);
      return 0;
    }
    const { token, rest } = extractGlobalToken(argv);
    const command = await resolveCommand(COMMANDS, rest);
    if (command === undefined)
      throw new UsageError(withHelpHint(`Unknown command: ${String(rest[0])}`));
    return await command.module.run(command.rest, {
      path: command.path,
      environment: environment ?? (await buildDefaultEnvironment()),
      token,
    });
  } catch (error: unknown) {
    await writeError((value) => (environment?.stderr ?? process.stderr).write(value), error);
    return await errorExitCode(error);
  }
}
