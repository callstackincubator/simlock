import { describe, expect, it } from "vitest";

import {
  deviceRecordSchema,
  fitHostFacts,
  fitPlatformCatalog,
  grantedDeviceSchema,
  hostFactsSchema,
  leaseGrantSchema,
  leaseRequestRecordSchema,
  platformCatalogSchema,
  statusDeviceSchema,
} from "./schemas.js";

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
    "leaseIdentity",
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
      mode: "slim",
    });
  });

  it("rejects a device object that is missing the fields a grant must keep", () => {
    expect(() => grantedDeviceSchema.parse({ id: "device-1" })).toThrow();
  });

  it("keeps id, driverDeviceId, spec, and mode, with address optional", () => {
    const parsed = grantedDeviceSchema.parse({
      id: "device-1",
      driverDeviceId: "SIM-1",
      mode: "full",
      spec: { platform: "android", model: "Pixel 8", osVersion: "34" },
    });
    expect(parsed).toEqual({
      id: "device-1",
      driverDeviceId: "SIM-1",
      mode: "full",
      spec: { platform: "android", model: "Pixel 8", osVersion: "34" },
    });
  });

  it("rejects a granted device without a mode, or with a mode other than slim or full", () => {
    const device = {
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
    };
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
      mode: "slim",
      leaseIdentity: "fresh",
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
    ] as const) {
      expect(device).not.toHaveProperty(field);
    }

    expect(device).toEqual({
      id: "device-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "quarantined",
      mode: "slim",
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

  it("rejects a status device without a mode, or with a mode other than slim or full", () => {
    const device = {
      id: "device-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "ready",
    };
    expect(() => statusDeviceSchema.parse(device)).toThrow();
    expect(() => statusDeviceSchema.parse({ ...device, mode: "reduced" })).toThrow();
  });

  it("shows no planned mode on a device's spec in a grant, a status device, or a list.get record", () => {
    const device = {
      ...fullCoreShapedDevice(),
      mode: "full",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5", mode: "slim" },
    };

    expect(grantedDeviceSchema.parse(device).spec).not.toHaveProperty("mode");
    expect(statusDeviceSchema.parse(device).spec).not.toHaveProperty("mode");
    expect(deviceRecordSchema.parse(device).spec).not.toHaveProperty("mode");
  });

  it("shows a device spec's image tag in a grant, a status device, and a list.get record", () => {
    const device = {
      ...fullCoreShapedDevice(),
      spec: {
        platform: "android",
        model: "Pixel 8",
        osVersion: "34",
        imageTag: "google_apis_playstore",
      },
    };

    expect(grantedDeviceSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
    expect(statusDeviceSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
    expect(deviceRecordSchema.parse(device).spec.imageTag).toBe("google_apis_playstore");
  });

  it("rejects a list.get device record without a mode, or with a mode other than slim or full", () => {
    const record = {
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      state: "ready",
      driverData: {},
      createdAt: 0,
    };
    expect(deviceRecordSchema.parse({ ...record, mode: "full" })).toMatchObject({ mode: "full" });
    expect(() => deviceRecordSchema.parse(record)).toThrow();
    expect(() => deviceRecordSchema.parse({ ...record, mode: "reduced" })).toThrow();
  });
});

describe("fitHostFacts", () => {
  it("cuts over-long host strings, leaves out tools that do not fit, and stops at the list's maximum", () => {
    const fitted = fitHostFacts({
      arch: "a".repeat(200),
      os: "o".repeat(200),
      osVersion: "1".repeat(200),
      tools: [
        { name: "emulator", platform: "android" as const, version: "9".repeat(129) },
        { name: "cmdline-tools", platform: "android" as const, version: "" },
        ...Array.from({ length: 40 }, (_, index) => ({
          name: `tool-${index}`,
          platform: "android" as const,
          version: "1",
        })),
      ],
    });

    expect(fitted.arch).toHaveLength(128);
    expect(fitted.os).toHaveLength(128);
    expect(fitted.osVersion).toHaveLength(128);
    expect(fitted.tools).toHaveLength(32);
    expect(fitted.tools[0]?.name).toBe("tool-0");
    expect(() => hostFactsSchema.parse(fitted)).not.toThrow();
  });

  it("leaves facts that already fit as they are", () => {
    const host = {
      arch: "arm64",
      os: "macOS",
      osVersion: "15.5",
      tools: [{ build: "16F6", name: "xcode", platform: "ios" as const, version: "16.4" }],
    };

    expect(fitHostFacts(host)).toEqual(host);
  });
});

describe("fitPlatformCatalog", () => {
  const entry = (customModels: string[]) => ({
    customModels,
    defaultRuntime: "35",
    modelAliases: {},
    modelRuntimes: Object.fromEntries(customModels.map((model) => [model, ["35"]])),
    models: customModels,
    platform: "android" as const,
    runtimes: ["35"],
  });

  it("stops customModels at its maximum, in an entry the schema accepts", () => {
    const names = Array.from({ length: 4097 }, (_, index) => `m${index}`);

    const fitted = fitPlatformCatalog(entry(names));

    expect(fitted.customModels).toEqual(names.slice(0, 4096));
    expect(() => platformCatalogSchema.parse(fitted)).not.toThrow();
  });

  it("leaves out customModels when no name fits", () => {
    const fitted = fitPlatformCatalog(entry(["x".repeat(257)]));

    expect(fitted).not.toHaveProperty("customModels");
    expect(fitted.models).toEqual(["x".repeat(257)]);
  });

  it("leaves an entry that already fits as it is", () => {
    const fits = entry(["My Tablet"]);

    expect(fitPlatformCatalog(fits)).toEqual(fits);
  });
});

describe("leaseRequestRecordSchema", () => {
  it("keeps the image tag a stored request named", () => {
    const record = leaseRequestRecordSchema.parse({
      createdAt: 0,
      id: "req_1",
      ownerId: "agent",
      request: { imageTag: "google_apis", model: "Pixel 8", platform: "android" },
      requesterId: "agent",
      state: "open",
    });

    expect(record.request.imageTag).toBe("google_apis");
  });

  it.each([
    ["a character outside letters, digits, '_', '.' and '-'", "google apis"],
    ["more than 64 characters", "a".repeat(65)],
  ])("refuses a stored request or a device spec whose image tag has %s", (_label, imageTag) => {
    const record = {
      createdAt: 0,
      id: "req_1",
      ownerId: "agent",
      request: { imageTag, model: "Pixel 8", platform: "android" },
      requesterId: "agent",
      state: "open",
    };
    const device = {
      driverDeviceId: "emulator-5554",
      id: "dev_1",
      mode: "full",
      spec: { imageTag, model: "Pixel 8", osVersion: "34", platform: "android" },
    };

    expect(leaseRequestRecordSchema.safeParse(record).success).toBe(false);
    expect(grantedDeviceSchema.safeParse(device).success).toBe(false);
  });
});
