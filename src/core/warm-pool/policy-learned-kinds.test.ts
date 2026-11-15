import { describe, expect, it } from "vitest";
import type { VirtualDevice, VirtualSpec } from "../domain.js";
import { evaluate as plan } from "./policy.js";
import {
  evaluate,
  minute,
  now,
  shutdownAfterMs,
  spec,
  device,
  learnedOf,
  modelDemand,
  view,
} from "./test-policy.js";

// why: the pure planner needs many capacity, matching and ordering cases through its policy seam.
describe("warm pool policy", () => {
  describe("targets", () => {
    const kind = spec("iPhone 17");
    const ofKind = (id: string, state: VirtualDevice["state"], extra = {}): VirtualDevice =>
      device(id, state, { spec: kind, ...extra });

    describe("learned kinds", () => {
      const older = spec("iPad Pro");
      const provision = (wanted: VirtualSpec) => ({
        action: "provision",
        reason: "target",
        spec: wanted,
        target: wanted,
      });

      it("fills configured targets in config order, then learned kinds newest first, booting a shut-down device of the kind before creating", () => {
        const learned = [learnedOf(kind, 1, now - minute), learnedOf(older, 1, now - 2 * minute)];

        const first = plan(view([], { learned, limit: 1, maxConcurrentBoots: 2 }));
        expect(first.proposals).toEqual([provision(kind)]);
        expect(first.targets.map((report) => [report.target, report.origin, report.short])).toEqual(
          [
            ["ios iPhone 17 26.0", "learned", undefined],
            ["ios iPad Pro 26.0", "learned", "running-limit"],
          ],
        );

        const configured = spec("iPhone 15");
        expect(
          evaluate(view([], { learned, limit: 1, targets: [{ count: 1, spec: configured }] })),
        ).toEqual([provision(configured)]);

        const shut = ofKind("shut", "shutdown");
        expect(evaluate(view([shut], { learned: [learnedOf(kind, 1, now)] }))).toEqual([
          { action: "boot", deviceId: "shut", reason: "target", target: kind },
        ]);

        const merged = plan(
          view([ofKind("a", "leased")], {
            learned: [learnedOf(kind, 2, now), learnedOf(older, 1, now - minute)],
            limit: 2,
            targets: [{ count: 1, spec: kind }],
          }),
        );
        expect(merged.proposals).toEqual([provision(kind)]);
        expect(
          merged.targets.map((report) => [report.origin, report.count, report.configuredCount]),
        ).toEqual([
          ["configured", 2, 1],
          ["learned", 1, 0],
        ]);
      });

      it("plans enough copies to keep max(peak - leased, 1) of a learned kind ready, counting copies on their way, for a plain kind and a baseline kind alike", () => {
        const baselined = { ...kind, baseline: { name: "demo", version: 1 } };
        const cases = [
          ["peak 1, 1 leased", [ofKind("a", "leased")], 1, kind, [], [provision(kind)]],
          ["peak 1, 1 reclaiming", [ofKind("a", "reclaiming")], 1, kind, [], [provision(kind)]],
          [
            "peak 1, 1 ready under a claim",
            [ofKind("a", "ready")],
            1,
            kind,
            ["a"],
            [provision(kind)],
          ],
          [
            "peak 3, 3 leased",
            [ofKind("a", "leased"), ofKind("b", "leased"), ofKind("c", "leased")],
            3,
            kind,
            [],
            [provision(kind)],
          ],
          [
            "peak 3, 2 leased + 1 reclaiming",
            [ofKind("a", "leased"), ofKind("b", "leased"), ofKind("c", "reclaiming")],
            3,
            kind,
            [],
            [provision(kind)],
          ],
          [
            "peak 3, 1 leased + 1 ready",
            [ofKind("a", "leased"), ofKind("b", "ready")],
            3,
            kind,
            [],
            [provision(kind)],
          ],
          [
            "peak 3, 3 leased + 1 boot in flight",
            [ofKind("a", "leased"), ofKind("b", "leased"), ofKind("c", "leased")],
            3,
            kind,
            [],
            [],
            [kind],
          ],
          [
            "baseline kind, peak 1, 1 leased",
            [ofKind("a", "leased", { spec: baselined })],
            1,
            baselined,
            [],
            [provision(baselined)],
          ],
          [
            "baseline kind, peak 2, 2 copies of version 1 leased while version 2 is newest",
            [
              ofKind("a", "leased", { spec: baselined }),
              ofKind("b", "leased", { spec: baselined }),
            ],
            2,
            { ...kind, baseline: { name: "demo", version: 2 } },
            [],
            [provision({ ...kind, baseline: { name: "demo", version: 2 } })],
          ],
          [
            "baseline kind, peak 2, 2 copies of version 1 on another model leased while version 2 is newest",
            [
              ofKind("a", "leased", { spec: { ...baselined, model: "iPhone 15" } }),
              ofKind("b", "leased", { spec: { ...baselined, model: "iPhone 15" } }),
            ],
            2,
            { ...kind, baseline: { name: "demo", version: 2 } },
            [],
            [provision({ ...kind, baseline: { name: "demo", version: 2 } })],
          ],
          [
            "baseline kind, peak 2, 2 copies of version 1 on another platform leased while version 2 is newest",
            [
              ofKind("a", "leased", { spec: { ...baselined, platform: "android" } }),
              ofKind("b", "leased", { spec: { ...baselined, platform: "android" } }),
            ],
            2,
            { ...kind, baseline: { name: "demo", version: 2 } },
            [],
            [provision({ ...kind, baseline: { name: "demo", version: 2 } })],
          ],
        ] as const;

        for (const [name, devices, peak, wanted, claimed, expected, inFlight = []] of cases) {
          expect(
            evaluate(
              view(devices, {
                claimed,
                inFlight,
                learned: [learnedOf(wanted, peak, now)],
                maxConcurrentBoots: 3,
              }),
            ),
            name,
          ).toEqual(expected);
        }
      });

      it("plans the larger of what the configured count and the learned count each lack for a kind both configured and learned", () => {
        const cases = [
          ["configured 1 + peak 2, 1 leased", 1, 2, 1],
          ["configured 2 + peak 1, 1 leased", 2, 1, 2],
          ["configured 1 + peak 3, 1 leased", 1, 3, 2],
        ] as const;

        for (const [name, configuredCount, peak, created] of cases) {
          expect(
            evaluate(
              view([ofKind("a", "leased")], {
                learned: [learnedOf(kind, peak, now)],
                maxConcurrentBoots: 3,
                targets: [{ count: configuredCount, spec: kind }],
              }),
            ),
            name,
          ).toEqual(Array.from({ length: created }, () => provision(kind)));
        }
      });

      it("keeps a learned kind's never-leased device out of never-leased-idle while the kind wants it, and proposes one beyond its count after idle.shutdownAfterMs", () => {
        const old = now - shutdownAfterMs - 1;
        const wanted = ofKind("wanted", "ready", { createdAt: 1, readyAt: old });
        const extra = ofKind("extra", "ready", { createdAt: 2, readyAt: old });
        const young = ofKind("young", "ready", { createdAt: 3, readyAt: now - 1_000 });
        const learned = [learnedOf(kind, 1, now)];

        expect(evaluate(view([wanted], { learned }))).toEqual([]);
        expect(evaluate(view([wanted, extra], { learned }))).toEqual([
          { action: "shutdown", deviceId: "extra", reason: "never-leased-idle" },
        ]);
        expect(evaluate(view([wanted, young], { learned }))).toEqual([]);
        expect(evaluate(view([wanted, extra], { learned: [learnedOf(kind, 2, now)] }))).toEqual([]);
      });

      it("keeps a learned kind and its devices but plans nothing for it while it is unplanned, and still plans a configured target of its spec", () => {
        const learned = [learnedOf(kind, 1, now)];
        const old = now - shutdownAfterMs - 1;
        const spare = ofKind("spare", "ready", { createdAt: 1, readyAt: old });

        expect(evaluate(view([], { learned, unplanned: [kind] }))).toEqual([]);
        expect(evaluate(view([spare], { learned, unplanned: [kind] }))).toEqual([]);
        expect(evaluate(view([], { learned }))).toEqual([provision(kind)]);
        expect(
          evaluate(view([], { learned, targets: [{ count: 1, spec: kind }], unplanned: [kind] })),
        ).toEqual([provision(kind)]);
      });

      it("displaces the least recently used idle ready device of an older learned kind for a newer one short for a running slot, and never a configured target's device, one that serves a waiting request or is already shut down for the budget, or for a kind short for ram-budget, device-limit or reserve; a configured target displaces it", () => {
        const learned = [learnedOf(kind, 1, now - minute), learnedOf(older, 2, now - 2 * minute)];
        const recent = device("recent", "ready", { endedAgo: 5 * minute, spec: older });
        const stale = device("stale", "ready", { endedAgo: 30 * minute, spec: older });
        const displace = { action: "shutdown", deviceId: "stale", reason: "displaced" };

        const base = plan(view([recent, stale], { learned, limit: 2, maxConcurrentBoots: 2 }));
        expect(base.proposals).toEqual([displace, provision(kind)]);
        expect(base.targets.map((report) => [report.target, report.ready, report.short])).toEqual([
          ["ios iPhone 17 26.0", 0, undefined],
          ["ios iPad Pro 26.0", 1, "running-limit"],
        ]);

        const refused = (options: Parameters<typeof view>[1]) =>
          evaluate(view([recent, stale], { learned, maxConcurrentBoots: 2, ...options }));
        expect(refused({ limit: 2 })).toEqual([displace, provision(kind)]);
        expect(refused({ limit: 2, targets: [{ count: 1, spec: older }] })).toEqual([]);
        expect(refused({ limit: 2, waiting: [modelDemand("iPad Pro")] })).toEqual([]);
        expect(evaluate(view([recent], { learned, limit: 1, maxConcurrentBoots: 2 }))).toEqual([
          { ...displace, deviceId: "recent" },
          provision(kind),
        ]);
        expect(refused({ handoffInFlight: true, limit: 2 })).toEqual([]);
        const holder = device("holder", "leased", { spec: spec("iPad Air") });
        expect(
          evaluate(
            view([holder, stale], {
              learned: [learnedOf(kind, 2, now - minute), learnedOf(older, 1, now - 2 * minute)],
              limit: 1,
              maxConcurrentBoots: 2,
            }),
          ),
        ).toEqual([{ action: "shutdown", deviceId: "stale", reason: "over-budget" }]);
        const droid = device("droid", "ready", {
          endedAgo: 40 * minute,
          spec: spec("Pixel 8", { platform: "android" }),
        });
        expect(
          evaluate(
            view([droid], {
              learned: [learnedOf(kind, 1, now), learnedOf(droid.spec, 1, now - minute)],
              limit: 2,
              limits: { ios: 0 },
              maxConcurrentBoots: 2,
            }),
          ),
        ).toEqual([]);
        expect(refused({ limit: 3, refuseProvision: "ram-budget" })).toEqual([]);
        // why: short for a slot and for RAM the shutdown would not free: no shutdown, or the pool would reboot the victim every pass.
        expect(refused({ limit: 2, refuseProvision: "ram-budget" })).toEqual([]);
        expect(refused({ limit: 2, refuseProvisionUntilDown: "ram-budget" })).toEqual([
          displace,
          provision(kind),
        ]);
        expect(refused({ limit: 2, spared: [{ count: 2, spec: older }] })).toEqual([]);
        expect(refused({ limit: 3, refuseProvision: "device-limit" })).toEqual([]);
        expect(refused({ limit: 3, reserve: { ios: 1 } })).toEqual([]);

        const newer = device("newer", "ready", { endedAgo: 30 * minute, spec: kind });
        expect(
          evaluate(
            view([newer], {
              learned,
              limit: 1,
              maxConcurrentBoots: 2,
            }),
          ),
        ).toEqual([]);
        const phone = spec("iPhone 15");
        expect(
          evaluate(
            view([recent], {
              learned: [learnedOf(older, 1, now)],
              limit: 1,
              maxConcurrentBoots: 2,
              targets: [{ count: 1, spec: phone }],
            }),
          ),
        ).toEqual([{ ...displace, deviceId: "recent" }, provision(phone)]);
      });
    });
  });
});
