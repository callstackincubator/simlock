import { describe, expect, it } from "vitest";

import { type VirtualDevice, IllegalTransition, transition, transitionEnteredAt } from "./index.js";
import {
  assertVirtual,
  type DeviceClass,
  type PhysicalDevice,
  type PhysicalSpec,
  type PhysicalState,
  type DeviceRequirement,
  type VirtualSpec,
  fits,
  fitsPhysical,
  mayBeGranted,
  noPhysicalMatch,
  sameSpec,
} from "./domain.js";

const baseDevice: Omit<VirtualDevice, "state"> = {
  physical: false,
  createdAt: 1_000,
  driverData: { opaque: true },
  driverDeviceId: "driver_test",
  id: "dev_test",
  spec: { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
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
  const spec: VirtualSpec = {
    physical: false,
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
  };

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
    const tagged: VirtualSpec = { ...spec, imageTag: "google_apis_playstore" };
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
  const spec: VirtualSpec = {
    physical: false,
    model: "iPhone 15",
    osVersion: "18.4",
    platform: "ios",
  };
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
    const unclassed: VirtualSpec = { ...spec, model: "Custom Phone" };
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
    const slim: VirtualSpec = { ...spec, mode: "slim" };
    expect(fits(exact, slim, classOf)).toBe(true);
  });
});

const physicalSpec: PhysicalSpec = {
  class: "phone",
  model: "iPhone 15 Pro",
  osVersion: "18.4",
  physical: true,
  platform: "ios",
};

const physicalDevice: Omit<PhysicalDevice, "state"> = {
  createdAt: 1_000,
  driverData: {},
  driverDeviceId: "00008110-001A2B3C4D5E",
  enrolledApps: ["com.example.kept"],
  id: "dev_phys",
  physical: true,
  spec: physicalSpec,
};

