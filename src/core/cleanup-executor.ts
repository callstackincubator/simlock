import type { EventBus } from "../bus/index.js";
import type { Proposal } from "./cleanup/types.js";
import type { DeviceRecord } from "./domain.js";
import type { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import type { RegistrySnapshot } from "./registry.js";

/** Executes cleanup proposals after independently revalidating safety. */
export interface CleanupActionExecutor {
  execute(proposal: Proposal): Promise<boolean>;
}

/** Registry surface required to revalidate and commit a cleanup action. */
export interface CleanupRegistry {
  readonly snapshot: RegistrySnapshot;
}

export interface CleanupExecutorOptions {
  readonly eventBus: EventBus;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "destroy" | "shutdown">;
  readonly notifyAvailability: () => void;
  readonly registry: CleanupRegistry;
}

/**
 * Performs a single device cleanup action. Proposal selection remains in the
 * reaper; this class only revalidates and executes an already proposed action.
 */
export class CleanupExecutor implements CleanupActionExecutor {
  constructor(private readonly options: CleanupExecutorOptions) {}

  async execute(proposal: Proposal): Promise<boolean> {
    const action = proposal.action;
    if (action !== "shutdown" && action !== "destroy") return false;

    const device = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === proposal.target,
    );
    if (device === undefined || !canExecute(device, action, this.options.registry.snapshot)) {
      return false;
    }
    const updated =
      action === "shutdown"
        ? await this.options.lifecycle.shutdown(device, "cleanup-reaper", "cleanup")
        : await this.options.lifecycle.destroy(device, "cleanup-reaper", "cleanup");
    if (updated === undefined) return false;

    this.options.eventBus.emit(
      "cleanup.executed",
      { action, reason: proposal.reason, ruleName: proposal.rule, target: proposal.target },
      "cleanup-executor",
    );
    this.options.notifyAvailability();
    return true;
  }
}

function canExecute(
  device: DeviceRecord,
  action: "shutdown" | "destroy",
  snapshot: RegistrySnapshot,
): boolean {
  if (snapshot.leases.some((lease) => lease.deviceId === device.id)) return false;
  return (
    (action === "shutdown" && device.state === "ready") ||
    (action === "destroy" && device.state === "shutdown")
  );
}
