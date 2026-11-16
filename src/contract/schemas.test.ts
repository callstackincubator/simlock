import { describe, expect, it } from "vitest";
import {
  deviceRecordSchema,
  grantedDeviceSchema,
  leaseGrantSchema,
  statusDeviceSchema,
} from "./index.js";

/**
 * Regression coverage for the defect fixed alongside ADR 0003 §1: a lease grant's device must
 * never carry core-private, driver-internal, or quarantine/recovery bookkeeping fields --
 * `driverData`, `state`, `createdAt`, any `quarantine*` field, any `foreign*` field, or
 * `recovering*`/`recoveryAttempts`. Those stay exclusive to `deviceRecordSchema`, used only by
 * the admin-only `list.get`/`status.get` operations.
 *
 * This asserts the behavior a caller of `simlock/client`/`simlock/admin` actually sees, not an
 * implementation detail: `leaseGrantSchema.parse` is exactly what `DaemonDispatcher#dispatch`'s
 * `#parseOutput` runs a grant through before it reaches any transport, and zod's default
 * "strip unknown keys" object mode is what performs the core-record -> contract-type mapping
 * for the device on a grant.
 */
describe("leaseGrantSchema's device projection", () => {
  const internalDeviceFields = [
    "driverData",
    "state",
    "createdAt",
    "lastLeaseEndedAt",
    "foreignStateDetectedAt",
    "foreignProvenanceDetectedAt",
    "recoveringSince",
    "recoveryAttempts",
    "quarantinedAt",
    "quarantineAttempts",
    "quarantineNextRetryAt",
    "quarantineCause",
    "leaseIdentity",
    "transitionAgeMs",
  ] as const;

  /** A device shaped like a full core `DeviceRecord` mid-quarantine, exactly the kind of
   * payload a real `LeaseGrant` would carry into `#parseOutput`. */
  function fullCoreShapedDevice(): Record<string, unknown> {
    return {
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "quarantined",
      driverData: { udid: "SIM-1", secretDriverInternals: true },
      createdAt: 0,
      lastLeaseEndedAt: 10,
      foreignStateDetectedAt: 20,
      foreignProvenanceDetectedAt: 30,
      recoveringSince: 40,
      recoveryAttempts: 2,
      quarantinedAt: 50,
      quarantineAttempts: 3,
      quarantineNextRetryAt: 60,
      quarantineCause: { kind: "purge-failed", message: "Error: boom" },
      address: "127.0.0.1:1234",
      mode: "slim",
      leaseIdentity: "fresh",
      transitionAgeMs: 70,
    };
  }

  it("strips every internal DeviceRecord field off a grant's device", () => {
    const grant = leaseGrantSchema.parse({
      device: fullCoreShapedDevice(),
      environment: {},
      lease: {
        id: "lease-1",
        deviceId: "device-1",
        requesterId: "req",
        ownerId: "req",
        grantedAt: 0,
        lastRenewedAt: 0,
        idChosenByRequester: false,
        ttlMs: 1000,
        ttlDeadline: 1000,
      },
      timing: {
        estimatedProvisionMs: 0,
        estimatedBootMs: 0,
        estimatedReclaimMs: 0,
        estimatedReadyMs: 0,
      },
    });

    for (const field of internalDeviceFields) {
      expect(grant.device).not.toHaveProperty(field);
    }
    expect(grant.device).toEqual({
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      address: "127.0.0.1:1234",
      mode: "slim",
    });
  });

  it("rejects a device object that is missing the fields a grant must keep", () => {
    expect(() => grantedDeviceSchema.parse({ id: "device-1" })).toThrow();
  });

  it("keeps id, driverDeviceId, spec, and mode, with address optional", () => {
    const parsed = grantedDeviceSchema.parse({
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      mode: "full",
      spec: { physical: false, platform: "android", model: "Pixel 8", osVersion: "34" },
    });
    expect(parsed).toEqual({
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      mode: "full",
      spec: { physical: false, platform: "android", model: "Pixel 8", osVersion: "34" },
    });
  });

  it("rejects a granted device without a mode, or with a mode other than slim or full", () => {
    const device = {
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
    };
    expect(() => grantedDeviceSchema.parse({ ...device, mode: "slim" })).not.toThrow();
    expect(() => grantedDeviceSchema.parse(device)).toThrow();
    expect(() => grantedDeviceSchema.parse({ ...device, mode: "reduced" })).toThrow();
  });
});

