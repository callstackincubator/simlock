import { describe, expect, it } from "vitest";
import {
  doctorReportSchema,
  fitHostFacts,
  fitPlatformCatalog,
  grantedDeviceSchema,
  hostFactsSchema,
  leaseRequestRecordSchema,
  platformCatalogSchema,
} from "./index.js";

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
  it("keeps the image tag and baseline a stored request named", () => {
    const record = leaseRequestRecordSchema.parse({
      createdAt: 0,
      id: "req_1",
      ownerId: "agent",
      request: {
        baseline: "checkout",
        imageTag: "google_apis",
        model: "Pixel 8",
        platform: "android",
      },
      requesterId: "agent",
      state: "open",
    });

    expect(record.request.imageTag).toBe("google_apis");
    expect(record.request.baseline).toBe("checkout");
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

describe("doctorReportSchema's module-unavailable finding", () => {
  const finding = {
    kind: "module-unavailable",
    module: "agent-device",
    message: "found 0.20.3, need 0.21.28 or later",
    remedy: "install agent-device 0.21.28 or later",
  };
  const parses = (candidate: unknown) =>
    doctorReportSchema.safeParse({ findings: [candidate], sources: [] }).success;

  it("parses a module-unavailable finding, and refuses one without module, without message or without remedy", () => {
    expect(doctorReportSchema.parse({ findings: [finding], sources: [] })).toStrictEqual({
      findings: [finding],
      sources: [],
    });

    const { module: _module, ...withoutModule } = finding;
    const { message: _message, ...withoutMessage } = finding;
    const { remedy: _remedy, ...withoutRemedy } = finding;
    expect(parses(withoutModule)).toBe(false);
    expect(parses(withoutMessage)).toBe(false);
    expect(parses(withoutRemedy)).toBe(false);
  });

  it("refuses a module that fails the capability name check", () => {
    for (const module of ["", "Agent-Device", "1abc", "has space", `a${"b".repeat(32)}`]) {
      expect(parses({ ...finding, module })).toBe(false);
    }
    expect(parses({ ...finding, module: `a${"b".repeat(31)}` })).toBe(true);
  });

  it("refuses the old agent-device-unavailable kind", () => {
    const { module: _module, ...rest } = finding;
    expect(parses({ ...rest, kind: "agent-device-unavailable" })).toBe(false);
    expect(parses({ ...finding, kind: "agent-device-unavailable" })).toBe(false);
  });
});

describe("doctorReportSchema's sources", () => {
  const source = { platform: "ios", kind: "seed", model: "iPhone 17", osVersion: "27.0" };
  const parses = (candidate: unknown) =>
    doctorReportSchema.safeParse({ findings: [], sources: [candidate] }).success;

  it("parses a source with its optional fields, and refuses an unknown kind, a size that is negative or not whole, an over-long staleReason, model or osVersion, and an orphan that is not true", () => {
    expect(
      doctorReportSchema.parse({
        findings: [],
        sources: [{ ...source, imageTag: "api-35", sizeBytes: 0, staleReason: "x".repeat(300) }],
      }),
    ).toStrictEqual({
      findings: [],
      sources: [{ ...source, imageTag: "api-35", sizeBytes: 0, staleReason: "x".repeat(300) }],
    });
    expect(parses({ ...source, orphan: true })).toBe(true);
    expect(parses({ ...source, kind: "copy" })).toBe(false);
    expect(parses({ ...source, sizeBytes: -1 })).toBe(false);
    expect(parses({ ...source, sizeBytes: 1.5 })).toBe(false);
    expect(parses({ ...source, staleReason: "x".repeat(301) })).toBe(false);
    expect(parses({ ...source, model: "x".repeat(201) })).toBe(false);
    expect(parses({ ...source, osVersion: "x".repeat(201) })).toBe(false);
    expect(parses({ ...source, imageTag: "x".repeat(201) })).toBe(false);
    expect(parses({ ...source, orphan: false })).toBe(false);
    expect(doctorReportSchema.safeParse({ findings: [] }).success).toBe(false);
  });

  it("keeps a quick seed's settled flag and lease count, and refuses a count that is negative or not whole", () => {
    const quick = { ...source, settled: false, leases: 3 };
    expect(doctorReportSchema.parse({ findings: [], sources: [quick] }).sources).toStrictEqual([
      quick,
    ]);
    expect(parses({ ...source, settled: true, leases: 0 })).toBe(true);
    expect(parses({ ...source, leases: -1 })).toBe(false);
    expect(parses({ ...source, leases: 1.5 })).toBe(false);
    expect(parses({ ...source, settled: "yes" })).toBe(false);
  });
});
