import type { EventBus } from "../bus/index.js";
import type { UpdateFailure, UpdateState } from "../contract/index.js";
import type { Registry } from "../core/index.js";
import type { DaemonRole, NpmCli, UpdaterLauncher } from "../ports/index.js";

export interface UpdateInput {
  readonly version?: string | undefined;
  readonly force?: boolean | undefined;
  readonly query?: boolean | undefined;
}

export interface UpdateProgress {
  readonly update: UpdateState | null;
  readonly lastUpdateFailure: UpdateFailure | null;
  readonly latestVersion: string | null;
}

export interface UpdateOutcome extends UpdateProgress {
  readonly started: boolean;
  readonly upToDate: boolean;
  readonly resolved: string | null;
}

export interface UpdateCoordinator {
  request(input: UpdateInput): Promise<UpdateOutcome>;
  state(): UpdateProgress;
}

export interface UpdateCoordinatorOptions {
  readonly npm: NpmCli;
  readonly launcher: UpdaterLauncher;
  readonly registry: Pick<Registry, "snapshot">;
  readonly eventBus: Pick<EventBus, "emit" | "subscribe">;
  readonly version: string;
  readonly packageRoot: string;
  readonly simlockHome: string;
  readonly role: DaemonRole;
  readonly logPath: string;
  readonly pid: number;
}

export function createUpdateCoordinator(_options: UpdateCoordinatorOptions): UpdateCoordinator {
  const idle: UpdateProgress = { update: null, lastUpdateFailure: null, latestVersion: null };
  return {
    request: async () => ({ ...idle, started: false, upToDate: false, resolved: null }),
    state: () => idle,
  };
}
