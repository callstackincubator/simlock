import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineOperation, OPERATIONS, type Effect, type OperationName } from "./operations.js";
import { PUSH_SCHEMAS } from "./pushes.js";
import { ROLES, type Role } from "./roles.js";

describe("defineOperation", () => {
  it("returns the definition unchanged, typed from its zod schemas", () => {
    const echo = defineOperation({
      name: "test.echo",
      role: "agent",
      effect: "read",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    });
    expect(echo.input.parse({ value: "hi" })).toEqual({ value: "hi" });
    expect(echo.output.parse({ value: "hi" })).toEqual({ value: "hi" });
    expect(echo.role).toBe("agent");
  });
});

/**
 * The ADR §3 operation matrix, name -> role. A table-driven test against this makes
 * "forgetting a role" (or getting one wrong) a test failure, not just a type-level one --
 * `doctor.run` gets two rows since its role is a function of `fix`.
 */
const ROLE_MATRIX: ReadonlyArray<{
  readonly name: OperationName;
  readonly input: unknown;
  readonly role: Role;
}> = [
  { name: "catalog.get", input: {}, role: "agent" },
  { name: "status.get", input: {}, role: "agent" },
  { name: "lease.request", input: { model: "iPhone 17", platform: "ios" }, role: "agent" },
  { name: "lease.cancel", input: {}, role: "agent" },
  { name: "lease.renew", input: { leaseId: "lease_1" }, role: "agent" },
  { name: "lease.release", input: { leaseId: "lease_1" }, role: "agent" },
  { name: "lease.list", input: {}, role: "agent" },
  { name: "doctor.run", input: { fix: false }, role: "agent" },
  { name: "doctor.run", input: {}, role: "agent" },
  { name: "doctor.run", input: { fix: true }, role: "admin" },
  { name: "doctor.run", input: { purgeOrphans: true }, role: "admin" },
  { name: "lease.release-all", input: {}, role: "admin" },
  { name: "list.get", input: {}, role: "admin" },
  { name: "cleanup.run", input: {}, role: "admin" },
  { name: "nuke.run", input: {}, role: "admin" },
  { name: "config.get", input: {}, role: "admin" },
  { name: "daemon.stop", input: {}, role: "admin" },
  { name: "events.replay", input: {}, role: "admin" },
  { name: "events.subscribe", input: {}, role: "admin" },
  { name: "events.unsubscribe", input: {}, role: "admin" },
  { name: "token.create", input: { role: "agent" }, role: "admin" },
  { name: "driver.passthrough", input: { args: ["devices"], tool: "adb" }, role: "agent" },
  {
    name: "device.exec",
    input: { args: ["devices"], leaseId: "lease_1", tool: "adb" },
    role: "agent",
  },
  { name: "token.list", input: {}, role: "admin" },
  { name: "token.revoke", input: { id: "tok_1" }, role: "admin" },
  // ADR 0005 §8/§23: gateway-only, admin throughout.
  { name: "worker.list", input: {}, role: "admin" },
  { name: "worker.drain", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "worker.undrain", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "worker.remove", input: { workerId: "wrk_1" }, role: "admin" },
  // ADR 0010 §6: an operator's consent to a download.
  { name: "component.install", input: { platform: "ios", version: "26.4" }, role: "admin" },
];

describe("operation role matrix", () => {
  it("declares every operation the ADR's §3 matrix names", () => {
    const declaredNames = new Set(Object.keys(OPERATIONS));
    const matrixNames = new Set(ROLE_MATRIX.map((row) => row.name));
    expect(declaredNames).toEqual(matrixNames);
  });

  it("only ever resolves to one of the two declared roles", () => {
    for (const row of ROLE_MATRIX) expect(ROLES).toContain(row.role);
  });

  it.each(ROLE_MATRIX)("$name with $input resolves to role $role", ({ name, input, role }) => {
    const operation = OPERATIONS[name];
    const roleFn = operation.role as Role | ((input: unknown) => Role);
    const resolved = typeof roleFn === "function" ? roleFn(input) : roleFn;
    expect(resolved).toBe(role);
  });
});

