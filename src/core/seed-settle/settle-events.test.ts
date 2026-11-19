import { describe, expect, it } from "vitest";

import {
  deferred,
  flush,
  iphoneSpec,
  minute,
  newDevicesPaused,
  quick,
  settledResult,
  settlerRig,
  type SettlerRig,
} from "./test-rig.js";

const kind = { model: "iPhone 17", osVersion: "26.5", platform: "ios" } as const;

function seedEvents(rig: SettlerRig) {
  const seen: { event: string; payload: unknown }[] = [];
  rig.harness.bus.subscribeAll((envelope) => {
    if (envelope.event.startsWith("seed.")) {
      seen.push({ event: envelope.event, payload: envelope.payload });
    }
  });
  return seen;
}

const abortable = (signal: AbortSignal) =>
  new Promise<ReturnType<typeof settledResult>>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("seed settler: events", () => {
  it("emits seed.settle-started when the driver is called and seed.settle-ended with the outcome for a settle, a cap, a failure, an abort and an operator's settle, and none for a kind already settled", async () => {
    const ended = async (
      arrange: (
        rig: SettlerRig,
        end: ReturnType<typeof deferred<ReturnType<typeof settledResult>>>,
      ) => void,
      finish: (
        rig: SettlerRig,
        end: ReturnType<typeof deferred<ReturnType<typeof settledResult>>>,
      ) => Promise<void>,
    ) => {
      const rig = await settlerRig();
      const seen = seedEvents(rig);
      const end = deferred<ReturnType<typeof settledResult>>();
      rig.ios.sources = [{ ...quick("seed", 3), imageTag: "default" }];
      rig.ios.settleSeed = () => end.promise;
      arrange(rig, end);
      await rig.started();
      await rig.advance(5 * minute);
      const startedOnly = seen.map(({ event }) => event);
      await rig.advance(6 * minute);
      await finish(rig, end);
      await flush();
      return { seen, startedOnly };
    };
    const identity = { ...kind, imageTag: "default", sourceId: "seed" };

    const settled = await ended(
      () => undefined,
      async (_rig, end) => end.resolve(settledResult("seed")),
    );
    expect(settled.startedOnly, "started with the driver call, before it returns").toEqual([
      "seed.settle-started",
    ]);
    expect(settled.seen).toEqual([
      {
        event: "seed.settle-started",
        payload: { ...identity, leases: 3, trigger: "background" },
      },
      {
        event: "seed.settle-ended",
        payload: {
          ...identity,
          durationMs: 6 * minute,
          newSourceId: "seed-settled",
          outcome: "settled",
          sizeBytes: 1_800_000_000,
        },
      },
    ]);

    const cap = await ended(
      () => undefined,
      async (_rig, end) => end.resolve({ ...settledResult("seed"), reason: "cap" }),
    );
    expect(cap.seen.at(-1)?.payload).toMatchObject({ newSourceId: "seed-settled", outcome: "cap" });

    const failed = await ended(
      () => undefined,
      async (_rig, end) => end.reject(new Error("the simulator would not boot")),
    );
    expect(failed.seen.at(-1)?.payload).toEqual({
      ...identity,
      durationMs: 6 * minute,
      message: "the simulator would not boot",
      outcome: "failed",
    });

    const aborts = {
      "daemon-stopping": (rig: SettlerRig) => rig.settler.stop(),
      "memory-pressure": async (rig: SettlerRig) => rig.pressure.reading(newDevicesPaused),
      nuke: (rig: SettlerRig) => rig.settler.holdWhile(async () => undefined),
    };
    for (const [reason, abort] of Object.entries(aborts)) {
      const run = await ended(
        (rig) => {
          rig.ios.settleSeed = (_id, signal) => abortable(signal);
        },
        async (rig) => {
          await abort(rig);
        },
      );
      expect(run.seen.at(-1)?.payload, reason).toEqual({
        ...identity,
        durationMs: 6 * minute,
        outcome: "aborted",
        reason,
      });
    }

    const operator = await settlerRig();
    const seen = seedEvents(operator);
    operator.ios.ensureSeed = async () => ({ leases: 7, settled: false, sourceId: "seed" });
    await operator.started();
    await operator.settler.settle(iphoneSpec, { onProgress: () => undefined });
    expect(seen.map(({ event, payload }) => ({ event, payload }))).toMatchObject([
      {
        event: "seed.settle-started",
        payload: { leases: 7, sourceId: "seed", trigger: "operator" },
      },
      { event: "seed.settle-ended", payload: { outcome: "settled", sourceId: "seed" } },
    ]);

    const already = await settlerRig();
    const none = seedEvents(already);
    already.ios.sources = [quick("seed", 3, { settled: true })];
    await already.started();
    await expect(
      already.settler.settle(iphoneSpec, { onProgress: () => undefined }),
    ).resolves.toMatchObject({ outcome: "already-settled", sourceId: "seed" });
    expect(none).toEqual([]);
  });
});
