import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import type { VirtualSpec } from "./index.js";

export const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

export function totalChanges(state: StateDatabase): unknown {
  return state.database.prepare("SELECT total_changes() AS changes").get()?.changes;
}

export const physicalInput = {
  apps: ["com.example.one", "com.example.two"],
  class: "phone",
  driverDeviceId: "00008110-001A2B3C4D5E" as string,
  model: "iPhone 15 Pro",
  osVersion: "18.4",
  platform: "ios",
} as const;

// why: a device id is "dev_" plus the next name pushed to `names`, so a test picks its ids.
export async function seededWorld() {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const state = await openTestState();
  const names: string[] = [];
  const registry = await loadTestRegistry({
    clock,
    eventBus: bus,
    idGenerator: { generate: () => names.shift() ?? "unexpected" },
    state,
  });
  const reload = () =>
    loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "unexpected" },
      state,
    });
  const enroll = (name: string, overrides: Partial<typeof physicalInput> = {}) => {
    names.push(name);
    return registry.enrollPhysical({ ...physicalInput, ...overrides });
  };
  const register = async (name: string) => {
    names.push(name);
    const device = await registry.registerDevice({
      driverData: { fakeDeviceId: `fake-${name}` },
      driverDeviceId: `driver_${name}`,
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    return device;
  };
  const lease = (deviceId: string, leaseId = `lse_${deviceId}`) =>
    registry.createLease({
      deviceId,
      leaseId,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 90_000,
      ttlMs: 60_000,
    });
  return { bus, clock, enroll, lease, register, registry, reload, state };
}
