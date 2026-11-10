import { EventBus } from "../bus/index.js";
import { Registry } from "../core/index.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  openTestState,
  testComponentWiring,
  testConfig,
} from "../core/testing.js";
import { createTestEngine, type TestEngine } from "../leasing/testing.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";

export async function backendOwnershipWorld() {
  const clock = new FakeClock(1_000);
  const state = await openTestState();
  let next = 0;
  const idGenerator = { generate: () => String(next++) };
  const drivers = new Map<string, FakeDriver>();
  for (const backend of ["local", "remote"]) {
    const driver = new FakeDriver({
      backend,
      clock,
      platform: "ios",
      availableOsVersions: ["26.5"],
    });
    drivers.set(backend, driver);
  }
  const tables = new Map([
    ["ios:local", fakeDeviceDataTable],
    ["ios:remote", fakeDeviceDataTable],
  ]);
  const config = testConfig({ warmPool: { enabled: false }, health: { enabled: false } });
  let active: TestEngine | undefined;
  const select = async (backend: string) => {
    active?.dispose();
    const eventBus = new EventBus(clock);
    const driver = drivers.get(backend);
    if (driver === undefined) throw new Error(`Unknown test backend ${backend}`);
    const registry = await Registry.load({
      clock,
      eventBus,
      idGenerator,
      state,
      deviceData: tables,
    });
    const selected = [driver];
    const wiring = testComponentWiring({ clock, drivers: selected, eventBus, registry });
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    const engine = createTestEngine({
      ...wiring,
      clock,
      config,
      drivers: selected,
      eventBus,
      idGenerator,
      registry,
      state,
      systemStats,
    });
    active = engine;
    return { driver, engine, registry };
  };
  const close = () => {
    active?.dispose();
    state.close();
  };
  return { close, select, state };
}
