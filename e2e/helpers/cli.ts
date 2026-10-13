import { spawn } from "node:child_process";
import { join } from "node:path";

import { REPO_ROOT } from "./repo-root.js";

const CLI_ENTRY = join(REPO_ROOT, "dist/cli/main.js");

export interface CliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
  readonly entry?: string;
}

export interface CliError {
  readonly code: string;
  readonly message: string;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed stdout, when it is exactly one line of JSON (most commands' success output). */
  readonly json: unknown;
  /** Parsed `{"error":{code,message}}` stderr line -- the CLI's documented failure contract. */
  readonly error: CliError | undefined;
}

/**
 * Runs one `simlock` CLI invocation to completion. Exit-code and structured-error
 * assertions read as one-liners: `expect((await cli(env, [...])).code).toBe(13)`.
 */
export function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: CliOptions = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.entry ?? CLI_ENTRY, ...args], {
      env: { ...env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`simlock ${args.join(" ")} timed out after ${options.timeout}ms`));
          }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.once("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout, stderr, ...parseOutputs(stdout, stderr) });
    });
  });
}

export interface CliBackgroundHandle {
  /** Resolves with the first stdout line -- the lease grant JSON in held mode. */
  firstStdoutLine(timeout?: number): Promise<string>;
  /** The stderr progress JSON lines observed so far, in order. */
  progressEvents(): readonly unknown[];
  /** Everything written to stdout so far, for a process that streams until it is stopped. */
  stdoutSoFar(): string;
  waitForExit(timeout?: number): Promise<CliResult>;
  kill(signal?: NodeJS.Signals): void;
  readonly pid: number | undefined;
}

export function cliBackground(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: CliOptions = {},
): CliBackgroundHandle {
  const child = spawn(process.execPath, [options.entry ?? CLI_ENTRY, ...args], {
    env: { ...env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  const progress: unknown[] = [];
  const stdoutWaiters: { resolve(line: string): void; reject(error: Error): void }[] = [];
  let firstLineSeen: string | undefined;
  let exitedWithoutLine: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (firstLineSeen === undefined && stdout.includes("\n")) {
      firstLineSeen = stdout.slice(0, stdout.indexOf("\n"));
      for (const waiter of stdoutWaiters.splice(0)) waiter.resolve(firstLineSeen);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        progress.push(JSON.parse(line));
      } catch {
        // Non-JSON stderr noise is preserved in `stderr` but not treated as progress.
      }
    }
  });

  // Subscribed at spawn time, not lazily on the first waitForExit(): a process that
  // ends on its own -- a held `lease` whose lease the daemon took back, say -- can
  // emit "close" while the test is still asserting on its output, and a listener
  // attached after the fact never fires. That would time out as "process never
  // exited" when it had in fact already exited.
  const exited = new Promise<CliResult>((resolve) => {
    // A process that dies before printing would otherwise surface only as a timeout, a minute
    // later and without its stderr. "close", not "exit": it comes after the last stdout chunk,
    // so a line printed just before exiting has already been seen and its waiters resolved. A
    // failed spawn emits "close" too.
    child.once("close", (code, signal) => {
      exitedWithoutLine = new Error(
        `simlock ${args.join(" ")} exited with code ${code}, signal ${signal} before printing a stdout line; stderr: ${stderr.trim() || "(empty)"}`,
      );
      for (const waiter of stdoutWaiters.splice(0)) waiter.reject(exitedWithoutLine);
      resolve({ code, stdout, stderr, ...parseOutputs(stdout, stderr) });
    });
  });
  const exit = (): Promise<CliResult> => exited;

  return {
    pid: child.pid,
    stdoutSoFar: () => stdout,
    async firstStdoutLine(timeout = 30_000) {
      if (firstLineSeen !== undefined) return firstLineSeen;
      if (exitedWithoutLine !== undefined) throw exitedWithoutLine;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeout}ms waiting for first stdout line`));
        }, timeout);
        stdoutWaiters.push({
          resolve(line) {
            clearTimeout(timer);
            resolve(line);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    progressEvents: () => [...progress],
    async waitForExit(timeout = 30_000) {
      return Promise.race([
        exit(),
        new Promise<CliResult>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Timed out after ${timeout}ms waiting for exit`)),
            timeout,
          );
        }),
      ]);
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
    },
  };
}

function parseOutputs(
  stdout: string,
  stderr: string,
): { json: unknown; error: CliError | undefined } {
  const json = parseSoleJsonLine(stdout);
  // A failing command's stderr is documented to carry exactly one structured error
  // line, but a request that got as far as queueing/provisioning first writes
  // progress lines on the same stream -- so search all lines, not just a sole one,
  // and prefer the last match (the final error, after any progress).
  const error = stderr
    .split("\n")
    .map((line) => parseJsonLine(line))
    .filter((value): value is Record<string, unknown> => isErrorEnvelope(value))
    .map((envelope) => envelope.error as CliError)
    .at(-1);
  return { json, error };
}

function parseSoleJsonLine(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n")) return undefined;
  return parseJsonLine(trimmed);
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isErrorEnvelope(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "error" in value;
}
