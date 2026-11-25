import type { LeaseRecord, Platform, VirtualDevice } from "./domain.js";
import type { Driver } from "./driver.js";
import { type Logger, NoopLogger } from "../ports/index.js";
import type { NukeExecutor } from "./core-ports.js";
import type { SeedSettler } from "./seed-settle/index.js";
import { stableError } from "./stable-error.js";

export interface LeaseMaintenance {
  beginMaintenance(): Promise<void>;
  releaseAllDuringMaintenance(reason: "killed", platform?: Platform): Promise<readonly string[]>;
  endMaintenance(): Promise<void>;
}

export interface AcquisitionMaintenance {
  beginMaintenance(): Promise<void>;
  endMaintenance(): Promise<void>;
}

export interface NukeRegistryView {
  readonly snapshot: {
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
}

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
    removeAll(
      platform?: Platform,
    ): Promise<{ readonly failure?: unknown; readonly names: readonly string[] }>;
  };
  readonly registry: NukeRegistryView;
  /** why: nuke --delete-devices also deletes the seeds the drivers keep; it names no other source (ADR 0061 §1). */
  readonly drivers: readonly Pick<Driver, "platform" | "listSources" | "destroySource">[];
  readonly logger?: Logger;
  /** why: a nuke deletes seeds, so no settle runs or swaps a seed while it does (ADR 0090 §2). */
  readonly seedSettler: Pick<SeedSettler, "holdWhile">;
  /** why: nuke starts the warm pool over, so the kinds it learned are not booted back. */
  readonly warmPool: { forget(platform?: Platform): void };
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

  async nuke(deleteDevices: boolean, platform?: Platform): Promise<NukeReport> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.options.seedSettler.holdWhile(() => this.#runNuke(deleteDevices, platform));
    } finally {
      release();
    }
  }

  async #runNuke(deleteDevices: boolean, platform?: Platform): Promise<NukeReport> {
    await this.options.acquisition.beginMaintenance();
    let releaseMaintenanceStarted = false;
    try {
      await this.options.leases.beginMaintenance();
      releaseMaintenanceStarted = true;
      const releasedLeaseIds = await this.options.leases.releaseAllDuringMaintenance(
        "killed",
        platform,
      );
      try {
        this.options.warmPool.forget(platform);
      } catch (error: unknown) {
        this.#logger.error("nuke could not clear the warm pool's record", {
          error: stableError(error),
        });
      }

      for (const device of this.options.registry.snapshot.virtualDevices) {
        if (platform !== undefined && device.spec.platform !== platform) continue;
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

      if (deleteDevices) await this.#destroySeeds(platform);
      const removedBaselines = deleteDevices ? await this.#removeBaselines(platform) : [];

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
  async #removeBaselines(platform?: Platform): Promise<readonly string[]> {
    const { failure, names } = await this.options.baselines.removeAll(platform);
    if (failure !== undefined) {
      this.#logger.error("nuke could not remove every baseline", { error: stableError(failure) });
    }
    return names;
  }

  /** why: one unreadable or stuck seed must not stop the rest of the reset; the seed stays and `doctor` lists it. */
  async #destroySeeds(platform?: Platform): Promise<void> {
    for (const driver of this.options.drivers) {
      if (platform !== undefined && driver.platform !== platform) continue;
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

  #canOperate(
    deviceId: string,
    expectedState: "ready" | "shutdown" | "provisioning" | "quarantined",
  ): boolean {
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
    if (
      current?.state !== "shutdown" &&
      current?.state !== "provisioning" &&
      current?.state !== "quarantined"
    ) {
      return undefined;
    }
    return this.#canOperate(current.id, current.state) ? current : undefined;
  }
}
