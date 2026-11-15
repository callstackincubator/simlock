import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";
import { Registry } from "./index.js";
import { spec } from "./test-registry.js";

export async function loadAfterCorruptingDevice(assignment: string): Promise<Registry> {
  const clock = new FakeClock(1_000);
  const state = await openTestState();
  const registry = await loadTestRegistry({
    clock,
    eventBus: new EventBus(clock),
    idGenerator: { generate: () => "stored" },
    state,
  });
  await registry.registerDevice({
    driverData: { fakeDeviceId: "fake-1" },
    driverDeviceId: "driver_stored",
    provisionDuration: 0,
    spec,
  });
  state.database.prepare(`UPDATE devices SET ${assignment}`).run();
  return loadTestRegistry({
    clock,
    eventBus: new EventBus(clock),
    idGenerator: { generate: () => "new" },
    state,
  });
}
