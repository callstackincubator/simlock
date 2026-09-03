import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineOperation, OPERATIONS, type OperationName } from "./operations.js";
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
  { name: "lease.heartbeat", input: {}, role: "agent" },
  { name: "doctor.run", input: { fix: false }, role: "agent" },
  { name: "doctor.run", input: {}, role: "agent" },
  { name: "doctor.run", input: { fix: true }, role: "admin" },
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
  { name: "token.list", input: {}, role: "admin" },
  { name: "token.revoke", input: { id: "tok_1" }, role: "admin" },
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
  it("lease.request: round-trips a representative held request and rejects legacy aliases", () => {
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

  it("lease.request: rejects ttlMs on a held lease as a schema-level BAD_REQUEST", () => {
    expect(() =>
      OPERATIONS["lease.request"].input.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        mode: "held",
        ttlMs: 60_000,
      }),
    ).toThrow();
  });

  it("lease.request: accepts ttlMs on a detached lease", () => {
    expect(() =>
      OPERATIONS["lease.request"].input.parse({
        model: "iPhone 17 Pro",
        platform: "ios",
        mode: "detached",
        ttlMs: 60_000,
      }),
    ).not.toThrow();
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
      lease: {
        id: "lease_1",
        deviceId: "dev_1",
        requesterId: "req_1",
        mode: "held",
        grantedAt: 1,
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
      health: "running",
      queueDepth: 0,
    };
    expect(OPERATIONS["status.get"].output.parse(status)).toBeDefined();
  });

  it("list.get: accepts each kind's array shape", () => {
    expect(OPERATIONS["list.get"].output.parse([])).toEqual([]);
    expect(OPERATIONS["list.get"].output.parse([{ name: "idle-shutdown" }])).toEqual([
      { name: "idle-shutdown" },
    ]);
  });

  it("config.get: round-trips a representative config", () => {
    const config = {
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
      lease: { heldTtlBackstopMs: 1, detachedTtlMs: 1, heartbeatIntervalMs: 1 },
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
