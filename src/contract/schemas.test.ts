import { describe, expect, it } from "vitest";

import { grantedDeviceSchema, leaseGrantSchema, statusDeviceSchema } from "./schemas.js";

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
    "transitionAgeMs",
  ] as const;

  /** A device shaped like a full core `DeviceRecord` mid-quarantine, exactly the kind of
   * payload a real `LeaseGrant` from `core`'s lease engine would carry into `#parseOutput`. */
  function fullCoreShapedDevice(): Record<string, unknown> {
    return {
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
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
      featureProfile: "reduced",
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
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      address: "127.0.0.1:1234",
      featureProfile: "reduced",
    });
  });

  it("rejects a device object that is missing the fields a grant must keep", () => {
    expect(() => grantedDeviceSchema.parse({ id: "device-1" })).toThrow();
  });

  it("keeps id, driverDeviceId, spec, and the optional address/featureProfile", () => {
    const parsed = grantedDeviceSchema.parse({
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "android", model: "Pixel 8", osVersion: "34" },
    });
    expect(parsed).toEqual({
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "android", model: "Pixel 8", osVersion: "34" },
    });
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
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
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
      featureProfile: "reduced",
      transitionAgeMs: 70,
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
      "featureProfile",
    ] as const) {
      expect(device).not.toHaveProperty(field);
    }

    expect(device).toEqual({
      id: "device-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "quarantined",
      foreignStateDetectedAt: 20,
      foreignProvenanceDetectedAt: 30,
      quarantineAttempts: 3,
      quarantineNextRetryAt: 60,
      transitionAgeMs: 70,
    });
  });

  it("rejects a device object that is missing the fields status.get must keep", () => {
    expect(() => statusDeviceSchema.parse({ id: "device-1" })).toThrow();
  });
});
