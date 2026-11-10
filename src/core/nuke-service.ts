import type { LeaseRecord, VirtualDevice } from "./domain.js";
import type { Driver } from "./driver.js";
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

export interface NukeReport {
  readonly releasedLeaseIds: readonly string[];
  readonly removedBaselines: readonly string[];
}

export interface NukeServiceOptions {
  readonly devices: NukeDeviceLifecycle;
  readonly acquisition: AcquisitionMaintenance;
  readonly leases: LeaseMaintenance;
  /** why: nuke --delete-devices removes every baseline and answers their names. */
  readonly baselines: {
    removeAll(): Promise<{ readonly failure?: unknown; readonly names: readonly string[] }>;
  };
  readonly registry: NukeRegistryView;
  /** why: nuke --delete-devices also deletes the seeds the drivers keep; it names no other source (ADR 0061 §1). */
  readonly drivers: readonly Pick<Driver, "platform" | "listSources" | "destroySource">[];
  readonly logger?: Logger;
  /** why: nuke starts the warm pool over, so the kinds it learned are not booted back. */
  readonly warmPool: { forget(): void };
}

/**
 * why: Coordinates the operator reset workflow without ever addressing driver devices directly:
 * it forwards current registry records to lifecycle operations, which perform their own final
 * ownership and claim checks. The one thing it asks a driver for is its seeds (`listSources`,
 * `destroySource`), and never an orphan source, which only `doctor --purge-orphans` deletes.
 */
export class NukeService implements NukeExecutor {
  #tail: Promise<void> = Promise.resolve();

  readonly #logger: Logger;

  constructor(private readonly options: NukeServiceOptions) {
    this.#logger = options.logger?.child("nuke") ?? new NoopLogger();
  }

  async nuke(deleteDevices: boolean): Promise<NukeReport> {
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

  async #runNuke(deleteDevices: boolean): Promise<NukeReport> {
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

      if (deleteDevices) await this.#destroySeeds();
      const removedBaselines = deleteDevices ? await this.#removeBaselines() : [];

      return { releasedLeaseIds, removedBaselines };
    } finally {
      try {
        if (releaseMaintenanceStarted) await this.options.leases.endMaintenance();
      } finally {
        await this.options.acquisition.endMaintenance();
      }
    }
  }

  /** why: a baseline source that will not delete must not fail the reset; its row is already gone, so every name is reported, and `doctor` lists the source that stayed. */
  async #removeBaselines(): Promise<readonly string[]> {
    const { failure, names } = await this.options.baselines.removeAll();
    if (failure !== undefined) {
      this.#logger.error("nuke could not remove every baseline", { error: stableError(failure) });
    }
    return names;
  }

  /** why: one unreadable or stuck seed must not stop the rest of the reset; the seed stays and `doctor` lists it. */
  async #destroySeeds(): Promise<void> {
    for (const driver of this.options.drivers) {
      try {
        for (const source of await driver.listSources()) {
          if (source.kind !== "seed" || source.orphan === true) continue;
          try {
            await driver.destroySource(source.id);
          } catch (error: unknown) {
            this.#logger.error("nuke could not delete a seed", {
              platform: driver.platform,
              sourceId: source.id,
              error: stableError(error),
            });
          }
        }
      } catch (error: unknown) {
        this.#logger.error("nuke could not list the seeds", {
          platform: driver.platform,
          error: stableError(error),
        });
      }
    }
  }

  #canOperate(deviceId: string, expectedState: "ready" | "shutdown" | "provisioning"): boolean {
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

    const current = this.#currentDestroyable(device.id);
    if (current !== undefined) await this.options.devices.destroy(current, "nuke", "nuke");
  }

  async #shutdownIfReady(device: VirtualDevice): Promise<VirtualDevice | undefined> {
    if (device.state !== "ready" || !this.#canOperate(device.id, "ready")) return undefined;
    return this.options.devices.shutdown(device, "nuke", "nuke");
  }

  #currentDestroyable(deviceId: string): VirtualDevice | undefined {
    const current = this.options.registry.snapshot.virtualDevices.find(
      (device) => device.id === deviceId,
    );
    if (current?.state !== "shutdown" && current?.state !== "provisioning") return undefined;
    return this.#canOperate(current.id, current.state) ? current : undefined;
  }
}
