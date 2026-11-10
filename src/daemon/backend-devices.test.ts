import { describe, expect, it } from "vitest";

import { NoDriverError } from "../core/index.js";
import { backendOwnershipWorld } from "./test-backend-ownership.js";

describe("backend-owned devices", () => {
  it.each(["save", "remove"] as const)(
    "refuses baseline %s for an unavailable device backend while keeping its lease active",
    async (operation) => {
      const world = await backendOwnershipWorld();
      try {
        const local = await world.select("local");
        const original = await local.engine.request(
          { platform: "ios", model: "iPhone 16", osVersion: "26.5" },
          { ownerId: "agent", requesterId: "original" },
        );
        await local.engine.core.baselines.save({
          leaseId: original.lease.id,
          name: "checkout",
          requesterId: "operator",
        });
        const copy = await local.engine.request(
          { platform: "ios", baseline: "checkout" },
          { ownerId: "agent", requesterId: "copy" },
        );
        await local.engine.settle();
        const remote = await world.select("remote");
        const callsBefore = [...remote.driver.calls];
        let refused: Promise<unknown>;
        if (operation === "save") {
          refused = remote.engine.core.baselines.save({
            leaseId: copy.lease.id,
            name: "other",
            requesterId: "operator",
          });
        } else {
          refused = remote.engine.core.baselines.remove({
            name: "checkout",
            requesterId: "operator",
          });
        }

        await expect(refused).rejects.toBeInstanceOf(NoDriverError);

        const leaseIds = remote.registry.snapshot.leases.map((lease) => lease.id);
        expect(leaseIds).toEqual([copy.lease.id]);
        const device = remote.registry.snapshot.devices.find(
          (entry) => entry.id === copy.device.id,
        );
        expect(device?.state).toBe("leased");
        expect(remote.driver.calls).toEqual(callsBefore);
      } finally {
        world.close();
      }
    },
  );
});
