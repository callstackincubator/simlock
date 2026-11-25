import { describe, expect, it } from "vitest";
import { LearnedKinds } from "./learned.js";
import { harness, learnedState, minute, now } from "./test-fixtures.js";
import { iphone17, ofKind, held } from "./test-converger.js";

// why: the warm pool is a decomposed module (ADR 0063 section 2); these tests drive its converger part directly.
describe("warm pool targets", () => {
  describe("figures", () => {
    const wanted = {
      mode: "full",
      model: "iPhone 17",
      origin: "configured",
      osVersion: "26.0",
      platform: "ios",
    } as const;

    it("lists a target with its kind, count, ready and booting, and no reason while it fills", async () => {
      let finish: () => void = () => undefined;
      const rig = harness([ofKind("ready", "ready")], {
        limit: 5,
        provision: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        targets: [{ ...iphone17, count: 2 }],
      });

      await rig.pool.pass();

      expect(rig.pool.figures()).toStrictEqual({
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [{ ...wanted, booting: 1, count: 2, ready: 1 }],
      });
      finish();
      await rig.pool.settle();
    });

    it("lists a target the resolver refuses with the kind it was configured with and the refusal as short", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
        targets: [{ ...iphone17, osVersion: "27.0" }],
      });

      await rig.pool.pass();

      expect(rig.pool.figures().targets).toStrictEqual([
        { ...wanted, booting: 0, count: 1, osVersion: "27.0", ready: 0, short: "runtime-missing" },
      ]);
    });

    it("lists every configured target as short disabled with the pool off, before and after a pass", async () => {
      const rig = harness([ofKind("ready", "ready")], {
        enabled: false,
        targets: [iphone17, { ...iphone17, mode: "slim", model: "iPhone 16" }],
      });
      const expected = {
        enabled: false,
        reserveRunning: { android: 0, ios: 0 },
        targets: [
          { ...wanted, booting: 0, count: 1, ready: 0, short: "disabled" },
          {
            ...wanted,
            booting: 0,
            count: 1,
            mode: "slim",
            model: "iPhone 16",
            ready: 0,
            short: "disabled",
          },
        ],
      };

      expect(rig.pool.figures()).toStrictEqual(expected);
      await rig.pool.pass();
      expect(rig.pool.figures()).toStrictEqual(expected);
    });

    it("lists every configured target before the first pass with no reason, so a status read just after a start is not empty", () => {
      const rig = harness([], { targets: [iphone17] });

      expect(rig.pool.figures()).toStrictEqual({
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [{ ...wanted, booting: 0, count: 1, ready: 0 }],
      });
    });

    it("names the platform's default mode for a target that names none, before a pass, with the pool off, refused and resolved", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const modes = async (options: { enabled?: boolean; refuse?: boolean; pass: boolean }) => {
        const rig = harness([], {
          defaultMode: "slim",
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
          ...(options.refuse === true
            ? { resolve: () => ({ message: "why", refusal: "no-driver" as const }) }
            : {}),
          targets: [unversioned],
        });
        if (options.pass) await rig.pool.pass();
        return rig.pool.figures().targets.map((target) => target.mode);
      };

      expect(await modes({ pass: false })).toEqual(["slim"]);
      expect(await modes({ enabled: false, pass: true })).toEqual(["slim"]);
      expect(await modes({ pass: true, refuse: true })).toEqual(["slim"]);
      expect(await modes({ pass: true })).toEqual(["slim"]);
    });

    it("counts only the boots of the spec a target keeps while its resolution is refused unresolvable, and none for one that never resolved", async () => {
      const creation = held();
      let refuse17 = false;
      const rig = harness([], {
        limit: 5,
        maxConcurrentBoots: 2,
        provision: () => creation.gate,
        resolve: (request) => {
          if (request.model === "iPhone 15") return { message: "why", refusal: "no-driver" };
          if (request.model === "iPhone 17" && refuse17) {
            return { message: "why", refusal: "unresolvable" };
          }
          return {
            spec: {
              physical: false,
              model: request.model ?? "",
              osVersion: "26.0",
              platform: request.platform,
            },
          };
        },
        targets: [
          iphone17,
          { ...iphone17, model: "iPhone 16" },
          { ...iphone17, model: "iPhone 15" },
        ],
      });
      const figures = () =>
        Object.fromEntries(rig.pool.figures().targets.map((target) => [target.model, target]));
      await rig.pool.pass();
      expect(figures()["iPhone 17"]?.booting).toBe(1);

      refuse17 = true;
      await rig.pool.pass();

      expect(figures()["iPhone 17"]).toMatchObject({ booting: 1, short: "unresolvable" });
      expect(figures()["iPhone 16"]).toMatchObject({ booting: 1 });
      expect(figures()["iPhone 15"]).toMatchObject({ booting: 0, short: "no-driver" });
      creation.finish();
      await rig.pool.settle();
    });

    it("leaves out osVersion for a refused target that names none", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const rig = harness([], {
        resolve: () => ({ message: "no driver", refusal: "no-driver" }),
        targets: [unversioned],
      });

      await rig.pool.pass();

      expect(rig.pool.figures().targets[0]).toStrictEqual({
        booting: 0,
        count: 1,
        mode: "full",
        model: "iPhone 17",
        origin: "configured",
        platform: "ios",
        ready: 0,
        short: "no-driver",
      });
    });
  });

  describe("warm-pool.target-missed", () => {
    const missed = (rig: ReturnType<typeof harness>): unknown[] => {
      const payloads: unknown[] = [];
      rig.eventBus.subscribe("warm-pool.target-missed", (envelope) => {
        payloads.push(envelope.payload);
      });
      return payloads;
    };

    it("fires once when a target first ends a pass short, with its kind, count, ready and reason", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
        targets: [{ ...iphone17, osVersion: "27.0" }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        {
          count: 1,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "27.0",
          platform: "ios",
          ready: 0,
          reason: "runtime-missing",
        },
      ]);
    });

    it("does not fire again on the next pass that leaves the target short", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "why", refusal: "runtime-missing" }),
        targets: [iphone17],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toHaveLength(1);
    });

    it("names the pool as the emitter, and leaves osVersion out for a target that names none", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      const rig = harness([], {
        resolve: () => ({ message: "no driver", refusal: "no-driver" }),
        targets: [unversioned],
      });
      const seen: { module: string; payload: unknown }[] = [];
      rig.eventBus.subscribe("warm-pool.target-missed", (envelope) => {
        seen.push({ module: envelope.module, payload: envelope.payload });
      });

      await rig.pool.pass();

      expect(seen).toStrictEqual([
        {
          module: "warm-pool",
          payload: {
            count: 1,
            mode: "full",
            model: "iPhone 17",
            origin: "configured",
            platform: "ios",
            ready: 0,
            reason: "no-driver",
          },
        },
      ]);
    });

    it("fires again when the target was met in between, ready reaching its count, and is missed again", async () => {
      let refuse = true;
      const rig = harness([ofKind("ready", "ready")], {
        resolve: (request) =>
          refuse
            ? { message: "why", refusal: "runtime-missing" }
            : {
                spec: {
                  physical: false,
                  model: request.model ?? "",
                  osVersion: "26.0",
                  platform: request.platform,
                },
              },
        targets: [iphone17],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      refuse = false;
      await rig.pool.pass();
      await rig.pool.settle();
      expect(rig.pool.figures().targets[0]).toMatchObject({ count: 1, ready: 1 });
      refuse = true;
      await rig.pool.pass();

      expect(payloads).toHaveLength(2);
    });

    it("does not fire again for a target that is only not short on a pass, filling or retrying, until it is met", async () => {
      const rig = harness([], {
        limit: 5,
        provision: async () => {
          throw new Error("no luck");
        },
        targets: [iphone17],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.settle();
      expect(rig.pool.figures().targets[0]?.short).toBe("boot-failed");
      rig.clock.advance(minute);
      await rig.pool.settle();
      rig.clock.advance(2 * minute);
      await rig.pool.settle();

      expect(rig.provisionCalls).toHaveLength(3);
      expect(payloads).toStrictEqual([expect.objectContaining({ reason: "boot-failed" })]);
    });

    it("fires once for a target with no OS that is refused one pass and short the next, though its kind changes", async () => {
      const { osVersion: _osVersion, ...unversioned } = iphone17;
      let refuse = true;
      const rig = harness([], {
        limit: 0,
        resolve: (request) =>
          refuse
            ? { message: "why", refusal: "unresolvable" }
            : {
                spec: {
                  physical: false,
                  model: request.model ?? "",
                  osVersion: "26.0",
                  platform: request.platform,
                },
              },
        targets: [unversioned],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      refuse = false;
      await rig.pool.pass();

      expect(rig.pool.figures().targets[0]).toMatchObject({
        osVersion: "26.0",
        short: "running-limit",
      });
      expect(payloads).toStrictEqual([expect.objectContaining({ reason: "unresolvable" })]);
    });

    it("fires once for two targets that resolve to one spec, and on no later pass", async () => {
      const rig = harness([], {
        limit: 0,
        targets: [iphone17, { ...iphone17, count: 2 }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        expect.objectContaining({ count: 3, reason: "running-limit" }),
      ]);
    });

    it("fires for each of two configured targets of one kind that are both refused, not once for the kind", async () => {
      const rig = harness([], {
        resolve: () => ({ message: "why", refusal: "runtime-missing" }),
        targets: [iphone17, { ...iphone17, count: 2 }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      await rig.pool.pass();

      expect(payloads).toStrictEqual([
        expect.objectContaining({ count: 1, model: "iPhone 17", reason: "runtime-missing" }),
        expect.objectContaining({ count: 2, model: "iPhone 17", reason: "runtime-missing" }),
      ]);
    });

    it("keeps each configured target's edge apart: one met and one short, then the met one missed, fires for it too", async () => {
      const rig = harness([ofKind("ready", "ready")], {
        limit: 0,
        targets: [iphone17, { ...iphone17, model: "iPhone 16" }],
      });
      const payloads = missed(rig);

      await rig.pool.pass();
      rig.lease("ready");
      await rig.pool.pass();

      expect(payloads.map((payload) => (payload as { model: string }).model)).toEqual([
        "iPhone 16",
        "iPhone 17",
      ]);
    });

    it("fires nothing for a target that is filling, and nothing with the pool off", async () => {
      const filling = harness([], { limit: 5, targets: [iphone17] });
      const fillingPayloads = missed(filling);
      await filling.pool.pass();
      await filling.pool.settle();
      const off = harness([], { enabled: false, targets: [iphone17] });
      const offPayloads = missed(off);
      await off.pool.pass();

      expect(fillingPayloads).toEqual([]);
      expect(offPayloads).toEqual([]);
    });
  });

  describe("targeted", () => {
    it("names, once a pass has resolved the targets, the ready unleased devices of the kind up to the count, oldest first", async () => {
      const rig = harness(
        [ofKind("newer", "ready", 20), ofKind("older", "ready", 10), ofKind("oldest", "ready", 5)],
        { limit: 5, targets: [{ ...iphone17, count: 2 }] },
      );
      await rig.pool.pass();

      expect([...(await rig.pool.targeted())].sort()).toEqual(["older", "oldest"]);
    });

    it("names a learned kind's ready devices up to its count before the first pass, and again for a pool started over the same record", async () => {
      const spec = ofKind("x", "ready").spec;
      new LearnedKinds(learnedState).learn(spec, "lease-1", now - minute);
      new LearnedKinds(learnedState).learn(spec, "lease-2", now - minute);
      const devices = [ofKind("newer", "ready", 20), ofKind("older", "ready", 10)];

      const before = harness(devices, { limit: 5 });
      const restarted = harness(devices, { limit: 5 });
      const off = harness(devices, { enabled: false, limit: 5 });

      expect([...(await before.pool.targeted())].sort()).toEqual(["newer", "older"]);
      expect([...(await restarted.pool.targeted())].sort()).toEqual(["newer", "older"]);
      expect([...(await off.pool.targeted())]).toEqual([]);
    });

    it("does not name a device that is leased or claimed", async () => {
      const rig = harness([ofKind("leased", "ready", 1), ofKind("claimed", "ready", 2)], {
        limit: 5,
        targets: [{ ...iphone17, count: 2 }],
      });
      await rig.pool.pass();
      rig.lease("leased");
      rig.claims.tryClaim("claimed", "boot");

      expect([...(await rig.pool.targeted())]).toEqual([]);
    });
  });
});
