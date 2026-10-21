import type { LeaseRecord, VirtualDevice } from "./domain.js";
import { type Logger, NoopLogger } from "../ports/index.js";
import type { NukeExecutor } from "./core-ports.js";
import { stableError } from "./stable-error.js";

/** Release maintenance boundary required by an operator reset. */
export interface LeaseMaintenance {
  beginMaintenance(): Promise<void>;
  releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]>;
  endMaintenance(): Promise<void>;
}

/** Acquisition maintenance boundary required by an operator reset. */
export interface AcquisitionMaintenance {
  beginMaintenance(): Promise<void>;
  endMaintenance(): Promise<void>;
}

/** Read-only registry view used to select Simlock-owned device records. */
export interface NukeRegistryView {
  readonly snapshot: {
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
}

/** Managed operations; implementations own driver calls, claims, and state commits. */
export interface NukeDeviceLifecycle {
  shutdown(
    target: VirtualDevice,
    initiator: "nuke",
    operation: "nuke",
  ): Promise<VirtualDevice | undefined>;
  destroy(
    target: VirtualDevice,
    initiator: "nuke",
    operation: "nuke",
  ): Promise<VirtualDevice | undefined>;
}

export interface NukeServiceOptions {
  readonly devices: NukeDeviceLifecycle;
  readonly acquisition: AcquisitionMaintenance;
  readonly leases: LeaseMaintenance;
  readonly registry: NukeRegistryView;
  readonly logger?: Logger;
  /** why: nuke starts the warm pool over, so the kinds it learned are not booted back. */
  readonly warmPool: { forget(): void };
}

/**
 * Coordinates the operator reset workflow without ever addressing driver
 * devices directly. It only forwards current registry records to lifecycle
 * operations, which perform their own final ownership and claim checks.
 */
export class NukeService implements NukeExecutor {
  #tail: Promise<void> = Promise.resolve();

  readonly #logger: Logger;

  constructor(private readonly options: NukeServiceOptions) {
    this.#logger = options.logger?.child("nuke") ?? new NoopLogger();
  }

  async nuke(deleteDevices: boolean): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#runNuke(deleteDevices);
    } finally {
      release();
    }
  }

  async #runNuke(
    deleteDevices: boolean,
  ): Promise<{ readonly releasedLeaseIds: readonly string[] }> {
    await this.options.acquisition.beginMaintenance();
    let releaseMaintenanceStarted = false;
    try {
      await this.options.leases.beginMaintenance();
      releaseMaintenanceStarted = true;
      const releasedLeaseIds = await this.options.leases.releaseAllDuringMaintenance("killed");
      try {
        this.options.warmPool.forget();
      } catch (error: unknown) {
        this.#logger.error("nuke could not clear the warm pool's record", {
          error: stableError(error),
        });
      }

      for (const device of this.options.registry.snapshot.virtualDevices) {
        try {
          await this.#resetDevice(device, deleteDevices);
        } catch (error: unknown) {
          this.#logger.error("nuke could not reset a device", {
            deviceId: device.id,
            platform: device.spec.platform,
            error: stableError(error),
          });
        }
      }

      return { releasedLeaseIds };
    } finally {
      try {
        if (releaseMaintenanceStarted) await this.options.leases.endMaintenance();
      } finally {
        await this.options.acquisition.endMaintenance();
      }
    }
  }

  #canOperate(deviceId: string, expectedState: "ready" | "shutdown"): boolean {
    const current = this.options.registry.snapshot.virtualDevices.find(
      (device) => device.id === deviceId,
    );
    return (
      current?.state === expectedState &&
      !this.options.registry.snapshot.leases.some((lease) => lease.deviceId === deviceId)
    );
  }

  async #resetDevice(device: VirtualDevice, deleteDevices: boolean): Promise<void> {
    if (device.state === "deleted") return;

    const shutdown = await this.#shutdownIfReady(device);
    if (!deleteDevices || (device.state === "ready" && shutdown === undefined)) return;

    const current = this.#currentShutdown(device.id);
    if (current !== undefined) await this.options.devices.destroy(current, "nuke", "nuke");
  }

  async #shutdownIfReady(device: VirtualDevice): Promise<VirtualDevice | undefined> {
    if (device.state !== "ready" || !this.#canOperate(device.id, "ready")) return undefined;
    return this.options.devices.shutdown(device, "nuke", "nuke");
  }

  #currentShutdown(deviceId: string): VirtualDevice | undefined {
    const current = this.options.registry.snapshot.virtualDevices.find(
      (device) => device.id === deviceId,
    );
    if (current?.state !== "shutdown" || !this.#canOperate(current.id, "shutdown"))
      return undefined;
    return current;
  }
}
