import { describe, expect, it } from "vitest";

import type { RunningCapacity } from "../capacity/index.js";
import type {
  DeviceClass,
  DeviceRecord,
  DeviceSpec,
  LeaseRecord,
  WaitingDemand,
} from "../domain.js";
import { evaluate, type WarmPolicyView } from "./policy.js";

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
  options: { spec?: DeviceSpec; endedAgo?: number; createdAt?: number } = {},
): DeviceRecord {
  return {
    createdAt: options.createdAt ?? 1,
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

function view(
  devices: readonly DeviceRecord[],
  options: {
    limit?: number;
    reserved?: number;
    waiting?: readonly WaitingDemand[];
    enabled?: boolean;
    claimed?: readonly string[];
    leased?: readonly DeviceRecord[];
    handoffInFlight?: boolean;
  } = {},
): WarmPolicyView {
  return {
    capacity: capacityOf(devices, { global: options.limit ?? 10 }, options.reserved),
    config: { enabled: options.enabled ?? true, shutdownAfterMs },
    devices,
    handoffInFlight: options.handoffInFlight ?? false,
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
    const forSlim = evaluate(view([slim, full], { waiting: [classDemand("slim")], limit: 5 }));

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

    expect(proposals.map((item) => item.deviceId)).toEqual(["first", "second"]);
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
});
