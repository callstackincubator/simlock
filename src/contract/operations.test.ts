import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineOperation, OPERATIONS, type OperationName } from "./operations.js";
import { PUSH_SCHEMAS } from "./pushes.js";
import { ROLES, type Role } from "./roles.js";

describe("defineOperation", () => {
  it("returns the definition unchanged, typed from its zod schemas", () => {
    const echo = defineOperation({
      name: "test.echo",
      role: "agent",
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

  it("lease.request: rejects mode, which ADR 0004 removed from the contract", () => {
    expect(() =>
      OPERATIONS["lease.request"].input.parse({
        model: "iPhone 17 Pro",
        mode: "held",
        platform: "ios",
      }),
    ).toThrow();
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
      queueDepth: 0,
    };
    expect(OPERATIONS["status.get"].output.parse(status)).toBeDefined();
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
          state: "leased",
          workerId: "wrk_1",
        },
      ],
      leases: [lease],
      capacity,
      health: "running",
      queueDepth: 0,
      mode: "gateway",
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
          queueDepth: 0,
          leases: [lease],
          devices: [],
          catalog: [{ platform: "ios", models: ["iPhone 17"], runtimes: ["26.0"] }],
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
          modelWorkers: { "iPhone 17": ["wrk_1", "wrk_2"] },
          runtimeWorkers: { "26.0": ["wrk_1"] },
        },
      ],
    });
    expect(parsed.platforms[0]?.modelWorkers).toEqual({ "iPhone 17": ["wrk_1", "wrk_2"] });
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
      gateway: { disconnectedRetentionMs: 86_400_000, execTimeoutMs: 660_000 },
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
      lease: { defaultTtlMs: 1, maxTtlMs: 1 },
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
      ios: { slim: { enabled: false, bootTimeoutMs: 1 } },
      stalledTransition: { thresholdMultiplier: 1, minimumThresholdMs: 1 },
    };
    expect(OPERATIONS["config.get"].output.parse(config)).toBeDefined();
  });
});
