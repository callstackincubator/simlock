import type { EventBus } from "../bus/index.js";
import type { Proposal } from "./cleanup/types.js";
import type { DeviceOperationClaim } from "./device-operation-claims.js";
import type { DeviceRecord, DeviceState, Platform } from "./domain.js";
import type { Driver } from "./driver.js";
import type { RegistryDeviceEvent, RegistrySnapshot } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";

/** Executes cleanup proposals after independently revalidating safety. */
export interface CleanupActionExecutor {
  execute(proposal: Proposal): Promise<boolean>;
}

/** Minimal claim surface needed to exclude overlapping device operations. */
export interface CleanupClaims {
  tryClaim(deviceId: string, operation: "cleanup"): DeviceOperationClaim | undefined;
}

/** Minimal driver lookup surface needed for cleanup verbs. */
export interface CleanupDrivers {
  get(platform: Platform): Pick<Driver, "destroy" | "shutdown">;
}

/** Registry surface required to revalidate and commit a cleanup action. */
export interface CleanupRegistry {
  readonly snapshot: RegistrySnapshot;
  transitionDevice(
    deviceId: string,
    to: DeviceState,
    event?: RegistryDeviceEvent,
  ): Promise<DeviceRecord>;
}

export interface CleanupExecutorOptions {
  readonly claims: CleanupClaims;
  readonly decisions: SerializedDecision;
  readonly drivers: CleanupDrivers;
  readonly eventBus: EventBus;
  readonly notifyAvailability: () => void;
  readonly registry: CleanupRegistry;
}

/**
 * Performs a single device cleanup action. Proposal selection remains in the
 * reaper; this class only revalidates and executes an already proposed action.
 */
export class CleanupExecutor implements CleanupActionExecutor {
  constructor(private readonly options: CleanupExecutorOptions) {}

  // fallow-ignore-next-line unused-class-member -- invoked through CleanupActionExecutor by CleanupReaper.
  async execute(proposal: Proposal): Promise<boolean> {
    const action = proposal.action;
    if (action !== "shutdown" && action !== "destroy") return false;

    const selected = await this.options.decisions.run(() => {
      const device = this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === proposal.target,
      );
      if (device === undefined || !canExecute(device, action, this.options.registry.snapshot)) {
        return undefined;
      }
      const claim = this.options.claims.tryClaim(device.id, "cleanup");
      return claim === undefined ? undefined : { claim, device };
    });
    if (selected === undefined) return false;

    const { claim, device } = selected;
    try {
      const driver = this.options.drivers.get(device.spec.platform);
      if (action === "shutdown") {
        await driver.shutdown(toDriverDevice(device));
      } else {
        await driver.destroy(toDriverDevice(device));
      }
    } catch (error: unknown) {
      await this.options.decisions.run(() => claim.release());
      throw error;
    }

    await this.options.decisions.run(async () => {
      try {
        await this.options.registry.transitionDevice(
          device.id,
          action === "shutdown" ? "shutdown" : "deleted",
          deviceEvent(action, device.id),
        );
      } finally {
        claim.release();
      }
    });
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

function deviceEvent(action: "shutdown" | "destroy", deviceId: string): RegistryDeviceEvent {
  return action === "shutdown"
    ? { event: "device.shutdown", payload: { deviceId, initiator: "cleanup-reaper" } }
    : { event: "device.deleted", payload: { deviceId, initiator: "cleanup-reaper" } };
}

function toDriverDevice(device: DeviceRecord): {
  readonly deviceId: string;
  readonly driverData: unknown;
} {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}
