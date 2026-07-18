/** Thrown for bad flags, missing required args, and other CLI usage mistakes; maps to exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * citty throws its own internal `CLIError` (not exported by the package) for a
 * handful of built-in checks (e.g. a required string/positional argument that
 * is missing). We duck-type on `.name` to fold those into the same "usage
 * error" bucket — exit 2, with usage printed — as our own `UsageError`.
 */
export function isUsageError(error: unknown): boolean {
  return error instanceof UsageError || (error instanceof Error && error.name === "CLIError");
}
