import { describe, expect, it } from "vitest";

import { statusGet } from "./operations.js";
import {
  capabilityReason,
  deviceRecordSchema,
  doctorReportSchema,
  fitHostFacts,
  fitHostLoad,
  fitPlatformCatalog,
  grantedDeviceSchema,
  hostFactsSchema,
  hostLoadSchema,
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

  it("shows a device spec's image tag in a grant, a status device, and a list.get record", () => {
    const device = {
      ...fullCoreShapedDevice(),
      spec: {
        physical: false,
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
    modelClasses: {},
    classDefaults: {},
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

  it("drops a modelClasses key too long for the schema and keeps the rest", () => {
    const fitted = fitPlatformCatalog({
      ...entry([]),
      modelClasses: { ["x".repeat(257)]: "phone" as const, "Pixel 8": "phone" as const },
    });

    expect(fitted.modelClasses).toEqual({ "Pixel 8": "phone" });
    expect(() => platformCatalogSchema.parse(fitted)).not.toThrow();
  });

  it("drops a classDefaults model name too long for the schema and keeps the rest", () => {
    const fitted = fitPlatformCatalog({
      ...entry([]),
      classDefaults: { phone: "Pixel 8", tv: "x".repeat(257) },
    });

    expect(fitted.classDefaults).toEqual({ phone: "Pixel 8" });
    expect(() => platformCatalogSchema.parse(fitted)).not.toThrow();
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
      physical: false,
      driverDeviceId: "emulator-5554",
      id: "dev_1",
      mode: "full",
      spec: { physical: false, imageTag, model: "Pixel 8", osVersion: "34", platform: "android" },
    };

    expect(leaseRequestRecordSchema.safeParse(record).success).toBe(false);
    expect(grantedDeviceSchema.safeParse(device).success).toBe(false);
  });
});

describe("platformCatalogSchema classDefaults", () => {
  const entry = {
    defaultRuntime: "35",
    modelAliases: {},
    modelClasses: {},
    modelRuntimes: {},
    models: [],
    platform: "android" as const,
    runtimes: ["35"],
  };

  it("requires classDefaults", () => {
    expect(platformCatalogSchema.safeParse(entry).success).toBe(false);
    expect(platformCatalogSchema.safeParse({ ...entry, classDefaults: {} }).success).toBe(true);
  });

  it("accepts a model name for a class", () => {
    const parsed = platformCatalogSchema.parse({ ...entry, classDefaults: { phone: "Pixel 9" } });

    expect(parsed.classDefaults).toEqual({ phone: "Pixel 9" });
  });

  it("refuses a key that is not a class", () => {
    expect(
      platformCatalogSchema.safeParse({ ...entry, classDefaults: { fridge: "Pixel 9" } }).success,
    ).toBe(false);
  });

  it("refuses a model name longer than the catalog's name bound", () => {
    expect(
      platformCatalogSchema.safeParse({ ...entry, classDefaults: { phone: "x".repeat(257) } })
        .success,
    ).toBe(false);
  });
});

describe("the status device entry's absent state (ADR 0022 §7)", () => {
  const absent = {
    class: "phone",
    driverDeviceId: "00008110-001A2B3C4D5E",
    id: "dev_7",
    physical: true,
    servesDefaultMode: false,
    spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
    state: "absent",
  };

  it("the status device entry and the worker view accept state absent and each absentReason, and refuse another reason", () => {
    const parsed = (device: object) => statusDeviceSchema.safeParse(device);

    for (const absentReason of ["locked", "untrusted", "not-present"] as const) {
      const result = parsed({ ...absent, absentReason });
      expect(result.success, `absent (${absentReason})`).toBe(true);
      expect(result.success ? result.data : undefined).toMatchObject({
        absentReason,
        state: "absent",
      });
    }
    expect(parsed({ ...absent, absentReason: "unplugged" }).success).toBe(false);
  });
});

describe("doctorReportSchema's agent-device-unavailable finding", () => {
  const finding = {
    kind: "agent-device-unavailable",
    message: "found 0.20.3, need 0.21.25 or later",
    remedy: "install agent-device 0.21.25 or later",
  };

  it("parses a report with the finding, and refuses one without message or without remedy", () => {
    expect(doctorReportSchema.parse({ findings: [finding] })).toStrictEqual({
      findings: [finding],
    });

    const { message: _message, ...withoutMessage } = finding;
    const { remedy: _remedy, ...withoutRemedy } = finding;
    expect(doctorReportSchema.safeParse({ findings: [withoutMessage] }).success).toBe(false);
    expect(doctorReportSchema.safeParse({ findings: [withoutRemedy] }).success).toBe(false);
  });
});

describe("a worker status's capabilities list", () => {
  const status = (capabilities: unknown) =>
    statusGet.output.safeParse({
      capabilities,
      daemon: { health: "running", mode: "worker" },
      host: { arch: "arm64", os: "macOS", osVersion: "26.0", tools: [] },
    });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    name: "agent-device",
    state: "unavailable",
    reason: "found 0.20.1, need 0.21.25 or later",
    ...overrides,
  });

  it("passes with a 32-character name and a 500-character reason", () => {
    expect(status([entry()]).success).toBe(true);
    expect(status([entry({ name: `a${"b".repeat(31)}`, reason: "r".repeat(500) })]).success).toBe(
      true,
    );
  });

  it("passes an available and an off entry that carry no reason", () => {
    expect(
      status([
        { name: "agent-device", state: "available" },
        { name: "other", state: "off" },
      ]).success,
    ).toBe(true);
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["17 entries", Array.from({ length: 17 }, (_, i) => entry({ name: `cap-${String(i)}` }))],
    ["a name with an upper-case letter", [entry({ name: "Agent-device" })]],
    ["a name starting with a digit", [entry({ name: "1agent" })]],
    ["a name starting with -", [entry({ name: "-agent" })]],
    ["a 33-character name", [entry({ name: `a${"b".repeat(32)}` })]],
    ["a duplicate name", [entry(), entry({ reason: "other" })]],
    ["a reason on an available entry", [entry({ state: "available" })]],
    ["a reason on an off entry", [entry({ state: "off" })]],
    ["an unavailable entry with no reason", [{ name: "agent-device", state: "unavailable" }]],
    ["an unavailable entry with an empty reason", [entry({ reason: "" })]],
    ["a 501-character reason", [entry({ reason: "r".repeat(501) })]],
    ["a reason with a newline", [entry({ reason: "a\nb" })]],
    ["a reason with an escape", [entry({ reason: "a\u001bb" })]],
    ["a reason with a U+2028", [entry({ reason: "a\u2028b" })]],
  ];

  it.each(refused)("fails the schema with %s", (_title, capabilities) => {
    expect(status([entry()]).success).toBe(true);
    expect(status(capabilities).success).toBe(false);
  });
});

describe("capabilityReason", () => {
  it("answers a 600-character reason with a newline, an escape, a DEL and a U+2028 as 500 characters with spaces in their place", () => {
    const text = `a\nb\u001bc\u007fd\u2028${"x".repeat(600)}`;

    const cleaned = capabilityReason(text);

    expect(cleaned.length).toBe(500);
    expect(cleaned.startsWith("a b c d ")).toBe(true);
  });

  it("answers a reason that is only control characters as unknown", () => {
    expect(capabilityReason("\n\u001b\u007f\u2028")).toBe("unknown");
    expect(capabilityReason("")).toBe("unknown");
  });

  it("never splits a surrogate pair when it cuts to 500 units", () => {
    const cleaned = capabilityReason(`${"x".repeat(499)}\u{1F600}`);

    expect(cleaned).toBe("x".repeat(499));
  });
});

describe("a status answer's load block", () => {
  const load = {
    ageMs: 4_120,
    cpu: { busyPercent: 34.2, cores: 10, limited: false },
    disk: { freeBytes: 120_689_623_040, totalBytes: 530_870_820_864 },
    memory: {
      availableBytes: 10_522_669_875,
      limited: false,
      pressure: "normal",
      swapUsedBytes: 1_288_490_188,
      totalBytes: 34_359_738_368,
    },
  };
  const answer = (block: unknown) =>
    statusGet.output.safeParse({
      daemon: { health: "running", mode: "worker" },
      host: { arch: "arm64", os: "macOS", osVersion: "26.0", tools: [] },
      load: block,
    });

  it("round-trips field for field", () => {
    const parsed = answer(load);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.load).toStrictEqual(load);
  });

  it.each([
    ["a negative disk figure", { ...load, disk: { ...load.disk, freeBytes: -1 } }],
    ["a negative age", { ...load, ageMs: -1 }],
    ["an ageMs over one day", { ...load, ageMs: 86_400_001 }],
    ["a busy % over 100", { ...load, cpu: { ...load.cpu, busyPercent: 100.1 } }],
    ["cores of 0", { ...load, cpu: { ...load.cpu, cores: 0 } }],
    ["an unknown pressure", { ...load, memory: { ...load.memory, pressure: "severe" } }],
    ["a negative swap", { ...load, memory: { ...load.memory, swapUsedBytes: -5 } }],
  ])("is refused with %s", (_why, refused) => {
    expect(answer(load).success).toBe(true);

    expect(answer(refused).success).toBe(false);
  });

  it("accepts an ageMs of exactly one day, half a core, and parts left out", () => {
    expect(answer({ ageMs: 86_400_000 }).success).toBe(true);
    expect(answer({ ageMs: 0, cpu: { ...load.cpu, cores: 0.5 } }).success).toBe(true);
  });
});

