import { describe, expect, it, vi } from "vitest";

import { RuntimeMissingError, UnsupportedRequestOptionError, type Driver } from "../core/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, flushPromises, session } from "./test-dispatcher.js";

const admin = session({ principal: "tok_admin", role: "admin" });
/** why: the driver's refusal of a runtime no download can supply, as the iOS driver words it. */
function unfixable(message: string): RuntimeMissingError {
  const error = new RuntimeMissingError("ios", "15.0", { downloadable: false });
  error.message = message;
  return error;
}
type Built = Awaited<ReturnType<typeof buildDispatcher>>;

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
    const reserve = vi.spyOn(built.engine.core.capacity, "tryReserveProvisioning");
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
    expect(reserve, "an already settled seed takes no creation reservation").not.toHaveBeenCalled();
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

  it("leaves a settle the call started running when its 60 minutes pass, and answers the call timed-out", async () => {
    let signal: AbortSignal | undefined;
    const built = await buildDispatcher({
      seedVerbs: {
        ensureSeed: async () => ({ leases: 1, settled: false, sourceId: "quick" }),
        settleSeed: (_sourceId, options) => {
          signal = options.signal;
          return new Promise<never>(() => undefined);
        },
      },
    });
    built.engine.core.seedSettler.start();
    let error: unknown = "no answer yet";
    void built.dispatcher
      .dispatch("seed.make", { model: "iPhone 17", platform: "ios" }, admin)
      .catch((caught: unknown) => {
        error = caught;
      });
    await flushPromises();
    expect(signal, "the settle is under way").toBeDefined();

    built.clock.advance(60 * 60_000);
    await flushPromises();

    expect(error).toMatchObject({ details: { reason: "timed-out" } });
    expect(signal?.aborted, "the settle goes on").toBe(false);
  });

  it("fails a call queued behind another kind's settle with timed-out after 60 minutes from its arrival, and never makes its seed afterwards", async () => {
    let release: (() => void) | undefined;
    const ensured: string[] = [];
    const built = await buildDispatcher({
      seedVerbs: {
        ensureSeed: async (spec) => {
          ensured.push(spec.model);
          return { leases: 0, settled: false, sourceId: spec.model };
        },
        settleSeed: (sourceId) =>
          new Promise((resolve) => {
            release = () => resolve({ reason: "idle", settledAfterMs: 1, sourceId });
          }),
      },
    });
    built.engine.core.seedSettler.start();
    const first = built.dispatcher.dispatch(
      "seed.make",
      { model: "iPhone 17", platform: "ios" },
      admin,
    );
    first.catch(() => undefined);
    await flushPromises();
    built.clock.advance(30 * 60_000);
    const waits: unknown[] = [];
    let error: unknown = "no answer yet";
    built.dispatcher
      .dispatch(
        "seed.make",
        { model: "iPhone 16", platform: "ios" },
        { ...admin, onSeedProgress: (_kind: unknown, progress: unknown) => waits.push(progress) },
      )
      .catch((caught: unknown) => {
        error = caught;
      });
    await flushPromises();
    expect(waits).toEqual([{ reason: "settle-running", stage: "waiting" }]);

    built.clock.advance(59 * 60_000);
    await flushPromises();
    expect(error, "59 minutes after its arrival it still waits").toBe("no answer yet");
    built.clock.advance(60_000);
    await flushPromises();
    expect(classifyError(error)).toBe("SEED_SETTLE_FAILED");
    expect(error).toMatchObject({
      details: { model: "iPhone 16", platform: "ios", reason: "timed-out" },
    });

    release?.();
    await flushPromises();
    built.clock.advance(10 * 60_000);
    await flushPromises();
    expect(ensured, "the timed-out call's seed is never made").toEqual(["iPhone 17"]);
  });

  it("joins the settle already running on its kind's seed: two calls for one kind settle it once and each hears it wait", async () => {
    let release: (() => void) | undefined;
    const settleSeed = vi.fn(
      (sourceId: string) =>
        new Promise<{ reason: "idle"; settledAfterMs: number; sourceId: string }>((resolve) => {
          release = () =>
            resolve({ reason: "idle", settledAfterMs: 5, sourceId: `${sourceId}-settled` });
        }),
    );
    const ensureSeed = vi.fn(async () => ({ leases: 0, settled: false, sourceId: "made" }));
    const built = await buildDispatcher({ seedVerbs: { ensureSeed, settleSeed } });
    built.driver.setSources([
      {
        id: "quick",
        kind: "seed",
        leases: 3,
        model: "iPhone 17",
        osVersion: "26.5",
        settled: false,
      },
    ]);
    built.engine.core.seedSettler.start();
    built.clock.advance(5 * 60_000);
    await flushPromises();
    expect(settleSeed, "the background settle is under way").toHaveBeenCalledTimes(1);

    const waits: unknown[][] = [[], []];
    const calls = waits.map((heard, index) =>
      built.dispatcher.dispatch(
        "seed.make",
        { model: "iPhone 17", osVersion: "26.5", platform: "ios" },
        {
          ...admin,
          onSeedProgress: (_kind: unknown, progress: unknown) => waits[index]!.push(progress),
        },
      ),
    );
    await flushPromises();
    expect(waits).toEqual([
      [{ reason: "settle-running", stage: "waiting" }],
      [{ reason: "settle-running", stage: "waiting" }],
    ]);

    release?.();
    await flushPromises();
    await expect(Promise.all(calls)).resolves.toEqual([
      expect.objectContaining({ outcome: "settled", sourceId: "quick-settled" }),
      expect.objectContaining({ outcome: "settled", sourceId: "quick-settled" }),
    ]);
    expect(settleSeed, "one settle for both calls").toHaveBeenCalledTimes(1);
    expect(ensureSeed, "the seed was not made again").not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "memory-pressure",
      // why: `arrange` puts the worker under the pressure and answers the call that lifts it.
      arrange: (built: Built) => {
        built.setMemoryPressure("new-devices-paused");
        return () => built.setMemoryPressure("none");
      },
      options: {},
    },
    {
      reason: "disk-pressure",
      arrange: (built: Built) => () => {
        Object.assign(built.config.diskPressure, { freeBytesThreshold: 0 });
      },
      options: { diskPressureThreshold: 2 ** 60 },
    },
    {
      reason: "capacity",
      arrange: (built: Built) => {
        const refusing = vi
          .spyOn(built.engine.core.capacity, "tryReserveProvisioning")
          .mockReturnValue({ ok: false, reason: "ram-budget" });
        return () => refusing.mockRestore();
      },
      options: {},
    },
  ] as const)(
    "waits and starts nothing while the worker is under $reason, then goes on and settles when it lifts",
    async ({ arrange, options, reason }) => {
      const ensureSeed = vi.fn(async () => ({ leases: 0, settled: false, sourceId: "made" }));
      const settleSeed = vi.fn(async (sourceId: string) => ({
        reason: "idle" as const,
        settledAfterMs: 1,
        sourceId,
      }));
      const built = await buildDispatcher({ ...options, seedVerbs: { ensureSeed, settleSeed } });
      const lift = arrange(built);
      built.engine.core.seedSettler.start();
      const heard: unknown[] = [];

      const answer = built.dispatcher.dispatch(
        "seed.make",
        { model: "iPhone 17", platform: "ios" },
        { ...admin, onSeedProgress: (_kind: unknown, progress: unknown) => heard.push(progress) },
      );
      await flushPromises();

      expect(heard).toEqual([{ reason, stage: "waiting" }]);
      expect(ensureSeed).not.toHaveBeenCalled();
      expect(settleSeed).not.toHaveBeenCalled();

      lift();
      built.clock.advance(5 * 60_000);
      await flushPromises();

      await expect(answer).resolves.toMatchObject({ outcome: "settled", sourceId: "made" });
      expect(heard.at(-1), "it settles after the wait").toEqual({ stage: "settling" });
      expect(ensureSeed).toHaveBeenCalledTimes(1);
    },
  );

  it("makes a seed on a worker that serves only slim simulators, because a seed is made full and leased by no one", async () => {
    const built = await buildDispatcher({
      iosModes: ["slim"],
      seedVerbs: {
        ensureSeed: async () => ({ leases: 0, settled: false, sourceId: "made" }),
        settleSeed: async (sourceId) => ({ reason: "idle", settledAfterMs: 1, sourceId }),
      },
    });
    built.engine.core.seedSettler.start();

    const answer = built.dispatcher.dispatch(
      "seed.make",
      { model: "iPhone 17", platform: "ios" },
      admin,
    );
    await flushPromises();

    await expect(answer).resolves.toMatchObject({ outcome: "settled", sourceId: "made" });
  });

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
      code: "RUNTIME_MISSING",
      input: { model: "iPhone 17", osVersion: ">=27", platform: "ios" },
      label: "a range no installed runtime fits",
      message:
        "no installed iOS runtime fits >=27; install one with simlock component install ios and a version",
      options: { driverOptions: { knownModels: ["iPhone 17"] } },
    },
    {
      code: "RUNTIME_MISSING",
      failure: new RuntimeMissingError("android", "default", { downloadable: false }),
      input: { model: "Pixel 9", platform: "android" },
      label: "an Android default with no system image installed, as the Android driver refuses it",
      message:
        "no installed Android runtime fits the default; install one with simlock component install android and a version",
      options: { driverOptions: { knownModels: ["Pixel 9"], platform: "android" as const } },
    },
    {
      code: "BAD_REQUEST",
      failure: new UnsupportedRequestOptionError("ios", "imageTag"),
      input: { imageTag: "google_apis", model: "iPhone 17", platform: "ios" },
      label: "an image tag on ios",
      message: "ios lease requests do not take imageTag",
      options: {},
    },
    {
      code: "RUNTIME_MISSING",
      failure: unfixable("iOS 15.0 predates the download floor; install it manually via Xcode"),
      input: { model: "iPhone 17", osVersion: "15.0", platform: "ios" },
      label: "an iOS below 16, in the lease's own words and not as an install command",
      message: "iOS 15.0 predates the download floor; install it manually via Xcode",
      options: {},
    },
    {
      code: "RUNTIME_MISSING",
      failure: unfixable("iOS 15.0 predates the download floor; install it manually via Xcode"),
      input: { model: "iPhone 7", platform: "ios" },
      label: "an iOS default below the download floor, in the lease's own words",
      message: "iOS 15.0 predates the download floor; install it manually via Xcode",
      options: {},
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
    async ({ code, failure, input, message, options, session: asked, stopping }) => {
      const verbs = {
        ensureSeed: vi.fn(async () => ({ leases: 0, settled: false, sourceId: "made" })),
        settleSeed: vi.fn(async () => {
          throw new Error("unreachable");
        }),
      };
      const built = await buildDispatcher({ ...options, seedVerbs: verbs });
      if (stopping === true) built.engine.core.seedSettler.beginStop();
      if (failure !== undefined) built.driver.failOn("resolveSpec", 1, failure);

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
