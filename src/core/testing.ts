import type { EventBus } from "../bus/index.js";
import { type Clock, MemoryFilesystem } from "../ports/index.js";
import { ComponentInstaller } from "./component-installer.js";
import { DiskSpaceGuard, type Driver } from "./driver.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

/**
 * Test-only: fakes and test wiring other modules' tests use. Only a `*.test.ts` file or a
 * `test-*.ts` helper may import this file, and `pnpm lint` enforces it. Anything production code
 * also uses belongs on `index.ts`.
 */
export { capacityChangedPayload } from "./capacity/index.js";
export { FakeDriver } from "./fake-driver.js";
export type { FakeDriverOptions } from "./fake-driver.js";

/**
 * Test-only: the decision gate and the component installer a `LeaseEngine` is built with, wired
 * the way the daemon wires them -- one gate shared by the engine and the installer, so the
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
