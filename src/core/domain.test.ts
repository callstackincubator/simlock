import { describe, expect, it } from "vitest";

import { type DeviceRecord, IllegalTransition, transition, transitionEnteredAt } from "./index.js";
import {
  type DeviceClass,
  type DeviceRequirement,
  type DeviceSpec,
  fits,
  mayBeGranted,
  sameSpec,
} from "./domain.js";

const baseDevice: Omit<DeviceRecord, "state"> = {
  createdAt: 1_000,
  driverData: { opaque: true },
  driverDeviceId: "driver_test",
  id: "dev_test",
  spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
  mode: "full",
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
    ["shutdown", "quarantined"],
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
  ] as const)("drops the address on %s -> %s, since nothing listens there any more", (from, to) => {
    const result = transition({ ...baseDevice, address: "emulator-5586", state: from }, to);

    expect(result).toEqual({ ...baseDevice, state: to });
    expect(result).not.toHaveProperty("address");
  });

  /**
   * The counterpart, and the reason the drop above stops at `shutdown`. A quarantined device
   * is just as unreachable, but its way back to `ready` is a `reclaim`, and `ReclaimResult`
   * carries no address for `recoverFromQuarantine` to put back -- so dropping it here is
   * permanent, and the device is then grantable with no serial the holder can reach it by.
   */
  it.each([
    ["reclaiming", "quarantined"],
    ["provisioning", "quarantined"],
  ] as const)("keeps the address on %s -> %s, since recovery cannot re-supply one", (from, to) => {
    const result = transition({ ...baseDevice, address: "emulator-5586", state: from }, to);

    expect(result.address).toBe("emulator-5586");
  });

  it("carries an address through quarantine and back out to ready", () => {
    const quarantined = transition(
      { ...baseDevice, address: "emulator-5586", state: "reclaiming" },
      "quarantined",
    );

    // Exactly what `Registry.recoverFromQuarantine` does: no `DeviceTransitionUpdate`, because
    // the driver's reclaim result has no address to give it.
    expect(transition(quarantined, "ready").address).toBe("emulator-5586");
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

describe("mayBeGranted", () => {
  it("refuses only a fresh device that has ended a lease", () => {
    const ready = { ...baseDevice, state: "ready" as const };

    expect(mayBeGranted({ ...ready, leaseIdentity: "fresh", lastLeaseEndedAt: 2_000 })).toBe(false);
    expect(mayBeGranted({ ...ready, leaseIdentity: "fresh" })).toBe(true);
    expect(mayBeGranted({ ...ready, leaseIdentity: "reusable", lastLeaseEndedAt: 2_000 })).toBe(
      true,
    );
    expect(mayBeGranted({ ...ready, lastLeaseEndedAt: 2_000 })).toBe(true);
  });
});

describe("sameSpec", () => {
  const spec: DeviceSpec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" };

  it("matches two identical plain specs", () => {
    expect(sameSpec(spec, { ...spec })).toBe(true);
  });

  it("keeps a slim spec apart from the full spec of the same model and runtime", () => {
    expect(sameSpec({ ...spec, mode: "slim" }, spec)).toBe(false);
    expect(sameSpec(spec, { ...spec, mode: "slim" })).toBe(false);
  });

  it("matches two slim specs", () => {
    expect(sameSpec({ ...spec, mode: "slim" }, { ...spec, mode: "slim" })).toBe(true);
  });

  it("keeps a spec with an image tag apart from one with another tag and from one with none", () => {
    const tagged: DeviceSpec = { ...spec, imageTag: "google_apis_playstore" };
    expect(sameSpec(tagged, { ...spec, imageTag: "google_apis" })).toBe(false);
    expect(sameSpec(tagged, spec)).toBe(false);
    expect(sameSpec(spec, tagged)).toBe(false);
    expect(sameSpec(tagged, { ...tagged })).toBe(true);
  });

  it("still compares platform, model, and osVersion", () => {
    expect(sameSpec(spec, { ...spec, model: "iPhone 15" })).toBe(false);
    expect(sameSpec(spec, { ...spec, osVersion: "26.4" })).toBe(false);
    expect(sameSpec(spec, { ...spec, platform: "android" })).toBe(false);
  });
});

describe("fits (ADR 0015 §6)", () => {
  const spec: DeviceSpec = { model: "iPhone 15", osVersion: "18.4", platform: "ios" };
  const classes: Record<string, DeviceClass> = { "iPhone 15": "phone", "iPad Pro": "tablet" };
  const classOf = (model: string) => classes[model];
  const exact: DeviceRequirement = {
    imageTag: undefined,
    osVersion: { kind: "exact", version: "18.4" },
    platform: "ios",
    target: { kind: "model", model: "iPhone 15" },
  };

  it("holds for a device that satisfies every part of the requirement", () => {
    expect(fits(exact, spec, classOf)).toBe(true);
    expect(fits({ ...exact, target: { class: "phone", kind: "class" } }, spec, classOf)).toBe(true);
  });

  it("fails when the platform differs, and only then", () => {
    expect(fits({ ...exact, platform: "android" }, spec, classOf)).toBe(false);
  });

  it("fails when the model differs, and only then", () => {
    expect(fits({ ...exact, target: { kind: "model", model: "iPhone 16" } }, spec, classOf)).toBe(
      false,
    );
  });

  it("fails when the device's model is of another class, and only then", () => {
    expect(fits({ ...exact, target: { class: "tablet", kind: "class" } }, spec, classOf)).toBe(
      false,
    );
  });

  it("fails for a device whose model has no class when a class is requested", () => {
    const unclassed: DeviceSpec = { ...spec, model: "Custom Phone" };
    expect(fits({ ...exact, target: { class: "phone", kind: "class" } }, unclassed, classOf)).toBe(
      false,
    );
  });

  it("fails when an exact OS differs, and only then", () => {
    expect(fits({ ...exact, osVersion: { kind: "exact", version: "26.0" } }, spec, classOf)).toBe(
      false,
    );
  });

  it("holds for any OS the catalog lists as installed, and fails for one it does not", () => {
    const anyInstalled = (versions: readonly string[]) =>
      ({ ...exact, osVersion: { kind: "installed", versions } }) as const;
    expect(fits(anyInstalled(["17.0", "18.4"]), spec, classOf)).toBe(true);
    expect(fits(anyInstalled(["17.0", "26.0"]), spec, classOf)).toBe(false);
  });

  it("fails when the image tag differs, one side has none, and only then", () => {
    const tagged = { ...spec, imageTag: "google_apis" };
    expect(fits({ ...exact, imageTag: "google_apis" }, tagged, classOf)).toBe(true);
    expect(fits({ ...exact, imageTag: "google_apis" }, spec, classOf)).toBe(false);
    expect(fits(exact, tagged, classOf)).toBe(false);
    expect(fits({ ...exact, imageTag: "default" }, tagged, classOf)).toBe(false);
  });

  it("does not read the mode, which the planner compares", () => {
    expect(fits(exact, { ...spec, mode: "slim" }, classOf)).toBe(true);
  });
});
