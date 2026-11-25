import { describe, expect, it } from "vitest";
import {
  OPERATIONS,
  type Effect,
  type OperationName,
  type OperationRole,
  requestedDevice,
  ROLES,
  roleAllows,
  type Role,
} from "./index.js";

const ROLE_MATRIX: ReadonlyArray<{
  readonly name: OperationName;
  readonly input: unknown;
  readonly role: OperationRole;
}> = [
  { name: "catalog.get", input: {}, role: "any" },
  { name: "status.get", input: {}, role: "any" },
  { name: "lease.request", input: { model: "iPhone 17", platform: "ios" }, role: "agent" },
  { name: "lease.cancel", input: {}, role: "agent" },
  { name: "lease.renew", input: { leaseId: "lease_1" }, role: "agent" },
  { name: "lease.release", input: { leaseId: "lease_1" }, role: "agent" },
  { name: "lease.list", input: {}, role: "any" },
  { name: "lease.get", input: { leaseId: "lse_1" }, role: "any" },
  { name: "doctor.run", input: { fix: false }, role: "agent" },
  { name: "doctor.run", input: {}, role: "agent" },
  { name: "doctor.run", input: { fix: true }, role: "admin" },
  { name: "doctor.run", input: { purgeOrphans: true }, role: "admin" },
  { name: "lease.release-all", input: {}, role: "admin" },
  { name: "lease.release-run", input: { runId: "nightly-7" }, role: "agent" },
  { name: "list.get", input: {}, role: "viewer" },
  { name: "cleanup.run", input: {}, role: "admin" },
  { name: "nuke.run", input: {}, role: "admin" },
  { name: "warm.forget", input: { model: "Pixel", platform: "android" }, role: "admin" },
  { name: "baseline.save", input: { leaseId: "L1", name: "checkout" }, role: "admin" },
  { name: "baseline.list", input: {}, role: "any" },
  { name: "baseline.remove", input: { name: "checkout" }, role: "admin" },
  { name: "config.get", input: {}, role: "viewer" },
  { name: "config.get", input: { showSecrets: false }, role: "viewer" },
  { name: "config.get", input: { showSecrets: true }, role: "admin" },
  { name: "daemon.stop", input: {}, role: "admin" },
  { name: "daemon.update", input: {}, role: "admin" },
  { name: "events.replay", input: {}, role: "viewer" },
  { name: "events.subscribe", input: {}, role: "viewer" },
  { name: "events.unsubscribe", input: {}, role: "viewer" },
  { name: "usage.get", input: { from: 0, to: 60_000 }, role: "viewer" },
  { name: "inbox.get", input: {}, role: "viewer" },
  { name: "token.create", input: { role: "agent" }, role: "admin" },
  { name: "driver.passthrough", input: { args: ["devices"], tool: "adb" }, role: "agent" },
  {
    name: "device.exec",
    input: { args: ["devices"], leaseId: "lease_1", tool: "adb" },
    role: "agent",
  },
  {
    name: "device.rotate",
    input: { leaseId: "lease_1", orientation: "landscape_left" },
    role: "agent",
  },
  { name: "identity.get", input: {}, role: "any" },
  { name: "token.list", input: {}, role: "viewer" },
  { name: "token.revoke", input: { id: "tok_1" }, role: "admin" },
  { name: "worker.list", input: {}, role: "viewer" },
  { name: "worker.drain", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "worker.undrain", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "worker.remove", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "worker.update", input: { workerId: "wrk_1" }, role: "admin" },
  { name: "component.install", input: { platform: "ios", version: "26.4" }, role: "admin" },
  { name: "component.list", input: {}, role: "any" },
  {
    name: "worker.install-component",
    input: { platform: "ios", version: "26.4", workers: "all" },
    role: "admin",
  },
  { name: "component.remove", input: { platform: "ios", version: "26.4" }, role: "admin" },
  { name: "device.add", input: { id: "00008110-001A2B3C4D5E", platform: "ios" }, role: "admin" },
  { name: "device.remove", input: { id: "00008110-001A2B3C4D5E" }, role: "admin" },
  {
    name: "relay.request",
    input: {
      hasBody: false,
      headers: [],
      method: "GET",
      relayId: "r-1",
      target: "agent-device",
      tenant: "gw.g.a",
      url: "http://gateway.test/x",
    },
    role: "admin",
  },
  { name: "relay.cancel", input: { relayId: "r-1" }, role: "admin" },
  { name: "alerts.test", input: { destination: "ops" }, role: "admin" },
];

