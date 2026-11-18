import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type Clock,
  daemonDataDirectory,
  JsonLinesLogger,
  type Logger,
  NodeFileLogSink,
  NodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  resolveSimlockHome,
  SystemClock,
} from "../ports/index.js";

export interface SupervisorDependencies {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  readonly openLog: (path: string) => Logger;
}

interface SupervisorArguments {
  readonly gateway: boolean;
  readonly task: string;
  readonly installId: string;
  readonly environment: Readonly<Record<string, string>>;
}

const RESTART_DELAY_MS = 10_000;
const SCHTASKS_TIMEOUT_MS = 10_000;
const WORD = /^[\w.-]+$/;
const BASE64URL = /^[\w-]+$/;

function decodeEnvironment(text: string): Record<string, string> | undefined {
  if (!BASE64URL.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

/** why: the task's own arguments are the only input, in one fixed order; anything else is a stale or hand-edited task and starts nothing. */
function parseArguments(argv: readonly string[]): SupervisorArguments | undefined {
  const gateway = argv[0] === "--gateway";
  const rest = gateway ? argv.slice(1) : argv;
  const [, task = "", , installId = "", , environmentText = ""] = rest;
  const shaped =
    rest.length === 6 &&
    ["--task", "--install-id", "--environment"].every((flag, index) => rest[index * 2] === flag) &&
    WORD.test(task) &&
    WORD.test(installId);
  const environment = shaped ? decodeEnvironment(environmentText) : undefined;
  return environment === undefined ? undefined : { gateway, task, installId, environment };
}

function describeExit(result: ProcessResult): string {
  return result.signal === undefined ? `code ${String(result.code)}` : `signal ${result.signal}`;
}

export async function runSupervisor(dependencies: SupervisorDependencies): Promise<number> {
  const { clock, runner } = dependencies;
  const parsed = parseArguments(dependencies.argv);
  if (parsed === undefined) return 2;
  const env = { ...dependencies.env, ...parsed.environment };
  const dataDirectory = daemonDataDirectory(
    resolveSimlockHome(env),
    parsed.gateway ? "gateway" : "worker",
  );
  const logPath = join(dataDirectory, "daemon.log");
  const logger = dependencies.openLog(logPath);
  const sleep = (): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimer(RESTART_DELAY_MS, resolve);
    });

  // why: a task that cannot be read in time counts as still there, so a slow Task Scheduler never stops a daemon the user wants.
  const taskIsOurs = async (): Promise<boolean> => {
    let read: ProcessResult;
    try {
      read = await runner.run("schtasks", ["/query", "/tn", parsed.task, "/xml"], {
        timeoutMs: SCHTASKS_TIMEOUT_MS,
      });
    } catch {
      return true;
    }
    if (read.code === null) return true;
    if (read.code !== 0) return false;
    return new RegExp(`--install-id ${parsed.installId.replaceAll(".", "\\.")}(?![\\w.-])`).test(
      read.stdout,
    );
  };

  for (;;) {
    let outcome: string;
    try {
      // why: no timeoutMs: the daemon runs until it exits, the one wait in Simlock with no limit.
      const result = await runner
        .spawn(
          dependencies.nodePath,
          [dependencies.mainPath, ...(parsed.gateway ? ["--gateway"] : [])],
          { env, stdio: { file: logPath } },
        )
        .wait();
      if (result.code === 0) return 0;
      outcome = `Daemon exited (${describeExit(result)})`;
    } catch (error: unknown) {
      outcome = `Daemon failed to start (${error instanceof Error ? error.message : String(error)})`;
    }
    logger.warn(`${outcome}; the service starts it again in 10 s`);
    await sleep();
    if (!(await taskIsOurs())) {
      logger.warn(`The service ${parsed.task} is gone; the supervisor stops`);
      return 0;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const clock = new SystemClock();
  process.exitCode = await runSupervisor({
    argv: process.argv.slice(2),
    env: process.env,
    nodePath: process.execPath,
    mainPath: join(dirname(fileURLToPath(import.meta.url)), "main.js"),
    runner: new NodeProcessRunner(),
    clock,
    openLog: (path) =>
      new JsonLinesLogger({
        clock,
        level: "info",
        module: "supervisor",
        sink: new NodeFileLogSink({ path }),
      }),
  });
}