/**
 * Regression coverage for S4 of the ADR 0003 adversarial review: `status.get` is `role:
 * "agent"` (ADR §3), with no ownership check -- it reports on every device in the registry, not
 * just ones the caller leases. It must not hand `driverData` (an opaque, driver-defined blob)
 * or reclamation/recovery bookkeeping to every agent for every device. `statusDeviceSchema` is
 * what `src/contract/operations.ts`'s `status.get` output declares in place of
 * `deviceRecordSchema`, and what `DaemonDispatcher#dispatch`'s `#parseOutput` runs each device
 * through before it reaches any transport.
 */
describe("statusDeviceSchema's device projection", () => {
  /** A device shaped like a full core `DeviceRecord` mid-quarantine, exactly the kind of
   * payload `DaemonDispatcher#statusGet`'s decoration would carry into `#parseOutput`. */
  function fullCoreShapedDevice(): Record<string, unknown> {
    return {
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "quarantined",
      driverData: { udid: "SIM-1", secretDriverInternals: true },
      createdAt: 0,
      lastLeaseEndedAt: 10,
      foreignStateDetectedAt: 20,
      foreignProvenanceDetectedAt: 30,
      recoveringSince: 40,
      recoveryAttempts: 2,
      quarantinedAt: 50,
      quarantineAttempts: 3,
      quarantineNextRetryAt: 60,
      address: "127.0.0.1:1234",
      mode: "slim",
      leaseIdentity: "fresh",
      transitionAgeMs: 70,
      servesDefaultMode: false,
    };
  }

  it("strips driverData, driverDeviceId, and reclamation/recovery bookkeeping, keeping only what a human status line needs", () => {
    const device = statusDeviceSchema.parse(fullCoreShapedDevice());

    for (const field of [
      "driverData",
      "driverDeviceId",
      "createdAt",
      "lastLeaseEndedAt",
      "recoveringSince",
      "recoveryAttempts",
      "quarantinedAt",
      "address",
    ] as const) {
      expect(device).not.toHaveProperty(field);
    }

    expect(device).toEqual({
      physical: false,
      id: "device-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "quarantined",
      mode: "slim",
      servesDefaultMode: false,
      foreignStateDetectedAt: 20,
      foreignProvenanceDetectedAt: 30,
      quarantineAttempts: 3,
      quarantineNextRetryAt: 60,
      transitionAgeMs: 70,
    });
  });

  it("keeps a physical device's driverDeviceId, its canonical ID, and still strips its driver data", () => {
    const device = statusDeviceSchema.parse({
      ...fullCoreShapedDevice(),
      class: "phone",
      driverDeviceId: "00008110-001A2B3C4D5E",
      mode: undefined,
      physical: true,
      spec: { physical: true, platform: "ios", model: "iPhone 15 Pro", osVersion: "18.4" },
      state: "ready",
    });

    expect(device).toMatchObject({
      class: "phone",
      driverDeviceId: "00008110-001A2B3C4D5E",
      physical: true,
    });
    expect(device).not.toHaveProperty("driverData");
    expect(device).not.toHaveProperty("address");
  });

  it("statusDeviceSchema and deviceRecordSchema accept presence present, and not present with each of locked, untrusted and not-present, and refuse any other reason", () => {
    const physical = {
      ...fullCoreShapedDevice(),
      class: "phone",
      driverDeviceId: "00008110-001A2B3C4D5E",
      mode: undefined,
      physical: true,
      spec: { physical: true, platform: "ios", model: "iPhone 15 Pro", osVersion: "18.4" },
      state: "ready",
    };

    for (const presence of [
      { present: true },
      { present: false, reason: "locked" },
      { present: false, reason: "untrusted" },
      { present: false, reason: "not-present" },
    ]) {
      const device = { ...physical, presence };
      expect(statusDeviceSchema.parse(device)).toMatchObject({ presence });
      expect(deviceRecordSchema.parse(device)).toMatchObject({ presence });
    }
    expect(statusDeviceSchema.parse(physical)).not.toHaveProperty("presence");
    for (const schema of [statusDeviceSchema, deviceRecordSchema]) {
      expect(() =>
        schema.parse({ ...physical, presence: { present: false, reason: "unplugged" } }),
      ).toThrow();
    }
  });

  it("statusDeviceSchema and deviceRecordSchema accept each of the four quarantine cause kinds and refuse every malformed cause", () => {
    const device = { ...fullCoreShapedDevice(), servesDefaultMode: true };
    const accepted = [
      { kind: "purge-failed", message: "DriverCrashError: simctl erase exited 164" },
      { kind: "shutdown-failed", message: "Error: shutdown exploded" },
      { kind: "delete-failed", message: "x".repeat(300) },
      { kind: "purge-failed" },
      { kind: "stalled", stalledState: "provisioning" },
      { kind: "stalled", stalledState: "reclaiming" },
    ];
    const refused = [
      { kind: "exploded", message: "Error: x" },
      { kind: "stalled" },
      { kind: "purge-failed", message: "Error: x", stalledState: "reclaiming" },
      { kind: "stalled", message: "Error: x", stalledState: "reclaiming" },
      { kind: "stalled", stalledState: "ready" },
      { kind: "purge-failed", message: 7 },
      { kind: "purge-failed", message: "" },
      { kind: "purge-failed", message: "x".repeat(301) },
      { kind: "purge-failed", message: "Error: a\nb" },
      { kind: "purge-failed", message: "Error: a\u2028b" },
    ];

    for (const schema of [statusDeviceSchema, deviceRecordSchema]) {
      for (const quarantineCause of accepted) {
        expect(schema.parse({ ...device, quarantineCause })).toMatchObject({ quarantineCause });
      }
      expect(schema.parse(device)).not.toHaveProperty("quarantineCause");
      for (const quarantineCause of refused) {
        expect(
          () => schema.parse({ ...device, quarantineCause }),
          JSON.stringify(quarantineCause),
        ).toThrow();
      }
    }
  });

  it("rejects a device object that is missing the fields status.get must keep", () => {
    expect(() => statusDeviceSchema.parse({ id: "device-1" })).toThrow();
  });

  it("rejects a status device without servesDefaultMode, or with one that is not a boolean", () => {
    const device = {
      id: "device-1",
      mode: "full",
      physical: false,
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "ready",
    };
    expect(() => statusDeviceSchema.parse(device)).toThrow();
    expect(() => statusDeviceSchema.parse({ ...device, servesDefaultMode: "yes" })).toThrow();
    expect(statusDeviceSchema.parse({ ...device, servesDefaultMode: true })).toMatchObject({
      servesDefaultMode: true,
    });
  });

  it("rejects a status device without a mode, or with a mode other than slim or full", () => {
    const device = {
      id: "device-1",
      servesDefaultMode: true,
      physical: false,
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "ready",
    };
    expect(() => statusDeviceSchema.parse(device)).toThrow();
    expect(() => statusDeviceSchema.parse({ ...device, mode: "reduced" })).toThrow();
    expect(statusDeviceSchema.parse({ ...device, mode: "slim" })).toMatchObject({ mode: "slim" });
  });

  it("shows no planned mode on a device's spec in a grant, a status device, or a list.get record", () => {
    const device = {
      ...fullCoreShapedDevice(),
      mode: "full",
      spec: {
        physical: false,
        platform: "ios",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        mode: "slim",
      },
    };

    expect(grantedDeviceSchema.parse(device).spec).not.toHaveProperty("mode");
    expect(statusDeviceSchema.parse(device).spec).not.toHaveProperty("mode");
    expect(deviceRecordSchema.parse(device).spec).not.toHaveProperty("mode");
  });

  it("shows a device spec's image tag and baseline in a grant, a status device, and a list.get record, and refuses a baseline version below 1 or a name the name rule refuses", () => {
    const device = {
      ...fullCoreShapedDevice(),
      spec: {
        physical: false,
        platform: "android",
        model: "Pixel 8",
        osVersion: "34",
        imageTag: "google_apis_playstore",
        baseline: { name: "checkout", version: 2 },
      },
    };

    expect(grantedDeviceSchema.parse(device).spec.baseline).toEqual({
      name: "checkout",
      version: 2,
    });
    expect(statusDeviceSchema.parse(device).spec.baseline).toEqual({
      name: "checkout",
      version: 2,
    });
    expect(deviceRecordSchema.parse(device).spec.baseline).toEqual({
      name: "checkout",
      version: 2,
    });
    expect(grantedDeviceSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
    expect(statusDeviceSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
    expect(deviceRecordSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
    for (const baseline of [
      { name: "checkout", version: 0 },
      { name: "Not A Name", version: 1 },
    ]) {
      expect(
        grantedDeviceSchema.safeParse({ ...device, spec: { ...device.spec, baseline } }).success,
      ).toBe(false);
    }
  });

  it("rejects a list.get device record without a mode, or with a mode other than slim or full", () => {
    const record = {
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "ready",
      driverData: {},
      createdAt: 0,
    };
    expect(deviceRecordSchema.parse({ ...record, mode: "full" })).toMatchObject({ mode: "full" });
    expect(() => deviceRecordSchema.parse(record)).toThrow();
    expect(() => deviceRecordSchema.parse({ ...record, mode: "reduced" })).toThrow();
  });
});

describe("a device's type on the wire (ADR 0022 §1)", () => {
  const virtualSpec = {
    model: "iPhone 17 Pro",
    osVersion: "26.5",
    physical: false,
    platform: "ios",
  };
  const physicalSpec = {
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    physical: true,
    platform: "ios",
  };
  const virtual = {
    createdAt: 0,
    driverData: {},
    driverDeviceId: "SIM-1",
    id: "dev_v",
    mode: "full",
    physical: false,
    servesDefaultMode: true,
    spec: virtualSpec,
    state: "ready",
  };
  const physical = {
    createdAt: 0,
    driverData: {},
    driverDeviceId: "00008110-001A2B3C4D5E",
    class: "phone",
    id: "dev_p",
    physical: true,
    servesDefaultMode: false,
    spec: physicalSpec,
    state: "ready",
  };

  it.each([
    ["statusDeviceSchema", statusDeviceSchema],
    ["deviceRecordSchema", deviceRecordSchema],
  ] as const)(
    "%s accepts a physical device with a class and no mode, and a virtual one with a mode",
    (_name, schema) => {
      expect(schema.parse(physical)).toMatchObject({ class: "phone", physical: true });
      expect(schema.parse(physical)).not.toHaveProperty("mode");
      expect(schema.parse(virtual)).toMatchObject({ mode: "full", physical: false });
      expect(schema.parse(virtual)).not.toHaveProperty("class");
    },
  );

  it.each([
    ["statusDeviceSchema", statusDeviceSchema],
    ["deviceRecordSchema", deviceRecordSchema],
  ] as const)("%s refuses what breaks the rule", (_name, schema) => {
    const { physical: _device, ...withoutPhysical } = virtual;
    const { physical: _spec, ...specWithoutPhysical } = virtualSpec;
    const { mode: _mode, ...withoutMode } = virtual;
    const { class: _class, ...withoutClass } = physical;

    expect(() => schema.parse(withoutPhysical), "a device without physical").toThrow();
    expect(
      () => schema.parse({ ...virtual, spec: specWithoutPhysical }),
      "a spec without physical",
    ).toThrow();
    expect(() => schema.parse(withoutMode), "a virtual device without a mode").toThrow();
    expect(
      () => schema.parse({ ...physical, mode: "full" }),
      "a physical device with a mode",
    ).toThrow();
    expect(() => schema.parse(withoutClass), "a physical device without a class").toThrow();
    expect(
      () => schema.parse({ ...virtual, class: "phone" }),
      "a virtual device with a class",
    ).toThrow();
    expect(
      () => schema.parse({ ...physical, class: "watch" }),
      "a class that cannot be enrolled",
    ).toThrow();
  });

  it("names the broken rule and where, for each of the four ways a device can break it", () => {
    const issues = (device: object) => {
      const result = statusDeviceSchema.safeParse(device);
      return result.success
        ? []
        : result.error.issues.map((issue) => ({ message: issue.message, path: issue.path }));
    };
    const { mode: _mode, ...withoutMode } = virtual;
    const { class: _class, ...withoutClass } = physical;

    expect(issues({ ...physical, mode: "full" })).toEqual([
      { message: "A physical device has no mode", path: ["mode"] },
    ]);
    expect(issues(withoutClass)).toEqual([
      { message: "A physical device has a class", path: ["class"] },
    ]);
    expect(issues(withoutMode)).toEqual([
      { message: "A virtual device has a mode", path: ["mode"] },
    ]);
    expect(issues({ ...virtual, class: "phone" })).toEqual([
      { message: "A virtual device has no class", path: ["class"] },
    ]);
  });

  it("grantedDeviceSchema accepts a physical device with no mode, keeps physical and class, and refuses a device without physical or a virtual one without a mode", () => {
    const granted = grantedDeviceSchema.parse(physical);

    expect(granted).toMatchObject({ class: "phone", physical: true });
    expect(granted).not.toHaveProperty("mode");
    expect(grantedDeviceSchema.parse(virtual)).toMatchObject({ mode: "full", physical: false });
    const { physical: _device, ...withoutPhysical } = virtual;
    const { mode: _mode, ...withoutMode } = virtual;
    expect(() => grantedDeviceSchema.parse(withoutPhysical)).toThrow();
    expect(() => grantedDeviceSchema.parse(withoutMode)).toThrow();
    expect(() => grantedDeviceSchema.parse({ ...physical, mode: "full" })).toThrow();
    expect(() => grantedDeviceSchema.parse({ ...virtual, class: "phone" })).toThrow();
  });
});
