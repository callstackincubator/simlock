import { describe, expect, it } from "vitest";
import type { VirtualDevice, VirtualSpec } from "../domain.js";
import { evaluate as plan, type ResolvedTarget, targetedDevices } from "./policy.js";
import {
  proposalsOf,
  minute,
  now,
  shutdownAfterMs,
  spec,
  device,
  learnedOf,
  leaseOn,
  classDemand,
  modelDemand,
  view,
} from "./test-policy.js";

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

    it("with a target of two, one ready device of its kind and a shut-down one, proposes one boot of the shut-down one", () => {
      const ready = ofKind("ready", "ready");
      const shut = ofKind("shut", "shutdown");

      const proposals = proposalsOf(view([ready, shut], { targets: [target(2)] }));

      expect(proposals).toEqual([
        { action: "boot", deviceId: "shut", reason: "target", target: kind },
      ]);
    });

    it("with a target and no device of its kind, proposes one provision with the resolved spec", () => {
      const other = device("other", "ready", { endedAgo: minute, spec: spec("iPad Pro") });

      const proposals = proposalsOf(view([other], { targets: [target(1)] }));

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("proposes nothing for a target whose count of devices of its kind is ready", () => {
      const first = ofKind("first", "ready");
      const second = ofKind("second", "ready");

      expect(proposalsOf(view([first, second], { targets: [target(2)] }))).toEqual([]);
    });

    it("counts a boot or creation of its kind still in flight toward the target's count", () => {
      expect(
        proposalsOf(view([], { inFlight: [kind], maxConcurrentBoots: 2, targets: [target(1)] })),
      ).toEqual([]);
      expect(
        proposalsOf(view([], { inFlight: [kind], maxConcurrentBoots: 2, targets: [target(2)] })),
      ).toHaveLength(1);
    });

    it("does not boot a shut-down device that is claimed, leased-identity spent, or reset", () => {
      const claimed = ofKind("claimed", "shutdown");
      const spent = ofKind("spent", "shutdown", {
        endedAgo: minute,
        leaseIdentity: "fresh",
        spent: true,
      });
      const reset = ofKind("reset", "shutdown");

      const proposals = proposalsOf(
        view([claimed, spent, reset], {
          claimed: ["claimed"],
          reset: ["reset"],
          targets: [target(1)],
        }),
      );

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("does not count a leased, claimed or spent device of its kind as ready", () => {
      const leased = ofKind("leased", "leased");
      const claimed = ofKind("claimed", "ready");
      const spent = ofKind("spent", "ready", {
        endedAgo: minute,
        leaseIdentity: "fresh",
        spent: true,
      });

      const proposals = proposalsOf(
        view([leased, claimed, spent], { claimed: ["claimed"], limit: 10, targets: [target(1)] }),
      );

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("with maxConcurrentBoots 1 and one boot in flight, proposes no second boot or provision", () => {
      const shut = ofKind("shut", "shutdown");

      expect(
        proposalsOf(view([shut], { inFlight: [spec("iPad Pro")], targets: [target(1)] })),
      ).toEqual([]);
      expect(proposalsOf(view([], { inFlight: [spec("iPad Pro")], targets: [target(1)] }))).toEqual(
        [],
      );
      expect(proposalsOf(view([shut], { targets: [target(1)] }))).toHaveLength(1);
    });

    it("with maxConcurrentBoots 2 proposes two of a target of three and counts a waiter's boot against the cap", () => {
      const one = ofKind("one", "shutdown");
      const two = ofKind("two", "shutdown");
      const three = ofKind("three", "shutdown");

      const proposals = proposalsOf(
        view([one, two, three], { maxConcurrentBoots: 2, targets: [target(3)] }),
      );
      expect(proposals).toHaveLength(2);
      expect(proposals.every((proposal) => proposal.reason === "target")).toBe(true);

      const tablet = device("tablet", "shutdown", { endedAgo: minute, spec: spec("iPad Pro") });
      const withWaiter = proposalsOf(
        view([tablet, one, two], {
          maxConcurrentBoots: 2,
          targets: [target(2)],
          waiting: [modelDemand("iPad Pro")],
        }),
      );
      expect(withWaiter.map((proposal) => proposal.reason)).toEqual(["waiting-request", "target"]);
    });

    it("proposes nothing while a request is queued on its platform, and proposes while that request is already booting its own device", () => {
      const shut = ofKind("shut", "shutdown");
      const queued = modelDemand("iPad Pro");

      expect(proposalsOf(view([shut], { targets: [target(1)], waiting: [queued] }))).toEqual([]);
      expect(
        proposalsOf(
          view([shut], {
            maxConcurrentBoots: 2,
            targets: [target(1)],
            waiting: [{ ...queued, inFlight: true }],
          }),
        ),
      ).toEqual([{ action: "boot", deviceId: "shut", reason: "target", target: kind }]);
      expect(
        proposalsOf(
          view([shut], {
            maxConcurrentBoots: 2,
            targets: [target(1)],
            waiting: [classDemand("full", "android")],
          }),
        ),
      ).toHaveLength(1);
    });

    it("fills a target after the queue's devices within one cap, and keeps it waiting, not short, only behind a waiter the pass could not serve", () => {
      const shut = ofKind("shut", "shutdown");
      const phone = device("phone", "shutdown", { endedAgo: 20 * minute, spec: spec("iPhone 15") });
      const head = modelDemand("iPad Pro");
      const filling = { targets: [target(1)], waiting: [head] };

      expect(plan(view([shut], { ...filling, maxConcurrentBoots: 2 })).proposals).toEqual([
        { action: "boot", deviceId: "shut", reason: "target", target: kind },
      ]);
      const capped = plan(view([shut], { ...filling, maxConcurrentBoots: 1 }));
      expect(capped.proposals).toEqual([]);
      expect(capped.targets[0]).not.toHaveProperty("short");

      expect(
        proposalsOf(
          view([phone, shut], {
            maxConcurrentBoots: 2,
            targets: [target(1)],
            waiting: [classDemand()],
          }),
        ),
      ).toEqual([
        { action: "boot", deviceId: "phone", reason: "waiting-request" },
        { action: "boot", deviceId: "shut", reason: "target", target: kind },
      ]);

      const unservable = plan(
        view([shut], { ...filling, maxConcurrentBoots: 3, refuseProvision: "device-limit" }),
      );
      expect(unservable.proposals).toEqual([]);
      expect(unservable.targets[0]).not.toHaveProperty("short");
    });

    it("proposes a shutdown for a never-leased ready device no target counts once it has been ready longer than idle.shutdownAfterMs", () => {
      const stale = device("stale", "ready", { readyAt: now - shutdownAfterMs - 1 });
      const boundary = device("boundary", "ready", { readyAt: now - shutdownAfterMs });
      const fresh = device("fresh", "ready", { readyAt: now - 1_000 });
      const leasedBefore = device("leased-before", "ready", {
        endedAgo: shutdownAfterMs * 3,
        spent: true,
        readyAt: now - shutdownAfterMs * 3,
      });

      const proposals = proposalsOf(view([stale, boundary, fresh, leasedBefore]));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
      ]);
    });

    it("reads a record with no readyAt as ready since createdAt", () => {
      const old = device("old", "ready", { createdAt: now - shutdownAfterMs - 1 });
      const young = device("young", "ready", { createdAt: now - 1_000 });

      expect(proposalsOf(view([old, young]))).toEqual([
        { action: "shutdown", deviceId: "old", reason: "never-leased-idle" },
      ]);
    });

    it("does not propose a shutdown for a never-leased device a target counts, nor one beyond the count's reach that a request serves", () => {
      const counted = ofKind("counted", "ready", { readyAt: 1 });
      const extra = ofKind("extra", "ready", { readyAt: 2, createdAt: 2 });

      // A target of one counts the older device only; the other one is not targeted and goes.
      expect(proposalsOf(view([counted, extra], { targets: [target(1)] }))).toEqual([
        { action: "shutdown", deviceId: "extra", reason: "never-leased-idle" },
      ]);
      // A queued request the extra device serves keeps it: it is about to be granted.
      expect(
        proposalsOf(
          view([counted, extra], { targets: [target(1)], waiting: [modelDemand("iPhone 17")] }),
        ),
      ).toEqual([]);
    });

    it("never proposes a never-leased shutdown for a leased, claimed or booting device", () => {
      const leased = device("leased", "leased", { readyAt: 1 });
      const claimed = device("claimed", "ready", { readyAt: 1 });
      const booting = device("booting", "provisioning", { readyAt: 1 });

      expect(proposalsOf(view([leased, claimed, booting], { claimed: ["claimed"] }))).toEqual([]);
    });

    it("proposes nothing for a target when the running limit is full, and reports running-limit", () => {
      const busy = device("busy", "leased", { spec: spec("iPad Pro") });

      const result = plan(view([busy], { limit: 1, targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets).toEqual([
        {
          booting: 0,
          configuredCount: 1,
          count: 1,
          kind: {
            mode: "full",
            model: "iPhone 17",
            osVersion: "26.0",
            platform: "ios",
          },
          origin: "configured",
          ready: 0,
          short: "running-limit",
          spec: kind,
          target: "ios iPhone 17 26.0",
        },
      ]);
    });

    it("proposes nothing for a target when the reserve holds the last slot, and reports reserve", () => {
      const result = plan(
        view([], { limits: { ios: 1 }, reserve: { ios: 1 }, targets: [target(1)] }),
      );

      expect(result.proposals).toEqual([]);
      expect(result.targets[0]).toMatchObject({ short: "reserve", count: 1, ready: 0 });
    });

    it.each(["device-limit", "ram-budget"] as const)(
      "proposes no creation for a target when the capacity strategy refuses it for %s, and reports it",
      (reason) => {
        const result = plan(view([], { refuseProvision: reason, targets: [target(1)] }));

        expect(result.proposals).toEqual([]);
        expect(result.targets[0]).toMatchObject({ short: reason });
      },
    );

    it("proposes no boot for a target when the capacity strategy refuses the device's RAM, and reports ram-budget", () => {
      const shut = ofKind("shut", "shutdown");

      const result = plan(view([shut], { refuseBoot: "ram-budget", targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets[0]).toMatchObject({ short: "ram-budget" });
    });

    it("reports no short for a target that is filled, and its ready count", () => {
      const ready = ofKind("ready", "ready");

      const result = plan(view([ready], { targets: [target(1)] }));

      expect(result.targets).toStrictEqual([
        {
          booting: 0,
          configuredCount: 1,
          count: 1,
          kind: {
            mode: "full",
            model: "iPhone 17",
            osVersion: "26.0",
            platform: "ios",
          },
          origin: "configured",
          ready: 1,
          spec: kind,
          target: "ios iPhone 17 26.0",
        },
      ]);
    });

    it("reports a target of two with one ready and one boot running as booting 1, and not short", () => {
      const ready = ofKind("ready", "ready");

      const result = plan(view([ready], { inFlight: [kind], targets: [target(2)] }));

      expect(result.targets[0]).toMatchObject({ booting: 1, count: 2, ready: 1 });
      expect(result.targets[0]).not.toHaveProperty("short");
    });

    it("counts a creation it proposes in this pass as booting, and leaves another kind's out", () => {
      const result = plan(view([], { targets: [target(1), target(1, { model: "iPad Pro" })] }));

      expect(result.proposals).toHaveLength(1);
      expect(result.targets.map((report) => report.booting)).toEqual([1, 0]);
    });

    it("reports a target held by the boot cap, or behind a waiter the pass could not serve, with no reason", () => {
      const capped = plan(view([], { inFlight: [spec("iPad Pro")], targets: [target(1)] }));
      expect(capped.targets[0]).toMatchObject({ booting: 0, count: 1, ready: 0 });
      expect(capped.targets[0]).not.toHaveProperty("short");

      const queued = plan(
        view([], {
          refuseProvision: "device-limit",
          targets: [target(1)],
          waiting: [classDemand()],
        }),
      );
      expect(queued.targets[0]).not.toHaveProperty("short");
    });

    it("shuts down an idle device no configured count keeps to make room for a target, and never one a configured count keeps", () => {
      const idle = device("idle", "ready", { endedAgo: minute, spec: spec("iPad Pro") });
      const make = { action: "provision", reason: "target", spec: kind, target: kind };

      const result = plan(view([idle], { limit: 1, targets: [target(1)] }));

      expect(result.proposals).toEqual([
        { action: "shutdown", deviceId: "idle", reason: "displaced" },
        make,
      ]);
      expect(result.targets[0]).toMatchObject({ booting: 1, ready: 0 });
      const pad = { count: 1, spec: spec("iPad Pro") };
      expect(proposalsOf(view([idle], { limit: 1, targets: [target(1), pad] }))).toEqual([]);
      expect(proposalsOf(view([idle], { limit: 1, targets: [pad, target(1)] }))).toEqual([]);
    });

    it("shuts down a copy past another configured kind's count, for a slot the reserve holds too, and fills every configured count before a learned peak", () => {
      const pad = spec("iPad Pro");
      const pads = ["a", "b"].map((id, index) =>
        device(id, "ready", { endedAgo: (index + 1) * minute, spec: pad }),
      );
      const both = [{ count: 1, spec: pad }, target(1)];
      const make = { action: "provision", reason: "target", spec: kind, target: kind };

      expect(proposalsOf(view(pads, { limit: 2, targets: both }))).toEqual([
        { action: "shutdown", deviceId: "b", reason: "displaced" },
        make,
      ]);
      expect(
        proposalsOf(view(pads, { limits: { ios: 3 }, reserve: { ios: 1 }, targets: both })),
      ).toEqual([{ action: "shutdown", deviceId: "b", reason: "displaced" }, make]);
      expect(
        proposalsOf(
          view([pads[0]!], { learned: [learnedOf(pad, 2, now)], limit: 2, targets: both }),
        ),
      ).toEqual([make]);
    });

    it("counts two targets resolving to one spec as one with the summed count", () => {
      const ready = ofKind("ready", "ready");

      const proposals = proposalsOf(
        view([ready], { maxConcurrentBoots: 5, targets: [target(1), target(2)] }),
      );

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
      expect(plan(view([ready], { targets: [target(1), target(2)] })).targets).toHaveLength(1);
    });

    it("does not count a slim device toward a full target of the same model", () => {
      const slim = device("slim", "ready", { endedAgo: minute, spec: { ...kind, mode: "slim" } });

      const proposals = proposalsOf(view([slim], { targets: [target(1)] }));

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("proposes nothing for a target whose spec may not be attempted yet, and reports boot-failed", () => {
      const shut = ofKind("shut", "shutdown");

      const result = plan(view([shut], { blocked: [kind], targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets[0]).toMatchObject({ short: "boot-failed", count: 1, ready: 0 });
    });

    it("proposes nothing for a target and reports none with warmPool disabled", () => {
      const result = plan(view([], { enabled: false, targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets).toEqual([]);
    });

    it("does not boot or create for an android target out of an iOS slot", () => {
      const androidKind = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const iosBusy = device("busy", "leased");

      const result = plan(
        view([iosBusy], {
          limit: 5,
          limits: { android: 0 },
          targets: [{ count: 1, spec: androidKind }],
        }),
      );

      expect(result.proposals).toEqual([]);
      expect(result.targets[0]).toMatchObject({ short: "running-limit" });
    });

    it("is not short while held back after a failure when another boot is running, or a request is queued", () => {
      const shut = ofKind("shut", "shutdown");
      const held = { blocked: [kind], maxConcurrentBoots: 2, targets: [target(2)] };

      expect(plan(view([shut], held)).targets[0]).toMatchObject({ short: "boot-failed" });
      expect(plan(view([shut], { ...held, inFlight: [kind] })).targets[0]).not.toHaveProperty(
        "short",
      );
      expect(
        plan(
          view([shut], {
            ...held,
            refuseProvision: "device-limit",
            waiting: [modelDemand("iPad Pro")],
          }),
        ).targets[0],
      ).not.toHaveProperty("short");
    });

    it("spares the never-leased devices of a spared target and plans nothing for it", () => {
      const stale = device("stale", "ready", { readyAt: 1, spec: kind });

      const result = plan(view([stale], { spared: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets).toEqual([]);
      expect(proposalsOf(view([stale]))).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
      ]);
    });

    it("reports no short for a filled target whose spec may not be attempted yet", () => {
      const ready = ofKind("ready", "ready");

      const result = plan(view([ready], { blocked: [kind], targets: [target(1)] }));

      expect(result.targets).toStrictEqual([
        {
          booting: 0,
          configuredCount: 1,
          count: 1,
          kind: {
            mode: "full",
            model: "iPhone 17",
            osVersion: "26.0",
            platform: "ios",
          },
          origin: "configured",
          ready: 1,
          spec: kind,
          target: "ios iPhone 17 26.0",
        },
      ]);
    });

    it("proposes a boot of each of two shut-down devices once, and a creation for the target's third", () => {
      const one = ofKind("one", "shutdown");
      const two = ofKind("two", "shutdown");

      const proposals = proposalsOf(
        view([one, two], { maxConcurrentBoots: 3, targets: [target(3)] }),
      );

      expect(proposals).toEqual([
        { action: "boot", deviceId: "one", reason: "target", target: kind },
        { action: "boot", deviceId: "two", reason: "target", target: kind },
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("takes a slot for each proposal, so a target of two with room for one proposes one and is not short while it fills", () => {
      const result = plan(view([], { limit: 1, maxConcurrentBoots: 2, targets: [target(2)] }));

      expect(result.proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
      expect(result.targets[0]).toStrictEqual({
        booting: 1,
        configuredCount: 2,
        count: 2,
        kind: {
          mode: "full",
          model: "iPhone 17",
          osVersion: "26.0",
          platform: "ios",
        },
        origin: "configured",
        ready: 0,
        spec: kind,
        target: "ios iPhone 17 26.0",
      });
    });

    it("is short for a reason only when a pass could do nothing for it: not with a boot already running", () => {
      const busy = device("busy", "leased", { spec: spec("iPad Pro") });
      const full = { limit: 1, maxConcurrentBoots: 2, targets: [target(2)] };

      expect(plan(view([busy], full)).targets[0]).toMatchObject({ short: "running-limit" });
      expect(plan(view([busy], { ...full, inFlight: [kind] })).targets[0]).not.toHaveProperty(
        "short",
      );
    });

    it("reports device-limit before running-limit and reserve, and those before ram-budget", () => {
      const both = plan(
        view([], {
          limit: 1,
          refuseProvision: "device-limit",
          targets: [target(1)],
          reserve: { ios: 1 },
        }),
      );
      expect(both.targets[0]).toMatchObject({ short: "device-limit" });
      const full = plan(
        view([], { limit: 0, refuseProvision: "ram-budget", targets: [target(1)] }),
      );
      expect(full.targets[0]).toMatchObject({ short: "running-limit" });
      const bothLimits = plan(
        view([], { limit: 0, refuseProvision: "device-limit", targets: [target(1)] }),
      );
      expect(bothLimits.targets[0]).toMatchObject({ short: "device-limit" });
      const reserved = plan(
        view([], {
          limits: { ios: 1 },
          refuseProvision: "ram-budget",
          reserve: { ios: 1 },
          targets: [target(1)],
        }),
      );
      expect(reserved.targets[0]).toMatchObject({ short: "reserve" });
    });

    it.each([
      ["the machine", { limit: 1, limits: { ios: 5 } }],
      ["the platform", { limit: 5, limits: { ios: 1 } }],
    ])(
      "stops proposing for a target of two once the slot is taken when %s alone has room for one, and is not short",
      (_name, limits) => {
        const result = plan(view([], { ...limits, maxConcurrentBoots: 2, targets: [target(2)] }));

        expect(result.proposals).toEqual([
          { action: "provision", reason: "target", spec: kind, target: kind },
        ]);
        expect(result.targets[0]).not.toHaveProperty("short");
      },
    );

    it("does not count a boot in flight for another kind toward the target's count", () => {
      const result = proposalsOf(
        view([], { inFlight: [spec("iPad Pro")], maxConcurrentBoots: 2, targets: [target(1)] }),
      );

      expect(result).toEqual([{ action: "provision", reason: "target", spec: kind, target: kind }]);
    });

    it("proposes a creation with exactly one running slot free, and none with none free on either the platform or the machine", () => {
      const busyAndroid = device("busy", "leased", {
        spec: spec("Pixel 9", { osVersion: "36", platform: "android" }),
      });

      expect(proposalsOf(view([], { limit: 1, targets: [target(1)] }))).toHaveLength(1);
      const global = plan(
        view([busyAndroid], { limit: 1, limits: { ios: 5 }, targets: [target(1)] }),
      );
      expect(global.proposals).toEqual([]);
      expect(global.targets[0]).toMatchObject({ short: "running-limit" });
      const platform = plan(view([], { limit: 5, limits: { ios: 0 }, targets: [target(1)] }));
      expect(platform.proposals).toEqual([]);
      expect(platform.targets[0]).toMatchObject({ short: "running-limit" });
    });

    it("keeps the reserve out of a target's reach on the machine and on the platform, and uses the last slot beyond it", () => {
      const reserve = { android: 1, ios: 1 };

      const machine = plan(view([], { limit: 2, reserve, targets: [target(1)] }));
      expect(machine.proposals).toEqual([]);
      expect(machine.targets[0]).toMatchObject({ short: "reserve" });
      expect(proposalsOf(view([], { limit: 3, reserve, targets: [target(1)] }))).toHaveLength(1);

      const platform = plan(
        view([], { limits: { ios: 1 }, reserve: { ios: 1 }, targets: [target(1)] }),
      );
      expect(platform.targets[0]).toMatchObject({ short: "reserve" });
      expect(
        proposalsOf(view([], { limits: { ios: 2 }, reserve: { ios: 1 }, targets: [target(1)] })),
      ).toHaveLength(1);
    });

    it.each(["global-running-limit", "platform-running-limit"] as const)(
      "reports running-limit when the capacity strategy refuses a creation for %s",
      (reason) => {
        const result = plan(view([], { refuseProvision: reason, targets: [target(1)] }));

        expect(result.proposals).toEqual([]);
        expect(result.targets[0]).toMatchObject({ short: "running-limit" });
      },
    );

    it("frees the slot of a never-leased device it shuts down for a target of another kind in the same pass", () => {
      const stale = device("stale", "ready", { readyAt: 1, spec: spec("iPad Pro") });

      const proposals = proposalsOf(view([stale], { limit: 1, targets: [target(1)] }));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("proposes a never-leased device once when the budget already proposes it", () => {
      const first = device("first", "ready", { readyAt: 1 });
      const second = device("second", "ready", { readyAt: 1 });

      const proposals = proposalsOf(view([first, second], { limit: 1 }));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "first", reason: "over-budget" },
        { action: "shutdown", deviceId: "second", reason: "never-leased-idle" },
      ]);
    });

    it("spares a never-leased device only for a queued request it serves, not one already booting or one it does not serve", () => {
      const stale = device("stale", "ready", { readyAt: 1 });
      const shutdown = { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" };

      expect(proposalsOf(view([stale], { waiting: [modelDemand("iPhone 15")] }))).toEqual([]);
      expect(
        proposalsOf(view([stale], { waiting: [{ ...modelDemand("iPhone 15"), inFlight: true }] })),
      ).toEqual([shutdown]);
      expect(proposalsOf(view([stale], { waiting: [modelDemand("iPad Pro")] }))).toEqual([
        shutdown,
      ]);
    });

    it("does not name a device with a lease record as targeted even when its state still reads ready", () => {
      const leasedReady = ofKind("leased-ready", "ready");

      const named = targetedDevices({
        devices: [leasedReady],
        isClaimed: () => false,
        leases: [leaseOn(leasedReady)],
        learned: [],
        targets: [target(1)],
        waiting: [],
      });

      expect([...named]).toEqual([]);
    });
  });
});
