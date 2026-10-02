import type { ComponentInstallProgress } from "../core/driver.js";
import type { Clock, ProcessHandle, ProcessResult, ProcessRunner } from "../ports/index.js";

// A platform installer ignoring `SIGTERM` must not hold an aborted install open: after this long
// it gets `SIGKILL`, the same escalation `NodeProcessRunner.run` applies to a timeout.
const SIGTERM_TO_SIGKILL_GRACE_MS = 10_000;
// How long to keep reading output lines after the process ended. Lines already captured are
// read in microtasks; this only bounds a pipe some grandchild still holds open.
const OUTPUT_DRAIN_MS = 1_000;

export interface InstallerProcessOptions {
  readonly onProgress: (progress: ComponentInstallProgress) => void;
  readonly signal: AbortSignal;
  /** Written to stdin, then closed: `sdkmanager --licenses`'s `y` answers. */
  readonly input?: string;
}

/**
 * How an installer process ended. `stopped` means `signal` fired and the process was ended for
 * it; `result` is then whatever the killed process left.
 */
export interface InstallerProcessOutcome {
  readonly result: ProcessResult;
  readonly stopped: boolean;
}

/**
 * Runs one platform installer (`xcodebuild -downloadPlatform`, `sdkmanager --install`) with no
 * timeout of its own -- the caller's budget is `ComponentInstaller`'s, and reaches this process
 * only through `signal`, which ends it. Every output line, ended at `\n` or at a bare `\r`, is
 * scanned for a percentage and reported as progress; a line with none yields nothing. Shared by both drivers so the two
 * cannot end or read their installers differently.
 */
export async function runInstallerProcess(
  runner: ProcessRunner,
  clock: Clock,
  command: string,
  args: readonly string[],
  options: InstallerProcessOptions,
): Promise<InstallerProcessOutcome> {
  if (options.signal.aborted) {
    return { result: { code: null, stderr: "", stdout: "" }, stopped: true };
  }
  // Installers redraw their progress bar in place with a bare `\r`; ending a line there is what
  // lets each redraw be read as it happens instead of all at once when the process exits.
  const handle = runner.spawn(command, args, {
    lineEnd: "carriage-return-too",
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  let killTimer: ReturnType<Clock["setTimer"]> | undefined;
  const stop = (): void => {
    killQuietly(handle, "SIGTERM");
    killTimer = clock.setTimer(SIGTERM_TO_SIGKILL_GRACE_MS, () => {
      killQuietly(handle, "SIGKILL");
    });
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const reading = Promise.all([
    reportProgress(handle.stdout, options.onProgress),
    reportProgress(handle.stderr, options.onProgress),
  ]);
  try {
    const result = await handle.wait();
    await drained(clock, reading);
    return { result, stopped: options.signal.aborted };
  } finally {
    options.signal.removeEventListener("abort", stop);
    if (killTimer !== undefined) clock.cancel(killTimer);
  }
}

/** The last percentage printed on a line, e.g. `12.5` from `Downloading iOS 18.0: 12.5%`. */
function parseProgressPercent(line: string): number | undefined {
  const matches = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return undefined;
  const percent = Number.parseFloat(last);
  return percent >= 0 && percent <= 100 ? percent : undefined;
}

async function reportProgress(
  lines: AsyncIterable<string>,
  onProgress: (progress: ComponentInstallProgress) => void,
): Promise<void> {
  for await (const line of lines) {
    const percent = parseProgressPercent(line);
    if (percent !== undefined) onProgress({ percent, stage: "downloading" });
  }
}

async function drained(clock: Clock, reading: Promise<unknown>): Promise<void> {
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = clock.setTimer(OUTPUT_DRAIN_MS, resolve);
  });
  try {
    await Promise.race([reading.then(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clock.cancel(timer);
  }
}

function killQuietly(handle: ProcessHandle, signal: NodeJS.Signals): void {
  try {
    handle.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Runs one platform removal (`sdkmanager --uninstall`) like `runInstallerProcess`, with a
 * deadline of its own as well as `signal`: whichever comes first ends the process, `SIGTERM`
 * then `SIGKILL`. `timedOut` says the deadline did it.
 */
export async function runBoundedProcess(
  runner: ProcessRunner,
  clock: Clock,
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<InstallerProcessOutcome & { readonly timedOut: boolean }> {
  const bounded = new AbortController();
  let timedOut = false;
  const timer = clock.setTimer(options.timeoutMs, () => {
    timedOut = true;
    bounded.abort();
  });
  const forward = (): void => {
    bounded.abort();
  };
  if (options.signal.aborted) bounded.abort();
  else options.signal.addEventListener("abort", forward, { once: true });
  try {
    const outcome = await runInstallerProcess(runner, clock, command, args, {
      onProgress: () => undefined,
      signal: bounded.signal,
    });
    return { ...outcome, timedOut };
  } finally {
    clock.cancel(timer);
    options.signal.removeEventListener("abort", forward);
  }
}
