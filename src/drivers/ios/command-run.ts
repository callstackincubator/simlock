import { DriverCrashError } from "../../core/index.js";
import type { Clock, Logger, ProcessResult, ProcessRunner } from "../../ports/index.js";
import type { ProcessOutcome } from "./boot-courtesies.js";

/** why: what `runCommand` does with a command it stopped waiting for, instead of killing it at once. */
export interface LateAnswer {
  readonly killAfterMs: number;
  /** why: called once, only after the limit passed; `undefined` when the command was killed or failed to answer. */
  readonly onSettled: (result: ProcessResult | undefined) => void;
}

/** why: one command on one deadline; with `late` it is left running past the deadline, not killed there. */
export async function runCommand(
  processRunner: ProcessRunner,
  clock: Clock,
  command: string,
  argv: readonly string[],
  timeoutMs: number,
  late?: LateAnswer,
): Promise<ProcessOutcome> {
  let process;
  try {
    // why: the runner's own timeout is a backstop past the late kill, so it never ends a command the driver let run on.
    const runnerTimeoutMs = late === undefined ? timeoutMs : timeoutMs + late.killAfterMs;
    process = processRunner.spawn(command, [...argv], { timeoutMs: runnerTimeoutMs });
  } catch (error: unknown) {
    throw new DriverCrashError(`Could not start ${argv.join(" ")}: ${errorMessage(error)}`);
  }

  let resolveTimeout: (() => void) | undefined;
  const timedOut = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });
  const waited = process.wait();
  const kill = (): void => {
    try {
      process.kill("SIGTERM");
    } catch {
      // why: A process that has already exited needs no timeout cleanup.
    }
  };
  const timer = clock.setTimer(timeoutMs, () => {
    resolveTimeout?.();
    if (late === undefined) {
      kill();
      return;
    }
    const killTimer = clock.setTimer(late.killAfterMs, kill);
    const settled = (result: ProcessResult | undefined): void => {
      clock.cancel(killTimer);
      late.onSettled(result);
    };
    waited.then(settled, () => settled(undefined));
  });

  try {
    return await Promise.race([
      waited.then((result) => ({ kind: "finished" as const, result })),
      timedOut.then(() => ({ kind: "timed-out" as const })),
    ]);
  } catch (error: unknown) {
    throw new DriverCrashError(`${argv.join(" ")} failed: ${errorMessage(error)}`);
  } finally {
    clock.cancel(timer);
  }
}

/** why: the UDID a command printed after its limit is the driver's own, so it is deleted; none printed is logged. */
export async function deleteLateSimulator(
  args: readonly string[],
  result: ProcessResult | undefined,
  logger: Logger | undefined,
  remove: (udid: string) => Promise<void>,
): Promise<void> {
  const udid = result?.code === 0 ? result.stdout.trim() : "";
  if (udid === "") {
    logger?.warn(`simctl ${args.join(" ")} gave no simulator after its limit`);
    return;
  }
  try {
    await remove(udid);
  } catch (error: unknown) {
    logger?.warn(
      `could not delete simulator ${udid} that simctl ${args.join(" ")} made after its limit: ${errorMessage(error)}`,
    );
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
