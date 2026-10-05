import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { createCore, loadConfig, Registry } from "./index.js";
import { FakeDriver, testComponentWiring } from "./testing.js";

describe("createCore", () => {
  it("calling nuke before connect throws an error naming the missing port", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const drivers = [new FakeDriver({ clock, platform: "ios" })];
    const filesystem = new MemoryFilesystem();
    const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem,
      idGenerator: { generate: () => "1" },
      statePath: "/state.json",
    });
    const core = createCore({
      clock,
      config: await loadConfig({ filesystem, systemStats }),
      drivers,
      eventBus,
      registry,
      systemStats,
      ...testComponentWiring({ clock, drivers, eventBus, registry }),
    });

    await expect(core.nuke.nuke(false)).rejects.toThrow(/leaseMaintenance/);
  });
});
