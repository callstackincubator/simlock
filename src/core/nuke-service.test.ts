import { describe, expect, it } from "vitest";

import type { DeviceRecord, LeaseRecord } from "./domain.js";
import { NukeService, type NukeDeviceLifecycle, type NukeRegistryView } from "./nuke-service.js";

const device = (id: string, state: DeviceRecord["state"]): DeviceRecord => ({
  createdAt: 0,
  driverData: { privateDriverData: id },
  driverDeviceId: `driver_${id}`,
  id,
  spec: { model: "Phone", osVersion: "1", platform: "ios" },
  state,
});

class MutableRegistry implements NukeRegistryView {
  devices: DeviceRecord[];
  leases: LeaseRecord[] = [];

  constructor(devices: DeviceRecord[]) {
    this.devices = devices;
  }

  get snapshot() {
    return { devices: this.devices, leases: this.leases };
  }
}

function createHarness(devices: DeviceRecord[]) {
  const registry = new MutableRegistry(devices);
  const calls: string[] = [];
  const lifecycle: NukeDeviceLifecycle = {
    async shutdown(target) {
      calls.push(`shutdown:${target.id}`);
      const index = registry.devices.findIndex((candidate) => candidate.id === target.id);
      if (index === -1 || registry.devices[index]?.state !== "ready") return undefined;
      const updated = { ...target, state: "shutdown" as const };
      registry.devices[index] = updated;
      return updated;
    },
    async destroy(target) {
      calls.push(`destroy:${target.id}`);
      const index = registry.devices.findIndex((candidate) => candidate.id === target.id);
      if (index === -1 || registry.devices[index]?.state !== "shutdown") return undefined;
      const updated = { ...target, state: "deleted" as const };
      registry.devices[index] = updated;
      return updated;
    },
  };
  const service = new NukeService({
    acquisition: {
      async beginMaintenance() {
        calls.push("maintenance:begin");
      },
      async endMaintenance() {
        calls.push("maintenance:end");
      },
    },
    devices: lifecycle,
    leases: {
      async beginMaintenance() {
        calls.push("release-maintenance:begin");
      },
      async releaseAllDuringMaintenance(reason) {
        calls.push(`release:${reason}`);
        return ["lse_1", "lse_2"];
      },
      async endMaintenance() {
        calls.push("release-maintenance:end");
      },
    },
    registry,
  });
  return { calls, lifecycle, registry, service };
}

describe("NukeService", () => {
  it("fences acquisition before releasing killed leases and returns their ids", async () => {
    const harness = createHarness([]);

    await expect(harness.service.nuke(false)).resolves.toEqual({
      releasedLeaseIds: ["lse_1", "lse_2"],
    });

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("targets only non-deleted registry records and supports shutdown-only mode", async () => {
    const ready = device("registered", "ready");
    const harness = createHarness([ready, device("already-deleted", "deleted")]);

    await harness.service.nuke(false);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:registered",
      "release-maintenance:end",
      "maintenance:end",
    ]);
    expect(harness.registry.devices).toMatchObject([
      { id: "registered", state: "shutdown" },
      { id: "already-deleted", state: "deleted" },
    ]);
  });

  it("deletes ready and shutdown registry records only after they are shutdown", async () => {
    const harness = createHarness([device("ready", "ready"), device("shutdown", "shutdown")]);

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:ready",
      "destroy:ready",
      "destroy:shutdown",
      "release-maintenance:end",
      "maintenance:end",
    ]);
    expect(harness.registry.devices.map((candidate) => candidate.state)).toEqual([
      "deleted",
      "deleted",
    ]);
  });

  it("never asks the lifecycle to touch a currently leased device", async () => {
    const leased = device("leased", "ready");
    const harness = createHarness([leased]);
    harness.registry.leases = [
      {
        deviceId: leased.id,
        grantedAt: 0,
        id: "lse_live",
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 1,
      },
    ];

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("skips lifecycle-refused and state-changed targets without forcing destruction", async () => {
    const refused = device("refused", "ready");
    const changed = device("changed", "ready");
    const harness = createHarness([refused, changed]);
    harness.lifecycle.shutdown = async (target) => {
      harness.calls.push(`shutdown:${target.id}`);
      if (target.id === "refused") {
        harness.registry.devices[0] = { ...target, state: "shutdown" };
      }
      if (target.id === "changed") {
        harness.registry.devices[1] = { ...target, state: "deleted" };
      }
      return undefined;
    };

    await harness.service.nuke(true);

    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "shutdown:refused",
      "shutdown:changed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });

  it("uses no event bus command path", async () => {
    const harness = createHarness([device("ready", "ready")]);
    const events: string[] = [];

    await harness.service.nuke(true);

    expect(events).toEqual([]);
    expect(harness.calls).toContain("shutdown:ready");
  });

  it("reopens admission even when reset work fails", async () => {
    const harness = createHarness([]);
    let fail = true;
    harness.service = new NukeService({
      acquisition: {
        async beginMaintenance() {
          harness.calls.push("maintenance:begin");
        },
        async endMaintenance() {
          harness.calls.push("maintenance:end");
        },
      },
      devices: harness.lifecycle,
      leases: {
        async beginMaintenance() {
          harness.calls.push("release-maintenance:begin");
        },
        async releaseAllDuringMaintenance() {
          if (fail) {
            fail = false;
            throw new Error("release failed");
          }
          harness.calls.push("release:killed");
          return [];
        },
        async endMaintenance() {
          harness.calls.push("release-maintenance:end");
        },
      },
      registry: harness.registry,
    });

    await expect(harness.service.nuke(false)).rejects.toThrow("release failed");
    await expect(harness.service.nuke(false)).resolves.toEqual({ releasedLeaseIds: [] });
    expect(harness.calls).toEqual([
      "maintenance:begin",
      "release-maintenance:begin",
      "release-maintenance:end",
      "maintenance:end",
      "maintenance:begin",
      "release-maintenance:begin",
      "release:killed",
      "release-maintenance:end",
      "maintenance:end",
    ]);
  });
});