const ALLOWED_BY_REQUIRED: Readonly<Record<OperationRole, readonly Role[]>> = {
  admin: ["admin"],
  agent: ["agent", "admin"],
  any: ["agent", "viewer", "admin"],
  viewer: ["viewer", "admin"],
};

describe("operation role matrix", () => {
  it("declares every operation the ADR's §3 matrix names", () => {
    const declaredNames = new Set(Object.keys(OPERATIONS));
    const matrixNames = new Set(ROLE_MATRIX.map((row) => row.name));
    expect(declaredNames).toEqual(matrixNames);
  });

  it.each(ROLE_MATRIX)("$name with $input resolves to role $role", ({ name, input, role }) => {
    const operation = OPERATIONS[name];
    const roleFn = operation.role as OperationRole | ((input: unknown) => OperationRole);
    const resolved = typeof roleFn === "function" ? roleFn(input) : roleFn;
    expect(resolved).toBe(role);
    expect(ROLES.filter((session) => roleAllows(session, resolved))).toEqual(
      ALLOWED_BY_REQUIRED[role],
    );
  });
});

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
  { name: "lease.get", input: { leaseId: "lse_1" }, effect: "read" },
  { name: "doctor.run", input: {}, effect: "read" },
  { name: "doctor.run", input: { fix: false }, effect: "read" },
  { name: "doctor.run", input: { fix: true }, effect: "write" },
  { name: "doctor.run", input: { purgeOrphans: true }, effect: "write" },
  { name: "lease.release-all", input: {}, effect: "write" },
  { name: "lease.release-run", input: { runId: "nightly-7" }, effect: "write" },
  { name: "list.get", input: {}, effect: "read" },
  { name: "cleanup.run", input: {}, effect: "write" },
  { name: "cleanup.run", input: { dryRun: false }, effect: "write" },
  { name: "cleanup.run", input: { dryRun: true }, effect: "read" },
  { name: "nuke.run", input: {}, effect: "write" },
  { name: "warm.forget", input: { model: "Pixel", platform: "android" }, effect: "write" },
  { name: "baseline.save", input: { leaseId: "L1", name: "checkout" }, effect: "write" },
  { name: "baseline.list", input: {}, effect: "read" },
  { name: "baseline.remove", input: { name: "checkout" }, effect: "write" },
  { name: "config.get", input: {}, effect: "read" },
  { name: "daemon.stop", input: {}, effect: "write" },
  { name: "daemon.update", input: {}, effect: "write" },
  { name: "events.replay", input: {}, effect: "read" },
  { name: "events.subscribe", input: {}, effect: "read" },
  { name: "events.unsubscribe", input: {}, effect: "read" },
  { name: "usage.get", input: { from: 0, to: 60_000 }, effect: "read" },
  { name: "inbox.get", input: {}, effect: "read" },
  { name: "token.create", input: { role: "agent" }, effect: "write" },
  { name: "driver.passthrough", input: { args: ["devices"], tool: "adb" }, effect: "read" },
  {
    name: "device.exec",
    input: { args: ["devices"], leaseId: "lease_1", tool: "adb" },
    effect: "write",
  },
  {
    name: "device.rotate",
    input: { leaseId: "lease_1", orientation: "landscape_left" },
    effect: "write",
  },
  { name: "identity.get", input: {}, effect: "read" },
  { name: "token.list", input: {}, effect: "read" },
  { name: "token.revoke", input: { id: "tok_1" }, effect: "write" },
  { name: "worker.list", input: {}, effect: "read" },
  { name: "worker.drain", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "worker.undrain", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "worker.remove", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "worker.update", input: { workerId: "wrk_1" }, effect: "write" },
  { name: "component.install", input: { platform: "ios", version: "26.4" }, effect: "write" },
  { name: "component.list", input: {}, effect: "read" },
  {
    name: "worker.install-component",
    input: { platform: "ios", version: "26.4", workers: "all" },
    effect: "write",
  },
  { name: "component.remove", input: { platform: "ios", version: "26.4" }, effect: "write" },
  { name: "device.add", input: { id: "00008110-001A2B3C4D5E", platform: "ios" }, effect: "write" },
  { name: "device.remove", input: { id: "00008110-001A2B3C4D5E" }, effect: "write" },
  {
    name: "relay.request",
    input: {
      hasBody: false,
      headers: [],
      method: "GET",
      relayId: "r-1",
      target: "agent-device",
      tenant: "gw.g.a",
      url: "http://gateway.test/x",
    },
    effect: "write",
  },
  { name: "relay.cancel", input: { relayId: "r-1" }, effect: "write" },
  { name: "alerts.test", input: { destination: "ops" }, effect: "write" },
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

  it.each(EFFECT_MATRIX)("$name with $input is a $effect", ({ name, input, effect }) => {
    expect(resolvedEffect(name, input)).toBe(effect);
  });
});

