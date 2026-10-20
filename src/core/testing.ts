import { describe, expect, it } from "vitest";

import type { EventBus } from "../bus/index.js";
import {
  type Clock,
  MemoryFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  type SqliteOpener,
  type SqliteSchemaOwner,
} from "../ports/index.js";
import { openStateDatabase, type StateDatabase } from "../state/index.js";
import { ComponentInstaller } from "./component-installer.js";
import { type DeviceDataTable, DiskSpaceGuard, type Driver } from "./driver.js";
import { fakeDeviceDataTable } from "./fake-driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { Platform } from "./domain.js";
import { Registry, type RegistryOptions } from "./registry.js";
import { registryOwner } from "./registry-schema.js";
import { SerializedDecision } from "./serialized-decision.js";

/**
 * Test-only: fakes and test wiring other modules' tests use. Only a `*.test.ts` file or a
 * `test-*.ts` helper may import this file, and `pnpm lint` enforces it. Anything production code
 * also uses belongs on `index.ts`.
 */
export { capacityChangedPayload } from "./capacity/index.js";
export {
  type CapacityLimits,
  createCapacityStrategy,
  type ResourceStrategyOptions,
} from "./capacity/index.js";
export { readyTransitionUpdate } from "./driver.js";
export { FakeDriver, fakeDeviceDataTable } from "./fake-driver.js";
export type { FakeDriverOptions } from "./fake-driver.js";
export { QuarantineCoordinator } from "./quarantine-coordinator.js";

/**
 * Test-only: the decision gate and the component installer `createCore` and `createLeasing` are
 * built with, wired the way the daemon wires them -- one gate shared by both and the installer, so the
 * installer's registry writes are serialized with every other one. Unlimited free disk. A test
 * that passes its own `components` gets the gate alone.
 */
export function testComponentWiring<
  Components extends Pick<ComponentInstaller, "claimProvision" | "install"> = ComponentInstaller,
>(options: {
  readonly clock: Clock;
  readonly drivers: readonly Driver[];
  readonly eventBus: Pick<EventBus, "emit">;
  readonly registry: Pick<Registry, "deleteComponent" | "recordComponent" | "snapshot">;
  /** Stands in for the installer, when a test needs to see whether it was reached at all. */
  readonly components?: Components | undefined;
}): {
  readonly components: Components | ComponentInstaller;
  readonly decisions: SerializedDecision;
} {
  const decisions = new SerializedDecision();
  return {
    components:
      options.components ??
      new ComponentInstaller({
        clock: options.clock,
        decisions,
        diskSpace: new DiskSpaceGuard(),
        drivers: new DriverCatalog(options.drivers),
        eventBus: options.eventBus,
        filesystem: new MemoryFilesystem(),
        registry: options.registry,
        timeoutMs: 1_200_000,
      }),
    decisions,
  };
}

export const fakeDeviceDataTables: ReadonlyMap<Platform, DeviceDataTable> = new Map([
  ["android", fakeDeviceDataTable],
  ["ios", fakeDeviceDataTable],
]);

// why: the real adapter on SQLite's in-memory database, whatever path the state module asks for.
const memorySqlite: SqliteOpener = {
  open: (_path, options) => new NodeSqliteOpener().open(":memory:", options),
};

function openMemoryState(owners: readonly SqliteSchemaOwner[]): Promise<StateDatabase> {
  return openStateDatabase({
    dataDirectory: "/memory",
    filesystem: new MemoryFilesystem(),
    logger: new NoopLogger(),
    oldFiles: [],
    owners,
    sqlite: memorySqlite,
    upgradeStep: "",
  });
}

export function openTestState(): Promise<StateDatabase> {
  return openMemoryState([registryOwner, fakeDeviceDataTable]);
}

export function describeDeviceDataTable(
  name: string,
  table: DeviceDataTable,
  examples: readonly [unknown, unknown, ...unknown[]],
): void {
  describe(`DeviceDataTable ${name}`, () => {
    it("reads back each example it was written with, a second write replaces the first, and a missing id is refused", async () => {
      const state = await openMemoryState([table]);
      const [first, second] = examples;
      for (const [index, example] of examples.entries()) {
        const id = `dev_${String(index)}`;
        table.write(state.database, id, example);
        const read = table.read(state.database, id);
        expect(read).toStrictEqual(example);
      }
      table.write(state.database, "dev_replace", first);
      table.write(state.database, "dev_replace", second);
      expect(table.read(state.database, "dev_replace")).toStrictEqual(second);
      expect(() => table.read(state.database, "dev_missing")).toThrow();
      state.close();
    });
  });
}

export async function loadTestRegistry(
  options: Omit<RegistryOptions, "deviceData" | "state"> & {
    readonly state?: StateDatabase | undefined;
  },
): Promise<Registry> {
  return Registry.load({
    ...options,
    deviceData: fakeDeviceDataTables,
    state: options.state ?? (await openTestState()),
  });
}