describe("fitHostLoad", () => {
  const memory = {
    availableBytes: 4_000,
    limited: false,
    swapUsedBytes: 0,
    totalBytes: 16_000,
  };

  it("caps ageMs at one day and drops a part whose figures break the schema, keeping the others", () => {
    const fitted = fitHostLoad({
      ageMs: 90_000_000,
      cpu: { busyPercent: 150, cores: 4, limited: false },
      disk: { freeBytes: -1, totalBytes: 500 },
      memory,
    });

    expect(fitted).toStrictEqual({ ageMs: 86_400_000, memory });
    expect(() => hostLoadSchema.parse(fitted)).not.toThrow();
  });

  it("drops a memory part whose figures break the schema, keeping the others", () => {
    const disk = { freeBytes: 1, totalBytes: 2 };

    const fitted = fitHostLoad({ ageMs: 5, disk, memory: { ...memory, totalBytes: -1 } });

    expect(fitted).toStrictEqual({ ageMs: 5, disk });
  });

  it("leaves a reading that already fits as it is, and nothing as nothing", () => {
    const reading = {
      ageMs: 15,
      cpu: { busyPercent: 12.5, cores: 0.5, limited: true },
      disk: { freeBytes: 1, totalBytes: 2 },
      memory,
    };

    expect(fitHostLoad(reading)).toStrictEqual(reading);
    expect(fitHostLoad(undefined)).toBeUndefined();
  });
});
