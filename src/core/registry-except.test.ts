import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import type { VirtualSpec } from "./index.js";

const spec: VirtualSpec = {
  mode: "slim",
  model: "iPhone 16",
  osVersion: "26.5",
  physical: false,
  platform: "ios",
};

describe("Registry: an except list", () => {
  it("keeps the list a lease kept running on its device and on its stored request across a reload, and none where none was named", async () => {
    const clock = new FakeClock(1_000);
    const state = await openTestState();
    let next = 0;
    const load = () =>
      loadTestRegistry({
        clock,
        eventBus: new EventBus(clock),
        idGenerator: { generate: () => String((next += 1)) },
        state,
      });
    const registry = await load();
    const except = ["store", "other"];
    const lease = async (name: string, withExcept: boolean) => {
      const device = await registry.registerDevice({
        backend: "local",
        driverData: { fakeDeviceId: name },
        driverDeviceId: name,
        provisionDuration: 0,
        spec,
      });
      await registry.transitionDevice(device.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      });
      await registry.createLeaseRequest({
        id: `req_${name}`,
        ownerId: "agent",
        request: { platform: "ios", ...(withExcept ? { except } : {}) },
        requesterId: name,
      });
      await registry.createLease({
        deviceId: device.id,
        ...(withExcept ? { except } : {}),
        ownerId: "agent",
        requesterId: name,
        ttlDeadline: 5_000,
        ttlMs: 4_000,
      });
      return device.id;
    };
    const kept = await lease("with", true);
    const plain = await lease("without", false);

    const reloaded = await load();

    const deviceOf = (id: string) => reloaded.snapshot.devices.find((d) => d.id === id);
    expect(deviceOf(kept)).toMatchObject({ except });
    expect(deviceOf(plain)).not.toHaveProperty("except");
    const requestOf = (name: string) =>
      reloaded.leaseRequests().find((record) => record.id === `req_${name}`)?.request;
    expect(requestOf("with")).toEqual({ except, platform: "ios" });
    expect(requestOf("without")).toEqual({ platform: "ios" });
  });
});
