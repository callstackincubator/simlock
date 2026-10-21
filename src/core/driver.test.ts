import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import type { PhysicalDevice, PhysicalSpec, VirtualDevice } from "./domain.js";
import {
  DiskSpaceGuard,
  type Driver,
  type DriverDevice,
  type DriverRefusalReason,
  InsufficientDiskSpaceError,
  type PhysicalInspection,
  sameReceipt,
  toDriverDevice,
  UnknownModelError,
  uninstallPlan,
} from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import type { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";

const gibibyte = 1024 ** 3;

describe("DiskSpaceGuard", () => {
  it("rejects a reservation that alone exceeds free space with InsufficientDiskSpaceError naming required and available bytes", async () => {
    const filesystem = new MemoryFilesystem(4 * gibibyte);
    const guard = new DiskSpaceGuard();

    const error = await guard
      .reserve(filesystem, "android", 6 * gibibyte, "/volume")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
    expect(error).toMatchObject({
      availableBytes: 4 * gibibyte,
      platform: "android",
      requiredBytes: 6 * gibibyte,
    });
  });

  it("rejects a second concurrent reservation that would overfill the volume alongside the first", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    // First reservation fits (6 of 10 GiB); still outstanding when the second is attempted.
    const releaseFirst = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");

    // 10 GiB free minus the 6 GiB already reserved leaves 4 GiB -- not enough for another 6 GiB,
    // even though a bare disk-free reading alone would say yes.
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).rejects.toBeInstanceOf(InsufficientDiskSpaceError);

    releaseFirst();
  });

  it("frees the reservation on release, letting a subsequent reservation succeed", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    const releaseFirst = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    releaseFirst();

    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("tracks reservations independently per path", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    // Both reservations are 6 of the same 10 GiB free reading, but against different paths --
    // neither should see the other's outstanding bytes.
    await expect(
      guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume-a"),
    ).resolves.toBeInstanceOf(Function);
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume-b"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("is idempotent: releasing twice does not double-free the reservation", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    const release = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    release();
    release();

    // A double release must not credit the 6 GiB back twice, which would let two more 6 GiB
    // reservations both succeed against only 10 GiB of real free space.
    const releaseSecond = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).rejects.toBeInstanceOf(InsufficientDiskSpaceError);
    releaseSecond();
  });
});

describe("sameReceipt", () => {
  it("matches only the same keys with the same values", () => {
    const receipt = { build: "23F77", image: "IMG-1" };

    expect(sameReceipt(receipt, { image: "IMG-1", build: "23F77" })).toBe(true);
    expect(sameReceipt(receipt, { build: "23F77", image: "IMG-2" })).toBe(false);
    expect(sameReceipt(receipt, { ...receipt, stamp: "x" })).toBe(false);
    expect(sameReceipt({ ...receipt, stamp: "x" }, receipt)).toBe(false);
    expect(sameReceipt({ build: "23F77" }, { image: "23F77" })).toBe(false);
  });
});

describe("UnknownModelError", () => {
  it("names the model of an exact request, and has no class", () => {
    const error = new UnknownModelError("ios", "iPhone 99");

    expect(error.message).toBe("Unknown ios model: iPhone 99");
    expect(error).toMatchObject({ class: undefined, model: "iPhone 99", platform: "ios" });
  });

  it("names the class and the config key to set for a class with no listed model", () => {
    const error = new UnknownModelError("android", undefined, "tablet");

    expect(error.message).toBe(
      "No android model of class tablet is listed on this host; name one in android.defaultModels.tablet",
    );
    expect(error).toMatchObject({ class: "tablet", model: undefined, platform: "android" });
  });
});

declare const driver: Driver;
declare const lifecycle: ManagedDeviceLifecycle;
declare const physicalDevice: PhysicalDevice;
declare const virtualDevice: VirtualDevice;

