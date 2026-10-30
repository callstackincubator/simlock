import { parseArgs } from "node:util";

import { UsageError, errorMessage, withHelpHint } from "./errors.js";
import type { Output } from "./types.js";

export { UsageError, withHelpHint } from "./errors.js";

export function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

export function commandArgs(
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

export function requiredPositional(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined)
    throw new UsageError(withHelpHint(`Expected ${label}`));
  return positionals[0];
}

export function writeResult(write: (value: string) => unknown, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

/** why: a parent node may or may not have consumed its child word -- a flag in that position
 * reaches the module as the first argument -- so one function decides where the subcommand word
 * is and what is left to parse, rather than each parent guessing again. */
export function subcommand(
  argv: readonly string[],
  path: readonly string[],
): { readonly command: string | undefined; readonly flagArgs: readonly string[] } {
  if (path.length > 1) return { command: path[1] as string, flagArgs: argv };
  return { command: argv[0], flagArgs: argv.slice(1) };
}

/** why: six parents (`component`, `device`, `token`, `worker`, `alerts`, `warm`) answer a bare word or a `--help` in the subcommand's position by printing
 * their own usage and exiting 0, so the answer lives here once instead of in each parent
 * (architecture rule 10); a parent whose bare word means something else (`config` prints the
 * config, `daemon` answers its own usage below) reads `subcommand` and decides itself. */
export function subcommandOrUsage(
  argv: readonly string[],
  path: readonly string[],
  stdout: Output,
  usage: string,
): { readonly command: string; readonly flagArgs: readonly string[] } | 0 {
  const { command, flagArgs } = subcommand(argv, path);
  if (command === undefined || isHelp(command)) {
    stdout.write(usage);
    return 0;
  }
  return { command, flagArgs };
}
