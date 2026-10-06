import type { CapacityPlatform, RamBudget, RunningCapacity } from "./capacity/index.js";
import type { Platform } from "./domain.js";
import type { PassthroughCommand, PassthroughContext } from "./driver.js";
import type { PlatformCatalog } from "./driver-catalog.js";

/** Read-only capacity view used by daemon status. */
export interface CapacityReader {
  readonly runningCapacity: RunningCapacity;
  /** Managed-device ceiling, taken from the live strategy rather than from config. */
  deviceLimit(platform: CapacityPlatform): number;
  /** The live strategy's RAM budget over the registered devices; `undefined` when it keeps none. */
  readonly ramBudget: RamBudget | undefined;
  /** Whether creating one more full device of `platform` would be refused for RAM, by the same
   * check the planner makes. */
  atRamBudget(platform: CapacityPlatform): boolean;
}

/** Administrative lease expiry used by doctor reconciliation. */
export interface LeaseExpirer {
  expire(leaseId: string): Promise<void>;
}

/** Read-only device catalog used by the `simlock catalog` command and MCP tool. */
export interface CatalogReader {
  listCatalog(platform?: Platform): Promise<readonly PlatformCatalog[]>;
}

/**
 * Resolves `simlock <tool> <args>` into the scoped command its owning driver builds, for
 * the daemon request handler. Separate from `CatalogReader` because it answers about
 * tooling rather than about devices, and nothing on the lease path needs it.
 */
export interface PassthroughResolver {
  passthrough(
    tool: string,
    args: readonly string[],
    context?: PassthroughContext,
  ): PassthroughCommand;
}

/** Operator reset capability used by the nuke command facade. */
export interface NukeExecutor {
  nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }>;
}
