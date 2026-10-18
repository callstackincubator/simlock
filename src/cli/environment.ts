// why: nothing heavy is imported statically here -- `loadConfig`, the module registry, the
// event-file reader and the admin client load inside the closures that use them, so building
// an environment costs what it always cost while loading this file costs almost nothing.
import { join } from "node:path";

import { resolveRequesterId } from "../agent-identity/index.js";
import type { SimlockAdminClient } from "../admin/index.js";
import type { ConfigOverrides, ModuleConfigEntry } from "../core/index.js";
import type {
  Clock,
  DaemonLauncher,
  Filesystem,
  IpcConnection,
  IpcConnector,
  ParentWatch,
  ParentWatchHandle,
} from "../ports/index.js";
import { errorMessage } from "./errors.js";
import { readLogFile } from "./log-file.js";
import { readPipedStdin } from "./stdio.js";
import type { CliEnvironment, CliEnvironmentPorts } from "./types.js";

class AutoLaunchIpcConnector implements IpcConnector {
  constructor(
    private readonly ipc: IpcConnector,
    private readonly clock: Clock,
    private readonly launcher: DaemonLauncher,
    private readonly checkConfig: () => Promise<void>,
  ) {}

  async connect(endpoint: string): Promise<IpcConnection> {
    try {
      return await this.ipc.connect(endpoint);
    } catch (error: unknown) {
      if (!(await isUnavailable(error))) throw error;
    }
    await this.checkConfig();
    await this.launcher.launch();
    // why: the constant lives behind the ports barrel, which loads on the first connection that needs it.
    const { DAEMON_STARTUP_TIMEOUT_MS } = await import("../ports/index.js");
    const deadline = this.clock.now() + DAEMON_STARTUP_TIMEOUT_MS;
    let lastError: unknown;
    while (this.clock.now() < deadline) {
      try {
        return await this.ipc.connect(endpoint);
      } catch (error: unknown) {
        if (!(await isUnavailable(error))) throw error;
        lastError = error;
        await new Promise<void>((resolve) => this.clock.setTimer(50, resolve));
      }
    }
    const { SimlockError } = await import("../contract/index.js");
    throw new SimlockError(
      "DAEMON_STARTUP_FAILED",
      "transport",
      `Timed out starting simlock daemon: ${errorMessage(lastError)}`,
      {},
    );
  }
}

/** why: the class lives behind the ports barrel, which this module must not load at CLI start;
 * the name check picks the candidate and `instanceof` against the real class proves it. */
async function isUnavailable(error: unknown): Promise<boolean> {
  if (!(error instanceof Error) || error.name !== "IpcError") return false;
  const { IpcError } = await import("../ports/index.js");
  return (
    error instanceof IpcError &&
    (error.code === "connection-refused" || error.code === "endpoint-not-found")
  );
}

async function moduleConfigEntries(): Promise<readonly ModuleConfigEntry[]> {
  const { optionalModules } = await import("../module-registry/index.js");
  return optionalModules.map(({ config, name }) => ({ name, ...config }));
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

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Daemon returned an invalid response");
  return value as Record<string, unknown>;
}

/** why: the default parent watcher is the ports' Node adapter, and the barrel behind it loads
 * with every port the CLI never uses; this stands in until a command actually watches a parent,
 * which only `lease` (through `termination.ts`) ever does. */
function lazyNodeParentWatch(): ParentWatch {
  let started: Promise<ParentWatch> | undefined;
  return {
    watch(pid: number, onExit: () => void): ParentWatchHandle {
      let stopped = false;
      let inner: ParentWatchHandle | undefined;
      started ??= import("../ports/index.js").then(({ NodeParentWatch }) => new NodeParentWatch());
      // why: a failed load means no parent watch, never a crash: the lease keeps renewing and
      // ends only by signal or `simlock release` -- degraded, like a watch that misses its exit.
      void started.then(
        (watcher) => {
          if (stopped) return;
          inner = watcher.watch(pid, onExit);
        },
        () => undefined,
      );
      return {
        stop: () => {
          stopped = true;
          inner?.stop();
        },
      };
    },
  };
}

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
  const autoLaunchIpc = new AutoLaunchIpcConnector(ipc, clock, launcher, async () => {
    const { loadConfig } = await import("../core/index.js");
    await loadConfig({
      configPath,
      filesystem,
      modules: await moduleConfigEntries(),
      systemStats,
    });
  });

  const connect = async (
    connector: IpcConnector,
    resolveCredential: () => Promise<string | undefined>,
  ): Promise<SimlockAdminClient> => {
    const [{ connectSimlockAdmin }, { resolveDaemonSocketPath }] = await Promise.all([
      import("../admin/index.js"),
      import("../ports/index.js"),
    ]);
    // why: Resolved here rather than once during construction, because it can throw: a
    // `SIMLOCK_HOME` whose socket path exceeds the platform limit is a `SocketPathTooLongError`.
    // Every consumer of this path is behind a command already inside `runCli`'s own try, where
    // that throw becomes the single structured error line `docs/CLI.md` promises instead of a
    // raw stack trace, and `simlock --help` (which needs no socket at all) never resolves it.
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
    parentWatch: ports.parentWatch ?? lazyNodeParentWatch(),
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    runPassthrough:
      ports.runPassthrough ??
      ((command) =>
        import("./passthrough.js").then(({ spawnPassthrough }) => spawnPassthrough(command))),
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
      const [{ loadConfig }, { MemoryFilesystem }] = await Promise.all([
        import("../core/index.js"),
        import("../ports/index.js"),
      ]);
      const unknownKeyWarnings: string[] = [];
      await loadConfig({
        configPath: "/config-set-validation.json",
        filesystem: new MemoryFilesystem(),
        modules: await moduleConfigEntries(),
        overrides: merged as ConfigOverrides,
        systemStats,
        warn: (message) => {
          if (message.startsWith("Unknown config key:")) unknownKeyWarnings.push(message);
        },
      });
      if (unknownKeyWarnings.length > 0) throw new Error(unknownKeyWarnings.join("; "));
    },
    readLogFile: async () => readLogFile(filesystem, logPath),
    followLogFile: async () => {
      const { followLog } = await import("./follow-log.js");
      return followLog({
        clock,
        filesystem,
        path: logPath,
        signals: ports.signals ?? process,
        write: (text: string) => (ports.stdout ?? process.stdout).write(text),
      });
    },
    readEventFile: async (sinceTs) => {
      const { EVENT_FILE_NAME, readEventFile } = await import("../bus/index.js");
      return readEventFile(filesystem, join(dataDirectory, EVENT_FILE_NAME), { sinceTs });
    },
    signals: ports.signals ?? process,
    stderr: ports.stderr ?? process.stderr,
    stdout: ports.stdout ?? process.stdout,
    confirm: ports.confirm ?? confirmTerminal,
  };
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
