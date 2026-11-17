import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry } from "./testing.js";
import { spec } from "./test-registry.js";

describe("Registry: the device event a transition carries", () => {
  async function provisioned() {
    const clock = new FakeClock(1_000);
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "x" },
    });
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: "fake-1" },
      driverDeviceId: "driver_x",
      provisionDuration: 0,
      spec,
    });
    return { device, registry };
  }

  it("names the event a transition requires when it comes without one or with another", async () => {
    const { device, registry } = await provisioned();

    await expect(registry.transitionDevice(device.id, "ready")).rejects.toThrow(
      "Transition from provisioning to ready requires device.ready device event",
    );
    await expect(
      registry.transitionDevice(device.id, "ready", {
        event: "device.shutdown",
        payload: { deviceId: device.id, initiator: "test" },
      }),
    ).rejects.toThrow("requires device.ready device event");
    expect(registry.snapshot.devices[0]?.state).toBe("provisioning");
  });

  it("says a transition requires no event when it comes with one", async () => {
    const { device, registry } = await provisioned();

    await expect(
      registry.transitionDevice(device.id, "quarantined", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: device.id },
      }),
    ).rejects.toThrow("Transition from provisioning to quarantined requires no device event");
  });
});