/** Which calls change state: the daemon log records a `write` at its default level and a
 * `read` only at `debug`. Rows keyed like `ROLE_MATRIX`, input-dependent ones twice. */
const EFFECT_MATRIX: ReadonlyArray<{
  readonly name: OperationName;
  readonly input: unknown;
  readonly effect: Effect;
}> = [
  { name: "catalog.get", input: {}, effect: "read" },
  { name: "status.get", input: {}, effect: "read" },
  { name: "lease.request", input: { model: "iPhone 17", platform: "ios" }, effect: "write" },
  { name: "lease.cancel", input: {}, effect: "write" },
  { name: "lease.renew", input: { leaseId: "lease_1" }, effect: "write" },
  { name: "lease.release", input: { leaseId: "lease_1" }, effect: "write" },
  { name: "lease.list", input: {}, effect: "read" },
  { name: "doctor.run", input: {}, effect: "read" },
  { name: "doctor.run", input: { fix: false }, effect: "read" },
  { name: "doctor.run", input: { fix: true }, effect: "write" },
  { name: "doctor.run", input: { purgeOrphans: true }, effect: "write" },
  { name: "lease.release-all", input: {}, effect: "write" },
  { name: "list.get", input: {}, effect: "read" },
  { name: "cleanup.run", input: {}, effect: "write" },
  { name: "cleanup.run", input: { dryRun: false }, effect: "write" },
  { name: "cleanup.run", input: { dryRun: true }, effect: "read" },
  { name: "nuke.run", input: {}, effect: "write" },
  { name: "config.get", input: {}, effect: "read" },
  { name: "daemon.stop", input: {}, effect: "write" },
  { name: "events.replay", input: {}, effect: "read" },
  { name: "events.subscribe", input: {}, effect: "read" },
  { name: "events.unsubscribe", input: {}, effect: "read" },
  { name: "token.create", input: { role: "agent" }, effect: "write" },
  { name: "driver.passthrough", input: { args: ["devices"], tool: "adb" }, effect: "read" },
  {
    name: "device.exec",
    input: { args: ["devices"], leaseId: "lease_1", tool: "adb" },
    effect: "write",
  },
  { name: "token.list", input: {}, effect: "read" },
  { name: "token.revoke", input: { id: "tok_1" }, effect: "write" },
  { name: "worker.list", input: {}, effect: "read" },
  { name: "worker.drain", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "worker.undrain", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "worker.remove", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "component.install", input: { platform: "ios", version: "26.4" }, effect: "write" },
];

function resolvedEffect(name: OperationName, input: unknown): unknown {
  const effect = OPERATIONS[name].effect as Effect | ((input: unknown) => Effect) | undefined;
  return typeof effect === "function" ? effect(OPERATIONS[name].input.parse(input)) : effect;
}

describe("operation effects", () => {
  it("every operation declares an effect", () => {
    for (const name of Object.keys(OPERATIONS) as OperationName[]) {
      expect(["read", "write"], name).toContain(
        resolvedEffect(name, EFFECT_MATRIX.find((row) => row.name === name)?.input),
      );
    }
    expect(new Set(EFFECT_MATRIX.map((row) => row.name))).toEqual(new Set(Object.keys(OPERATIONS)));
  });

  it("doctor.run is a write only with fix or purgeOrphans, and cleanup.run is a read only with dryRun", () => {
    expect(resolvedEffect("doctor.run", {})).toBe("read");
    expect(resolvedEffect("doctor.run", { fix: true })).toBe("write");
    expect(resolvedEffect("doctor.run", { purgeOrphans: true })).toBe("write");
    expect(resolvedEffect("cleanup.run", {})).toBe("write");
    expect(resolvedEffect("cleanup.run", { dryRun: true })).toBe("read");
  });

  it.each(EFFECT_MATRIX)("$name with $input is a $effect", ({ name, input, effect }) => {
    expect(resolvedEffect(name, input)).toBe(effect);
  });
});

