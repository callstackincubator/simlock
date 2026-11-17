import { describe, expect, it } from "vitest";
import {
  statusGet,
  capabilityReason,
  deviceRecordSchema,
  doctorReportSchema,
  eventEnvelopeSchema,
  fitHostLoad,
  hostLoadSchema,
  statusWarmPoolSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./index.js";

describe("a worker status's capabilities list", () => {
  const status = (capabilities: unknown) =>
    statusGet.output.safeParse({
      capabilities,
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "26.0", tools: [] },
    });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    name: "agent-device",
    state: "unavailable",
    reason: "found 0.20.1, need 0.21.28 or later",
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
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
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

describe("the worker view's load", () => {
  const view = {
    connection: "connected" as const,
    drained: false,
    id: "wrk_1",
    lastSeenAt: 1,
  };
  const load = {
    cpu: { busyPercent: 34.2, cores: 10, limited: false },
    disk: { freeBytes: 120, totalBytes: 500 },
    memory: {
      availableBytes: 4_000,
      limited: false,
      pressure: "normal" as const,
      swapUsedBytes: 100,
      totalBytes: 16_000,
    },
    readAt: 8_000,
  };

  it("the worker view schema round-trips load, and refuses a negative readAt, a negative figure or a busy % over 100", () => {
    expect(workerViewSchema.parse({ ...view, load })).toEqual({ ...view, load });
    expect(workerViewSchema.parse({ ...view, load: { readAt: 0 } })).toEqual({
      ...view,
      load: { readAt: 0 },
    });

    expect(() => workerViewSchema.parse({ ...view, load: { ...load, readAt: -1 } })).toThrow();
    expect(() =>
      workerViewSchema.parse({ ...view, load: { ...load, disk: { ...load.disk, freeBytes: -1 } } }),
    ).toThrow();
    expect(() =>
      workerViewSchema.parse({
        ...view,
        load: { ...load, cpu: { ...load.cpu, busyPercent: 100.5 } },
      }),
    ).toThrow();
  });
});

describe("the worker view's baselines", () => {
  const view = {
    connection: "connected" as const,
    drained: false,
    id: "wrk_1",
    lastSeenAt: 1,
  };
  const entry = {
    mode: "full" as const,
    model: "Pixel 9",
    name: "checkout",
    osVersion: "36",
    platform: "android" as const,
    savedAt: "2026-11-02T13:10:00Z",
    version: 2,
  };

  it("the worker view schema takes 1000 baselines and refuses 1001, and an entry's workerId of 1 to 128 characters and refuses an empty or 129-character one", () => {
    const parse = (baselines: unknown[]) => workerViewSchema.parse({ ...view, baselines });

    expect(parse([])).toEqual({ ...view, baselines: [] });
    expect(parse(Array.from({ length: 1000 }, () => entry))).toHaveProperty("baselines.999");
    expect(() => parse(Array.from({ length: 1001 }, () => entry))).toThrow();
    expect(parse([{ ...entry, workerId: "x".repeat(128) }])).toHaveProperty(
      "baselines.0.workerId",
      "x".repeat(128),
    );
    expect(() => parse([{ ...entry, workerId: "" }])).toThrow();
    expect(() => parse([{ ...entry, workerId: "x".repeat(129) }])).toThrow();
  });
});

describe("waitingRequestSchema's reason", () => {
  const reasons = [
    "behind-earlier-request",
    "device-limit",
    "ram-budget",
    "global-running-limit",
    "platform-running-limit",
    "waiting-for-device",
    "no-free-physical",
  ] as const;
  const queued = {
    createdAt: 1,
    id: "req_1",
    queuePosition: 1,
    requesterId: "agent",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
  } as const;

  it("accepts each of the eight reasons on a queued entry and keeps it", () => {
    expect(waitingRequestSchema.safeParse(queued).success).toBe(true);
    for (const reason of reasons) {
      expect(waitingRequestSchema.parse({ ...queued, reason })).toMatchObject({ reason });
    }
  });

  it("refuses a reason outside the eight on a queued entry", () => {
    expect(waitingRequestSchema.safeParse({ ...queued, reason: "bogus" }).success).toBe(false);
  });

  it("refuses any reason on a starting entry", () => {
    const { queuePosition: _position, ...rest } = queued;
    const starting = { ...rest, stage: "starting" } as const;

    expect(waitingRequestSchema.safeParse(starting).success).toBe(true);
    for (const reason of reasons) {
      expect(waitingRequestSchema.safeParse({ ...starting, reason }).success).toBe(false);
    }
  });
});

describe("waitingRequestSchema's workers", () => {
  const reasons = [
    "disconnected",
    "incompatible",
    "not-ready",
    "unhealthy",
    "drained",
    "busy",
    "no-driver",
    "unknown-model",
    "runtime-missing",
    "capability-missing",
    "full",
    "no-free-physical",
    "not-chosen",
  ] as const;
  const queued = {
    createdAt: 1,
    id: "req_1",
    queuePosition: 1,
    requesterId: "agent",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
  } as const;
  const withWorkers = (workers: unknown) => waitingRequestSchema.safeParse({ ...queued, workers });

  it("accepts each of the thirteen reasons and a capacity reason with full, and keeps them", () => {
    for (const reason of reasons) {
      expect(withWorkers([{ reason, workerId: "wrk_a" }]).success).toBe(true);
    }
    expect(
      waitingRequestSchema.parse({
        ...queued,
        workers: [{ capacityReason: "ram-budget", reason: "full", workerId: "wrk_a" }],
      }),
    ).toMatchObject({ workers: [{ capacityReason: "ram-budget", reason: "full" }] });
  });

  it("refuses an unknown reason, a capacity reason with drained, an unknown capacity reason and one workerId twice", () => {
    expect(withWorkers([{ reason: "full", workerId: "wrk_a" }]).success).toBe(true);
    expect(withWorkers([{ reason: "bogus", workerId: "wrk_a" }]).success).toBe(false);
    expect(
      withWorkers([{ capacityReason: "ram-budget", reason: "drained", workerId: "wrk_a" }]).success,
    ).toBe(false);
    expect(
      withWorkers([{ capacityReason: "bogus", reason: "full", workerId: "wrk_a" }]).success,
    ).toBe(false);
    expect(
      withWorkers([
        { reason: "drained", workerId: "wrk_a" },
        { reason: "full", workerId: "wrk_a" },
      ]).success,
    ).toBe(false);
  });
});

describe("opaque fields stay optional on the wire", () => {
  it("accepts an answer whose opaque driverData or payload key is absent (JSON drops undefined)", () => {
    const record = {
      physical: false,
      id: "device-1",
      driverDeviceId: "SIM-1",
      spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "26.5" },
      mode: "full",
      state: "ready",
      createdAt: 0,
    };
    const orphan = {
      findings: [
        { kind: "orphan-device", platform: "ios", device: { deviceId: "SIM-1", address: "a" } },
      ],
      sources: [],
    };
    const envelope = { id: "evt_1", seq: 1, timestamp: 1, event: "x", module: "m" };
    expect(deviceRecordSchema.safeParse(record).success).toBe(true);
    expect(doctorReportSchema.safeParse(orphan).success).toBe(true);
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("statusWarmPoolSchema", () => {
  const entry = {
    booting: 0,
    count: 1,
    mode: "full",
    model: "Pixel 8",
    origin: "learned",
    osVersion: "35",
    platform: "android",
    ready: 1,
  };
  const block = (targets: readonly unknown[]) => ({
    enabled: true,
    reserveRunning: { android: 0, ios: 0 },
    targets,
  });
  const { origin: _origin, ...withoutOrigin } = entry;

  it("accepts origin configured and learned, an optional imageTag, an optional baseline, and 320 entries, and refuses an entry without origin or with another word, a tag imageTagSchema refuses, a baseline name the name rule refuses, and 321 entries", () => {
    const cases: readonly { name: string; targets: readonly unknown[]; accepted: boolean }[] = [
      { accepted: true, name: "learned", targets: [entry] },
      { accepted: true, name: "configured", targets: [{ ...entry, origin: "configured" }] },
      { accepted: true, name: "a tag", targets: [{ ...entry, imageTag: "google_apis_playstore" }] },
      { accepted: true, name: "320 entries", targets: Array.from({ length: 320 }, () => entry) },
      { accepted: true, name: "a baseline", targets: [{ ...entry, baseline: "checkout" }] },
      { accepted: false, name: "no origin", targets: [withoutOrigin] },
      { accepted: false, name: "another word", targets: [{ ...entry, origin: "remembered" }] },
      { accepted: false, name: "a bad tag", targets: [{ ...entry, imageTag: "no spaces" }] },
      { accepted: false, name: "a bad baseline", targets: [{ ...entry, baseline: "Not A Name" }] },
      { accepted: false, name: "321 entries", targets: Array.from({ length: 321 }, () => entry) },
    ];

    expect(
      cases.map(({ name, targets }) => [
        name,
        statusWarmPoolSchema.safeParse(block(targets)).success,
      ]),
    ).toEqual(cases.map(({ accepted, name }) => [name, accepted]));
    expect(
      statusWarmPoolSchema.parse(block([{ ...entry, imageTag: "google_apis" }])).targets[0],
    ).toMatchObject({ imageTag: "google_apis", origin: "learned" });
    expect(
      statusWarmPoolSchema.parse(block([{ ...entry, baseline: "checkout" }])).targets[0],
    ).toMatchObject({ baseline: "checkout", origin: "learned" });
  });
});
