import type { CapacityPlatform, RamBudget, RunningCapacity } from "./capacity/index.js";
import type { LearnedKindMatch, WarmPoolFigures } from "./warm-pool/index.js";
import type { Platform, VirtualSpec } from "./domain.js";
import type {
  PassthroughCommand,
  PassthroughContext,
  PhysicalDriverDevice,
  VirtualDriverDevice,
} from "./driver.js";
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

/** why: ADR 0068 §2: what core reads of a worker's memory pressure step, so it never names host-load. */
export interface MemoryPressureReader {
  /** why: the step with when and why it began, and when the latest reading came; `undefined` while host load is off or before its first reading. */
  current():
    | {
        readonly step: "none" | "warming-paused" | "new-devices-paused";
        readonly since?: number;
        readonly cause?: {
          readonly trigger: "level" | "floor";
          readonly availablePercent: number;
          readonly level?: "normal" | "warn" | "critical";
          readonly floorPercent?: number;
        };
        readonly readingAt: number;
      }
    | undefined;
  /** why: calls the listener after each reading, once the step is updated; returns the way to stop. */
  onReading(listener: () => void): () => void;
}

/** Read-only view of the warm pool, used by daemon status and doctor. */
export interface WarmPoolReader {
  /** The pool as its last pass left it. */
  figures(): WarmPoolFigures;
}

/** why: an operator's undo of a mistaken lease: forgets the learned kinds the match names, answering them. */
export interface WarmKindForgetter {
  forget(match: LearnedKindMatch): VirtualSpec[];
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
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand>;
}

/** Operator reset capability used by the nuke command facade. */
export interface NukeExecutor {
  nuke(deleteDevices: boolean): Promise<{
    readonly releasedLeaseIds: readonly string[];
    readonly removedBaselines: readonly string[];
  }>;
}
