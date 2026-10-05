import type { EventBus } from "../../bus/index.js";
import type { Clock, Logger } from "../../ports/index.js";
import type { CapacityCoordinator } from "../capacity/index.js";
import type { DeviceOperationClaims } from "../device-operation-claims.js";
import type { DeviceRecord, LeaseRecord, WaitingDemand } from "../domain.js";
import type { ManagedDeviceLifecycle } from "../managed-device-lifecycle.js";
import type { SerializedDecision } from "../serialized-decision.js";
import type { WarmPoolConfig } from "./config.js";

export interface WarmPoolOptions {
  readonly acquisition: {
    kick(): void;
    waitingDemand(): readonly WaitingDemand[];
  };
  readonly capacity: Pick<CapacityCoordinator, "runningCapacity" | "tryReserveBoot">;
  readonly claims: Pick<DeviceOperationClaims, "isClaimed" | "operationFor" | "tryClaim">;
  readonly clock: Clock;
  readonly config: WarmPoolConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "subscribe">;
  readonly idle: { readonly shutdownAfterMs: number };
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "bootWarm" | "shutdown">;
  readonly logger?: Logger;
  readonly registry: {
    readonly snapshot: {
      readonly devices: readonly DeviceRecord[];
      readonly leases: readonly LeaseRecord[];
    };
  };
}

/** The tick that re-runs a pass when no event does, so a slot freed silently is still used. */
export const WARM_POOL_TICK_MS = 30_000;

/** Observes the bus and runs one pass at a time over the pool. */
export class WarmPool {
  constructor(private readonly options: WarmPoolOptions) {}

  start(): void {
    void this.options;
  }

  dispose(): void {
    void this.options;
  }

  async pass(): Promise<void> {
    void this.options;
  }

  async settle(): Promise<void> {
    void this.options;
  }
}
