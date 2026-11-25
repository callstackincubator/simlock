import { describe, expect, it } from "vitest";
import { OPERATIONS, PUSH_SCHEMAS, platformCatalogSchema } from "./index.js";

describe("operation input/output round trips", () => {
  it("status.get: round-trips a gateway's aggregate, workers and all (ADR 0005 §20)", () => {
    const capacityEntry = {
      atRamBudget: false,
      running: 1,
      maxRunning: 2,
      reserved: 0,
      overLimit: false,
      limit: 2,
      warm: 0,
      used: 1,
    };
    const capacity = {
      ios: capacityEntry,
      android: capacityEntry,
      global: { running: 1, maxRunning: 4, reserved: 0, overLimit: false, warm: 0 },
    };
    const lease = {
      id: "lease_1",
      deviceId: "dev_1",
      requesterId: "agent-1",
      ownerId: "agent-1",
      grantedAt: 1,
      ttlMs: 2,
      ttlDeadline: 3,
      lastRenewedAt: 1,
      idChosenByRequester: false,
      workerId: "wrk_1",
    };
    const parsed = OPERATIONS["status.get"].output.parse({
      devices: [
        {
          physical: false,
          id: "dev_1",
          spec: { physical: false, platform: "ios", model: "iPhone 17", osVersion: "26.0" },
          mode: "full",
          servesDefaultMode: true,
          state: "leased",
          workerId: "wrk_1",
        },
      ],
      leases: [lease],
      capacity,
      daemon: {
        health: "running",
        mode: "gateway",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { os: "Linux", osVersion: "6.8.0", arch: "x64", tools: [] },
      queueDepth: 0,
      workers: [
        {
          id: "wrk_1",
          label: "mac-mini-1",
          connection: "connected",
          drained: false,
          lastSeenAt: 10,
          health: "running",
          version: "0.3.0",
          capacity,
          host: {
            os: "macOS",
            osVersion: "15.5",
            arch: "arm64",
            tools: [{ platform: "android", name: "emulator", version: "35.4.9" }],
          },
          queueDepth: 0,
          leases: [lease],
          devices: [],
          catalog: [
            {
              platform: "ios",
              models: ["iPhone 17"],
              runtimes: ["26.0"],
              modelAliases: {},
              classDefaults: {},
              modelClasses: {},
              modelRuntimes: { "iPhone 17": ["26.0"] },
            },
          ],
        },
        {
          id: "wrk_2",
          connection: "incompatible",
          drained: false,
          lastSeenAt: 11,
          protocol: { gateway: { min: 4, max: 4 }, worker: { min: 3, max: 3 } },
          leases: [],
          devices: [],
          catalog: [],
        },
      ],
    });
    expect(parsed.workers?.[1]?.protocol?.worker).toEqual({ min: 3, max: 3 });
    expect(parsed.workers?.[0]?.host?.tools[0]?.name).toBe("emulator");
    expect(parsed.devices?.[0]?.workerId).toBe("wrk_1");
    expect(parsed.leases?.[0]?.workerId).toBe("wrk_1");
  });

  it("catalog.get: round-trips a gateway's per-entry worker annotations (ADR 0005 §21)", () => {
    const parsed = OPERATIONS["catalog.get"].output.parse({
      platforms: [
        {
          platform: "ios",
          models: ["iPhone 17"],
          runtimes: ["26.0"],
          modelAliases: {},
          classDefaults: {},
          modelClasses: {},
          modelRuntimes: { "iPhone 17": ["26.0"] },
          modelWorkers: { "iPhone 17": ["wrk_1", "wrk_2"] },
          runtimeWorkers: { "26.0": ["wrk_1"] },
        },
      ],
    });
    expect(parsed.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_1", "wrk_2"] });
  });

  it("catalog.get rejects a platform entry without modelRuntimes", () => {
    const entry = {
      platform: "ios",
      models: ["iPhone 17"],
      runtimes: ["26.0"],
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
    };
    expect(() => OPERATIONS["catalog.get"].output.parse({ platforms: [entry] })).toThrow(
      /modelRuntimes/,
    );
    expect(() =>
      OPERATIONS["catalog.get"].output.parse({
        platforms: [{ ...entry, modelRuntimes: { "iPhone 17": ["26.0"] } }],
      }),
    ).not.toThrow();
  });

  it("catalog.get rejects an entry without modelClasses and one whose class is not one of the seven", () => {
    const entry = {
      platform: "ios",
      models: ["iPhone 17"],
      runtimes: ["26.0"],
      classDefaults: {},
      modelAliases: {},
      modelRuntimes: { "iPhone 17": ["26.0"] },
    };
    const parse = (modelClasses?: unknown) =>
      platformCatalogSchema.parse(modelClasses === undefined ? entry : { ...entry, modelClasses });

    expect(() => parse()).toThrow(/modelClasses/);
    expect(() => parse({ "iPhone 17": "phablet" })).toThrow(/modelClasses/);
    expect(() => parse({ ["x".repeat(257)]: "phone" })).toThrow(/modelClasses/);
    for (const deviceClass of ["phone", "tablet", "watch", "tv", "vision", "auto", "desktop"]) {
      expect(parse({ "iPhone 17": deviceClass }).modelClasses).toEqual({
        "iPhone 17": deviceClass,
      });
    }
  });

  it("catalog.get rejects a platform entry without modelAliases, and takes images as optional", () => {
    const entry = {
      platform: "android",
      models: ["Pixel 8"],
      runtimes: ["35"],
      classDefaults: {},
      modelClasses: {},
      modelRuntimes: { "Pixel 8": ["35"] },
    };
    expect(() => OPERATIONS["catalog.get"].output.parse({ platforms: [entry] })).toThrow(
      /modelAliases/,
    );
    const parsed = OPERATIONS["catalog.get"].output.parse({
      platforms: [
        {
          ...entry,
          modelAliases: { "Pixel 8": ["pixel_8"] },
          images: [{ runtime: "35", tag: "google_apis", abi: "arm64-v8a" }],
        },
      ],
    });
    expect(parsed.platforms[0]?.images).toEqual([
      { runtime: "35", tag: "google_apis", abi: "arm64-v8a" },
    ]);
  });

  it("catalog.get bounds every string and list in modelAliases, customModels, images, slimCategories and modes", () => {
    const base = {
      platform: "android",
      models: ["Pixel 8"],
      runtimes: ["35"],
      modelRuntimes: { "Pixel 8": ["35"] },
      modelAliases: {},
      classDefaults: {},
      modelClasses: {},
    };
    const image = { runtime: "35", tag: "google_apis", abi: "arm64-v8a" };
    const names = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`);
    const aliasedModels = (count: number) =>
      Object.fromEntries(names(count).map((name) => [name, ["a"]]));
    const classedModels = (count: number) =>
      Object.fromEntries(names(count).map((name) => [name, "phone"]));
    const bounds = [
      [
        { modelAliases: { ["x".repeat(256)]: ["a"] } },
        { modelAliases: { ["x".repeat(257)]: ["a"] } },
      ],
      [
        { modelAliases: { "Pixel 8": ["x".repeat(256)] } },
        { modelAliases: { "Pixel 8": ["x".repeat(257)] } },
      ],
      [{ modelAliases: { "Pixel 8": names(32) } }, { modelAliases: { "Pixel 8": names(33) } }],
      [{ modelAliases: aliasedModels(4096) }, { modelAliases: aliasedModels(4097) }],
      [
        { modelClasses: { ["x".repeat(256)]: "phone" } },
        { modelClasses: { ["x".repeat(257)]: "phone" } },
      ],
      [{ modelClasses: classedModels(4096) }, { modelClasses: classedModels(4097) }],
      [{ customModels: ["x".repeat(256)] }, { customModels: ["x".repeat(257)] }],
      [{ customModels: names(4096) }, { customModels: names(4097) }],
      [{ slimCategories: names(32) }, { slimCategories: names(33) }],
      [{ slimCategories: ["a" + "x".repeat(31)] }, { slimCategories: ["a" + "x".repeat(32)] }],
      [{ slimCategories: ["a-1"] }, { slimCategories: ["Store"] }],
      [{ defaultMode: "slim" }, { defaultMode: "lean" }],
      [{ modes: ["slim", "full"] }, { modes: [] }],
      [{ modes: ["slim", "full"] }, { modes: ["slim", "full", "slim"] }],
      [{ modes: ["slim"] }, { modes: ["lean"] }],
      [
        { images: [{ ...image, runtime: "x".repeat(128) }] },
        { images: [{ ...image, runtime: "x".repeat(129) }] },
      ],
      [
        { images: [{ ...image, tag: "x".repeat(128) }] },
        { images: [{ ...image, tag: "x".repeat(129) }] },
      ],
      [
        { images: [{ ...image, abi: "x".repeat(128) }] },
        { images: [{ ...image, abi: "x".repeat(129) }] },
      ],
      [
        { images: Array.from({ length: 1024 }, () => image) },
        { images: Array.from({ length: 1025 }, () => image) },
      ],
    ] as const;
    for (const [accepted, refused] of bounds) {
      const parse = (extra: object) =>
        OPERATIONS["catalog.get"].output.parse({ platforms: [{ ...base, ...extra }] });
      expect(() => parse(accepted)).not.toThrow();
      expect(() => parse(refused)).toThrow();
    }
  });

  it("worker.remove reports whether there was a view to forget; drain never lies", () => {
    // why: `remove` is idempotent: forgetting a worker the gateway has already forgotten is done,
    // not an error -- so `false` is a legitimate outcome, the same shape `token.revoke` uses.
    expect(OPERATIONS["worker.remove"].output.parse({ workerId: "wrk_1", removed: false })).toEqual(
      { workerId: "wrk_1", removed: false },
    );
    // why: Drain and undrain each report the state they establish, and only that state: an
    // `undrain` answering `drained: true` would be a contradiction rather than an outcome.
    expect(OPERATIONS["worker.drain"].output.parse({ workerId: "wrk_1", drained: true })).toEqual({
      workerId: "wrk_1",
      drained: true,
    });
    expect(() =>
      OPERATIONS["worker.drain"].output.parse({ workerId: "wrk_1", drained: false }),
    ).toThrow();
    expect(() =>
      OPERATIONS["worker.undrain"].output.parse({ workerId: "wrk_1", drained: true }),
    ).toThrow();
  });

  it("list.get: accepts each kind's array shape", () => {
    expect(OPERATIONS["list.get"].output.parse([])).toEqual([]);
    expect(OPERATIONS["list.get"].output.parse([{ name: "idle-shutdown" }])).toEqual([
      { name: "idle-shutdown" },
    ]);
  });

  it("device.exec: parses a command, keeps stdin optional, and refuses anything else", () => {
    // why: ADR 0005 §19a. `.strict()` is doing real work here: a client that sent `input` or `env`
    // hoping either would reach the child must be told no, not have it silently dropped.
    expect(
      OPERATIONS["device.exec"].input.parse({
        args: ["shell", "getprop"],
        leaseId: "lse_1",
        stdin: "y\n",
        tool: "adb",
      }),
    ).toEqual({ args: ["shell", "getprop"], leaseId: "lse_1", stdin: "y\n", tool: "adb" });

    expect(
      OPERATIONS["device.exec"].input.parse({ args: [], leaseId: "lse_1", tool: "simctl" }),
    ).toEqual({ args: [], leaseId: "lse_1", tool: "simctl" });

    // why: `tool` is an open string, exactly as `driver.passthrough`'s is: which wrappers exist is
    // the drivers' answer, so a name none of them wraps parses fine here and comes back as
    // `UNKNOWN_PASSTHROUGH_TOOL` from the driver catalog rather than as a malformed body.
    expect(
      OPERATIONS["device.exec"].input.parse({ args: [], leaseId: "lse_1", tool: "bash" }),
    ).toEqual({ args: [], leaseId: "lse_1", tool: "bash" });
    expect(() =>
      OPERATIONS["device.exec"].input.parse({ args: [], leaseId: "lse_1", tool: "" }),
    ).toThrow();
    expect(() =>
      OPERATIONS["device.exec"].input.parse({
        args: [],
        leaseId: "lse_1",
        tool: "simctl",
        env: {},
      }),
    ).toThrow();
    expect(() => OPERATIONS["device.exec"].input.parse({ args: [], tool: "simctl" })).toThrow();

    expect(OPERATIONS["device.exec"].output.parse({ exitCode: 0 })).toEqual({ exitCode: 0 });
  });

  it("device.rotate: accepts a leaseId and requesterId of 1 to 256 characters and each orientation, and refuses an empty or 257-character one, another orientation or an unknown key", () => {
    const parse = (input: object) => OPERATIONS["device.rotate"].input.parse(input);
    const base = { leaseId: "lse_1", orientation: "portrait" };

    for (const orientation of [
      "portrait",
      "portrait_upside_down",
      "landscape_left",
      "landscape_right",
    ]) {
      expect(parse({ ...base, orientation })).toEqual({ ...base, orientation });
    }
    expect(parse({ ...base, leaseId: "x".repeat(256), requesterId: "y".repeat(256) })).toEqual({
      ...base,
      leaseId: "x".repeat(256),
      requesterId: "y".repeat(256),
    });

    for (const refused of [
      { ...base, leaseId: "" },
      { ...base, leaseId: "x".repeat(257) },
      { ...base, requesterId: "" },
      { ...base, requesterId: "y".repeat(257) },
      { ...base, requesterId: "a\u001b[2Jb" },
      { ...base, orientation: "upside_down" },
      { ...base, angle: 90 },
    ]) {
      expect(() => parse(refused)).toThrow();
    }
  });

  it("baseline.remove: accepts a workerId of 1 to 128 characters, and refuses an empty or 129-character one, a non-string and an unknown key", () => {
    const parse = (input: object) => OPERATIONS["baseline.remove"].input.parse(input);
    const base = { name: "checkout" };

    expect(parse(base)).toEqual(base);
    for (const workerId of ["w", "x".repeat(128)]) {
      expect(parse({ ...base, workerId })).toEqual({ ...base, workerId });
    }
    for (const refused of [
      { ...base, workerId: "" },
      { ...base, workerId: "x".repeat(129) },
      { ...base, workerId: 7 },
      { ...base, worker: "wrk_a" },
    ]) {
      expect(() => parse(refused)).toThrow();
    }
  });

  it("the output push carries a frame id, a stream, and a chunk", () => {
    expect(PUSH_SCHEMAS.output.parse({ chunk: "hello", requestId: 7, stream: "stdout" })).toEqual({
      chunk: "hello",
      requestId: 7,
      stream: "stdout",
    });
    expect(() =>
      PUSH_SCHEMAS.output.parse({ chunk: "hello", requestId: 7, stream: "stdin" }),
    ).toThrow();
    expect(() => PUSH_SCHEMAS.output.parse({ chunk: "hello", stream: "stdout" })).toThrow();
  });

  it("the progress push carries the downloading stage with its component, whether it waits, and an optional whole percent", () => {
    const pushes = [
      { component: "26.4", stage: "downloading", waiting: true },
      { component: "26.4", percent: 41, stage: "downloading", waiting: false },
    ];
    for (const progress of pushes) {
      expect(PUSH_SCHEMAS.progress.parse({ progress, requestId: 7 })).toEqual({
        progress,
        requestId: 7,
      });
    }
  });

  it.each([
    ["a percent above 100", { percent: 101 }, { percent: 100 }],
    ["a percent below 0", { percent: -1 }, { percent: 0 }],
    ["a percent that is not whole", { percent: 41.7 }, { percent: 41 }],
    [
      "a component over 64 characters",
      { component: "x".repeat(65) },
      { component: "x".repeat(64) },
    ],
  ])("refuses a downloading progress push with %s", (_case, outside, inside) => {
    const base = { component: "26.4", stage: "downloading", waiting: false };
    const parse = (fields: object) =>
      PUSH_SCHEMAS.progress.safeParse({ progress: { ...base, ...fields }, requestId: 7 }).success;
    expect(parse(outside)).toBe(false);
    expect(parse(inside)).toBe(true);
  });

  it("config.get: round-trips a representative config, carries a driver's own keys under ios and android as sent, and refuses a platform section whose core keys are missing or wrong", () => {
    const config = {
      capabilities: {},
      mode: "worker",
      gateway: {
        disconnectedRetentionMs: 86_400_000,
        execTimeoutMs: 660_000,
        leaseRequestTimeoutMs: 300_000,
        routing: "warm-then-free",
        alerts: { destinations: [] },
        admission: { command: ["bun", "policy.ts"], timeoutMs: 5_000 },
      },
      capacity: { strategy: "fixed", config: { maxRunning: 4 } },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_000 },
      idle: { shutdownAfterMs: 1, deleteAfterMs: 2 },
      update: { check: true },
      warmPool: {
        enabled: true,
        maxConcurrentBoots: 1,
        reserveRunning: { android: 0, ios: 0 },
        targets: [],
        quarantine: {
          maxRetries: 1,
          retryBackoffMs: 1,
          retryBackoffMultiplier: 1,
          maxRetryBackoffMs: 1,
        },
      },
      devices: { autoEnroll: false, deletedRetentionMs: 1 },
      lease: {
        defaultTtlMs: 1,
        maxTtlMs: 1,
        identity: { ios: "fresh", android: "reusable" },
        requestRetentionMs: 1,
        endedIdRetentionMs: 1,
        maxRequestRecords: 1,
        maxPerRequester: 1,
        endWaitMs: 600_000,
      },
      exec: { timeoutMs: 1 },
      diskPressure: { freeBytesThreshold: 1 },
      memoryPressure: {
        clearAfterMs: 60_000,
        enabled: true,
        pauseNewDevices: { level: "critical", minAvailablePercent: 10 },
        pauseWarming: { level: "warn", minAvailablePercent: 20 },
      },
      drivers: {},
      eventBuffer: { capacity: 1 },
      log: { level: "info", rotateBytes: 1 },
      http: { enabled: false, host: "127.0.0.1", port: 4700 },
      health: {
        enabled: true,
        probeIntervalMs: 1,
        stableObservations: 1,
        maxRecoveryAttempts: 1,
        recoveryBackoffMs: 1,
        maxConcurrentRecoveries: 1,
      },
      ios: {
        defaultMode: "full",
        defaultModels: {},
        slim: { bootTimeoutMs: 1 },
        simulator: { audio: false, headless: false },
        aKeyOfALaterDriver: { nested: [1, "two"] },
      },
      android: {
        defaultModels: {},
        emulator: { headless: true, gpu: "host", audio: false, bootAnimation: false },
      },
      stalledTransition: { thresholdMultiplier: 1, minimumThresholdMs: 1 },
    };
    const output = OPERATIONS["config.get"].output;
    const parsed = output.parse(config);
    expect([parsed.ios, parsed.android]).toEqual([config.ios, config.android]);
    expect([
      output.safeParse({ ...config, ios: { ...config.ios, defaultMode: "fast" } }).success,
      output.safeParse({ ...config, android: { emulator: config.android.emulator } }).success,
      output.safeParse({ ...config, ios: { ...config.ios, modes: [] } }).success,
      output.safeParse({ ...config, ios: { ...config.ios, modes: ["slim", "full", "slim"] } })
        .success,
      output.safeParse({ ...config, ios: { ...config.ios, modes: ["lean"] } }).success,
    ]).toEqual([false, false, false, false, false]);
    expect(
      output.parse({ ...config, ios: { ...config.ios, modes: ["slim", "full"] } }).ios.modes,
    ).toEqual(["slim", "full"]);
    for (const maxPerRequester of [2, { ios: 2 }, { ios: 1, android: 1 }]) {
      const parsed = OPERATIONS["config.get"].output.parse({
        ...config,
        lease: { ...config.lease, maxPerRequester },
      });
      expect(parsed.lease.maxPerRequester).toEqual(maxPerRequester);
    }
  });

  it("config.get: keeps every warm target key and rejects a target with a platform or a mode the config loader would not accept", () => {
    const targets = [
      {
        count: 2,
        mode: "slim",
        model: "iPhone 17",
        osVersion: ">=18",
        platform: "ios",
      },
      { count: 1, mode: "full", model: "Pixel 9", platform: "android" },
    ];
    const warmPool = {
      targets,
      maxConcurrentBoots: 3,
      baselineLearnAfter: 5,
      refillDelayMs: 1500.5,
    };
    const output = OPERATIONS["config.get"].output;
    const base = {
      capabilities: {},
      mode: "worker",
      gateway: {
        disconnectedRetentionMs: 1,
        execTimeoutMs: 1,
        leaseRequestTimeoutMs: 1,
        routing: "warm-then-free",
        alerts: { destinations: [] },
        admission: { command: ["bun", "policy.ts"], timeoutMs: 5_000 },
      },
      capacity: { strategy: "fixed", config: { maxRunning: 4 } },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1 },
      idle: { shutdownAfterMs: 1, deleteAfterMs: 2 },
      update: { check: true },
      devices: { autoEnroll: false, deletedRetentionMs: 1 },
      lease: {
        defaultTtlMs: 1,
        maxTtlMs: 1,
        identity: { ios: "fresh", android: "reusable" },
        requestRetentionMs: 1,
        endedIdRetentionMs: 1,
        maxRequestRecords: 1,
        maxPerRequester: 1,
        endWaitMs: 600_000,
      },
      exec: { timeoutMs: 1 },
      drivers: {},
      diskPressure: { freeBytesThreshold: 1 },
      memoryPressure: {
        clearAfterMs: 60_000,
        enabled: true,
        pauseNewDevices: { level: "critical", minAvailablePercent: 10 },
        pauseWarming: { level: "warn", minAvailablePercent: 20 },
      },
      eventBuffer: { capacity: 1 },
      log: { level: "info", rotateBytes: 1 },
      http: { enabled: false, host: "127.0.0.1", port: 4700 },
      health: {
        enabled: true,
        probeIntervalMs: 1,
        stableObservations: 1,
        maxRecoveryAttempts: 1,
        recoveryBackoffMs: 1,
        maxConcurrentRecoveries: 1,
      },
      ios: { defaultMode: "full", defaultModels: {} },
      android: { defaultModels: {} },
      stalledTransition: { thresholdMultiplier: 1, minimumThresholdMs: 1 },
    };
    const config = (pool: object) => ({
      ...base,
      warmPool: {
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        quarantine: {
          maxRetries: 1,
          retryBackoffMs: 1,
          retryBackoffMultiplier: 1,
          maxRetryBackoffMs: 1,
        },
        ...pool,
      },
    });

    expect(output.parse(config(warmPool)).warmPool).toMatchObject(warmPool);
    expect(() =>
      output.parse(config({ ...warmPool, targets: [{ ...targets[0], platform: "tvos" }] })),
    ).toThrow();
    expect(() =>
      output.parse(config({ ...warmPool, targets: [{ ...targets[0], mode: "lean" }] })),
    ).toThrow();
    expect(() => output.parse(config({ maxConcurrentBoots: 1 }))).toThrow();
    const { refillDelayMs: _omitted, ...withoutDelay } = warmPool;
    expect(() => output.parse(config(withoutDelay))).toThrow();
    expect(() => output.parse(config({ targets: [] }))).toThrow();
  });

  it("config.get: bounds the drivers section's driver names, keys and string values, and takes strings, numbers and booleans", () => {
    const drivers = OPERATIONS["config.get"].output.shape.drivers;
    const long = (n: number) => "x".repeat(n);

    expect(
      drivers.safeParse({ [long(64)]: { [long(64)]: long(4096), n: 1, b: false } }).success,
    ).toBe(true);
    for (const refused of [
      { [long(65)]: { a: "x" } },
      { a: { [long(65)]: "x" } },
      { a: { k: long(4097) } },
      { a: { k: null } },
      { a: { k: ["x"] } },
    ]) {
      expect(drivers.safeParse(refused).success).toBe(false);
    }
  });

  it("status.get: rejects a RAM budget whose use is negative or not finite", () => {
    const shape = OPERATIONS["status.get"].output.shape.capacity.unwrap().shape.ramBudget;
    const budget = { limitBytes: 8, overLimit: false, usedBytes: 1 };

    expect(shape.parse(budget)).toEqual(budget);
    for (const usedBytes of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => shape.parse({ ...budget, usedBytes })).toThrow();
    }
    expect(() => shape.parse({ ...budget, limitBytes: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("config.get: carries each platform's defaultModels as lists of names per class, and refuses anything else", () => {
    const shape = OPERATIONS["config.get"].output.shape;
    const parse = (defaultModels: unknown) => ({
      ios: shape.ios.shape.defaultModels.safeParse(defaultModels),
      android: shape.android.shape.defaultModels.safeParse(defaultModels),
    });

    for (const parsed of Object.values(parse({ phone: ["iPhone 15", "iPhone 14"], tv: ["x"] }))) {
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ phone: ["iPhone 15", "iPhone 14"], tv: ["x"] });
    }
    for (const refused of [{ phone: [] }, { phone: [""] }, { fridge: ["x"] }, { phone: "x" }]) {
      expect(parse(refused).ios.success).toBe(false);
      expect(parse(refused).android.success).toBe(false);
    }
  });

  it("config.get: keeps both slim RAM sizes of the resource strategy when they are set", () => {
    const ramBudget = {
      androidBytesPerDevice: 4,
      androidSlimBytesPerDevice: 2,
      iosBytesPerDevice: 3,
      iosSlimBytesPerDevice: 1,
    };
    const capacity = {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
        ramBudget,
      },
    };
    const shape = OPERATIONS["config.get"].output.shape.capacity;

    expect(shape.parse(capacity)).toEqual(capacity);
  });
});
