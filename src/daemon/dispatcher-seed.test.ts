import { describe, expect, it } from "vitest";

import type { Driver } from "../core/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, flushPromises, session } from "./test-dispatcher.js";

const admin = session({ principal: "tok_admin", role: "admin" });

describe("Dispatcher: seed.make", () => {
  it("makes and settles a kind's seed: a quick seed is settled and the answer names the settled seed", async () => {
    const built = await buildDispatcher({
      seedVerbs: {
        ensureSeed: async () => ({ leases: 1, settled: false, sourceId: "quick" }),
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

  it.each([
    [
      "a make that fails",
      "failed",
      "seed iPhone 17 could not be settled: simctl clone failed",
      {
        ensureSeed: async () => {
          throw new Error("simctl clone failed");
        },
        settleSeed: async () => {
          throw new Error("unreachable");
        },
      },
    ],
    [
      "a settle that fails",
      "failed",
      "seed iPhone 17 could not be settled: the copy never went idle",
      {
        ensureSeed: async () => ({ leases: 1, settled: false, sourceId: "quick" }),
        settleSeed: async () => {
          throw new Error("the copy never went idle");
        },
      },
    ],
    [
      "60 minutes with the settle still running",
      "timed-out",
      "seed iPhone 17 was not settled within 60 minutes",
      {
        ensureSeed: async () => ({ leases: 1, settled: false, sourceId: "quick" }),
        settleSeed: () => new Promise<never>(() => undefined),
      },
    ],
  ] as const)(
    "answers SEED_SETTLE_FAILED for %s, with the platform, the model and the reason",
    async (
      _label,
      reason,
      message,
      seedVerbs: Required<Pick<Driver, "ensureSeed" | "settleSeed">>,
    ) => {
      const built = await buildDispatcher({ seedVerbs });
      built.engine.core.seedSettler.start();

      let error: unknown = "no answer yet";
      void built.dispatcher
        .dispatch("seed.make", { model: "iPhone 17", osVersion: "26.5", platform: "ios" }, admin)
        .catch((caught: unknown) => caught)
        .then((caught) => {
          error = caught;
        });
      await flushPromises();
      built.clock.advance(60 * 60_000);
      await flushPromises();

      expect(classifyError(error)).toBe("SEED_SETTLE_FAILED");
      expect(error).toMatchObject({
        details: { model: "iPhone 17", platform: "ios", reason },
        message,
      });
    },
  );
});