describe("worker.install-component input", () => {
  const parse = (input: Record<string, unknown>) =>
    OPERATIONS["worker.install-component"].input.safeParse({
      platform: "android",
      version: "35",
      ...input,
    }).success;

  it("accepts all workers, or 1 to 64 distinct worker ids", () => {
    expect(parse({ workers: "all" })).toBe(true);
    expect(parse({ workers: ["wrk_1"] })).toBe(true);
    expect(parse({ workers: Array.from({ length: 64 }, (_, index) => `wrk_${index}`) })).toBe(true);
  });

  it.each([
    ["no worker", []],
    ["65 workers", Array.from({ length: 65 }, (_, index) => `wrk_${index}`)],
    ["the same worker twice", ["wrk_1", "wrk_1"]],
    ["an empty worker id", [""]],
    ["a word other than all", "every"],
  ])("refuses a worker list that is %s", (_label, workers) => {
    expect(parse({ workers })).toBe(false);
  });

  it("checks the version with component.install's own schema", () => {
    expect(parse({ version: "-35", workers: "all" })).toBe(false);
    expect(parse({ version: "26 4", workers: "all" })).toBe(false);
    expect(parse({ version: "x".repeat(65), workers: "all" })).toBe(false);
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
    ["carrying ';', sdkmanager's package path separator", "35;extras"],
  ])("refuses a version that is %s", (_label, version) => {
    expect(parse(version)).toBe(false);
  });
});

describe("lease.request model", () => {
  const parse = (model: string) =>
    OPERATIONS["lease.request"].input.safeParse({ model, platform: "ios" });

  it("accepts a model of 256 characters and refuses one of 257, naming the field", () => {
    expect(parse("m".repeat(256)).success).toBe(true);
    const result = parse("m".repeat(257));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["model"]);
  });
});

describe("lease.request osVersion", () => {
  const parse = (osVersion: string) =>
    OPERATIONS["lease.request"].input.safeParse({
      model: "iPhone 17",
      osVersion,
      platform: "ios",
    });

  it.each([
    ["18.4"],
    ["17.4"],
    ["34"],
    ["18.5.1"],
    ["Baklava"],
    ["34-ext12"],
    ["x".repeat(64)],
    [">=18"],
    [">=18 <26"],
    ["18 - 26"],
  ])("accepts %s", (osVersion) => {
    expect(parse(osVersion).success).toBe(true);
  });

  it.each([["^18"], ["~18"], ["18.x"], ["18.X"], ["*"], [">=18 || <17"], [""]])(
    "refuses %j with a message naming the accepted forms",
    (osVersion) => {
      const result = parse(osVersion);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("18 - 26");
        expect(result.error.issues[0]?.path).toEqual(["osVersion"]);
      }
    },
  );

  it.each([
    ["trailing text after a space", "17.0 -foo"],
    ["a leading '-', like an option", "-1"],
    ["a ';', sdkmanager's package path separator", "34;extras"],
    ["more than 64 characters", "x".repeat(65)],
    ["a control character", "17.4\u0007"],
    ["a leading space", " 17.4"],
  ])(
    "refuses an exact version with %s, naming the bound a component version has",
    (_label, osVersion) => {
      const result = parse(osVersion);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toBe(
          "an exact OS version is 1 to 64 characters, none of them whitespace, a control character or `;`, and does not start with `-`",
        );
        expect(result.error.issues[0]?.path).toEqual(["osVersion"]);
      }
    },
  );
});

