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
