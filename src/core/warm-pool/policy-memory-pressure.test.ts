import { describe, expect, it } from "vitest";
import type { VirtualDevice } from "../domain.js";
import { evaluate as plan } from "./policy.js";
import {
  proposalsOf,
  minute,
  spec,
  device,
  learnedOf,
  classDemand,
  modelDemand,
  view,
} from "./test-policy.js";

// why: the pure planner needs many capacity, matching and ordering cases through its policy seam.
describe("warm pool policy", () => {
  describe("memory pressure", () => {
    const kind = spec("iPhone 17");
    const paused = { mayShed: false, step: "warming-paused" as const };
    const waiter = (inFlight = false) => classDemand("full", "ios", inFlight, "iPhone 17");

    it("at warming-paused starts nothing and reports every short target as memory-pressure, in place of any other reason", () => {
      const busy = device("busy", "leased", { spec: spec("iPad Pro") });
      const shut = device("shut", "shutdown", { endedAgo: 20 * minute, spec: kind });
      const cases = [
        { name: "configured target", options: { targets: [{ count: 1, spec: kind }] } },
        { name: "learned kind", options: { learned: [learnedOf(kind)] } },
        {
          name: "configured target also short for the reserve",
          options: {
            limits: { ios: 2 },
            reserve: { ios: 1 },
            targets: [{ count: 1, spec: kind }],
          },
          other: "reserve",
          proposes: false,
        },
        {
          name: "configured target also short for a boot that failed",
          options: { blocked: [kind], targets: [{ count: 1, spec: kind }] },
          other: "boot-failed",
          proposes: false,
        },
        {
          name: "creation for a queued request",
          options: { maxConcurrentBoots: 3, waiting: [waiter(true), waiter(), waiter()] },
        },
        {
          name: "boot of a shut-down device for a queued request",
          devices: [busy, shut],
          options: { waiting: [waiter()] },
        },
      ];

      const refused = plan(
        view([busy], { refuseProvision: "memory-pressure", targets: [{ count: 1, spec: kind }] }),
      );
      expect(refused.targets[0]?.short, "a capacity refusal for memory pressure").toBe(
        "memory-pressure",
      );

      for (const { devices = [busy], name, options, other, proposes = true } of cases) {
        const open = plan(view(devices, options));
        const held = plan(view(devices, { ...options, pressure: paused }));
        if (proposes)
          expect(open.proposals, `${name} is proposed when memory is not short`).not.toEqual([]);
        expect(held.proposals, name).toEqual([]);
        expect(open.targets[0]?.short, name).toBe(other);
        if (options.targets !== undefined || options.learned !== undefined)
          expect(held.targets[0]?.short, name).toBe("memory-pressure");
      }
    });

    it("sheds one idle device a reading: a device no configured target keeps first, then a kept one, least recently used first, never one a waiter would take, one the budget already shuts down or one whose shutdown just failed", () => {
      const ofKind = (id: string, endedAgo: number) =>
        device(id, "ready", { endedAgo, spec: kind });
      const keptOldest = ofKind("kept", 90 * minute);
      const extra = ofKind("extra", 40 * minute);
      const olderOther = device("older", "ready", {
        endedAgo: 60 * minute,
        spec: spec("iPad Pro"),
      });
      const newerOther = device("newer", "ready", { endedAgo: 5 * minute, spec: spec("iPad Pro") });
      const learnedOnly = device("learned", "ready", { endedAgo: 30 * minute });
      const targets = [{ count: 1, spec: kind }];
      const sheds = (
        devices: readonly VirtualDevice[],
        options: Parameters<typeof view>[1] = {},
        pressure: NonNullable<NonNullable<Parameters<typeof view>[1]>["pressure"]> = {},
      ): string[] =>
        proposalsOf(
          view(devices, { targets, ...options, pressure: { step: "warming-paused", ...pressure } }),
        ).flatMap((proposal) =>
          proposal.action === "shutdown" && proposal.reason === "memory-pressure"
            ? [proposal.deviceId]
            : [],
        );

      expect(sheds([keptOldest, newerOther, olderOther]), "unkept, least recently used").toEqual([
        "older",
      ]);
      expect(sheds([keptOldest, extra]), "a copy past the configured count").toEqual(["extra"]);
      expect(sheds([keptOldest]), "a kept device when nothing else is idle").toEqual(["kept"]);
      expect(
        sheds([learnedOnly, keptOldest], { learned: [learnedOf(learnedOnly.spec)] }),
        "a learned kind keeps nothing",
      ).toEqual(["learned"]);
      expect(
        sheds([keptOldest, extra], { spared: targets, targets: [] }),
        "a spared target's device counts as kept",
      ).toEqual(["extra"]);
      expect(
        sheds([keptOldest, olderOther, newerOther], {
          waiting: [modelDemand("iPad Pro")],
        }),
        "a device a waiter would take",
      ).toEqual(["kept"]);
      expect(
        sheds([keptOldest, olderOther, newerOther], { claimed: ["older"] }),
        "a claimed device",
      ).toEqual(["newer"]);
      expect(
        sheds([keptOldest, olderOther, newerOther], {}, { shedFailed: ["older"] }),
        "a device whose shutdown just failed",
      ).toEqual(["newer"]);
      expect(sheds([keptOldest, olderOther], {}, { mayShed: false }), "no new reading").toEqual([]);
      expect(sheds([keptOldest, olderOther], {}, { step: "none" }), "step none").toEqual([]);
      expect(sheds([device("busy", "leased")]), "nothing idle").toEqual([]);

      const overBudget = proposalsOf(
        view([keptOldest, olderOther, newerOther], {
          limit: 2,
          pressure: { step: "warming-paused" },
          targets: [],
        }),
      ).flatMap((proposal) => (proposal.action === "shutdown" ? [proposal.deviceId] : []));
      expect(overBudget, "a device the budget shuts down is not shed again").toEqual([
        "kept",
        "older",
      ]);
    });
  });
});
