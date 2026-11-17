import { join } from "node:path";
import { type DaemonMode, type ServiceCheck } from "../core/index.js";
import {
  JsonLinesLogger,
  NodeFileLogSink,
  type Logger,
  type ServiceDefinition,
  type ServiceManager,
  daemonDataDirectory,
  resolveSimlockHome,
  SystemClock,
} from "../ports/index.js";
import { DaemonAlreadyRunningError } from "./connection-host.js";

export function parseDaemonArgv(argv: readonly string[]): DaemonMode | undefined {
  if (argv.length === 0) return "worker";
  if (argv.length === 1 && argv[0] === "--gateway") return "gateway";
  return undefined;
}

/**
 * why: best-effort logger for the fatal startup handler below. It cannot depend on the
 * daemon's own `Config` — that is exactly what may have failed to load — so it always
 * writes to the daemon's own folder at a fixed level.
 */
function createFatalLogger(
  role: DaemonMode | undefined,
  level: "error" | "info" = "error",
): Logger {
  return new JsonLinesLogger({
    clock: new SystemClock(),
    level,
    module: "daemon",
    sink: new NodeFileLogSink({
      path: join(daemonDataDirectory(resolveSimlockHome(), role ?? "worker"), "daemon.log"),
    }),
  });
}

export function logAlreadyRunning(role: DaemonMode, error: DaemonAlreadyRunningError): void {
  try {
    createFatalLogger(role, "info").info("Daemon already running", { socket: error.endpoint });
  } catch {
    // why: logging itself failed, so the line goes to the console rather than being swallowed.
    console.error(error.message);
  }
}

export function logFatalStart(role: DaemonMode | undefined, message: string, extra: object): void {
  try {
    createFatalLogger(role).error("Daemon failed to start", { message, ...extra });
  } catch {
    // why: logging itself failed (e.g. an unwritable data directory), so the failure goes to the console rather than being swallowed.
    console.error(message);
  }
  process.exitCode = 1;
}

/** why: only a worker has a service check; a gateway and an unsupported platform (no manager) have none. */
export function serviceCheckFor(
  role: DaemonMode,
  manager: ServiceManager | undefined,
  definition: () => ServiceDefinition,
): { readonly serviceCheck?: ServiceCheck } {
  if (manager === undefined || role !== "worker") return {};
  const { name } = definition();
  return {
    serviceCheck: {
      manager: manager.manager,
      name,
      check: async () => {
        const state = await manager.state(definition());
        return state.state === "broken" ? state.missing : [];
      },
    },
  };
}

/** why: the process facts the production service check reads, injectable so a test can prove the definition it builds. */
export interface ServiceCheckHost {
  readonly manager: ServiceManager | undefined;
  readonly root: string;
  readonly home: string;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly env: NodeJS.ProcessEnv;
}
