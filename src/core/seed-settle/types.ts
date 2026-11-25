import type { EventBus } from "../../bus/index.js";
import type { Clock, Filesystem, Logger } from "../../ports/index.js";
import type { CapacityCoordinator } from "../capacity/index.js";
import type { ComponentInstaller } from "../component-installer.js";
import type { MemoryPressureReader } from "../core-ports.js";
import type { VirtualDevice, VirtualSpec } from "../domain.js";
import type { Driver } from "../driver.js";
import type { SerializedDecision } from "../serialized-decision.js";

/** why: the verbs of a driver the settler calls; a driver without `settleSeed` is never listed. */
export type SettlerDriver = Pick<Driver, "platform" | "listSources" | "settleSeed" | "ensureSeed">;

export interface SeedSettlerOptions {
  readonly drivers: readonly SettlerDriver[];
  readonly eventBus: Pick<EventBus, "emit">;
  readonly capacity: Pick<CapacityCoordinator, "tryReserveProvisioning" | "onBootActivity">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly registry: { readonly snapshot: { readonly virtualDevices: readonly VirtualDevice[] } };
  readonly components: Pick<ComponentInstaller, "claimProvision">;
  readonly memoryPressure: MemoryPressureReader;
  readonly filesystem: Pick<Filesystem, "diskFree">;
  /** why: the reaper's disk path, so both read the same disk. */
  readonly diskPath?: string;
  readonly diskPressure: { readonly freeBytesThreshold: number };
  readonly clock: Clock;
  readonly logger?: Logger;
}

export type SeedSettleProgress =
  | { readonly stage: "making" }
  | {
      readonly stage: "waiting";
      readonly reason: "settle-running" | "memory-pressure" | "disk-pressure" | "capacity";
    }
  | { readonly stage: "settling" };

export interface SeedSettleResult {
  readonly sourceId: string;
  readonly sizeBytes?: number;
  readonly outcome: "settled" | "already-settled";
  readonly settledAfterMs?: number;
}

export interface SeedSettler {
  start(): void;
  /** why: starts no settle from now on and refuses new operator calls; the running settle goes on until `stop`. */
  beginStop(): void;
  stop(): Promise<void>;
  /** why: nuke runs inside it: a running settle is aborted and awaited first, and none starts until `work` ends. */
  holdWhile<Result>(work: () => Promise<Result>): Promise<Result>;
  settle(
    spec: VirtualSpec,
    options: { readonly onProgress: (progress: SeedSettleProgress) => void },
  ): Promise<SeedSettleResult>;
}
