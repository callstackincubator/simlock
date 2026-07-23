import { homedir } from "node:os";
import { join } from "node:path";

import { confirm as clackConfirm, isCancel, log } from "@clack/prompts";
import pc from "picocolors";

import { NodeFilesystem } from "../ports/index.js";
import {
  assertStrictBooleanFlagSyntax,
  renderHelp,
  rootCommand,
  runTopCommand,
} from "./commands.js";
import { connectDaemon, connectExistingDaemon } from "./client.js";
import { isUsageError } from "./errors.js";
import { DaemonClientError, type DaemonConnection } from "./protocol.js";
import { HumanRenderer, JsonRenderer, requireObject, type Renderer } from "./render.js";

export { DaemonClientError, type DaemonConnection } from "./protocol.js";
export { parseDuration } from "./duration.js";

const DAEMON_ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  BAD_FRAME: 2,
  BAD_REQUEST: 2,
  NO_CAPACITY: 11,
  NO_DRIVER: 12,
  QUEUE_TIMEOUT: 10,
  RUNTIME_MISSING: 12,
  UNKNOWN_MODEL: 12,
};

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
  readonly noColor?: () => boolean;
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
    noColor: () => Boolean(process.env.NO_COLOR),
    readConfigFile: async () => {
      if (!(await filesystem.exists(configPath))) return {};
      return requireObject(JSON.parse(await filesystem.readFile(configPath)) as unknown);
    },
    readLogFile: async () => filesystem.readFile(logPath),
    signals: process,
    stderr: process.stderr,
    stdout: process.stdout,
    confirm:
      process.stdout.isTTY === true
        ? (question) => confirmInteractive(question, () => Boolean(process.env.NO_COLOR))
        : confirmTerminal,
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
    assertStrictBooleanFlagSyntax(argv);
    if (argv.length === 0 || isHelp(argv[0])) {
      renderer.info(await renderHelp(rootCommand));
      return 0;
    }
    return await runTopCommand(argv[0] as string, argv.slice(1), { environment, renderer });
  } catch (error: unknown) {
    renderer.error(errorMessage(error));
    if (isUsageError(error)) renderer.usage(await renderHelp(rootCommand));
    return errorExitCode(error);
  }
}

export function errorExitCode(error: unknown): number {
  if (isUsageError(error)) return 2;
  if (error instanceof DaemonClientError) return DAEMON_ERROR_EXIT_CODES[error.code] ?? 1;
  return 1;
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
async function confirmInteractive(question: string, noColor: () => boolean): Promise<boolean> {
  const colors = pc.createColors(!noColor());
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
