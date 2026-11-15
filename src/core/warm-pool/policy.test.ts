import { describe, expect, it } from "vitest";
import type { VirtualDevice, WaitingDemand } from "../domain.js";
import { evaluate as plan, type WarmPolicyView } from "./policy.js";
import {
  evaluate,
  minute,
  now,
  spec,
  device,
  learnedOf,
  capacityOf,
  classDemand,
  modelDemand,
  view,
} from "./test-policy.js";

// why: the pure planner needs many capacity, matching and ordering cases through its policy seam.
describe("warm pool policy", () => {
  it("proposes, for waiters behind the head and in queue order, one creation of each waiter's spec, up to maxConcurrentBoots, and nothing for the head", () => {
    const creation = (model: string) => ({
      action: "provision",
      reason: "waiting-request",
      spec: spec(model),
      target: spec(model),
    });
    const waiter = (model: string, inFlight = false) => classDemand("full", "ios", inFlight, model);
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });
    const shutDown = device("shut", "shutdown", { endedAgo: 20 * minute });
    const three = [waiter("iPhone 15", true), waiter("iPhone 17"), waiter("iPhone 16")];

    expect(evaluate(view([busy], { maxConcurrentBoots: 3, waiting: three }))).toEqual([
      creation("iPhone 17"),
      creation("iPhone 16"),
    ]);
    expect(evaluate(view([busy], { maxConcurrentBoots: 2, waiting: three }))).toEqual([
      creation("iPhone 17"),
    ]);
    expect(
      evaluate(
        view([busy], {
          maxConcurrentBoots: 3,
          waiting: [waiter("iPhone 15"), waiter("iPhone 17"), waiter("iPhone 16")],
        }),
      ),
    ).toEqual([creation("iPhone 17"), creation("iPhone 16")]);
    const refused = {
      ...view([busy], {
        maxConcurrentBoots: 1,
        waiting: [classDemand("full", "android"), waiter("iPhone 17")],
      }),
      capacity: capacityOf([busy], { android: 0, global: 10 }),
    };
    expect(evaluate(refused)).toEqual([creation("iPhone 17")]);
    const atCap = view([busy], {
      inFlight: [spec("iPhone 15")],
      maxConcurrentBoots: 1,
      targets: [{ count: 1, spec: spec("iPad Pro", { osVersion: "18.0" }) }],
      waiting: [waiter("iPhone 15", true), waiter("iPhone 17")],
    });
    expect(plan(atCap).proposals).toEqual([]);
    expect(plan(atCap).targets[0]?.short).toBeUndefined();
    expect(evaluate(view([shutDown], { waiting: [waiter("iPhone 15")] }))).toEqual([
      { action: "boot", deviceId: "shut", reason: "waiting-request" },
    ]);
    expect(evaluate(view([busy], { waiting: [waiter("iPhone 15")] }))).toEqual([]);
    expect(
      evaluate(view([shutDown], { inFlight: [spec("iPad Pro")], waiting: [waiter("iPhone 15")] })),
    ).toEqual([]);
  });

  it("matches each device to one waiter in queue order and proposes nothing for a waiter an idle ready device or an onItsWay entry serves", () => {
    const creation = (model: string) => ({
      action: "provision",
      reason: "waiting-request",
      spec: spec(model),
      target: spec(model),
    });
    const waiter = (model: string, inFlight = false) => classDemand("full", "ios", inFlight, model);
    const ready = (id: string, options: Parameters<typeof device>[2] = {}) =>
      device(id, "ready", { endedAgo: 90 * minute, ...options });
    const two = [waiter("iPhone 15", true), waiter("iPhone 15"), waiter("iPhone 17")];
    const base = { maxConcurrentBoots: 5, limit: 10 };

    expect(evaluate(view([ready("one")], { ...base, waiting: two }))).toEqual([
      creation("iPhone 17"),
    ]);
    expect(
      evaluate(
        view([ready("one")], { ...base, waiting: [waiter("iPhone 15"), waiter("iPhone 17")] }),
      ),
    ).toEqual([]);
    expect(evaluate(view([ready("one"), ready("two")], { ...base, waiting: two }))).toEqual([]);
    expect(
      evaluate(
        view([], {
          ...base,
          onItsWay: [{ spec: spec("iPhone 15") }],
          waiting: two,
        }),
      ),
    ).toEqual([creation("iPhone 17")]);
    expect(
      evaluate(
        view([], {
          ...base,
          onItsWay: [{ spec: spec("iPhone 15") }, { deviceId: "other", spec: spec("iPhone 17") }],
          waiting: two,
        }),
      ),
    ).toEqual([]);
    expect(
      evaluate(
        view([ready("slim", { spec: spec("iPhone 15", { mode: "slim" }) })], {
          ...base,
          waiting: [waiter("iPhone 15", true), waiter("iPhone 17")],
        }),
      ),
    ).toEqual([creation("iPhone 17")]);
    // why: the head is the first waiter no ready idle device takes: with one ready device and two
    // waiters it serves, the second is the head and leasing creates for it.
    expect(
      evaluate(
        view([ready("one")], { ...base, waiting: [waiter("iPhone 15"), waiter("iPhone 15")] }),
      ),
    ).toEqual([]);
  });

  it("proposes no boot for a waiter whose spec the retry schedule holds back after a failed boot", () => {
    const released = device("lse_15", "shutdown", { endedAgo: 90 * minute });
    const waiting = [classDemand(), classDemand()];

    expect(evaluate(view([released], { waiting }))).toEqual([
      { action: "boot", deviceId: "lse_15", reason: "waiting-request" },
    ]);
    expect(evaluate(view([released], { waiting, blocked: [spec("iPhone 15")] }))).toEqual([]);

    // why: the converger records the failure under the device's spec, which a class waiter's may differ from.
    const other = device("lse_17", "shutdown", {
      endedAgo: 90 * minute,
      spec: spec("iPhone 17"),
    });
    expect(evaluate(view([other], { waiting }))).toEqual([
      { action: "boot", deviceId: "lse_17", reason: "waiting-request" },
    ]);
    expect(evaluate(view([other], { waiting, blocked: [spec("iPhone 17")] }))).toEqual([]);
  });

  it("proposes a boot, not a shutdown, for a released iPhone 15 that serves a waiting class request at the running cap", () => {
    const released = device("lse_15", "shutdown", { endedAgo: 1_000 });
    const leased = device("busy", "leased", { spec: spec("iPhone 17") });

    const proposals = evaluate(view([released, leased], { limit: 2, waiting: [classDemand()] }));

    expect(proposals).toEqual([{ action: "boot", deviceId: "lse_15", reason: "waiting-request" }]);
  });

  it("does not propose a ready device that serves a waiting class request for shutdown at the running cap", () => {
    const ready = device("lse_15", "ready", { endedAgo: 1_000 });
    const other = device("other", "ready", { endedAgo: 500_000, spec: spec("iPad Pro") });

    const proposals = evaluate(view([ready, other], { limit: 1, waiting: [classDemand()] }));

    // Over budget by one: the device that serves the waiter stays, the one that does not goes.
    expect(proposals).toEqual([{ action: "shutdown", deviceId: "other", reason: "over-budget" }]);
  });

  it("does not propose a slim device for a waiting full request of its class, nor a full one for a slim request", () => {
    const slim = device("slim", "shutdown", {
      endedAgo: 1_000,
      spec: spec("iPhone 15", { mode: "slim" }),
    });
    const full = device("full", "shutdown", { endedAgo: 1_000 });

    const forFull = evaluate(view([slim, full], { waiting: [classDemand("full")], limit: 5 }));
    // Full first: a check that refuses only slim-for-full would pick `full` here.
    const forSlim = evaluate(view([full, slim], { waiting: [classDemand("slim")], limit: 5 }));

    expect(forFull.find((item) => item.reason === "waiting-request")).toEqual({
      action: "boot",
      deviceId: "full",
      reason: "waiting-request",
    });
    expect(forSlim.find((item) => item.reason === "waiting-request")).toEqual({
      action: "boot",
      deviceId: "slim",
      reason: "waiting-request",
    });
  });

  it("does not propose an iPhone 15 for a waiting request naming the iPhone 17", () => {
    const released = device("lse_15", "shutdown", { endedAgo: 20 * minute });
    const matching = device("lse_17", "shutdown", {
      endedAgo: 20 * minute,
      spec: spec("iPhone 17"),
    });

    const proposals = evaluate(view([released, matching], { waiting: [modelDemand("iPhone 17")] }));

    expect(proposals).toEqual([{ action: "boot", deviceId: "lse_17", reason: "waiting-request" }]);
  });

  it("proposes the least recently used idle device for shutdown when over budget, and never one that serves a waiting request", () => {
    const oldestServing = device("a-oldest", "ready", { endedAgo: 90 * minute });
    const older = device("b-older", "ready", { endedAgo: 60 * minute, spec: spec("iPad Pro") });
    const newer = device("c-newer", "ready", { endedAgo: 5 * minute, spec: spec("iPad Pro") });

    const proposals = evaluate(
      view([oldestServing, older, newer], { limit: 2, waiting: [classDemand()] }),
    );

    expect(proposals).toEqual([{ action: "shutdown", deviceId: "b-older", reason: "over-budget" }]);
  });

  it("shuts down as many as the budget is over by, and never a leased or claimed device", () => {
    const leased = device("leased", "leased", { endedAgo: 100 * minute });
    const claimed = device("claimed", "ready", { endedAgo: 90 * minute });
    const first = device("first", "ready", { endedAgo: 80 * minute });
    const second = device("second", "ready", { endedAgo: 70 * minute });
    const third = device("third", "ready", { endedAgo: 60 * minute });

    const proposals = evaluate(
      view([leased, claimed, first, second, third], { limit: 3, claimed: ["claimed"] }),
    );

    expect(proposals.map((item) => ("deviceId" in item ? item.deviceId : item.spec.model))).toEqual(
      ["first", "second"],
    );
  });

  it("counts a reservation against the budget", () => {
    const only = device("only", "ready", { endedAgo: 1_000 });

    const proposals = evaluate(view([only], { limit: 1, reserved: 1 }));

    expect(proposals).toEqual([{ action: "shutdown", deviceId: "only", reason: "over-budget" }]);
  });

  it("holds every budget shutdown while a booted device is on its way to a lease", () => {
    const first = device("first", "ready", { endedAgo: 80 * minute });
    const second = device("second", "ready", { endedAgo: 70 * minute });

    expect(evaluate(view([first, second], { limit: 1, handoffInFlight: true }))).toEqual([]);
    expect(evaluate(view([first, second], { limit: 1 }))).toEqual([
      { action: "shutdown", deviceId: "first", reason: "over-budget" },
    ]);
  });

  it("with warmPool disabled proposes every unleased ready device for shutdown and no boot", () => {
    const ready = device("ready", "ready", { endedAgo: 1_000 });
    const android = device("android", "ready", {
      endedAgo: 2_000,
      spec: { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const leased = device("leased", "leased");
    const shutdown = device("shutdown", "shutdown", { endedAgo: 1_000 });

    const proposals = evaluate(
      view([ready, android, leased, shutdown], { enabled: false, waiting: [classDemand()] }),
    );

    expect(proposals).toEqual([
      { action: "shutdown", deviceId: "android", reason: "disabled" },
      { action: "shutdown", deviceId: "ready", reason: "disabled" },
    ]);
  });

  it("proposes no boot back of a shut-down device released a moment ago whose kind is not learned", () => {
    const fresh = device("fresh", "shutdown", { endedAgo: 1_000 });
    const later = device("later", "shutdown", { endedAgo: minute });

    expect(evaluate(view([fresh, later], { limit: 5 }))).toEqual([]);
    expect(
      evaluate(
        view([fresh, later], { learned: [{ count: 1, lastLeasedAt: now, spec: fresh.spec }] }),
      ),
    ).toEqual([{ action: "boot", deviceId: "fresh", reason: "target", target: fresh.spec }]);
  });

  it("boots a device for a waiting request before one that was merely released recently", () => {
    const recent = device("recent", "shutdown", { endedAgo: 1_000, spec: spec("iPad Pro") });
    const serving = device("serving", "shutdown", { endedAgo: 9 * minute });
    const busy = device("busy", "leased");

    const proposals = evaluate(
      view([recent, serving, busy], { limit: 2, waiting: [classDemand()] }),
    );

    expect(proposals).toEqual([{ action: "boot", deviceId: "serving", reason: "waiting-request" }]);
  });

  it("holds the free slot for a waiting request no idle device serves instead of booting a learned kind's device into it", () => {
    const recent = device("recent", "shutdown", { endedAgo: 1_000, spec: spec("iPad Pro") });
    const busy = device("busy", "leased");
    const unserved = classDemand("full", "android");
    const served = device("served", "ready", { endedAgo: 1_000 });

    const learned = [learnedOf(recent.spec)];
    const boot = { action: "boot", deviceId: "recent", reason: "target", target: recent.spec };

    expect(evaluate(view([recent, busy], { learned, limit: 2, waiting: [unserved] }))).toEqual([]);
    expect(evaluate(view([recent, busy], { learned, limit: 2 }))).toEqual([boot]);
    expect(
      evaluate(view([recent, busy, served], { learned, limit: 3, waiting: [classDemand()] })),
    ).toEqual([boot]);
  });

  it("boots a shut-down device that serves a waiter behind the head before creating one, and may boot one an operator reset shut down, for the head too", () => {
    const boot = (deviceId: string) => ({ action: "boot", deviceId, reason: "waiting-request" });
    const phone = device("phone", "shutdown", { endedAgo: 20 * minute });
    const tablet = device("tablet", "shutdown", { endedAgo: 20 * minute, spec: spec("iPad Pro") });
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });
    const tabletHead = {
      ...classDemand("full", "ios", true),
      requirement: { ...classDemand().requirement, target: { class: "tablet", kind: "class" } },
    } satisfies WaitingDemand;
    const options = { maxConcurrentBoots: 3 };

    expect(
      evaluate(view([phone, busy], { ...options, waiting: [tabletHead, classDemand()] })),
    ).toEqual([boot("phone")]);
    expect(
      evaluate(
        view([phone, busy], { ...options, waiting: [tabletHead, classDemand(), classDemand()] }),
      ).map((proposal) => proposal.action),
    ).toEqual(["boot", "provision"]);
    expect(
      evaluate(view([tablet, busy], { ...options, waiting: [tabletHead, classDemand()] })),
    ).toEqual([expect.objectContaining({ action: "provision" })]);
    expect(
      evaluate(view([phone, tablet], { ...options, reset: ["phone"], waiting: [classDemand()] })),
    ).toEqual([boot("phone")]);
    expect(
      evaluate(
        view([phone, busy], { ...options, reset: ["phone"], waiting: [tabletHead, classDemand()] }),
      ),
    ).toEqual([boot("phone")]);
  });

  it("proposes no boot that admit.boot refuses for ram-budget, for a waiter or a learned kind's device, and holds the waiter's slot", () => {
    const serving = device("serving", "shutdown", { endedAgo: 20 * minute });
    const recent = device("recent", "shutdown", { endedAgo: 1_000, spec: spec("iPad Pro") });
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });
    const devices = [serving, recent, busy];
    const setup = { limit: 2, waiting: [classDemand()] };
    const refusing = (ids: readonly string[]): WarmPolicyView => {
      const base = view(devices, setup);
      return {
        ...base,
        admit: {
          ...base.admit,
          boot: (candidate) => (ids.includes(candidate.id) ? "ram-budget" : undefined),
        },
      };
    };

    expect(evaluate(refusing([]))).toEqual([
      { action: "boot", deviceId: "serving", reason: "waiting-request" },
    ]);
    expect(evaluate(refusing(["serving"]))).toEqual([]);
    const learned = [learnedOf(recent.spec)];
    expect(evaluate(view([recent], { learned, limit: 3 }))).toEqual([
      { action: "boot", deviceId: "recent", reason: "target", target: recent.spec },
    ]);
    expect(evaluate(view([recent], { learned, limit: 3, refuseBoot: "ram-budget" }))).toEqual([]);
  });

  it("does not boot back a device an operator reset shut down for a learned kind, though it was released a moment ago", () => {
    const reset = device("reset", "shutdown", { endedAgo: 1_000 });
    const other = device("other", "shutdown", { endedAgo: 2_000 });

    expect(
      evaluate(view([reset, other], { learned: [learnedOf(reset.spec)], reset: ["reset"] })),
    ).toEqual([{ action: "boot", deviceId: "other", reason: "target", target: reset.spec }]);
  });

  it("does not let a request whose device work is in flight shield an idle ready device it serves from an over-budget shutdown", () => {
    const serving = device("serving", "ready", { endedAgo: 90 * minute });
    const other = device("other", "ready", { endedAgo: 5 * minute, spec: spec("iPad Pro") });

    const proposals = evaluate(
      view([serving, other], { limit: 1, waiting: [classDemand("full", "ios", true)] }),
    );

    expect(proposals).toEqual([{ action: "shutdown", deviceId: "serving", reason: "over-budget" }]);
  });

  it("holds a slot for a request whose device work is in flight, and boots nothing for it", () => {
    const recent = device("recent", "shutdown", { endedAgo: 1_000 });
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });

    const proposals = evaluate(
      view([recent, busy], { limit: 2, waiting: [classDemand("full", "ios", true)] }),
    );

    expect(proposals).toEqual([]);
  });

  it("takes an over-budget platform's own least recently used device first, whatever the other platform holds", () => {
    const android = (id: string, endedAgo: number) =>
      device(id, "ready", {
        endedAgo,
        spec: { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" },
      });
    const oldestAndroid = android("android-old", 90 * minute);
    const newerAndroid = android("android-new", 5 * minute);
    const oldestIos = device("ios-old", "ready", { endedAgo: 80 * minute });
    const newerIos = device("ios-new", "ready", { endedAgo: 2 * minute });
    const devices = [oldestAndroid, newerAndroid, oldestIos, newerIos];

    const iosOver = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { android: 5, global: 5, ios: 1 }),
    });
    const androidOver = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { android: 1, global: 5, ios: 5 }),
    });
    const globalOver = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { android: 5, global: 3, ios: 5 }),
    });

    expect(iosOver).toEqual([{ action: "shutdown", deviceId: "ios-old", reason: "over-budget" }]);
    expect(androidOver).toEqual([
      { action: "shutdown", deviceId: "android-old", reason: "over-budget" },
    ]);
    expect(globalOver).toEqual([
      { action: "shutdown", deviceId: "android-old", reason: "over-budget" },
    ]);
  });

  it("never proposes a device that has a lease, whatever its state says", () => {
    const leasedReady = device("leased-ready", "ready", { endedAgo: 90 * minute });
    const free = device("free", "ready", { endedAgo: 1_000 });

    const proposals = evaluate(view([leasedReady, free], { limit: 1, leased: [leasedReady] }));

    expect(proposals).toEqual([{ action: "shutdown", deviceId: "free", reason: "over-budget" }]);
  });

  it("boots one device for two waiting requests it serves, once", () => {
    const serving = device("serving", "shutdown", { endedAgo: 1_000 });

    const proposals = evaluate(view([serving], { waiting: [classDemand(), classDemand()] }));

    expect(proposals).toEqual([{ action: "boot", deviceId: "serving", reason: "waiting-request" }]);
  });

  it("proposes no boot for a waiting request when its platform has no room", () => {
    const serving = device("serving", "shutdown", { endedAgo: 1_000 });
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });
    const devices = [serving, busy];

    const proposals = evaluate({
      ...view(devices, { waiting: [classDemand()] }),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });

    expect(proposals).toEqual([]);
  });

  it("holds the waiting request's own platform slot too, not only a global one", () => {
    const tablet = device("tablet", "shutdown", { endedAgo: 1_000, spec: spec("iPad Pro") });
    const devices = [tablet];

    // The request wants a phone, which no device serves, and the only iOS slot is its own.
    const learned = [learnedOf(tablet.spec)];
    const held = evaluate({
      ...view(devices, { learned, waiting: [classDemand()] }),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });
    const free = evaluate({
      ...view(devices, { learned }),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });

    expect(held).toEqual([]);
    expect(free).toEqual([
      { action: "boot", deviceId: "tablet", reason: "target", target: tablet.spec },
    ]);
  });

  it("proposes a device that serves a waiting request once, not again for a learned kind", () => {
    const serving = device("serving", "shutdown", { endedAgo: 1_000 });
    const other = device("other", "shutdown", { endedAgo: 2_000, spec: spec("iPad Pro") });

    const proposals = evaluate(
      view([serving, other], {
        learned: [learnedOf(serving.spec), learnedOf(other.spec)],
        maxConcurrentBoots: 3,
        waiting: [classDemand()],
      }),
    );

    expect(proposals).toEqual([
      { action: "boot", deviceId: "serving", reason: "waiting-request" },
      { action: "boot", deviceId: "other", reason: "target", target: other.spec },
    ]);
  });

  it("boots only as many of a learned kind's devices as the tighter of the global and the platform room allows", () => {
    const first = device("first", "shutdown", { endedAgo: 1_000 });
    const second = device("second", "shutdown", { endedAgo: 2_000 });
    const devices = [first, second];

    const learned = [learnedOf(first.spec, 2)];
    const globalTight = evaluate({
      ...view(devices, { learned, maxConcurrentBoots: 2 }),
      capacity: capacityOf(devices, { global: 1, ios: 5 }),
    });
    const platformTight = evaluate({
      ...view(devices, { learned, maxConcurrentBoots: 2 }),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });

    const boot = { action: "boot", deviceId: "first", reason: "target", target: first.spec };
    expect(globalTight).toEqual([boot]);
    expect(platformTight).toEqual([boot]);
  });

  it("proposes no shutdown at exactly the budget, globally or on either platform", () => {
    const android = device("android", "ready", {
      endedAgo: 1_000,
      spec: { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const ios = device("ios", "ready", { endedAgo: 2_000 });
    const devices = [android, ios];

    for (const limits of [
      { android: 5, global: 2, ios: 5 },
      { android: 5, global: 5, ios: 1 },
      { android: 1, global: 5, ios: 5 },
    ]) {
      expect(
        evaluate({ ...view(devices), capacity: capacityOf(devices, limits) }),
        JSON.stringify(limits),
      ).toEqual([]);
    }
  });

  it("proposes no boot at the budget, and none for a claimed, leased or spent device", () => {
    const busy = device("busy", "leased");
    const claimed = device("claimed", "shutdown", { endedAgo: 1_000 });
    const spent: VirtualDevice = {
      ...device("spent", "shutdown", { endedAgo: 1_000, spent: true }),
      leaseIdentity: "fresh",
    };
    const free = device("free", "shutdown", { endedAgo: 2_000 });

    const learned = [learnedOf(free.spec, 4)];
    expect(evaluate(view([busy, free], { learned, limit: 1 }))).toEqual([]);
    expect(
      evaluate(
        view([busy, claimed, spent, free], {
          claimed: ["claimed"],
          learned,
          limit: 5,
          maxConcurrentBoots: 2,
        }),
      ),
    ).toEqual([
      { action: "boot", deviceId: "free", reason: "target", target: free.spec },
      { action: "provision", reason: "target", spec: free.spec, target: free.spec },
    ]);
  });

  it("proposes a boot only where its platform has room", () => {
    const androidBusy = device("busy", "leased", {
      spec: { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const androidShut = device("android-shut", "shutdown", {
      endedAgo: 1_000,
      spec: { physical: false, model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const iosShut = device("ios-shut", "shutdown", { endedAgo: 2_000 });
    const devices = [androidBusy, androidShut, iosShut];

    const proposals = evaluate({
      ...view(devices, { learned: [learnedOf(androidShut.spec, 2), learnedOf(iosShut.spec)] }),
      capacity: capacityOf(devices, { android: 1, global: 5, ios: 5 }),
    });

    expect(proposals).toEqual([
      { action: "boot", deviceId: "ios-shut", reason: "target", target: iosShut.spec },
    ]);
  });

  describe("reserveRunning", () => {
    const idleIos = (count: number): VirtualDevice[] =>
      Array.from({ length: count }, (_, index) =>
        device(`ios-${index}`, "ready", { endedAgo: (index + 1) * minute }),
      );

    it("proposes a third idle iOS device for shutdown and not a second with reserveRunning.ios 1 and maxRunning 3", () => {
      const three = idleIos(3);
      const two = idleIos(2);

      expect(evaluate(view(three, { limits: { ios: 3 }, reserve: { ios: 1 } }))).toEqual([
        { action: "shutdown", deviceId: "ios-2", reason: "over-budget" },
      ]);
      expect(evaluate(view(two, { limits: { ios: 3 }, reserve: { ios: 1 } }))).toEqual([]);
    });

    it("takes the sum of the platform reserves off the global budget", () => {
      const androidSpec = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const idle = (count: number): VirtualDevice[] => [
        ...idleIos(count - 1),
        device("android-0", "ready", { endedAgo: minute, spec: androidSpec }),
      ];
      const reserve = { android: 1, ios: 1 };

      // Global limit 4 minus the two reserves leaves room for two idle devices, not three.
      expect(evaluate(view(idle(3), { limit: 4, reserve }))).toHaveLength(1);
      expect(evaluate(view(idle(2), { limit: 4, reserve }))).toEqual([]);
    });

    it("proposes every idle device of a platform for shutdown when the reserve is above its limit, and none of the other", () => {
      const androidSpec = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const devices = [
        ...idleIos(2),
        device("android-0", "ready", { endedAgo: minute, spec: androidSpec }),
      ];

      const proposals = evaluate(view(devices, { limits: { ios: 2 }, reserve: { ios: 3 } }));

      expect(
        proposals.map((proposal) => ("deviceId" in proposal ? proposal.deviceId : "")).sort(),
      ).toEqual(["ios-0", "ios-1"]);
    });

    it("counts a reserve above the platform limit as the limit, so the global budget loses no more than the platform holds", () => {
      const androidSpec = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const devices = [
        device("android-0", "ready", { endedAgo: minute, spec: androidSpec }),
        device("android-1", "ready", { endedAgo: 2 * minute, spec: androidSpec }),
      ];

      // iOS limit 1 with reserve 4 holds one slot of the global 3, leaving room for two Androids.
      expect(
        evaluate(view(devices, { limit: 3, limits: { ios: 1 }, reserve: { ios: 4 } })),
      ).toEqual([]);
    });

    it("does not boot a learned kind's device into a global slot the other platform's reserve holds", () => {
      const androidSpec = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const released = device("released", "shutdown", { endedAgo: minute });
      const running = device("android-0", "ready", { endedAgo: minute, spec: androidSpec });
      const reserve = { android: 1, ios: 1 };

      // Global limit 3 with one running leaves two, and the two reserves hold both.
      const learned = [learnedOf(released.spec)];
      expect(evaluate(view([released, running], { learned, limit: 3, reserve }))).toEqual([]);
      expect(evaluate(view([released, running], { learned, limit: 3 }))).toEqual([
        { action: "boot", deviceId: "released", reason: "target", target: released.spec },
      ]);
    });

    it("does not boot a learned kind's device into a slot the reserve holds", () => {
      const released = device("released", "shutdown", { endedAgo: minute });
      const running = idleIos(1);

      const learned = [learnedOf(released.spec, 2)];
      expect(
        evaluate(
          view([released, ...running], { learned, limits: { ios: 2 }, reserve: { ios: 1 } }),
        ),
      ).toEqual([]);
      expect(evaluate(view([released, ...running], { learned, limits: { ios: 2 } }))).toEqual([
        { action: "boot", deviceId: "released", reason: "target", target: released.spec },
      ]);
    });

    it("boots a device for the waiting request at the head of the queue even into the reserved slot", () => {
      const released = device("released", "shutdown", { endedAgo: minute });

      expect(
        evaluate(
          view([released], {
            limits: { ios: 1 },
            reserve: { ios: 1 },
            waiting: [classDemand()],
          }),
        ),
      ).toEqual([{ action: "boot", deviceId: "released", reason: "waiting-request" }]);
    });
  });
});
