// why: nothing heavy is imported statically -- `--help`, an unknown command and a bad flag are
// answered without loading any component, and a `SimlockError` can only arrive from a path that
// already loaded the module that raises it, so the `../contract/index.js` lookup is a cache hit
// whenever it matters.
import { UsageError } from "./usage-error.js";

export { UsageError, withHelpHint } from "./usage-error.js";

/** why: resolved on first use -- loading the ports barrel for its one error class at CLI start
 * is exactly what the lazy command tree exists to avoid. A name check picks the candidate;
 * `instanceof` against the real class proves it. */
async function isSocketPathTooLong(error: unknown): Promise<boolean> {
  if (!(error instanceof Error) || error.name !== "SocketPathTooLongError") return false;
  const { SocketPathTooLongError } = await import("../ports/index.js");
  return error instanceof SocketPathTooLongError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeError(write: (value: string) => unknown, error: unknown): Promise<void> {
  await write(
    `${JSON.stringify({ error: { code: await cliErrorCode(error), message: errorMessage(error) } })}\n`,
  );
}

async function cliErrorCode(error: unknown): Promise<string> {
  if (error instanceof UsageError) return "USAGE";
  if (await isSocketPathTooLong(error)) return "USAGE";
  const { isSimlockError } = await import("../contract/index.js");
  if (isSimlockError(error)) return error.code;
  return "INTERNAL";
}

export async function errorExitCode(error: unknown): Promise<number> {
  if (error instanceof UsageError) return 2;
  if (await isSocketPathTooLong(error)) return 2;
  const { ERROR_TABLE, isSimlockError } = await import("../contract/index.js");
  if (isSimlockError(error)) return ERROR_TABLE[error.code].cliExitCode;
  return 1;
}

export async function asDaemonRefusal(error: unknown): Promise<unknown> {
  const { isSimlockError } = await import("../contract/index.js");
  return isSimlockError(error) && error.kind !== "transport" ? error : undefined;
}

export async function asUsageIfRefused(error: unknown): Promise<unknown> {
  const { isSimlockError } = await import("../contract/index.js");
  if (
    isSimlockError(error) &&
    (error.code === "PASSTHROUGH_REFUSED" || error.code === "UNKNOWN_PASSTHROUGH_TOOL")
  ) {
    return new UsageError(error.message);
  }
  return error;
}
