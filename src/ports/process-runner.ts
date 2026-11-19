import { constants } from "node:os";

import type { StreamingProcessResult } from "./process-runner-types.js";

export type {
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
  ProcessStreamOptions,
  StreamingProcessHandle,
  StreamingProcessResult,
} from "./process-runner-types.js";
export { InputStreamFailedError, ProcessSpawnError } from "./process-runner-types.js";
export { ExecOutputDeliveryStalledError, NodeProcessRunner } from "./node-process-runner.js";
export type { ScriptedProcessExpectation } from "./scripted-process-runner.js";
export { ScriptedProcessRunner } from "./scripted-process-runner.js";

/**
 * why: The single number a shell reports for a finished process: its own exit code, or
 * `128 + signal` when a signal ended it. Lives here, in the port's adapter layer, because
 * turning a signal *name* into its number needs `node:os` -- which application code (the
 * dispatcher that answers `device.exec` with an `exitCode`) may not import (architecture
 * rule 9). Mirrors what `src/cli/passthrough.ts` does for a locally-spawned passthrough, so
 * the same command reports the same number whether it ran here or there.
 */
export function exitCodeOf(result: StreamingProcessResult): number {
  if (result.code !== null) return result.code;
  if (result.signal === null) return 1;
  return 128 + (constants.signals[result.signal] ?? 0);
}