describe("a physical device's state machine (ADR 0022 §2)", () => {
  it.each([
    ["ready", "leased"],
    ["ready", "deleted"],
    ["leased", "reclaiming"],
    ["reclaiming", "ready"],
    ["reclaiming", "quarantined"],
    ["quarantined", "ready"],
    ["quarantined", "deleted"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(transition({ ...physicalDevice, state: from }, to)).toEqual({
      ...physicalDevice,
      state: to,
    });
  });

  it.each(["ready", "leased", "reclaiming", "quarantined", "absent", "deleted"] as const)(
    "allows nothing out of %s beyond its table: every other physical state, shutdown and provisioning throw",
    (from) => {
      const allowed: Record<PhysicalState, readonly string[]> = {
        absent: ["reclaiming", "ready", "deleted"],
        deleted: [],
        leased: ["reclaiming", "absent"],
        quarantined: ["ready", "deleted"],
        ready: ["leased", "absent", "deleted"],
        reclaiming: ["ready", "quarantined", "absent"],
      };
      for (const to of [
        "ready",
        "leased",
        "reclaiming",
        "quarantined",
        "absent",
        "deleted",
        "shutdown",
        "provisioning",
      ] as const) {
        if (allowed[from].includes(to)) continue;
        expect(
          () => transition({ ...physicalDevice, state: from }, to),
          `${from} -> ${to}`,
        ).toThrow(IllegalTransition);
      }
    },
  );

  it("refuses ready -> shutdown, reclaiming -> shutdown, shutdown -> ready and any move into provisioning, which the virtual table still allows or has", () => {
    expect(() => transition({ ...physicalDevice, state: "ready" }, "shutdown")).toThrow(
      IllegalTransition,
    );
    expect(() => transition({ ...physicalDevice, state: "reclaiming" }, "shutdown")).toThrow(
      IllegalTransition,
    );
    expect(() => transition({ ...physicalDevice, state: "ready" }, "provisioning")).toThrow(
      IllegalTransition,
    );
    expect(() =>
      transition({ ...physicalDevice, state: "shutdown" as unknown as "ready" }, "ready"),
    ).toThrow(IllegalTransition);
    expect(transition({ ...baseDevice, state: "ready" }, "shutdown").state).toBe("shutdown");
    expect(transition({ ...baseDevice, state: "reclaiming" }, "shutdown").state).toBe("shutdown");
    expect(transition({ ...baseDevice, state: "shutdown" }, "ready").state).toBe("ready");
  });

  it("gives a transition into ready no driver-reported mode, whatever the update carries", () => {
    const ready = transition({ ...physicalDevice, state: "reclaiming" }, "ready", { mode: "full" });

    expect(ready).not.toHaveProperty("mode");
  });

  it("records the absent reason only on a move into absent, and leaves no reason key when none was given", () => {
    const leased = { ...physicalDevice, state: "leased" as const };

    expect(transition(leased, "absent", { absentReason: "locked" })).toMatchObject({
      absentReason: "locked",
      state: "absent",
    });
    expect(transition(leased, "absent")).not.toHaveProperty("absentReason");
    expect(
      transition({ ...physicalDevice, state: "reclaiming" }, "ready", { absentReason: "locked" }),
    ).not.toHaveProperty("absentReason");
  });

  it("drops a deferred reclaim on any exit from reclaiming, as a virtual device does", () => {
    const reclaiming = {
      ...physicalDevice,
      deferredReclaimLeaseId: "lse_1",
      state: "reclaiming" as const,
    };

    expect(transition(reclaiming, "quarantined")).not.toHaveProperty("deferredReclaimLeaseId");
  });
});

describe("physical specs and records against the shared rules", () => {
  it("never matches a virtual spec of the same platform, model and OS under sameSpec", () => {
    const virtual: VirtualSpec = {
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      physical: false,
      platform: "ios",
    };

    expect(sameSpec(physicalSpec, virtual)).toBe(false);
    expect(sameSpec(virtual, physicalSpec)).toBe(false);
    expect(sameSpec(physicalSpec, { ...physicalSpec })).toBe(true);
  });

  it("never fits a requirement, by model or by class, that a virtual spec of the same model would meet", () => {
    const requirement: DeviceRequirement = {
      imageTag: undefined,
      osVersion: { kind: "exact", version: "18.4" },
      platform: "ios",
      target: { kind: "model", model: "iPhone 15 Pro" },
    };
    const classOf = () => "phone" as const;
    const virtual: VirtualSpec = {
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      physical: false,
      platform: "ios",
    };

    expect(fits(requirement, virtual, classOf)).toBe(true);
    expect(fits(requirement, physicalSpec, classOf)).toBe(false);
    expect(
      fits({ ...requirement, target: { class: "phone", kind: "class" } }, physicalSpec, classOf),
    ).toBe(false);
  });

  it("ages a reclaiming physical device from lastLeaseEndedAt", () => {
    expect(
      transitionEnteredAt({ ...physicalDevice, lastLeaseEndedAt: 4_000, state: "reclaiming" }),
    ).toBe(4_000);
  });

  it("may be granted whatever its history, since lease.identity does not apply to it", () => {
    expect(mayBeGranted({ ...physicalDevice, lastLeaseEndedAt: 4_000, state: "ready" })).toBe(true);
  });
});

describe("assertVirtual", () => {
  it("hands back a virtual device as it is, and throws for a physical one", () => {
    const virtual: VirtualDevice = { ...baseDevice, state: "ready" };

    expect(assertVirtual(virtual)).toBe(virtual);
    expect(() => assertVirtual({ ...physicalDevice, state: "ready" })).toThrow(/dev_phys/);
  });
});

describe("fitsPhysical", () => {
  const iphone = { spec: physicalSpec };
  const ipad = { spec: { ...physicalSpec, class: "tablet", model: "iPad Pro" } } as const;

  it("matches by platform, by model ignoring case, and by class, with no class meaning phone", () => {
    expect(fitsPhysical(iphone, { platform: "ios" })).toBe(true);
    expect(fitsPhysical(iphone, { platform: "android" })).toBe(false);

    expect(fitsPhysical(iphone, { model: "iphone 15 pro", platform: "ios" })).toBe(true);
    expect(fitsPhysical(iphone, { model: "iPhone 14", platform: "ios" })).toBe(false);

    expect(fitsPhysical(ipad, { class: "tablet", platform: "ios" })).toBe(true);
    expect(fitsPhysical(iphone, { class: "tablet", platform: "ios" })).toBe(false);
    expect(fitsPhysical(iphone, { platform: "ios" })).toBe(true);
    expect(fitsPhysical(ipad, { platform: "ios" })).toBe(false);
  });

  it("matches --os 18.4 to 18.4 and not 18.4.1, --os 18 to no device on 18.4.1, and a range to 18.4.1", () => {
    const patched = { spec: { ...physicalSpec, osVersion: "18.4.1" } };

    expect(fitsPhysical(iphone, { osVersion: "18.4", platform: "ios" })).toBe(true);
    expect(fitsPhysical(patched, { osVersion: "18.4", platform: "ios" })).toBe(false);
    expect(fitsPhysical(patched, { osVersion: "18", platform: "ios" })).toBe(false);
    expect(fitsPhysical(patched, { osVersion: ">=18 <19", platform: "ios" })).toBe(true);
    expect(fitsPhysical(patched, { osVersion: "18 - 18", platform: "ios" })).toBe(true);
  });

  it("matches an Android physical request with --os 34 to API level 34 and not 33", () => {
    const api = (osVersion: string) => ({
      spec: { ...physicalSpec, model: "Pixel 8", osVersion, platform: "android" as const },
    });

    expect(fitsPhysical(api("34"), { osVersion: "34", platform: "android" })).toBe(true);
    expect(fitsPhysical(api("33"), { osVersion: "34", platform: "android" })).toBe(false);
  });
});

describe("noPhysicalMatch", () => {
  it("names >=18 <19 for iOS --os 18 and >=18.4 <18.5 for iOS --os 18.4", () => {
    expect(noPhysicalMatch({ osVersion: "18", platform: "ios" }).message).toContain(">=18 <19");
    expect(noPhysicalMatch({ osVersion: "18.4", platform: "ios" }).message).toContain(
      ">=18.4 <18.5",
    );
  });

  it("names no range for iOS 18.4.1, for Android 34, Baklava and 34-ext12, for a range, or with no --os", () => {
    const unnamed = [
      { osVersion: "18.4.1", platform: "ios" },
      { osVersion: "34", platform: "android" },
      { osVersion: "Baklava", platform: "android" },
      { osVersion: "34-ext12", platform: "android" },
      { osVersion: ">=18 <19", platform: "ios" },
      { platform: "ios" },
    ] as const;

    expect(noPhysicalMatch({ osVersion: "18", platform: "ios" }).message).toContain(">=18 <19");
    for (const request of unnamed) {
      const { message } = noPhysicalMatch(request);
      expect(message).toContain(request.platform);
      expect(message).not.toMatch(/>=\d+(\.\d+)? <\d/);
    }
  });

  it("words the whole message from the request: a model, else its class or phone, then an exact OS, or a range as the requested range", () => {
    const message = (request: Parameters<typeof noPhysicalMatch>[0]) =>
      noPhysicalMatch(request).message;

    expect(message({ platform: "android" })).toBe(
      "no enrolled physical device can match android class phone",
    );
    expect(message({ class: "tablet", platform: "android" })).toBe(
      "no enrolled physical device can match android class tablet",
    );
    expect(message({ model: "Pixel 8", platform: "android" })).toBe(
      "no enrolled physical device can match android model Pixel 8",
    );
    expect(
      message({ class: "tablet", model: "Pixel 8", osVersion: "34", platform: "android" }),
    ).toBe("no enrolled physical device can match android model Pixel 8 os 34");
    expect(message({ osVersion: "18.4.1", platform: "ios" })).toBe(
      "no enrolled physical device can match ios class phone os 18.4.1",
    );
    expect(message({ osVersion: ">=18 <19", platform: "ios" })).toBe(
      "no enrolled physical device can match ios class phone os in the requested range",
    );
    expect(message({ osVersion: "18.4", platform: "ios" })).toBe(
      'no enrolled physical device can match ios class phone os 18.4; --os is exact, for any 18.4.x write --os ">=18.4 <18.5"',
    );
    expect(message({ osVersion: "18.10", platform: "ios" })).toBe(
      'no enrolled physical device can match ios class phone os 18.10; --os is exact, for any 18.10.x write --os ">=18.10 <18.11"',
    );
  });

  it("leaves out of its details every field the request did not set, rather than setting it undefined", () => {
    expect(noPhysicalMatch({ osVersion: "18", platform: "ios" }).details).toStrictEqual({
      osVersion: "18",
      platform: "ios",
    });
    expect(noPhysicalMatch({ model: "Pixel 8", platform: "android" }).details).toStrictEqual({
      model: "Pixel 8",
      platform: "android",
    });
    expect(noPhysicalMatch({ class: "tablet", platform: "ios" }).details).toStrictEqual({
      class: "tablet",
      platform: "ios",
    });
  });

  it("carries the request's platform, model, class and OS in its details, each only when the request set it", () => {
    expect(
      noPhysicalMatch({ class: "tablet", model: "iPad Pro", osVersion: "18", platform: "ios" })
        .details,
    ).toEqual({ class: "tablet", model: "iPad Pro", osVersion: "18", platform: "ios" });
    expect(noPhysicalMatch({ platform: "android" }).details).toEqual({ platform: "android" });
  });
});

describe("a physical device's absent state (ADR 0022 §2, §8)", () => {
  const absent = "absent" as unknown as PhysicalState;
  const settle = (
    device: Omit<PhysicalDevice, "state"> | Omit<VirtualDevice, "state">,
    from: string,
    to: string,
  ) => {
    try {
      return transition(
        { ...device, state: from } as unknown as VirtualDevice,
        to as unknown as "ready",
      ).state as string;
    } catch (error) {
      return error instanceof IllegalTransition ? "illegal" : "unexpected";
    }
  };

  it("a physical record may move ready, leased or reclaiming to absent, and absent to reclaiming, ready or deleted; quarantined -> absent and any virtual move to absent throw IllegalTransition", () => {
    for (const from of ["ready", "leased", "reclaiming"]) {
      expect(settle(physicalDevice, from, absent), `${from} -> absent`).toBe("absent");
    }
    for (const to of ["reclaiming", "ready", "deleted"]) {
      expect(settle(physicalDevice, absent, to), `absent -> ${to}`).toBe(to);
    }

    expect(() =>
      transition(
        { ...physicalDevice, state: "quarantined" } as unknown as VirtualDevice,
        absent as unknown as "ready",
      ),
    ).toThrow(IllegalTransition);
    for (const from of [
      "provisioning",
      "ready",
      "leased",
      "reclaiming",
      "quarantined",
      "shutdown",
      "deleted",
    ]) {
      expect(settle(baseDevice, from, absent), `virtual ${from} -> absent`).toBe("illegal");
    }
  });
});