describe("the virtual-only driver and lifecycle calls (ADR 0022 §4, §5)", () => {
  const physicalDriverDevice = {
    address: "00008110-001A2B3C4D5E",
    deviceId: "00008110-001A2B3C4D5E",
    driverData: {},
    physical: true,
  } satisfies DriverDevice & { readonly physical: true };
  const physicalSpec: PhysicalSpec = {
    class: "phone",
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    physical: true,
    platform: "ios",
  };
  const prepare = { mode: "full", purpose: "prepare" } as const;

  /** Never run: every line must fail to compile, or its `@ts-expect-error` is itself an error. */
  function physicalCallsDoNotCompile(): void {
    // @ts-expect-error a physical driver device is not a VirtualDriverDevice
    void driver.makeReady(physicalDriverDevice, prepare);
    // @ts-expect-error a physical driver device is not a VirtualDriverDevice
    void driver.reclaim(physicalDriverDevice, { clean: "standard" });
    // @ts-expect-error a physical driver device is not a VirtualDriverDevice
    void driver.shutdown(physicalDriverDevice);
    // @ts-expect-error a physical driver device is not a VirtualDriverDevice
    void driver.destroy(physicalDriverDevice);
    // @ts-expect-error a physical driver device is not a VirtualDriverDevice
    void driver.destroyLegacy?.(physicalDriverDevice);
    // @ts-expect-error a physical spec is not a VirtualSpec
    void driver.provision(physicalSpec);
    // @ts-expect-error a resolved spec is virtual, so it is not assignable to a physical one
    const _resolved: Promise<PhysicalSpec> = driver.resolveSpec({ model: "m", platform: "ios" });
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.bootForLease(physicalDevice, undefined as never);
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.bootWarm(physicalDevice, undefined as never);
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.readyProvisionedForLease(physicalDevice);
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.shutdown(physicalDevice, "test", "cleanup");
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.destroy(physicalDevice, "test", "cleanup");
    // @ts-expect-error a physical record is not a VirtualDevice
    void lifecycle.recoverLeased(physicalDevice, "lse_1");
  }

  /** Never run: the same calls with the virtual types are the ones that compile. */
  function virtualCallsCompile(): void {
    void lifecycle.bootForLease(virtualDevice, undefined as never);
    void lifecycle.bootWarm(virtualDevice, undefined as never);
    void lifecycle.readyProvisionedForLease(virtualDevice);
    void lifecycle.shutdown(virtualDevice, "test", "cleanup");
    void lifecycle.destroy(virtualDevice, "test", "cleanup");
    void lifecycle.recoverLeased(virtualDevice, "lse_1");
  }

  it("take a VirtualDriverDevice, a VirtualSpec and a VirtualDevice, and a resolved spec goes to provision as it is", async () => {
    const fake: Driver = new FakeDriver({
      availableOsVersions: ["18.4"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });

    const spec = await fake.resolveSpec({ model: "iPhone 16", osVersion: "18.4", platform: "ios" });
    const provisioned = await fake.provision(spec);
    const device = { ...provisioned, physical: false } as const;
    const ready = await fake.makeReady(device, prepare);
    await fake.shutdown({ ...ready, physical: false });
    await fake.destroy({ ...ready, physical: false });

    expect(spec.physical).toBe(false);
    expect(physicalCallsDoNotCompile).toBeTypeOf("function");
    expect(virtualCallsCompile).toBeTypeOf("function");
  });
});

describe("PhysicalInspection (ADR 0022 §5)", () => {
  function otherPlatformDoesNotCompile(): void {
    const otherPlatform: PhysicalInspection = {
      enrollable: false,
      message: "enrolled as iOS",
      // @ts-expect-error only the core can know a device is enrolled on the other platform
      reason: "enrolled-on-other-platform",
    };
    void otherPlatform;
  }

  it("lets a driver refuse with every reason but enrolled-on-other-platform", () => {
    const reasons: Record<DriverRefusalReason, true> = {
      "developer-mode-off": true,
      locked: true,
      "network-only": true,
      "not-connected": true,
      "os-too-old": true,
      unreadable: true,
      "unsupported-kind": true,
      untrusted: true,
      "virtual-device": true,
    };

    const refusals = (Object.keys(reasons) as DriverRefusalReason[]).map(
      (reason): PhysicalInspection => ({ enrollable: false, message: `refused ${reason}`, reason }),
    );

    expect(refusals).toHaveLength(9);
    expect(refusals.map((refusal) => !refusal.enrollable && refusal.reason)).not.toContain(
      "enrolled-on-other-platform",
    );
    expect(otherPlatformDoesNotCompile).toBeTypeOf("function");
  });
});

describe("toDriverDevice", () => {
  const recordFields = {
    address: "emulator-5554",
    createdAt: 1_000,
    driverData: { opaque: true },
    driverDeviceId: "driver_1",
    id: "dev_1",
  };

  it("carries physical: true and its enrollment app list for a physical record", () => {
    const record: PhysicalDevice = {
      ...recordFields,
      enrolledApps: ["com.example.kept", "com.example.other"],
      physical: true,
      spec: {
        class: "phone",
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        physical: true,
        platform: "ios",
      },
      state: "leased",
    };

    expect(toDriverDevice(record)).toEqual({
      address: "emulator-5554",
      deviceId: "driver_1",
      driverData: { opaque: true },
      enrolledApps: ["com.example.kept", "com.example.other"],
      physical: true,
    });
  });

  it("gives an empty address for a record that has none", () => {
    const record: VirtualDevice = {
      createdAt: 1_000,
      driverData: {},
      driverDeviceId: "driver_1",
      id: "dev_1",
      mode: "full",
      physical: false,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
      state: "provisioning",
    };

    expect(toDriverDevice(record).address).toBe("");
  });

  it("gives a virtual record's address, deviceId, driverData and physical: false", () => {
    const record: VirtualDevice = {
      ...recordFields,
      mode: "full",
      physical: false,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
      state: "reclaiming",
    };

    expect(toDriverDevice(record)).toEqual({
      address: "emulator-5554",
      deviceId: "driver_1",
      driverData: { opaque: true },
      physical: false,
    });
  });
});

describe("uninstallPlan", () => {
  it.each([
    {
      case: "differing lists",
      listed: ["com.example.kept", "com.example.stray", "com.example.another"],
      enrolled: ["com.example.kept", "com.example.gone"],
      expected: {
        missing: ["com.example.gone"],
        uninstall: ["com.example.stray", "com.example.another"],
      },
    },
    {
      case: "the same apps in another order",
      listed: ["a", "b"],
      enrolled: ["b", "a"],
      expected: { missing: [], uninstall: [] },
    },
  ])(
    "returns the listed-now apps not on the enrollment list, and the enrollment apps not listed now, for $case",
    ({ listed, enrolled, expected }) => {
      expect(uninstallPlan(listed, enrolled)).toEqual(expected);
    },
  );
});
