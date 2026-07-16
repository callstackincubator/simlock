import type { LeaseEngine } from "./lease-engine.js";
import type { Registry } from "./registry.js";

export interface NukeOptions {
  readonly leaseEngine: LeaseEngine;
  readonly registry: Registry;
}

export interface NukeRunOptions {
  readonly deleteDevices: boolean;
}

/** Thin operator command facade; the lease engine keeps destructive ownership. */
export class Nuke {
  constructor(private readonly options: NukeOptions) {}

  async run(options: NukeRunOptions): Promise<{
    readonly deletedDevices: readonly string[];
    readonly releasedLeaseIds: readonly string[];
  }> {
    const before = this.options.registry.snapshot.devices
      .filter((device) => device.state !== "deleted")
      .map((device) => device.id);
    const { releasedLeaseIds } = await this.options.leaseEngine.nuke(options.deleteDevices);
    const deleted = new Set(
      this.options.registry.snapshot.devices
        .filter((device) => device.state === "deleted")
        .map((device) => device.id),
    );
    return {
      deletedDevices: before.filter((deviceId) => deleted.has(deviceId)),
      releasedLeaseIds,
    };
  }
}
