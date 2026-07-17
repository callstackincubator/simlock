import { describe, expect, it } from "vitest";

import { selectWarmVictim } from "./warm-pool.js";

const device = (
  id: string,
  platform: "ios" | "android",
  state: "ready" | "leased" | "reclaiming" | "shutdown",
  lastLeaseEndedAt: number,
) => ({
  createdAt: 0,
  driverData: {},
  driverDeviceId: id,
  id,
  lastLeaseEndedAt,
  spec: { model: id, osVersion: "1", platform },
  state,
});

describe("warm-pool policy", () => {
  it("selects deterministic LRU warm inventory in the blocking scope", () => {
    const devices = [
      device("ios-b", "ios", "ready", 10),
      device("android-old", "android", "ready", 1),
      device("ios-a", "ios", "ready", 10),
      device("ios-leased", "ios", "leased", 0),
      device("ios-reclaiming", "ios", "reclaiming", 0),
    ];

    expect(selectWarmVictim(devices, { kind: "platform", platform: "ios" })?.id).toBe("ios-a");
    expect(selectWarmVictim(devices, { kind: "global" })?.id).toBe("android-old");
  });

  it("does not treat shutdown, leased, or reclaiming devices as warm", () => {
    const devices = [
      device("shutdown", "ios", "shutdown", 0),
      device("leased", "ios", "leased", 0),
      device("reclaiming", "ios", "reclaiming", 0),
    ];

    expect(selectWarmVictim(devices, { kind: "global" })).toBeUndefined();
  });
});
