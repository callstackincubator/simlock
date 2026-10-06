import { describe, expect, it } from "vitest";

import type { CapacityRefusalReason, RunningCapacity } from "../capacity/index.js";
import type {
  DeviceClass,
  DeviceRecord,
  DeviceSpec,
  LeaseRecord,
  WaitingDemand,
} from "../domain.js";
import { sameSpec } from "../domain.js";
import {
  evaluate as plan,
  type ResolvedTarget,
  targetedDevices,
  type WarmPolicyView,
} from "./policy.js";

const evaluate = (policyView: WarmPolicyView) => plan(policyView).proposals;

const minute = 60_000;
const now = 1_000 * minute;
const shutdownAfterMs = 10 * minute;

const phones = new Set(["iPhone 15", "iPhone 17"]);
const classOf = (model: string): DeviceClass | undefined =>
  phones.has(model) ? "phone" : "tablet";

function spec(model: string, overrides: Partial<DeviceSpec> = {}): DeviceSpec {
  return { model, osVersion: "26.0", platform: "ios", ...overrides };
}

function device(
  id: string,
  state: DeviceRecord["state"],
  options: {
    spec?: DeviceSpec;
    endedAgo?: number;
    createdAt?: number;
    readyAt?: number;
    leaseIdentity?: "fresh";
  } = {},
): DeviceRecord {
  return {
    createdAt: options.createdAt ?? 1,
    ...(options.readyAt === undefined ? {} : { readyAt: options.readyAt }),
    ...(options.leaseIdentity === undefined ? {} : { leaseIdentity: options.leaseIdentity }),
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    mode: "full",
    spec: options.spec ?? spec("iPhone 15"),
    state,
    ...(options.endedAgo === undefined ? {} : { lastLeaseEndedAt: now - options.endedAgo }),
  };
}

function leaseOn(target: DeviceRecord): LeaseRecord {
  return {
    deviceId: target.id,
    grantedAt: 1,
    id: `lease-${target.id}`,
    lastRenewedAt: 1,
    ownerId: "holder",
    requesterId: "holder",
    ttlDeadline: now + minute,
    ttlMs: minute,
  };
}

function capacityOf(
  devices: readonly DeviceRecord[],
  limits: { global: number; ios?: number; android?: number },
  reserved = 0,
): RunningCapacity {
  const running = (platform?: string): number =>
    devices.filter(
      (item) =>
        ["ready", "leased", "reclaiming", "quarantined"].includes(item.state) &&
        (platform === undefined || item.spec.platform === platform),
    ).length;
  const entry = (maxRunning: number, platform?: string) => ({
    maxRunning,
    overLimit: running(platform) + reserved > maxRunning,
    reserved,
    running: running(platform),
  });
  return {
    android: entry(limits.android ?? limits.global, "android"),
    global: entry(limits.global),
    ios: entry(limits.ios ?? limits.global, "ios"),
  };
}

function classDemand(
  mode: "slim" | "full" = "full",
  platform: "ios" | "android" = "ios",
  inFlight = false,
) {
  return {
    classOf,
    inFlight,
    mode,
    platform,
    requirement: {
      imageTag: undefined,
      osVersion: { kind: "installed", versions: ["26.0"] },
      platform,
      target: { class: "phone", kind: "class" },
    },
  } satisfies WaitingDemand;
}

function modelDemand(model: string): WaitingDemand {
  return {
    classOf,
    inFlight: false,
    mode: "full",
    platform: "ios",
    requirement: {
      imageTag: undefined,
      osVersion: { kind: "exact", version: "26.0" },
      platform: "ios",
      target: { kind: "model", model },
    },
  };
}

