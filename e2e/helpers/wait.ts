/**
 * The only timing primitive in this suite: no test or helper may `sleep`/fixed-delay.
 * Everything that needs "wait until X" polls a predicate through this function.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: {
    readonly timeout?: number;
    readonly interval?: number;
    /** Evaluated lazily, only on timeout, so it can report the real last-observed state. */
    readonly label?: string | (() => string);
  } = {},
): Promise<void> {
  const timeout = options.timeout ?? 30_000;
  const interval = options.interval ?? 100;
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  for (;;) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error: unknown) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeout}ms${labelSuffix(options.label)}${causeSuffix(lastError)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function labelSuffix(label: string | (() => string) | undefined): string {
  const resolved = typeof label === "function" ? label() : label;
  return resolved === undefined ? "" : ` (${resolved})`;
}

function causeSuffix(error: unknown): string {
  if (error === undefined) return "";
  return `: ${error instanceof Error ? error.message : String(error)}`;
}
