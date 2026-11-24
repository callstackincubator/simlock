import { describe, expect, it, vi } from "vitest";

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

  it("reports each stage with the seed's kind, and answers a seed that is already settled at once with no settle", async () => {
    const stages: unknown[] = [];
    const settleSeed = vi.fn(async (sourceId: string) => ({
      reason: "idle" as const,
      settledAfterMs: 1,
      sourceId,
    }));
    const built = await buildDispatcher({
      seedVerbs: {
        ensureSeed: async () => ({ leases: 0, settled: false, sourceId: "made" }),
        settleSeed,
      },
    });
    built.engine.core.seedSettler.start();
    const onSeedProgress = (kind: unknown, progress: unknown) => stages.push({ kind, progress });

    const made = built.dispatcher.dispatch(
      "seed.make",
      { model: "iPhone 17", platform: "ios" },
      { ...admin, onSeedProgress },
    );
    await flushPromises();
    await made;
    built.driver.setSources([
      {
        id: "ready",
        kind: "seed",
        leases: 3,
        model: "iPhone 17",
        osVersion: "26.5",
        settled: true,
        sizeBytes: 900,
      },
    ]);
    settleSeed.mockClear();
    const settled = built.dispatcher.dispatch(
      "seed.make",
      { model: "iPhone 17", platform: "ios" },
      admin,
    );
    await flushPromises();

    const kind = { model: "iPhone 17", osVersion: "26.5", platform: "ios" };
    expect(stages).toEqual([
      { kind, progress: { stage: "making" } },
      { kind, progress: { stage: "settling" } },
    ]);
    await expect(settled).resolves.toEqual({
      ...kind,
      outcome: "already-settled",
      sizeBytes: 900,
      sourceId: "ready",
    });
    expect(settleSeed).not.toHaveBeenCalled();
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

  it.each([
    {
      code: "UNKNOWN_MODEL",
      input: { model: "iPhone 99", platform: "ios" },
      label: "an unknown model",
      options: { driverOptions: { knownModels: ["iPhone 17"] } },
    },
    {
      code: "UNKNOWN_MODEL",
      input: { model: "iPhone 17", platform: "ios" },
      label: "a platform whose virtual devices are off",
      options: { virtualDevices: { ios: false } },
    },
    {
      code: "RUNTIME_MISSING",
      input: { model: "iPhone 17", osVersion: "27.0", platform: "ios" },
      label: "an exact runtime that is not installed",
      message: "iOS 27.0 is not installed; install it with simlock component install ios 27.0",
      options: {},
    },
    {
      code: "RUNTIME_MISSING",
      input: { model: "iPhone 17", platform: "ios" },
      label: "a default runtime when none is installed",
      message:
        "no installed iOS runtime fits the default; install one with simlock component install ios and a version",
      options: { driverOptions: { availableOsVersions: [] } },
    },
    {
      code: "FORBIDDEN",
      input: { model: "iPhone 17", platform: "ios" },
      label: "an agent session",
      options: {},
      session: session(),
    },
    {
      code: "DAEMON_STOPPING",
      input: { model: "iPhone 17", platform: "ios" },
      label: "a daemon that is stopping",
      options: {},
      stopping: true,
    },
  ])(
    "refuses $label with $code, before any seed is made",
    async ({ code, input, message, options, session: asked, stopping }) => {
      const verbs = {
        ensureSeed: vi.fn(async () => ({ leases: 0, settled: false, sourceId: "made" })),
        settleSeed: vi.fn(async () => {
          throw new Error("unreachable");
        }),
      };
      const built = await buildDispatcher({ ...options, seedVerbs: verbs });
      if (stopping === true) built.engine.core.seedSettler.beginStop();

      const error = await built.dispatcher
        .dispatch("seed.make", input, asked ?? admin)
        .catch((caught: unknown) => caught);

      expect(classifyError(error)).toBe(code);
      if (message !== undefined) expect(error).toMatchObject({ message });
      expect(verbs.ensureSeed).not.toHaveBeenCalled();
      expect(built.driver.calls.map((call) => call.operation)).not.toContain("provision");
    },
  );
});
