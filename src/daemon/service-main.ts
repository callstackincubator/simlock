import type { Clock, Logger, ProcessRunner } from "../ports/index.js";

export interface SupervisorDependencies {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  readonly openLog: (path: string) => Logger;
}

export async function runSupervisor(_dependencies: SupervisorDependencies): Promise<number> {
  return 0;
}
