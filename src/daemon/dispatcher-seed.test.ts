import { describe, expect, it } from "vitest";

import { buildDispatcher, flushPromises, session } from "./test-dispatcher.js";

const admin = session({ principal: "tok_admin", role: "admin" });

describe("Dispatcher: seed.make", () => {
  it("makes and settles a kind's seed: a quick seed is settled and the answer names the settled seed", async () => {
    const built = await buildDispatcher({
      seedVerbs: {
        ensureSeed: async () => {
          throw new Error("a quick seed is already there");
        },
        settleSeed: async (sourceId) => ({
          reason: "idle",
          settledAfterMs: 181_000,
          sizeBytes: 1_800_000_000,
          sourceId: `${sourceId}-settled`,
        }),
      },
    });
    built.driver.setSources([
      {
        id: "quick",
        kind: "seed",
        leases: 1,
        model: "iPhone 17",
        osVersion: "26.5",
        settled: false,
      },
    ]);
    built.engine.core.seedSettler.start();

    const answer = built.dispatcher.dispatch(
      "seed.make",
      { model: "iPhone 17", osVersion: "26.5", platform: "ios" },
      admin,
    );
    await flushPromises();

    await expect(answer).resolves.toEqual({
      model: "iPhone 17",
      osVersion: "26.5",
      outcome: "settled",
      platform: "ios",
      settledAfterMs: 181_000,
      sizeBytes: 1_800_000_000,
      sourceId: "quick-settled",
    });
  });
});
