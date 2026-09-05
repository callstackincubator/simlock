import { describe, expect, it } from "vitest";

import { type DeviceRecord, IllegalTransition, transition, transitionEnteredAt } from "./index.js";
import { type DeviceSpec, sameSpec } from "./domain.js";

const baseDevice: Omit<DeviceRecord, "state"> = {
  createdAt: 1_000,
  driverData: { opaque: true },
  driverDeviceId: "driver_test",
  id: "dev_test",
  spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
};

describe("transition", () => {
  it.each([
    ["provisioning", "ready"],
    ["provisioning", "deleted"],
    ["provisioning", "quarantined"],
    ["ready", "leased"],
    ["ready", "shutdown"],
    ["leased", "reclaiming"],
    ["reclaiming", "ready"],
    ["reclaiming", "shutdown"],
    ["reclaiming", "quarantined"],
    ["quarantined", "ready"],
    ["quarantined", "shutdown"],
    ["quarantined", "deleted"],
    ["shutdown", "ready"],
    ["shutdown", "deleted"],
  ] as const)("allows %s -> %s", (from, to) => {
    const result = transition({ ...baseDevice, state: from }, to);

    expect(result).toEqual({ ...baseDevice, state: to });
  });

  it.each([
    ["ready", "deleted"],
    ["leased", "shutdown"],
    ["deleted", "ready"],
    // A leased device can only reach `quarantined` by first going through
    // `reclaiming` (i.e. after release) -- never directly. This is the structural
    // half of "never quarantine a leased device" (#21): even a caller bug can't
    // skip the release step and quarantine a device out from under its holder.
    ["leased", "quarantined"],
    ["quarantined", "leased"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(() => transition({ ...baseDevice, state: from }, to)).toThrow(IllegalTransition);
  });

  it.each([
    ["ready", "shutdown"],
    ["reclaiming", "shutdown"],
    ["reclaiming", "quarantined"],
    ["provisioning", "quarantined"],
  ] as const)("drops the address on %s -> %s, since nothing runs there any more", (from, to) => {
    const result = transition({ ...baseDevice, address: "emulator-5586", state: from }, to);

    expect(result).toEqual({ ...baseDevice, state: to });
    expect(result).not.toHaveProperty("address");
  });

  it("keeps the address across transitions between running states", () => {
    const leased = transition(
      { ...baseDevice, address: "emulator-5586", state: "ready" },
      "leased",
    );

    expect(leased.address).toBe("emulator-5586");
    expect(transition(leased, "reclaiming").address).toBe("emulator-5586");
  });

  it("takes the address a stop supplies over the one it drops", () => {
    const result = transition({ ...baseDevice, address: "old", state: "ready" }, "shutdown", {
      address: "new",
    });

    expect(result.address).toBe("new");
  });
});

describe("transitionEnteredAt", () => {
  it("reads provisioning's entry time off createdAt", () => {
    expect(transitionEnteredAt({ ...baseDevice, state: "provisioning" })).toBe(1_000);
  });

  it("reads reclaiming's entry time off lastLeaseEndedAt", () => {
    expect(
      transitionEnteredAt({ ...baseDevice, lastLeaseEndedAt: 2_000, state: "reclaiming" }),
    ).toBe(2_000);
  });

  it("is undefined for reclaiming with no recorded release (defensive, should not occur)", () => {
    expect(transitionEnteredAt({ ...baseDevice, state: "reclaiming" })).toBeUndefined();
  });

  it("is undefined for every other state", () => {
    for (const state of ["ready", "leased", "quarantined", "shutdown", "deleted"] as const) {
      expect(transitionEnteredAt({ ...baseDevice, state })).toBeUndefined();
    }
  });
});

describe("sameSpec", () => {
  const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

  it("matches two identical plain specs", () => {
    expect(sameSpec(spec, { ...spec })).toBe(true);
  });

  it("treats undefined and false full as the same value", () => {
    expect(sameSpec(spec, { ...spec, full: false })).toBe(true);
    expect(sameSpec({ ...spec, full: false }, spec)).toBe(true);
  });

  it("fragments a --full spec from a slim (non-full) spec", () => {
    expect(sameSpec({ ...spec, full: true }, spec)).toBe(false);
    expect(sameSpec(spec, { ...spec, full: true })).toBe(false);
    expect(sameSpec({ ...spec, full: true }, { ...spec, full: false })).toBe(false);
  });

  it("matches two full specs", () => {
    expect(sameSpec({ ...spec, full: true }, { ...spec, full: true })).toBe(true);
  });

  it("still compares platform, model, and osVersion", () => {
    expect(sameSpec(spec, { ...spec, model: "iPhone 15" })).toBe(false);
    expect(sameSpec(spec, { ...spec, osVersion: "26.4" })).toBe(false);
    expect(sameSpec(spec, { ...spec, platform: "android" })).toBe(false);
  });
});
