import { describe, expect, it } from "vitest";
import { OPERATIONS } from "./index.js";

describe("operation input/output round trips", () => {
  it("lease.request: round-trips a representative request and rejects legacy aliases", () => {
    const input = OPERATIONS["lease.request"].input.parse({
      model: "iPhone 17 Pro",
      platform: "ios",
      osVersion: "18.0",
    });
    expect(input).toMatchObject({
      model: "iPhone 17 Pro",
      platform: "ios",
      osVersion: "18.0",
    });

    expect(() =>
      OPERATIONS["lease.request"].input.parse({ device: "iPhone 17 Pro", platform: "ios" }),
    ).toThrow();
    expect(() =>
      OPERATIONS["lease.request"].input.parse({
        request: { model: "iPhone 17 Pro", platform: "ios" },
      }),
    ).toThrow();
  });

  it("lease.request: accepts ttlMs on any request (ADR 0004 §4)", () => {
    expect(
      OPERATIONS["lease.request"].input.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ttlMs: 60_000 });
  });

  it.each(["slim", "full"] as const)("lease.request: accepts mode %s", (mode) => {
    expect(
      OPERATIONS["lease.request"].input.parse({ model: "iPhone 17 Pro", mode, platform: "ios" }),
    ).toMatchObject({ mode });
  });

  it.each([
    ["full", { full: true }],
    ["a mode other than slim or full", { mode: "fast" }],
    ["the lease mode ADR 0004 retired", { mode: "held" }],
  ])("lease.request: rejects %s", (_label, extra) => {
    expect(
      OPERATIONS["lease.request"].input.safeParse({
        model: "iPhone 17 Pro",
        platform: "ios",
        ...extra,
      }).success,
    ).toBe(false);
  });

  it("lease.request/lease.renew: a non-positive ttlMs is a schema-level BAD_REQUEST", () => {
    // why: The upper bound (`lease.maxTtlMs`) is the dispatcher's to enforce -- it is a daemon
    // config value this module cannot see -- but "a TTL is a positive number" is shape.
    expect(() =>
      OPERATIONS["lease.request"].input.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        ttlMs: 0,
      }),
    ).toThrow();
    expect(() => OPERATIONS["lease.renew"].input.parse({ leaseId: "lse_1", ttlMs: -1 })).toThrow();
  });

  it("lease.cancel: keeps a platform of ios or android and refuses any other", () => {
    const input = OPERATIONS["lease.cancel"].input;

    expect(input.parse({ platform: "android", requesterId: "agent" })).toEqual({
      platform: "android",
      requesterId: "agent",
    });
    expect(input.parse({ platform: "ios" })).toEqual({ platform: "ios" });
    expect(input.safeParse({ platform: "tvos" }).success).toBe(false);
  });

  it("lease.request: round-trips a representative output grant", () => {
    const grant = {
      device: {
        physical: false,
        id: "dev_1",
        driverDeviceId: "sim-1",
        spec: { physical: false, platform: "ios", model: "iPhone 17 Pro", osVersion: "18.0" },
        mode: "full",
        state: "leased",
        driverData: { udid: "abc" },
        createdAt: 1,
      },
      environment: {},
      lease: {
        id: "lease_1",
        deviceId: "dev_1",
        requesterId: "req_1",
        ownerId: "req_1",
        grantedAt: 1,
        lastRenewedAt: 1,
        idChosenByRequester: false,
        ttlMs: 1,
        ttlDeadline: 2,
      },
      timing: {
        estimatedProvisionMs: 1,
        estimatedBootMs: 1,
        estimatedReclaimMs: 1,
        estimatedReadyMs: 1,
      },
    };
    expect(OPERATIONS["lease.request"].output.parse(grant)).toBeDefined();
  });

  it("lease.request: rejects a malformed input (missing platform)", () => {
    expect(() => OPERATIONS["lease.request"].input.parse({ model: "iPhone 17" })).toThrow();
  });

  it("doctor.run: round-trips a driver-advisory finding", () => {
    const report = {
      findings: [{ kind: "driver-advisory", platform: "ios", code: "slim-disabled", message: "x" }],
      sources: [],
    };
    expect(OPERATIONS["doctor.run"].output.parse(report)).toBeDefined();
  });

  it("doctor.run: round-trips a prerequisite-missing finding field for field", () => {
    const finding = {
      kind: "prerequisite-missing",
      platform: "android",
      prerequisite: "android-emulator",
      message: "The Android emulator package is not installed.",
      remedy: "Run `sdkmanager --install emulator`.",
    };
    expect(OPERATIONS["doctor.run"].output.parse({ findings: [finding], sources: [] })).toEqual({
      findings: [finding],
      sources: [],
    });
    const { remedy: _remedy, ...withoutRemedy } = finding;
    expect(() =>
      OPERATIONS["doctor.run"].output.parse({ findings: [withoutRemedy], sources: [] }),
    ).toThrow();
  });

  it("doctor.run: round-trips a service-broken finding field for field, and refuses an empty missing list or a missing name, remedy or unknown manager", () => {
    const finding = {
      kind: "service-broken",
      manager: "launchd",
      name: "com.callstack.simlock.worker",
      missing: ["/Users/me/.nvm/versions/node/v22.13.0/bin/node"],
      remedy: "Run `simlock daemon install` again.",
    };
    expect(OPERATIONS["doctor.run"].output.parse({ findings: [finding], sources: [] })).toEqual({
      findings: [finding],
      sources: [],
    });
    expect(() =>
      OPERATIONS["doctor.run"].output.parse({
        findings: [{ ...finding, missing: [] }],
        sources: [],
      }),
    ).toThrow();
    for (const broken of [{ name: undefined }, { manager: "pm2" }, { remedy: undefined }]) {
      expect(() =>
        OPERATIONS["doctor.run"].output.parse({
          findings: [{ ...finding, ...broken }],
          sources: [],
        }),
      ).toThrow();
    }
  });

  it("status.get: round-trips a representative status snapshot", () => {
    const status = {
      devices: [],
      leases: [],
      capacity: {
        ios: {
          atRamBudget: false,
          running: 0,
          maxRunning: 1,
          reserved: 0,
          overLimit: false,
          limit: 1,
          warm: 0,
          used: 0,
        },
        android: {
          atRamBudget: false,
          running: 0,
          maxRunning: 1,
          reserved: 0,
          overLimit: false,
          limit: 1,
          warm: 0,
          used: 0,
        },
        global: { running: 0, maxRunning: 2, reserved: 0, overLimit: false, warm: 0 },
      },
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: {
        os: "macOS",
        osVersion: "15.5",
        arch: "arm64",
        tools: [{ platform: "ios", name: "xcode", version: "16.4", build: "16F6" }],
      },
      queueDepth: 0,
      warmPool: { enabled: true, reserveRunning: { android: 0, ios: 1 }, targets: [] },
    };
    expect(OPERATIONS["status.get"].output.parse(status)).toBeDefined();
  });

  describe("status.get memoryPressure", () => {
    const host = { os: "macOS", osVersion: "15.5", arch: "arm64", tools: [] };
    const entry = {
      atRamBudget: false,
      limit: 1,
      maxRunning: 1,
      overLimit: false,
      reserved: 0,
      running: 0,
      used: 0,
      warm: 0,
    };
    const parse = (memoryPressure: unknown) =>
      OPERATIONS["status.get"].output.safeParse({
        capacity: {
          android: entry,
          global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: entry,
          memoryPressure,
        },
        daemon: {
          health: "running",
          lastUpdateFailure: null,
          latestVersion: null,
          mode: "worker",
          update: null,
          version: "0.0.0-test",
        },
        devices: [],
        host,
        leases: [],
        queueDepth: 0,
      }).success;
    const floor = { availablePercent: 8, floorPercent: 10, trigger: "floor" };

    it("a worker's block is bounded: the percent a whole number from 0 to 100, the floor 0 to 100, the time not negative", () => {
      expect(parse({ step: "none" })).toBe(true);
      expect(parse({ cause: floor, since: 0, step: "new-devices-paused" })).toBe(true);
      expect(
        parse({ cause: { ...floor, availablePercent: 100 }, since: 1, step: "warming-paused" }),
      ).toBe(true);
      for (const cause of [
        { ...floor, availablePercent: 101 },
        { ...floor, availablePercent: -1 },
        { ...floor, availablePercent: 8.5 },
        { ...floor, floorPercent: 101 },
        { ...floor, floorPercent: -1 },
        { ...floor, level: "bogus" },
        { ...floor, trigger: "other" },
      ]) {
        expect(parse({ cause, since: 1, step: "warming-paused" })).toBe(false);
      }
      for (const since of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
        expect(parse({ cause: floor, since, step: "warming-paused" })).toBe(false);
      }
      expect(parse({ step: "paused" })).toBe(false);
    });
  });

  describe("status.get warmPool", () => {
    const host = { os: "macOS", osVersion: "15.5", arch: "arm64", tools: [] };
    const warmPool = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 1,
          count: 2,
          mode: "full",
          model: "iPhone 17",
          origin: "configured",
          osVersion: "26.0",
          platform: "ios",
          ready: 1,
        },
        {
          booting: 0,
          count: 1,
          mode: "full",
          model: "iPhone 17",
          origin: "learned",
          osVersion: "27.0",
          platform: "ios",
          ready: 0,
          short: "runtime-missing",
        },
      ],
    };
    const capacityEntry = {
      atRamBudget: false,
      limit: 1,
      maxRunning: 1,
      overLimit: false,
      reserved: 0,
      running: 0,
      used: 0,
      warm: 0,
    };
    const running = {
      capacity: {
        android: capacityEntry,
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
        ios: capacityEntry,
      },
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host,
      leases: [],
      queueDepth: 0,
    };

    it("round-trips the block field for field", () => {
      expect(OPERATIONS["status.get"].output.parse({ ...running, warmPool }).warmPool).toEqual(
        warmPool,
      );
    });

    it("parses a starting daemon's answer without it, and a running one that carries it", () => {
      expect(
        OPERATIONS["status.get"].output.parse({ ...running, warmPool }).warmPool,
      ).toBeDefined();
      expect(
        OPERATIONS["status.get"].output.parse({
          daemon: {
            health: "starting",
            mode: "worker",
            version: "0.0.0-test",
            update: null,
            lastUpdateFailure: null,
            latestVersion: null,
          },
          host,
        }),
      ).toEqual({
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host,
      });
    });

    it("rejects a short outside the ten reasons, and a target list longer than 320", () => {
      const target = warmPool.targets[0];
      expect(() =>
        OPERATIONS["status.get"].output.parse({
          ...running,
          warmPool: { ...warmPool, targets: [{ ...target, short: "tired" }] },
        }),
      ).toThrow();
      expect(() =>
        OPERATIONS["status.get"].output.parse({
          ...running,
          warmPool: { ...warmPool, targets: Array.from({ length: 321 }, () => target) },
        }),
      ).toThrow();
    });
  });

  it.each([
    "disabled",
    "no-driver",
    "runtime-missing",
    "unknown-model",
    "unresolvable",
    "boot-failed",
    "device-limit",
    "running-limit",
    "reserve",
    "ram-budget",
  ])("status.get: accepts the warm pool reason %s", (short) => {
    const target = {
      booting: 0,
      count: 1,
      mode: "full",
      model: "iPhone 17",
      origin: "configured",
      platform: "ios",
      ready: 0,
      short,
    };
    const status = {
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
      warmPool: { enabled: true, reserveRunning: { android: 0, ios: 0 }, targets: [target] },
    };

    expect(OPERATIONS["status.get"].output.parse(status).warmPool?.targets[0]?.short).toBe(short);
  });

  it.each(["runtime-missing", "unknown-model", "over-limit"])(
    "doctor.run: accepts a warm-pool-target-unreachable finding with reason %s",
    (reason) => {
      const finding = {
        kind: "warm-pool-target-unreachable",
        message: "m",
        reason,
        remedy: "r",
        target: "t",
      };

      expect(
        OPERATIONS["doctor.run"].output.parse({ findings: [finding], sources: [] }).findings,
      ).toEqual([finding]);
    },
  );

  it("doctor.run: round-trips a warm-pool-target-unreachable finding field for field", () => {
    const finding = {
      kind: "warm-pool-target-unreachable",
      message: "iOS 27.0 is not installed",
      platform: "ios",
      reason: "runtime-missing",
      remedy: "run simlock component install ios 27.0",
      target: "iPhone 17 / 27.0 / full",
    };
    expect(OPERATIONS["doctor.run"].output.parse({ findings: [finding], sources: [] })).toEqual({
      findings: [finding],
      sources: [],
    });
  });

  it("status.get: cuts installs to their first 16 and each component to 64 characters, on the status and on a worker view", () => {
    const installs = Array.from({ length: 20 }, (_, index) => ({
      component: `${String(index).padStart(2, "0")}${"x".repeat(100)}`,
      platform: "ios",
      since: index,
      state: "waiting",
      waiters: 1,
    }));
    const cut = installs
      .slice(0, 16)
      .map((install) => ({ ...install, component: install.component.slice(0, 64) }));
    const capacityEntry = {
      atRamBudget: false,
      running: 0,
      maxRunning: 1,
      reserved: 0,
      overLimit: false,
      limit: 1,
      warm: 0,
      used: 0,
    };

    const parsed = OPERATIONS["status.get"].output.parse({
      capacity: {
        android: capacityEntry,
        global: { running: 0, maxRunning: 1, reserved: 0, overLimit: false, warm: 0 },
        ios: capacityEntry,
      },
      daemon: {
        health: "running",
        mode: "gateway",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host: { os: "Linux", osVersion: "6.8.0", arch: "x64", tools: [] },
      installs,
      leases: [],
      queueDepth: 0,
      workers: [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          id: "wrk_1",
          installs,
          lastSeenAt: 1,
          leases: [],
        },
      ],
    });

    expect(parsed.installs).toEqual(cut);
    expect(parsed.workers?.[0]?.installs).toEqual(cut);
  });
});
