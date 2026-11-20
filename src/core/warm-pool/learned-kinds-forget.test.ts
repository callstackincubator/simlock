import { describe, expect, it } from "vitest";
import { openMemoryState } from "../testing.js";
import type { WarmTarget } from "./config.js";
import type { WarmPool } from "./converger.js";
import { LearnedKinds, warmPoolOwner } from "./learned.js";
import { device, harness, iosListing, minute, now, waiter } from "./test-fixtures.js";

// why: the warm pool is a decomposed module (ADR 0063 section 2); these tests drive its converger and learned-kinds parts directly.
describe("warm pool learned kinds", () => {
  it("forgetKinds forgets the kinds the match names, logs each, answers them, and asks for a pass only when a kind matched, leaving their devices to the idle rules", async () => {
    const phone = device("kept", "ready", 0).spec;
    const state = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(state).learn(phone, "l1", now - 2 * minute);
    new LearnedKinds(state).ended("l1", now - minute);
    const pad = {
      ...device("pad", "shutdown", 60 * minute),
      spec: {
        model: "iPad Pro",
        osVersion: "26.0",
        physical: false as const,
        platform: "ios" as const,
      },
    };
    const rig = harness([device("kept", "ready", minute), pad], {
      catalog: async () => [iosListing],
      state,
      targets: [{ count: 1, model: "iPad Pro", osVersion: "26.0", platform: "ios" }],
    });
    expect([...(await rig.pool.targeted())]).toEqual(["kept"]);

    expect(rig.pool.forgetKinds({ model: "iPhone 16", platform: "ios" })).toEqual([]);
    await rig.pool.settle();
    expect(rig.bootCalls).toEqual([]);
    expect(rig.pool.forgetKinds({ model: "iPhone 15", platform: "ios" })).toEqual([phone]);
    await rig.pool.settle();

    expect(rig.bootCalls).toHaveLength(1);
    expect([...(await rig.pool.targeted())]).toEqual(["pad"]);
    expect(rig.shutdownCalls).toEqual([]);
    expect(new LearnedKinds(state).kinds(now)).toEqual([]);
    expect(
      rig.sink.records
        .filter((record) => record.message.includes("by the operator"))
        .map((record) => record.fields),
    ).toEqual([{ model: "iPhone 15", osVersion: "26.0", platform: "ios" }]);
  });

  it("forgetKinds matches a learned baseline kind on the newest version's model, OS, mode and image tag, and never answers or deletes a baseline still counting", async () => {
    const learnedBaseline = {
      ...device("d1", "ready", 0).spec,
      baseline: { name: "checkout", version: 1 },
    };
    const plain = device("d0", "ready", 0).spec;
    const newest = {
      imageTag: "google_apis",
      mode: "slim",
      model: "Pixel 8",
      osVersion: "35",
      platform: "android",
      version: 2,
    } as const;
    const run = async (
      match: Parameters<WarmPool["forgetKinds"]>[0],
      learnAfter = 1,
      withPlain = false,
    ) => {
      const state = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(state).learn(learnedBaseline, "l1", now - minute, learnAfter);
      if (withPlain) new LearnedKinds(state).learn(plain, "l0", now - minute);
      const rig = harness([], { baselines: { checkout: newest }, state });
      const answered = rig.pool.forgetKinds(match);
      return {
        answered: answered.map((spec) => [spec.model, spec.baseline?.name]),
        remaining: new LearnedKinds(state).kinds(now).length,
        state,
      };
    };

    expect((await run({ model: "Pixel 8", platform: "android" })).answered).toEqual([
      ["Pixel 8", "checkout"],
    ]);
    expect((await run({ model: "Pixel 8", platform: "android" })).remaining).toBe(0);
    expect((await run({ model: "iPhone 15", platform: "ios" })).answered).toEqual([]);
    expect((await run({ model: "iPhone 15", platform: "ios" })).remaining).toBe(1);
    // why: a plain kind that shares the baseline row's stored model is forgotten alone: the baseline's row is keyed on its name.
    const beside = await run({ model: "iPhone 15", platform: "ios" }, 1, true);
    expect(beside.answered).toEqual([["iPhone 15", undefined]]);
    expect(beside.remaining).toBe(1);
    expect(
      (await run({ model: "Pixel 8", osVersion: "35", platform: "android" })).answered,
    ).toHaveLength(1);
    expect(
      (await run({ model: "Pixel 8", osVersion: "34", platform: "android" })).answered,
    ).toEqual([]);
    expect(
      (await run({ mode: "slim", model: "Pixel 8", platform: "android" })).answered,
    ).toHaveLength(1);
    expect((await run({ mode: "full", model: "Pixel 8", platform: "android" })).answered).toEqual(
      [],
    );
    expect(
      (await run({ imageTag: "google_apis", model: "Pixel 8", platform: "android" })).answered,
    ).toHaveLength(1);
    expect(
      (await run({ imageTag: "other", model: "Pixel 8", platform: "android" })).answered,
    ).toEqual([]);

    const counting = await run({ model: "Pixel 8", platform: "android" }, 2);
    expect(counting.answered).toEqual([]);
    new LearnedKinds(counting.state).learn(learnedBaseline, "l2", now, 2);
    expect(new LearnedKinds(counting.state).kinds(now)).toHaveLength(1);
  });

  it("forgetKinds keeps the retry backoff of a failing configured target of the forgotten kind's spec", async () => {
    const phone = device("d1", "ready", 0).spec;
    const state = await openMemoryState([warmPoolOwner]);
    new LearnedKinds(state).learn(phone, "l1", now - 2 * minute);
    new LearnedKinds(state).ended("l1", now - minute);
    const rig = harness([device("shut", "shutdown", 60 * minute)], {
      boot: async () => {
        throw new Error("simulator did not boot");
      },
      catalog: async () => [iosListing],
      state,
      targets: [{ count: 1, model: "iPhone 15", osVersion: "26.0", platform: "ios" }],
    });
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.bootCalls).toHaveLength(1);

    expect(rig.pool.forgetKinds({ model: "iPhone 15", platform: "ios" })).toEqual([phone]);
    await rig.pool.settle();
    expect(rig.bootCalls).toHaveLength(1);

    rig.clock.advance(minute);
    await rig.pool.settle();
    expect(rig.bootCalls).toHaveLength(2);
  });

  it("forgets a learned kind on its third failed boot or creation in a row with one warning, and a success in between, a forgetting or an operator's forget resets the count, and a configured target's kind is never forgotten", async () => {
    const phone = device("d1", "ready", 0).spec;
    const configured: WarmTarget = {
      count: 1,
      model: "iPhone 15",
      osVersion: "26.0",
      platform: "ios",
    };
    const run = async (
      outcomes: readonly ("fail" | "ok")[],
      creation: boolean,
      options: { forgetAt?: number; relearnAt?: number; targets?: WarmTarget[] } = {},
    ) => {
      const state = await openMemoryState([warmPoolOwner]);
      new LearnedKinds(state).learn(phone, "l1", now - 2 * minute);
      new LearnedKinds(state).ended("l1", now - minute);
      let attempt = 0;
      const next = (): "fail" | "ok" => outcomes[attempt++] ?? "ok";
      const rig: ReturnType<typeof harness> = harness(
        creation ? [] : [device("shut", "shutdown", 60 * minute)],
        {
          boot: async (target) => {
            if (next() === "fail") throw new Error("simulator did not boot");
            return { ...target, state: "ready" };
          },
          catalog: async () => [iosListing],
          provision: async () => {
            if (next() === "fail") throw new Error("creation failed");
          },
          state,
          ...(options.targets === undefined ? {} : { targets: options.targets }),
        },
      );
      for (let round = 0; round < outcomes.length; round += 1) {
        if (round === options.forgetAt)
          rig.pool.forgetKinds({ model: phone.model, platform: "ios" });
        if (round === options.relearnAt || round === options.forgetAt) {
          new LearnedKinds(state).learn(phone, "l2", rig.clock.now() - 2 * minute);
          new LearnedKinds(state).ended("l2", rig.clock.now() - minute);
        }
        await rig.pool.pass();
        await rig.pool.settle();
        rig.clock.advance(10 * minute);
        rig.state.devices = rig.state.devices
          .filter((item) => !item.id.startsWith("new-"))
          .map((item) => ({ ...item, state: "shutdown" as const }));
      }
      return {
        kinds: new LearnedKinds(state).kinds(rig.clock.now()).length,
        warnings: rig.sink.records.filter(
          (record) =>
            record.message ===
            "a warm pool learned kind failed three times in a row and was forgotten",
        ),
      };
    };

    for (const creation of [false, true]) {
      const third = await run(["fail", "fail", "fail"], creation);
      expect(third.kinds, `creation ${creation}`).toBe(0);
      expect(third.warnings).toHaveLength(1);
      const reset = await run(["fail", "fail", "ok", "fail", "fail"], creation);
      expect(reset.kinds, `creation ${creation}`).toBe(1);
      expect(reset.warnings).toEqual([]);
      const two = await run(["fail", "fail"], creation);
      expect(two.kinds, `creation ${creation}`).toBe(1);
      const again = await run(["fail", "fail", "fail", "fail"], creation, { relearnAt: 3 });
      expect(again.kinds, `creation ${creation}`).toBe(1);
      const forgot = await run(["fail", "fail", "fail"], creation, { forgetAt: 2 });
      expect(forgot.kinds, `creation ${creation}`).toBe(1);
      expect(forgot.warnings).toEqual([]);
      const kept = await run(["fail", "fail", "fail"], creation, { targets: [configured] });
      expect(kept.kinds, `creation ${creation}`).toBe(1);
      expect(kept.warnings).toEqual([]);
    }

    const behind = { ...phone, model: "iPhone 16" };
    const waiters = harness([], {
      maxConcurrentBoots: 2,
      provision: async () => {
        throw new Error("creation failed");
      },
      state: await openMemoryState([warmPoolOwner]),
      waiting: () => [waiter({ ...phone, model: "iPhone 15" }, true), waiter(behind)],
    });
    for (let round = 0; round < 3; round += 1) {
      await waiters.pool.pass();
      await waiters.pool.settle();
      waiters.clock.advance(10 * minute);
    }
    expect(waiters.provisionCalls).toHaveLength(3);
    expect(
      waiters.sink.records.filter((record) => record.message.includes("was forgotten")),
    ).toEqual([]);
  });
});