// fallow-ignore-next-line complexity -- one test fixture builder; each option is a plain pass-through to a view field.
function view(
  devices: readonly DeviceRecord[],
  options: {
    limit?: number;
    limits?: { ios?: number; android?: number };
    reserve?: { ios?: number; android?: number };
    reserved?: number;
    waiting?: readonly WaitingDemand[];
    enabled?: boolean;
    claimed?: readonly string[];
    leased?: readonly DeviceRecord[];
    handoffInFlight?: boolean;
    reset?: readonly string[];
    targets?: readonly ResolvedTarget[];
    spared?: readonly ResolvedTarget[];
    inFlight?: readonly DeviceSpec[];
    maxConcurrentBoots?: number;
    blocked?: readonly DeviceSpec[];
    refuseProvision?: CapacityRefusalReason;
    refuseBoot?: CapacityRefusalReason;
  } = {},
): WarmPolicyView {
  return {
    admit: {
      boot: () => options.refuseBoot,
      create: () => options.refuseProvision,
    },
    inFlight: options.inFlight ?? [],
    retry: {
      mayAttempt: (target) => !(options.blocked ?? []).some((held) => sameSpec(held, target)),
    },
    spared: options.spared ?? [],
    targets: options.targets ?? [],
    capacity: capacityOf(
      devices,
      { global: options.limit ?? 10, ...options.limits },
      options.reserved,
    ),
    config: {
      enabled: options.enabled ?? true,
      maxConcurrentBoots: options.maxConcurrentBoots ?? 1,
      reserveRunning: { android: 0, ios: 0, ...options.reserve },
      shutdownAfterMs,
    },
    devices,
    handoffInFlight: options.handoffInFlight ?? false,
    resetDevices: new Set(options.reset ?? []),
    isClaimed: (id) => options.claimed?.includes(id) ?? false,
    leases: (options.leased ?? devices.filter((item) => item.state === "leased")).map(leaseOn),
    now,
    waiting: options.waiting ?? [],
  };
}

