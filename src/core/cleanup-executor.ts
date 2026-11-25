import type { EventBus } from "../bus/index.js";
import type { Proposal } from "./cleanup/index.js";
import type { VirtualDevice } from "./domain.js";
import type { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import type { RegistrySnapshot } from "./registry.js";

export interface CleanupActionExecutor {
  execute(proposal: Proposal): Promise<boolean>;
}

export interface CleanupRegistry {
  readonly snapshot: RegistrySnapshot;
}

export interface CleanupExecutorOptions {
  readonly eventBus: EventBus;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "destroy" | "shutdown">;
  readonly notifyAvailability: () => void;
  readonly registry: CleanupRegistry;
}

export class CleanupExecutor implements CleanupActionExecutor {
  constructor(private readonly options: CleanupExecutorOptions) {}

  async execute(proposal: Proposal): Promise<boolean> {
    const action = proposal.action;
    if (action !== "shutdown" && action !== "destroy") return false;

    const device = this.options.registry.snapshot.virtualDevices.find(
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
  device: VirtualDevice,
  action: "shutdown" | "destroy",
  snapshot: RegistrySnapshot,
): boolean {
  if (snapshot.leases.some((lease) => lease.deviceId === device.id)) return false;
  return (
    (action === "shutdown" && device.state === "ready") ||
    (action === "destroy" && device.state === "shutdown")
  );
}
