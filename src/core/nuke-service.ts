import type { DeviceRecord, LeaseRecord } from "./domain.js";
import type { NukeExecutor } from "./lease-ports.js";

/** Administrative lease release capability required by an operator reset. */
export interface LeaseAdministration {
  releaseAll(reason: "killed"): Promise<readonly string[]>;
}

/** Direct pending-request cancellation capability required by an operator reset. */
export interface PendingRequestCancellation {
  cancelAll(reason: "killed"): Promise<void>;
}

/** Read-only registry view used to select Pitlane-owned device records. */
export interface NukeRegistryView {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

/** Managed operations; implementations own driver calls, claims, and state commits. */
export interface NukeDeviceLifecycle {
  shutdown(
    target: DeviceRecord,
    initiator: "nuke",
    operation: "nuke",
  ): Promise<DeviceRecord | undefined>;
  destroy(
    target: DeviceRecord,
    initiator: "nuke",
    operation: "nuke",
  ): Promise<DeviceRecord | undefined>;
}

export interface NukeServiceOptions {
  readonly devices: NukeDeviceLifecycle;
  readonly leases: LeaseAdministration;
  readonly pendingRequests: PendingRequestCancellation;
  readonly registry: NukeRegistryView;
}

/**
 * Coordinates the operator reset workflow without ever addressing driver
 * devices directly. It only forwards current registry records to lifecycle
 * operations, which perform their own final ownership and claim checks.
 */
export class NukeService implements NukeExecutor {
  constructor(private readonly options: NukeServiceOptions) {}

  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    const releasedLeaseIds = await this.options.leases.releaseAll("killed");
    await this.options.pendingRequests.cancelAll("killed");

    for (const device of this.options.registry.snapshot.devices) {
      await this.#resetDevice(device, deleteDevices);
    }

    return { releasedLeaseIds };
  }

  #canOperate(deviceId: string, expectedState: "ready" | "shutdown"): boolean {
    const current = this.options.registry.snapshot.devices.find((device) => device.id === deviceId);
    return (
      current?.state === expectedState &&
      !this.options.registry.snapshot.leases.some((lease) => lease.deviceId === deviceId)
    );
  }

  async #resetDevice(device: DeviceRecord, deleteDevices: boolean): Promise<void> {
    if (device.state === "deleted") return;

    const shutdown = await this.#shutdownIfReady(device);
    if (!deleteDevices || (device.state === "ready" && shutdown === undefined)) return;

    const current = this.#currentShutdown(device.id);
    if (current !== undefined) await this.options.devices.destroy(current, "nuke", "nuke");
  }

  async #shutdownIfReady(device: DeviceRecord): Promise<DeviceRecord | undefined> {
    if (device.state !== "ready" || !this.#canOperate(device.id, "ready")) return undefined;
    return this.options.devices.shutdown(device, "nuke", "nuke");
  }

  #currentShutdown(deviceId: string): DeviceRecord | undefined {
    const current = this.options.registry.snapshot.devices.find((device) => device.id === deviceId);
    if (current?.state !== "shutdown" || !this.#canOperate(current.id, "shutdown"))
      return undefined;
    return current;
  }
}