describe("warm pool policy", () => {
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

    // `reason` tells the waiting-request boot from the recently-released one: both devices were
    // released a moment ago, so each is booted back either way once a slot is free.
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
      spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
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

  it("does not boot a shut-down device released longer ago than idle.shutdownAfterMs without a waiting request", () => {
    const stale = device("stale", "shutdown", { endedAgo: shutdownAfterMs });
    const fresh = device("fresh", "shutdown", { endedAgo: shutdownAfterMs - 1 });
    const neverLeased = device("never", "shutdown");

    const proposals = evaluate(view([stale, fresh, neverLeased]));

    expect(proposals).toEqual([{ action: "boot", deviceId: "fresh", reason: "recently-released" }]);
  });

  it("with room for one boot and two recently released shut-down devices, proposes the more recently released one", () => {
    const earlier = device("earlier", "shutdown", { endedAgo: 4 * minute });
    const later = device("later", "shutdown", { endedAgo: 1 * minute });
    const busy = device("busy", "leased");

    const proposals = evaluate(view([earlier, later, busy], { limit: 2 }));

    expect(proposals).toEqual([{ action: "boot", deviceId: "later", reason: "recently-released" }]);
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

  it("holds the free slot for a waiting request no idle device serves instead of booting a recently released device into it", () => {
    const recent = device("recent", "shutdown", { endedAgo: 1_000, spec: spec("iPad Pro") });
    const busy = device("busy", "leased");
    const unserved = classDemand("full", "android");
    const served = device("served", "ready", { endedAgo: 1_000 });

    expect(evaluate(view([recent, busy], { limit: 2, waiting: [unserved] }))).toEqual([]);
    expect(evaluate(view([recent, busy], { limit: 2 }))).toEqual([
      { action: "boot", deviceId: "recent", reason: "recently-released" },
    ]);
    // A request an idle ready device serves takes no free slot.
    expect(evaluate(view([recent, busy, served], { limit: 3, waiting: [classDemand()] }))).toEqual([
      { action: "boot", deviceId: "recent", reason: "recently-released" },
    ]);
  });

  it("boots a device only for the head of the queue, not for a request behind it", () => {
    const tablet = device("tablet", "shutdown", { endedAgo: 20 * minute, spec: spec("iPad Pro") });
    const phone = device("phone", "shutdown", { endedAgo: 20 * minute });
    // The head wants an Android device nothing serves; the iOS phone request is behind it.
    const proposals = evaluate(
      view([tablet, phone], { waiting: [classDemand("full", "android"), classDemand()] }),
    );

    expect(proposals).toEqual([]);
  });

  it("boots nothing for a request behind a head whose device work is in flight", () => {
    const phone = device("phone", "shutdown", { endedAgo: 20 * minute });
    const busy = device("busy", "leased", { spec: spec("iPad Pro") });
    // The head is a tablet request being served (say by an eviction); the phone waits behind it.
    const tabletHead = {
      ...classDemand("full", "ios", true),
      requirement: {
        ...classDemand().requirement,
        target: { class: "tablet", kind: "class" },
      },
    } satisfies WaitingDemand;

    const proposals = evaluate(
      view([phone, busy], { limit: 5, waiting: [tabletHead, classDemand()] }),
    );

    expect(proposals).toEqual([]);
  });

  it("does not boot back a device an operator reset shut down, though it was released a moment ago", () => {
    const reset = device("reset", "shutdown", { endedAgo: 1_000 });
    const other = device("other", "shutdown", { endedAgo: 2_000 });

    expect(evaluate(view([reset, other], { reset: ["reset"] }))).toEqual([
      { action: "boot", deviceId: "other", reason: "recently-released" },
    ]);
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
        spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
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
    const held = evaluate({
      ...view(devices, { waiting: [classDemand()] }),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });
    const free = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });

    expect(held).toEqual([]);
    expect(free).toEqual([{ action: "boot", deviceId: "tablet", reason: "recently-released" }]);
  });

  it("proposes a device that serves a waiting request once, not again as a recently released one", () => {
    const serving = device("serving", "shutdown", { endedAgo: 1_000 });
    const other = device("other", "shutdown", { endedAgo: 2_000, spec: spec("iPad Pro") });

    const proposals = evaluate(view([serving, other], { waiting: [classDemand()] }));

    expect(proposals).toEqual([
      { action: "boot", deviceId: "serving", reason: "waiting-request" },
      { action: "boot", deviceId: "other", reason: "recently-released" },
    ]);
  });

  it("boots only as many recently released devices as the tighter of the global and the platform room allows", () => {
    const first = device("first", "shutdown", { endedAgo: 1_000 });
    const second = device("second", "shutdown", { endedAgo: 2_000 });
    const devices = [first, second];

    const globalTight = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { global: 1, ios: 5 }),
    });
    const platformTight = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { global: 5, ios: 1 }),
    });

    expect(globalTight).toEqual([
      { action: "boot", deviceId: "first", reason: "recently-released" },
    ]);
    expect(platformTight).toEqual([
      { action: "boot", deviceId: "first", reason: "recently-released" },
    ]);
  });

  it("proposes no shutdown at exactly the budget, globally or on either platform", () => {
    const android = device("android", "ready", {
      endedAgo: 1_000,
      spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
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
    const spent: DeviceRecord = {
      ...device("spent", "shutdown", { endedAgo: 1_000 }),
      leaseIdentity: "fresh",
    };
    const free = device("free", "shutdown", { endedAgo: 2_000 });

    expect(evaluate(view([busy, free], { limit: 1 }))).toEqual([]);
    expect(
      evaluate(view([busy, claimed, spent, free], { limit: 5, claimed: ["claimed"] })),
    ).toEqual([{ action: "boot", deviceId: "free", reason: "recently-released" }]);
  });

  it("proposes a boot only where its platform has room", () => {
    const androidBusy = device("busy", "leased", {
      spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const androidShut = device("android-shut", "shutdown", {
      endedAgo: 1_000,
      spec: { model: "Pixel 8", osVersion: "35", platform: "android" },
    });
    const iosShut = device("ios-shut", "shutdown", { endedAgo: 2_000 });
    const devices = [androidBusy, androidShut, iosShut];

    const proposals = evaluate({
      ...view(devices),
      capacity: capacityOf(devices, { android: 1, global: 5, ios: 5 }),
    });

    expect(proposals).toEqual([
      { action: "boot", deviceId: "ios-shut", reason: "recently-released" },
    ]);
  });

  describe("reserveRunning", () => {
    const idleIos = (count: number): DeviceRecord[] =>
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
      const idle = (count: number): DeviceRecord[] => [
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

    it("does not boot a recently released device into a global slot the other platform's reserve holds", () => {
      const androidSpec = spec("Pixel 9", { osVersion: "36", platform: "android" });
      const released = device("released", "shutdown", { endedAgo: minute });
      const running = device("android-0", "ready", { endedAgo: minute, spec: androidSpec });
      const reserve = { android: 1, ios: 1 };

      // Global limit 3 with one running leaves two, and the two reserves hold both.
      expect(evaluate(view([released, running], { limit: 3, reserve }))).toEqual([]);
      expect(evaluate(view([released, running], { limit: 3 }))).toEqual([
        { action: "boot", deviceId: "released", reason: "recently-released" },
      ]);
    });

    it("does not boot a recently released device into a slot the reserve holds", () => {
      const released = device("released", "shutdown", { endedAgo: minute });
      const running = idleIos(1);

      expect(
        evaluate(view([released, ...running], { limits: { ios: 2 }, reserve: { ios: 1 } })),
      ).toEqual([]);
      expect(evaluate(view([released, ...running], { limits: { ios: 2 } }))).toEqual([
        { action: "boot", deviceId: "released", reason: "recently-released" },
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
  describe("targets", () => {
    const kind = spec("iPhone 17");
    const target = (count: number, overrides: Partial<DeviceSpec> = {}): ResolvedTarget => ({
      count,
      spec: { ...kind, ...overrides },
    });
    const ofKind = (id: string, state: DeviceRecord["state"], extra = {}): DeviceRecord =>
      device(id, state, { spec: kind, ...extra });

    it("with a target of two, one ready device of its kind and a shut-down one, proposes one boot of the shut-down one", () => {
      const ready = ofKind("ready", "ready");
      const shut = ofKind("shut", "shutdown");

      const proposals = evaluate(view([ready, shut], { targets: [target(2)] }));

      expect(proposals).toEqual([
        { action: "boot", deviceId: "shut", reason: "target", target: kind },
      ]);
    });

    it("with a target and no device of its kind, proposes one provision with the resolved spec", () => {
      const other = device("other", "ready", { endedAgo: minute, spec: spec("iPad Pro") });

      const proposals = evaluate(view([other], { targets: [target(1)] }));

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("proposes nothing for a target whose count of devices of its kind is ready", () => {
      const first = ofKind("first", "ready");
      const second = ofKind("second", "ready");

      expect(evaluate(view([first, second], { targets: [target(2)] }))).toEqual([]);
    });

    it("counts a boot or creation of its kind still in flight toward the target's count", () => {
      expect(
        evaluate(view([], { inFlight: [kind], maxConcurrentBoots: 2, targets: [target(1)] })),
      ).toEqual([]);
      expect(
        evaluate(view([], { inFlight: [kind], maxConcurrentBoots: 2, targets: [target(2)] })),
      ).toHaveLength(1);
    });

    it("does not boot a shut-down device that is claimed, leased-identity spent, or reset", () => {
      const claimed = ofKind("claimed", "shutdown");
      const spent = ofKind("spent", "shutdown", { endedAgo: minute, leaseIdentity: "fresh" });
      const reset = ofKind("reset", "shutdown");

      const proposals = evaluate(
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
      const spent = ofKind("spent", "ready", { endedAgo: minute, leaseIdentity: "fresh" });

      const proposals = evaluate(
        view([leased, claimed, spent], { claimed: ["claimed"], limit: 10, targets: [target(1)] }),
      );

      expect(proposals).toEqual([
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("with maxConcurrentBoots 1 and one boot in flight, proposes no second boot or provision", () => {
      const shut = ofKind("shut", "shutdown");

      expect(
        evaluate(view([shut], { inFlight: [spec("iPad Pro")], targets: [target(1)] })),
      ).toEqual([]);
      expect(evaluate(view([], { inFlight: [spec("iPad Pro")], targets: [target(1)] }))).toEqual(
        [],
      );
      expect(evaluate(view([shut], { targets: [target(1)] }))).toHaveLength(1);
    });

    it("with maxConcurrentBoots 2 proposes two of a target of three and counts a keep boot against the cap", () => {
      const one = ofKind("one", "shutdown");
      const two = ofKind("two", "shutdown");
      const three = ofKind("three", "shutdown");

      const proposals = evaluate(
        view([one, two, three], { maxConcurrentBoots: 2, targets: [target(3)] }),
      );
      expect(proposals).toHaveLength(2);
      expect(proposals.every((proposal) => proposal.reason === "target")).toBe(true);

      // A recently released device the keep rule boots is one of the two.
      const released = device("released", "shutdown", { endedAgo: minute, spec: spec("iPad Pro") });
      const withKeep = evaluate(
        view([released, one, two], { maxConcurrentBoots: 2, targets: [target(2)] }),
      );
      expect(withKeep.map((proposal) => proposal.reason)).toEqual(["recently-released", "target"]);
    });

    it("proposes nothing while a request is queued on its platform, and proposes while that request is already booting its own device", () => {
      const shut = ofKind("shut", "shutdown");
      // A request for a model the shut-down device does not serve: the keep rule boots nothing.
      const queued = modelDemand("iPad Pro");

      expect(evaluate(view([shut], { targets: [target(1)], waiting: [queued] }))).toEqual([]);
      expect(
        evaluate(view([shut], { targets: [target(1)], waiting: [{ ...queued, inFlight: true }] })),
      ).toEqual([{ action: "boot", deviceId: "shut", reason: "target", target: kind }]);
      expect(
        evaluate(view([shut], { targets: [target(1)], waiting: [classDemand("full", "android")] })),
      ).toHaveLength(1);
    });

    it("proposes a shutdown for a never-leased ready device no target counts once it has been ready longer than idle.shutdownAfterMs", () => {
      const stale = device("stale", "ready", { readyAt: now - shutdownAfterMs - 1 });
      const boundary = device("boundary", "ready", { readyAt: now - shutdownAfterMs });
      const fresh = device("fresh", "ready", { readyAt: now - 1_000 });
      const leasedBefore = device("leased-before", "ready", {
        endedAgo: shutdownAfterMs * 3,
        readyAt: now - shutdownAfterMs * 3,
      });

      const proposals = evaluate(view([stale, boundary, fresh, leasedBefore]));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
      ]);
    });

    it("reads a record with no readyAt as ready since createdAt", () => {
      const old = device("old", "ready", { createdAt: now - shutdownAfterMs - 1 });
      const young = device("young", "ready", { createdAt: now - 1_000 });

      expect(evaluate(view([old, young]))).toEqual([
        { action: "shutdown", deviceId: "old", reason: "never-leased-idle" },
      ]);
    });

    it("does not propose a shutdown for a never-leased device a target counts, nor one beyond the count's reach that a request serves", () => {
      const counted = ofKind("counted", "ready", { readyAt: 1 });
      const extra = ofKind("extra", "ready", { readyAt: 2, createdAt: 2 });

      // A target of one counts the older device only; the other one is not targeted and goes.
      expect(evaluate(view([counted, extra], { targets: [target(1)] }))).toEqual([
        { action: "shutdown", deviceId: "extra", reason: "never-leased-idle" },
      ]);
      // A queued request the extra device serves keeps it: it is about to be granted.
      expect(
        evaluate(
          view([counted, extra], { targets: [target(1)], waiting: [modelDemand("iPhone 17")] }),
        ),
      ).toEqual([]);
    });

    it("never proposes a never-leased shutdown for a leased, claimed or booting device", () => {
      const leased = device("leased", "leased", { readyAt: 1 });
      const claimed = device("claimed", "ready", { readyAt: 1 });
      const booting = device("booting", "provisioning", { readyAt: 1 });

      expect(evaluate(view([leased, claimed, booting], { claimed: ["claimed"] }))).toEqual([]);
    });

    it("proposes nothing for a target when the running limit is full, and reports running-limit", () => {
      const busy = device("busy", "leased", { spec: spec("iPad Pro") });

      const result = plan(view([busy], { limit: 1, targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets).toEqual([
        { count: 1, ready: 0, short: "running-limit", spec: kind, target: "ios iPhone 17 26.0" },
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
        { count: 1, ready: 1, spec: kind, target: "ios iPhone 17 26.0" },
      ]);
    });

    it("never shuts a device down to make room for a target", () => {
      const idle = device("idle", "ready", { endedAgo: minute, spec: spec("iPad Pro") });

      const result = plan(view([idle], { limit: 1, targets: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets[0]).toMatchObject({ short: "running-limit" });
    });

    it("counts two targets resolving to one spec as one with the summed count", () => {
      const ready = ofKind("ready", "ready");

      const proposals = evaluate(
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

      const proposals = evaluate(view([slim], { targets: [target(1)] }));

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
        plan(view([shut], { ...held, waiting: [modelDemand("iPad Pro")] })).targets[0],
      ).not.toHaveProperty("short");
    });

    it("spares the never-leased devices of a spared target and plans nothing for it", () => {
      const stale = device("stale", "ready", { readyAt: 1, spec: kind });

      const result = plan(view([stale], { spared: [target(1)] }));

      expect(result.proposals).toEqual([]);
      expect(result.targets).toEqual([]);
      expect(evaluate(view([stale]))).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
      ]);
    });

    it("reports no short for a filled target whose spec may not be attempted yet", () => {
      const ready = ofKind("ready", "ready");

      const result = plan(view([ready], { blocked: [kind], targets: [target(1)] }));

      expect(result.targets).toStrictEqual([
        { count: 1, ready: 1, spec: kind, target: "ios iPhone 17 26.0" },
      ]);
    });

    it("proposes a boot of each of two shut-down devices once, and a creation for the target's third", () => {
      const one = ofKind("one", "shutdown");
      const two = ofKind("two", "shutdown");

      const proposals = evaluate(view([one, two], { maxConcurrentBoots: 3, targets: [target(3)] }));

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
        count: 2,
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

    it("counts a recently released device of its kind the keep rule boots as one of the target's, and one of another kind not", () => {
      const released = device("released", "shutdown", { endedAgo: minute, spec: kind });
      const other = device("other", "shutdown", { endedAgo: 2 * minute, spec: spec("iPad Pro") });
      const spare = ofKind("spare", "shutdown");

      expect(
        evaluate(view([released, spare], { maxConcurrentBoots: 3, targets: [target(1)] })),
      ).toEqual([{ action: "boot", deviceId: "released", reason: "recently-released" }]);
      expect(
        evaluate(view([released, spare], { maxConcurrentBoots: 3, targets: [target(2)] })),
      ).toEqual([
        { action: "boot", deviceId: "released", reason: "recently-released" },
        { action: "boot", deviceId: "spare", reason: "target", target: kind },
      ]);
      expect(
        evaluate(view([other, spare], { maxConcurrentBoots: 3, targets: [target(1)] })),
      ).toEqual([
        { action: "boot", deviceId: "other", reason: "recently-released" },
        { action: "boot", deviceId: "spare", reason: "target", target: kind },
      ]);
    });

    it("does not count a boot in flight for another kind toward the target's count", () => {
      const result = evaluate(
        view([], { inFlight: [spec("iPad Pro")], maxConcurrentBoots: 2, targets: [target(1)] }),
      );

      expect(result).toEqual([{ action: "provision", reason: "target", spec: kind, target: kind }]);
    });

    it("proposes a creation with exactly one running slot free, and none with none free on either the platform or the machine", () => {
      const busyAndroid = device("busy", "leased", {
        spec: spec("Pixel 9", { osVersion: "36", platform: "android" }),
      });

      expect(evaluate(view([], { limit: 1, targets: [target(1)] }))).toHaveLength(1);
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
      expect(evaluate(view([], { limit: 3, reserve, targets: [target(1)] }))).toHaveLength(1);

      const platform = plan(
        view([], { limits: { ios: 1 }, reserve: { ios: 1 }, targets: [target(1)] }),
      );
      expect(platform.targets[0]).toMatchObject({ short: "reserve" });
      expect(
        evaluate(view([], { limits: { ios: 2 }, reserve: { ios: 1 }, targets: [target(1)] })),
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

      const proposals = evaluate(view([stale], { limit: 1, targets: [target(1)] }));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" },
        { action: "provision", reason: "target", spec: kind, target: kind },
      ]);
    });

    it("proposes a never-leased device once when the budget already proposes it", () => {
      const first = device("first", "ready", { readyAt: 1 });
      const second = device("second", "ready", { readyAt: 1 });

      const proposals = evaluate(view([first, second], { limit: 1 }));

      expect(proposals).toEqual([
        { action: "shutdown", deviceId: "first", reason: "over-budget" },
        { action: "shutdown", deviceId: "second", reason: "never-leased-idle" },
      ]);
    });

    it("spares a never-leased device only for a queued request it serves, not one already booting or one it does not serve", () => {
      const stale = device("stale", "ready", { readyAt: 1 });
      const shutdown = { action: "shutdown", deviceId: "stale", reason: "never-leased-idle" };

      expect(evaluate(view([stale], { waiting: [modelDemand("iPhone 15")] }))).toEqual([]);
      expect(
        evaluate(view([stale], { waiting: [{ ...modelDemand("iPhone 15"), inFlight: true }] })),
      ).toEqual([shutdown]);
      expect(evaluate(view([stale], { waiting: [modelDemand("iPad Pro")] }))).toEqual([shutdown]);
    });

    it("does not name a device with a lease record as targeted even when its state still reads ready", () => {
      const leasedReady = ofKind("leased-ready", "ready");

      const named = targetedDevices({
        devices: [leasedReady],
        isClaimed: () => false,
        leases: [leaseOn(leasedReady)],
        targets: [target(1)],
      });

      expect([...named]).toEqual([]);
    });

    describe("targetedDevices", () => {
      const input = (devices: readonly DeviceRecord[], targets: readonly ResolvedTarget[]) => ({
        devices,
        isClaimed: (id: string) => id === "claimed",
        leases: devices.filter((item) => item.state === "leased").map(leaseOn),
        targets,
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

      it("leaves out a leased, claimed, shut-down or spent device and one of another mode", () => {
        const devices = [
          ofKind("leased", "leased"),
          ofKind("claimed", "ready"),
          ofKind("shut", "shutdown"),
          ofKind("spent", "ready", { endedAgo: 1, leaseIdentity: "fresh" }),
          device("slim", "ready", { spec: { ...kind, mode: "slim" } }),
          ofKind("good", "ready"),
        ];

        expect([...targetedDevices(input(devices, [target(5)]))]).toEqual(["good"]);
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