describe("component.install input", () => {
  const parse = (version: string) =>
    OPERATIONS["component.install"].input.safeParse({ platform: "android", version }).success;

  it("accepts a version as the catalog lists it, up to 64 characters", () => {
    expect(parse("35")).toBe(true);
    expect(parse("26.4")).toBe(true);
    expect(parse("x".repeat(64))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["longer than 64 characters", "x".repeat(65)],
    ["a space", "26 4"],
    ["a tab", "26\t4"],
    ["a newline", "35\n"],
    ["a control character", "35\u0000"],
    ["starting with '-', like an option", "-35"],
  ])("refuses a version that is %s", (_label, version) => {
    expect(parse(version)).toBe(false);
  });
});

describe("operation input/output round trips", () => {
  it("lease.request: round-trips a representative request and rejects legacy aliases", () => {
    const input = OPERATIONS["lease.request"].input.parse({
      model: "iPhone 17 Pro",
      platform: "ios",
      osVersion: "18.0",
    });
    expect(input).toMatchObject({ model: "iPhone 17 Pro", platform: "ios", osVersion: "18.0" });

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
    // The upper bound (`lease.maxTtlMs`) is the dispatcher's to enforce -- it is a daemon
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

  it("lease.request: round-trips a representative output grant", () => {
    const grant = {
      device: {
        id: "dev_1",
        driverDeviceId: "sim-1",
        spec: { platform: "ios", model: "iPhone 17 Pro", osVersion: "18.0" },
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

  it("lease.request: rejects a malformed input (missing model)", () => {
    expect(() => OPERATIONS["lease.request"].input.parse({ platform: "ios" })).toThrow();
  });

  it("doctor.run: round-trips a driver-advisory finding", () => {
    const report = {
      findings: [{ kind: "driver-advisory", platform: "ios", code: "slim-disabled", message: "x" }],
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
    expect(OPERATIONS["doctor.run"].output.parse({ findings: [finding] })).toEqual({
      findings: [finding],
    });
    const { remedy: _remedy, ...withoutRemedy } = finding;
    expect(() => OPERATIONS["doctor.run"].output.parse({ findings: [withoutRemedy] })).toThrow();
  });

  it("status.get: round-trips a representative status snapshot", () => {
    const status = {
      devices: [],
      leases: [],
      capacity: {
        ios: {
          running: 0,
          maxRunning: 1,
          reserved: 0,
          overLimit: false,
          limit: 1,
          warm: 0,
          used: 0,
        },
        android: {
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
      daemon: { health: "running", mode: "worker" },
      host: {
        os: "macOS",
        osVersion: "15.5",
        arch: "arm64",
        tools: [{ platform: "ios", name: "xcode", version: "16.4", build: "16F6" }],
      },
      queueDepth: 0,
    };
    expect(OPERATIONS["status.get"].output.parse(status)).toBeDefined();
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
      daemon: { health: "running", mode: "gateway" },
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

  it("status.get: round-trips a gateway's aggregate, workers and all (ADR 0005 §20)", () => {
    const capacityEntry = {
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
      workerId: "wrk_1",
    };
    const parsed = OPERATIONS["status.get"].output.parse({
      devices: [
        {
          id: "dev_1",
          spec: { platform: "ios", model: "iPhone 17", osVersion: "26.0" },
          mode: "full",
          state: "leased",
          workerId: "wrk_1",
        },
      ],
      leases: [lease],
      capacity,
      daemon: { health: "running", mode: "gateway" },
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
    expect(parsed.devices[0]?.workerId).toBe("wrk_1");
    expect(parsed.leases[0]?.workerId).toBe("wrk_1");
  });

  it("catalog.get: round-trips a gateway's per-entry worker annotations (ADR 0005 §21)", () => {
    const parsed = OPERATIONS["catalog.get"].output.parse({
      platforms: [
        {
          platform: "ios",
          models: ["iPhone 17"],
          runtimes: ["26.0"],
          modelAliases: {},
          modelRuntimes: { "iPhone 17": ["26.0"] },
          modelWorkers: { "iPhone 17": ["wrk_1", "wrk_2"] },
          runtimeWorkers: { "26.0": ["wrk_1"] },
        },
      ],
    });
    expect(parsed.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_1", "wrk_2"] });
  });

  it("catalog.get rejects a platform entry without modelRuntimes", () => {
    const entry = { platform: "ios", models: ["iPhone 17"], runtimes: ["26.0"], modelAliases: {} };
    expect(() => OPERATIONS["catalog.get"].output.parse({ platforms: [entry] })).toThrow(
      /modelRuntimes/,
    );
    expect(() =>
      OPERATIONS["catalog.get"].output.parse({
        platforms: [{ ...entry, modelRuntimes: { "iPhone 17": ["26.0"] } }],
      }),
    ).not.toThrow();
  });

  it("catalog.get rejects a platform entry without modelAliases, and takes images as optional", () => {
    const entry = {
      platform: "android",
      models: ["Pixel 8"],
      runtimes: ["35"],
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

  it("catalog.get bounds every string and list in modelAliases and images", () => {
    const base = {
      platform: "android",
      models: ["Pixel 8"],
      runtimes: ["35"],
      modelRuntimes: { "Pixel 8": ["35"] },
      modelAliases: {},
    };
    const image = { runtime: "35", tag: "google_apis", abi: "arm64-v8a" };
    const names = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`);
    const aliasedModels = (count: number) =>
      Object.fromEntries(names(count).map((name) => [name, ["a"]]));
    // Each pair is the largest value accepted and the smallest one refused.
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
    // `remove` is idempotent: forgetting a worker the gateway has already forgotten is done,
    // not an error -- so `false` is a legitimate outcome, the same shape `token.revoke` uses.
    expect(OPERATIONS["worker.remove"].output.parse({ workerId: "wrk_1", removed: false })).toEqual(
      { workerId: "wrk_1", removed: false },
    );
    // Drain and undrain each report the state they establish, and only that state: an
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
    // ADR 0005 §19a. `.strict()` is doing real work here: a client that sent `input` or `env`
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

    // `tool` is an open string, exactly as `driver.passthrough`'s is: which wrappers exist is
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

  it("the output push carries a frame id, a stream, and a chunk", () => {
    // The `output` family is request-scoped exactly like `progress` (ADR 0005 §19a), which is
    // the property that lets one connection run more than one command at a time.
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

  it("config.get: round-trips a representative config", () => {
    const config = {
      mode: "worker",
      gateway: {
        disconnectedRetentionMs: 86_400_000,
        execTimeoutMs: 660_000,
        leaseRequestTimeoutMs: 300_000,
        routing: "warm-then-free",
      },
      capacity: { strategy: "fixed", config: { maxRunning: 4 } },
      downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_000 },
      idle: { shutdownAfterMs: 1, deleteAfterMs: 2 },
      warmPool: {
        quarantine: {
          maxRetries: 1,
          retryBackoffMs: 1,
          retryBackoffMultiplier: 1,
          maxRetryBackoffMs: 1,
        },
      },
      lease: {
        defaultTtlMs: 1,
        maxTtlMs: 1,
        identity: { ios: "fresh", android: "reusable" },
        requestRetentionMs: 1,
        maxRequestRecords: 1,
      },
      exec: { timeoutMs: 1 },
      diskPressure: { freeBytesThreshold: 1 },
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
      ios: { defaultMode: "full", slim: { bootTimeoutMs: 1 } },
      android: { emulator: { headless: true, gpu: "host", audio: false, bootAnimation: false } },
      stalledTransition: { thresholdMultiplier: 1, minimumThresholdMs: 1 },
    };
    expect(OPERATIONS["config.get"].output.parse(config)).toBeDefined();
  });

  it("status.get: rejects a RAM budget whose use is negative or not finite", () => {
    const shape = OPERATIONS["status.get"].output.shape.capacity.shape.ramBudget;
    const budget = { limitBytes: 8, overLimit: false, usedBytes: 1 };

    expect(shape.parse(budget)).toEqual(budget);
    for (const usedBytes of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => shape.parse({ ...budget, usedBytes })).toThrow();
    }
    expect(() => shape.parse({ ...budget, limitBytes: Number.POSITIVE_INFINITY })).toThrow();
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
