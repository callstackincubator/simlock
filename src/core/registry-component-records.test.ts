import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { type StateDatabase } from "../state/index.js";
import { loadTestRegistry, openTestState } from "./testing.js";

describe("Registry: component records", () => {
  async function load(state: StateDatabase) {
    const clock = new FakeClock(1_000);
    return loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "test" },
      state,
    });
  }

  it("keeps one record per platform and version, the latest install replacing the earlier one", async () => {
    const registry = await load(await openTestState());

    await registry.recordComponent({
      installedAt: 1,
      platform: "android",
      receipt: { stamp: "first" },
      version: "35",
    });
    await registry.recordComponent({
      installedAt: 2,
      platform: "ios",
      receipt: { image: "IMG" },
      version: "35",
    });
    await registry.recordComponent({
      installedAt: 3,
      platform: "android",
      receipt: { stamp: "second" },
      version: "35",
    });

    expect(registry.snapshot.components).toEqual([
      { installedAt: 2, platform: "ios", receipt: { image: "IMG" }, version: "35" },
      { installedAt: 3, platform: "android", receipt: { stamp: "second" }, version: "35" },
    ]);
  });

  it("deletes the record of one platform and version, keeps the others, and the deletion survives a reload", async () => {
    const state = await openTestState();
    const registry = await load(state);
    for (const [platform, version] of [
      ["ios", "26.4"],
      ["ios", "27.0"],
      ["android", "26.4"],
    ] as const) {
      await registry.recordComponent({ installedAt: 1, platform, receipt: { version }, version });
    }

    await registry.deleteComponent("ios", "26.4");

    const kept = [
      { installedAt: 1, platform: "ios", receipt: { version: "27.0" }, version: "27.0" },
      { installedAt: 1, platform: "android", receipt: { version: "26.4" }, version: "26.4" },
    ];
    expect(registry.snapshot.components).toEqual(kept);
    expect((await load(state)).snapshot.components).toEqual(kept);
  });
});
