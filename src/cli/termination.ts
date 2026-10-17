import type { ParentWatch, ParentWatchHandle } from "../ports/index.js";
import type { Signals } from "./types.js";

interface TerminationWatch {
  readonly settled: Promise<void>;
  dispose(): void;
}

export function waitForTermination(
  signals: Signals,
  parentWatch?: ParentWatch,
  parentPid?: number,
): TerminationWatch {
  let detach!: () => void;
  // why: Declared before `finish` closes over it: an adapter that reported an
  // already-dead parent synchronously from `watch()` would otherwise reach
  // this binding before its initialiser ran.
  let watchHandle: ParentWatchHandle | undefined;
  const settled = new Promise<void>((resolve) => {
    const finish = () => {
      detach();
      resolve();
    };
    detach = () => {
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      watchHandle?.stop();
    };
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
    watchHandle =
      parentWatch !== undefined && parentPid !== undefined && parentPid > 0
        ? parentWatch.watch(parentPid, finish)
        : undefined;
  });
  return { dispose: () => detach(), settled };
}
