import { describe, expect, it } from "vitest";
import type { VirtualDevice, VirtualSpec, WaitingDemand } from "../domain.js";
import { type ResolvedTarget, targetedDevices, type WarmPolicyView } from "./policy.js";
import { spec, device, learnedOf, leaseOn, classDemand, modelDemand, view } from "./test-policy.js";

// why: the pure planner needs many capacity, matching and ordering cases through its policy seam.
describe("warm pool policy", () => {
  describe("targets", () => {
    const kind = spec("iPhone 17");
    const target = (count: number, overrides: Partial<VirtualSpec> = {}): ResolvedTarget => ({
      count,
      spec: { ...kind, ...overrides },
    });
    const ofKind = (id: string, state: VirtualDevice["state"], extra = {}): VirtualDevice =>
      device(id, state, { spec: kind, ...extra });

    describe("targetedDevices", () => {
      const input = (devices: readonly VirtualDevice[], targets: readonly ResolvedTarget[]) => ({
        devices,
        isClaimed: (id: string) => id === "claimed",
        leases: devices.filter((item) => item.state === "leased").map(leaseOn),
        learned: [] as WarmPolicyView["learned"],
        targets,
        waiting: [] as readonly WaitingDemand[],
      });

      it("names, for each target, its ready unleased devices of that kind, oldest first, up to the count", () => {
        const newer = ofKind("newer", "ready", { createdAt: 20 });
        const older = ofKind("older", "ready", { createdAt: 10 });
        const oldest = ofKind("oldest", "ready", { createdAt: 5 });
        const iPad = device("ipad", "ready", { spec: spec("iPad Pro") });

        expect(
          [...targetedDevices(input([newer, older, oldest, iPad], [target(2)]))].sort(),
        ).toEqual(["older", "oldest"]);
      });

      it("names a learned kind's ready unleased devices up to its count, oldest first, and the larger of a configured and a learned count", () => {
        const devices = [
          ofKind("newer", "ready", { createdAt: 20 }),
          ofKind("older", "ready", { createdAt: 10 }),
          ofKind("oldest", "ready", { createdAt: 5 }),
          device("ipad", "ready", { spec: spec("iPad Pro") }),
        ];
        const named = (learnedCount: number, targets: readonly ResolvedTarget[] = []) =>
          [
            ...targetedDevices({
              ...input(devices, targets),
              learned: [learnedOf(kind, learnedCount)],
            }),
          ].sort();

        expect(named(2)).toEqual(["older", "oldest"]);
        expect(named(1)).toEqual(["oldest"]);
        expect(named(1, [target(2)])).toEqual(["older", "oldest"]);
        expect(named(3, [target(2)])).toEqual(["newer", "older", "oldest"]);
      });

      it("leaves out a leased, claimed, shut-down or spent device and one of another mode", () => {
        const devices = [
          ofKind("leased", "leased"),
          ofKind("claimed", "ready"),
          ofKind("shut", "shutdown"),
          ofKind("spent", "ready", { endedAgo: 1, leaseIdentity: "fresh", spent: true }),
          device("slim", "ready", { spec: { ...kind, mode: "slim" } }),
          ofKind("good", "ready"),
        ];

        expect([...targetedDevices(input(devices, [target(5)]))]).toEqual(["good"]);
      });

      it("protects queued demand only for ready idle grantable devices matching its requirement and mode", () => {
        const ready = device("ready", "ready");
        const waiting = [classDemand()];
        const cases = [
          ["matching class", view([ready], { waiting }), ["ready"]],
          [
            "matching exact model",
            view([ready], { waiting: [modelDemand("iPhone 15")] }),
            ["ready"],
          ],
          ["no devices", view([], { waiting }), []],
          [
            "later active waiter",
            view([ready], {
              waiting: [classDemand("slim"), classDemand("full", "ios", true), ...waiting],
            }),
            ["ready"],
          ],
          [
            "union with configured and learned kinds",
            view(
              [
                ofKind("targeted", "ready"),
                device("learned", "ready", { spec: spec("iPad Pro") }),
                ready,
              ],
              {
                targets: [target(1)],
                learned: [learnedOf(spec("iPad Pro"))],
                waiting,
              },
            ),
            ["targeted", "learned", "ready"],
          ],
          [
            "another matching model",
            view([{ ...ready, spec: spec("iPhone 17") }], { waiting }),
            ["ready"],
          ],
          ["no demand", view([ready]), []],
          ["in flight", view([ready], { waiting: [classDemand("full", "ios", true)] }), []],
          ["claimed", view([ready], { claimed: [ready.id], waiting }), []],
          ["leased record", view([ready], { leased: [ready], waiting }), []],
          ["shutdown", view([{ ...ready, state: "shutdown" }], { waiting }), []],
          [
            "spent fresh",
            view([device("ready", "ready", { endedAgo: 1, leaseIdentity: "fresh", spent: true })], {
              waiting,
            }),
            [],
          ],
          [
            "spent without fresh identity",
            view([device("ready", "ready", { endedAgo: 1, spent: true })], { waiting }),
            [],
          ],
          [
            "unused fresh",
            view([device("ready", "ready", { leaseIdentity: "fresh" })], { waiting }),
            ["ready"],
          ],
          ["mode", view([ready], { waiting: [classDemand("slim")] }), []],
          ["platform", view([ready], { waiting: [classDemand("full", "android")] }), []],
          ["model", view([ready], { waiting: [modelDemand("iPhone 17")] }), []],
          ["class", view([{ ...ready, spec: spec("iPad Pro") }], { waiting }), []],
          [
            "OS",
            view([{ ...ready, spec: spec("iPhone 15", { osVersion: "25.0" }) }], { waiting }),
            [],
          ],
          [
            "image",
            view([ready], {
              waiting: [
                {
                  ...classDemand(),
                  requirement: { ...classDemand().requirement, imageTag: "google_apis" },
                },
              ],
            }),
            [],
          ],
        ] as const;

        for (const [name, policyView, expected] of cases) {
          expect([...targetedDevices(policyView)], name).toEqual(expected);
        }
      });

      it("sums the counts of targets of one spec and keeps a different spec apart", () => {
        const devices = [
          ofKind("a", "ready", { createdAt: 1 }),
          ofKind("b", "ready", { createdAt: 2 }),
          ofKind("c", "ready", { createdAt: 3 }),
          device("ipad", "ready", { spec: spec("iPad Pro") }),
        ];

        expect(
          [
            ...targetedDevices(
              input(devices, [target(1), target(2), { count: 1, spec: spec("iPad Pro") }]),
            ),
          ].sort(),
        ).toEqual(["a", "b", "c", "ipad"]);
      });
    });
  });
});