describe("lease.request leaseId", () => {
  const parse = (leaseId: unknown) =>
    OPERATIONS["lease.request"].input.safeParse({ leaseId, model: "iPhone 17", platform: "ios" });

  it.each([
    ["a plain ID", "myid"],
    ["a case-sensitive one", "MyID"],
    ["one with a hyphen and an underscore inside", "ad-7f3a_01"],
    ["one that looks like a generated ID", "lse_123"],
    ["a single character", "a"],
    ["a digit first", "7"],
    ["64 characters", "a".repeat(64)],
  ])("accepts %s", (_label, leaseId) => {
    expect(parse(leaseId).success).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["65 characters", "a".repeat(65)],
    ["a dot, kept for gateway IDs", "w1.myid"],
    ["a space", "my id"],
    ["a hyphen first", "-s"],
    ["an option", "--help"],
    ["an underscore first", "_x"],
    ["a character outside ASCII", "ząb"],
    ["a trailing newline", "myid\n"],
    ["a fullwidth digit", "\uFF11abc"],
    ["a number", 7],
    ["null", null],
  ])("refuses %s", (_label, leaseId) => {
    expect(parse(leaseId).success).toBe(false);
  });

  it("is optional, and an input without it parses to one without it", () => {
    expect(
      OPERATIONS["lease.request"].input.parse({ model: "iPhone 17", platform: "ios" }),
    ).toEqual({ model: "iPhone 17", platform: "ios" });
  });

  it("is not part of the device the request names", () => {
    const input = OPERATIONS["lease.request"].input.parse({
      leaseId: "myid",
      model: "iPhone 17",
      platform: "ios",
    });

    expect(requestedDevice(input)).toEqual({ model: "iPhone 17", platform: "ios" });
  });
});

describe("lease.request fleetRequestId", () => {
  const parse = (fleetRequestId: unknown) =>
    OPERATIONS["lease.request"].input.safeParse({
      fleetRequestId,
      model: "iPhone 17",
      noWait: true,
      platform: "ios",
    });

  it.each([
    ["a single character", "a"],
    ["a generated request id", "req_0f3a"],
    ["200 characters", "a".repeat(200)],
  ])("accepts %s", (_label, fleetRequestId) => {
    expect(parse(fleetRequestId).success).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["201 characters", "a".repeat(201)],
    ["a number", 7],
    ["null", null],
  ])("refuses %s", (_label, fleetRequestId) => {
    expect(parse(fleetRequestId).success).toBe(false);
  });

  it("is not part of the device the request names", () => {
    const input = OPERATIONS["lease.request"].input.parse({
      fleetRequestId: "req_1",
      model: "iPhone 17",
      noWait: true,
      platform: "ios",
    });

    expect(requestedDevice(input)).toEqual({ model: "iPhone 17", platform: "ios" });
  });
});

describe("lease.request metadata", () => {
  const parse = (metadata: unknown) =>
    OPERATIONS["lease.request"].input.safeParse({ metadata, platform: "ios" });
  const longKeys = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`${i}${"k".repeat(63)}`, "v".repeat(256)]),
    );

  it("a request's metadata is checked by the contract", () => {
    const accepted: ReadonlyArray<[string, unknown]> = [
      ["two keys", { project: "checkout-app", role: "ci" }],
      ["no keys", {}],
      ["an empty value", { project: "" }],
      ["16 keys", Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]))],
      ["a key of 64 characters", { ["k".repeat(64)]: "v" }],
      ["a value of 256 characters", { k: "v".repeat(256) }],
      ["exactly 2048 characters in all", { ...longKeys(6), k: "v".repeat(127) }],
    ];
    for (const [name, metadata] of accepted) {
      expect(parse(metadata).success, name).toBe(true);
    }

    const refused: ReadonlyArray<[string, unknown, string]> = [
      [
        "17 keys",
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])),
        "metadata has more than 16 keys",
      ],
      [
        "a key of 65 characters",
        { ["k".repeat(65)]: "v" },
        `metadata key must be 1 to 64 characters (got ${"k".repeat(65)})`,
      ],
      ["an empty key", { "": "v" }, "metadata key must be 1 to 64 characters (got )"],
      [
        "a value of 257 characters",
        { k: "v".repeat(257) },
        "metadata value for k must be at most 256 characters",
      ],
      [
        "2049 characters in all",
        { ...longKeys(6), k: "v".repeat(128) },
        "metadata is longer than 2048 characters in all",
      ],
    ];
    for (const [name, metadata, message] of refused) {
      const result = parse(metadata);
      expect(result.success, name).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.message),
        name,
      ).toEqual([message]);
    }

    const notText = parse({ n: 1 });
    expect(notText.success, "a value that is not text").toBe(false);
    expect(notText.error?.issues[0]?.path, "a value that is not text").toEqual(["metadata", "n"]);
  });
});
