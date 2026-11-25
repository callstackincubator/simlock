import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OPERATIONS, requestedClass, requestedDevice, PUSH_SCHEMAS } from "./index.js";

describe("lease.request names a model, a class, or nothing (ADR 0015 §1)", () => {
  const input = OPERATIONS["lease.request"].input;

  it("refuses a request with both a class and a model, with a message naming the two fields", () => {
    const result = input.safeParse({ class: "phone", model: "iPhone 16", platform: "ios" });

    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join();
    expect(message).toContain("`model`");
    expect(message).toContain("`class`");
  });

  it("accepts a request with a class only, a model only, or neither", () => {
    expect(input.safeParse({ class: "tablet", platform: "ios" }).success).toBe(true);
    expect(input.safeParse({ model: "iPhone 16", platform: "ios" }).success).toBe(true);
    expect(input.safeParse({ platform: "ios" }).success).toBe(true);
  });

  it("refuses a class that is not one of the seven", () => {
    expect(input.safeParse({ class: "phablet", platform: "ios" }).success).toBe(false);
  });

  it("requestedDevice copies the class and leaves out the model a request did not name", () => {
    expect(requestedDevice(input.parse({ class: "watch", platform: "ios" }))).toStrictEqual({
      class: "watch",
      platform: "ios",
    });
    expect(requestedDevice(input.parse({ platform: "android" }))).toStrictEqual({
      platform: "android",
    });
    expect(requestedDevice(input.parse({ model: "Pixel 8", platform: "android" }))).toStrictEqual({
      model: "Pixel 8",
      platform: "android",
    });
  });

  it("requestedClass answers the class named, phone for neither field, and none for an exact model", () => {
    expect(requestedClass({ class: "tv" })).toBe("tv");
    expect(requestedClass({})).toBe("phone");
    expect(requestedClass({ model: "iPhone 16" })).toBeUndefined();
  });
});

describe("lease.request physical (ADR 0022)", () => {
  const input = OPERATIONS["lease.request"].input;

  it.each([
    ["mode", { mode: "slim" }],
    ["imageTag", { imageTag: "x" }],
    ["allowDownload", { allowDownload: true }],
  ])("a physical request with %s is BAD_REQUEST naming the field", (field, extra) => {
    expect(input.safeParse({ physical: true, platform: "ios" }).success).toBe(true);

    const result = input.safeParse({ ...extra, physical: true, platform: "ios" });

    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join();
    expect(message).toContain(`\`${field}\``);
  });

  it.each([
    ["mode", { mode: "slim" }],
    ["imageTag", { imageTag: "x" }],
    ["allowDownload", { allowDownload: true }],
  ])("a physical request with %s reports the issue at that field's path", (field, extra) => {
    const result = input.safeParse({ ...extra, physical: true, platform: "ios" });

    expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toStrictEqual([
      [field],
    ]);
  });

  it("a physical request with allowDownload false passes", () => {
    const result = input.safeParse({ allowDownload: false, physical: true, platform: "ios" });

    expect(result.success).toBe(true);
    expect(result.success ? (result.data as { physical?: boolean }).physical : undefined).toBe(
      true,
    );
  });

  it("requestedDevice carries physical true only when the input set it", () => {
    expect(requestedDevice(input.parse({ physical: true, platform: "ios" }))).toStrictEqual({
      physical: true,
      platform: "ios",
    });
    expect(requestedDevice(input.parse({ physical: false, platform: "ios" }))).toStrictEqual({
      platform: "ios",
    });
    expect(requestedDevice(input.parse({ platform: "ios" }))).toStrictEqual({ platform: "ios" });
  });
});

describe("status.get physicalQueueDepth (ADR 0022)", () => {
  const host = { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] };
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
  const capacity = {
    android: entry,
    global: { maxRunning: 1, overLimit: false, reserved: 0, running: 0, warm: 0 },
    ios: entry,
  };
  const output = OPERATIONS["status.get"].output;

  it("a status carries the physical line's depth beside the virtual one", () => {
    const parsed = output.parse({
      capacity,
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
      physicalQueueDepth: 1,
      queueDepth: 2,
    });

    expect(parsed.queueDepth).toBe(2);
    expect((parsed as { physicalQueueDepth?: number }).physicalQueueDepth).toBe(1);
  });

  it("a worker's entry in a gateway's status carries it too", () => {
    const parsed = output.parse({
      capacity,
      daemon: {
        health: "running",
        mode: "gateway",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host,
      leases: [],
      queueDepth: 0,
      workers: [
        {
          capacity,
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          health: "running",
          host,
          id: "wrk_1",
          label: "mac-mini-1",
          lastSeenAt: 10,
          leases: [],
          physicalQueueDepth: 1,
          queueDepth: 0,
          version: "0.3.0",
        },
      ],
    });

    expect(
      (parsed.workers?.[0] as { physicalQueueDepth?: number } | undefined)?.physicalQueueDepth,
    ).toBe(1);
  });
});

describe("device.add and device.remove ids (ADR 0022 §2)", () => {
  const long = "x".repeat(201);

  it.each([
    ["201 characters", long],
    ["a space", "00008110 001A2B3C4D5E"],
    ["a tab", "00008110\t001A2B3C4D5E"],
    ["a control character", "00008110\u0007001A2B3C4D5E"],
    ["a leading dash", "-00008110-001A2B3C4D5E"],
    ["nothing", ""],
  ])("refuses an id with %s", (_case, id) => {
    expect(OPERATIONS["device.add"].input.safeParse({ id, platform: "ios" }).success).toBe(false);
    expect(OPERATIONS["device.remove"].input.safeParse({ id }).success).toBe(false);
  });

  it("takes an id of exactly 200 characters, and refuses a field it does not declare", () => {
    const id = "x".repeat(200);

    expect(OPERATIONS["device.add"].input.safeParse({ id, platform: "ios" }).success).toBe(true);
    expect(
      OPERATIONS["device.add"].input.safeParse({ id: "A", platform: "ios", worker: "w1" }).success,
    ).toBe(false);
    expect(OPERATIONS["device.remove"].input.safeParse({ id: "A", yes: true }).success).toBe(false);
  });

  it.each([
    ["a unit separator", "A\u001fB"],
    ["a delete", "A\u007fB"],
    ["a C1 control", "A\u0080B"],
    ["the last C1 control", "A\u009fB"],
    ["a no-break space", "A\u00a0B"],
    ["a newline", "A\nB"],
  ])("refuses an id with %s", (_case, id) => {
    expect(OPERATIONS["device.remove"].input.safeParse({ id }).success).toBe(false);
  });

  it.each([
    ["a letter beyond ASCII", "caf\u00e9"],
    ["a dash inside", "A-B"],
    ["a tilde and an inverted exclamation mark", "A~\u00a1B"],
  ])("takes an id with %s", (_case, id) => {
    expect(OPERATIONS["device.remove"].input.safeParse({ id }).success).toBe(true);
  });

  it("says why an id is refused", () => {
    const messages = (id: string) =>
      OPERATIONS["device.remove"].input
        .safeParse({ id })
        .error?.issues.map((issue) => issue.message);

    expect(messages("A B")).toEqual(["must not contain whitespace or control characters"]);
    expect(messages("-A")).toEqual(["must not start with -"]);
  });

  it("declares device.add and device.remove with their names, outputs and strict inputs", () => {
    const output = {
      appCount: 3,
      class: "tablet",
      driverDeviceId: "U",
      id: "dev_1",
      model: "iPad",
      osVersion: "18",
      platform: "ios",
      reenrolled: true,
    };

    expect(OPERATIONS["device.add"].name).toBe("device.add");
    expect(OPERATIONS["device.remove"].name).toBe("device.remove");
    expect(OPERATIONS["device.add"].output.parse(output)).toEqual(output);
    expect(OPERATIONS["device.add"].output.safeParse({ ...output, class: "watch" }).success).toBe(
      false,
    );
    expect(OPERATIONS["device.add"].output.safeParse({ ...output, appCount: -1 }).success).toBe(
      false,
    );
    expect(OPERATIONS["device.remove"].output.parse({ driverDeviceId: "U", id: "U" })).toEqual({
      driverDeviceId: "U",
      id: "U",
    });
    expect(OPERATIONS["device.add"].input.safeParse({ id: "A" }).success).toBe(false);
    expect(OPERATIONS["device.add"].input.safeParse({ id: "A", platform: "windows" }).success).toBe(
      false,
    );
    expect(OPERATIONS["device.remove"].input.safeParse({}).success).toBe(false);
  });
});

describe("lease.request requires", () => {
  const base = { model: "iPhone 17", platform: "ios" } as const;
  const parse = (extra: Record<string, unknown>) =>
    OPERATIONS["lease.request"].input.safeParse({ ...base, ...extra });
  const names = (count: number) =>
    Array.from({ length: count }, (_, index) => `cap-${String(index)}`);

  it.each([
    ["one name", ["agent-device"]],
    ["an empty list", []],
    ["8 names", names(8)],
  ])("accepts %s", (_label, requires) => {
    expect(parse({ requires }).success).toBe(true);
  });

  it("accepts a request without requires, and one with requires: [] parses to the same device", () => {
    expect(parse({}).success).toBe(true);
    const input = parse({ requires: [] });
    expect(input.success && requestedDevice(input.data)).toEqual({
      model: "iPhone 17",
      platform: "ios",
    });
  });

  it.each([
    ["an upper-case name", ["Agent-Device"]],
    ["a duplicate name", ["agent-device", "agent-device"]],
    ["9 names", names(9)],
  ])("refuses requires with %s with BAD_REQUEST-shaped issues on requires", (_label, requires) => {
    const parsed = parse({ requires });

    expect(parsed.success).toBe(false);
    expect(
      !parsed.success && parsed.error.issues.every((issue) => issue.path[0] === "requires"),
    ).toBe(true);
  });

  it("accepts requires together with idempotencyKey, and still refuses a bad name beside the key", () => {
    expect(parse({ idempotencyKey: "key-1", requires: ["agent-device"] }).success).toBe(true);

    expect(parse({ idempotencyKey: "key-1", requires: ["Agent-Device"] }).success).toBe(false);
  });
});

describe("relay.request on a byte channel", () => {
  const request = {
    hasBody: false,
    headers: [],
    method: "GET",
    relayId: "r-1",
    target: "agent-device",
    tenant: "gw.g.a",
    url: "http://gateway.test/x",
  };
  const parse = (input: Record<string, unknown>) =>
    OPERATIONS["relay.request"].input.safeParse(input).success;

  it("accepts a channel of 1 to 32 characters of [A-Za-z0-9-] and refuses an empty, a 33-character and a bad-character one, and a request without one", () => {
    expect(parse({ ...request, channel: "a" })).toBe(true);
    expect(parse({ ...request, channel: "Ab-9".repeat(8) })).toBe(true);
    expect(parse({ ...request, channel: "" })).toBe(false);
    expect(parse({ ...request, channel: "a".repeat(33) })).toBe(false);
    expect(parse({ ...request, channel: "a b" })).toBe(false);
    expect(parse({ ...request, channel: "a_b" })).toBe(false);
    expect(parse(request)).toBe(false);
  });

  it("accepts twoWay with GET and no body, and refuses it with another method, with a body, or as false, where the same request without twoWay is accepted", () => {
    const channel = { ...request, channel: "a" };
    expect(parse({ ...channel, twoWay: true })).toBe(true);
    expect(parse({ ...channel, method: "POST" })).toBe(true);
    expect(parse({ ...channel, method: "POST", twoWay: true })).toBe(false);
    expect(parse({ ...channel, hasBody: true, method: "PUT" })).toBe(true);
    expect(parse({ ...channel, hasBody: true, method: "PUT", twoWay: true })).toBe(false);
    expect(parse({ ...channel, twoWay: false })).toBe(false);
  });

  it("OPERATIONS has no relay.body and PUSH_SCHEMAS has no relay-chunk", () => {
    expect(Object.keys(OPERATIONS)).not.toContain("relay.body");
    expect(Object.keys(PUSH_SCHEMAS)).not.toContain("relay-chunk");
    expect(Object.keys(PUSH_SCHEMAS)).toContain("relay-head");
  });
});

describe("usage.get input", () => {
  const parse = (input: unknown) => OPERATIONS["usage.get"].input.safeParse(input);
  const issues = (input: unknown) => {
    const result = parse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  const DAY = 24 * 60 * 60 * 1000;

  it("takes epoch milliseconds with from before to, up to ninety days apart, and names the bound it refuses", () => {
    expect(parse({ from: 0, to: 1 }).success).toBe(true);
    expect(parse({ from: 1_000, to: 1_000 + 90 * DAY }).success).toBe(true);
    expect(parse({ from: 1_000, to: 1_001 + 90 * DAY }).success).toBe(false);
    expect(parse({ from: 5, to: 5 }).success).toBe(false);
    expect(parse({ from: 6, to: 5 }).success).toBe(false);
    expect(issues({ from: 6, to: 5 })).toEqual(["from must be before to"]);
    expect(issues({ from: 0, to: 91 * DAY })).toEqual([
      "the window must not be longer than 90 days",
    ]);
  });

  it("refuses a bound that is not an integer, is negative, is above 8.64e15 or is a string, and takes the last date a Date holds", () => {
    expect(parse({ from: 8.64e15 - 1, to: 8.64e15 }).success).toBe(true);
    expect(parse({ from: 0.5, to: 10 }).success).toBe(false);
    expect(parse({ from: 0, to: 10.5 }).success).toBe(false);
    expect(parse({ from: -1, to: 10 }).success).toBe(false);
    expect(parse({ from: 8.64e15, to: 8.64e15 + 2 }).success).toBe(false);
    expect(parse({ from: "0", to: 10 }).success).toBe(false);
    expect(parse({ from: 0 }).success).toBe(false);
  });
});

describe("events.replay input", () => {
  const parse = (input: unknown) => OPERATIONS["events.replay"].input.safeParse(input);

  it("accepts beforeId and limit in bounds, and refuses limit 0, 501 and 1.5, a beforeId of evt_ or abc, and beforeId or limit with sinceTs; accepts a workerId of 1 to 128 characters with any of them, and refuses an empty one or 129", () => {
    expect(parse({ beforeId: "evt_abc", limit: 1 }).success).toBe(true);
    expect(parse({ limit: 500 }).success).toBe(true);
    expect(parse({ sinceTs: 5 }).success).toBe(true);
    for (const workerId of ["w", "w".repeat(128)]) {
      expect(parse({ workerId }).success).toBe(true);
      expect(parse({ limit: 5, workerId }).success).toBe(true);
      expect(parse({ sinceTs: 5, workerId }).success).toBe(true);
    }
    for (const workerId of ["", "w".repeat(129)]) expect(parse({ workerId }).success).toBe(false);

    for (const limit of [0, 501, 1.5]) expect(parse({ limit }).success).toBe(false);
    for (const beforeId of ["evt_", "abc"]) expect(parse({ beforeId }).success).toBe(false);
    expect(parse({ beforeId: "evt_abc", sinceTs: 5 }).success).toBe(false);
    expect(parse({ limit: 5, sinceTs: 5 }).success).toBe(false);
  });
});

describe("daemon.update", () => {
  const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
  const exactVersion = {
    type: "string",
    maxLength: 64,
    pattern: "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$",
  };
  const version = { type: "string", maxLength: 64 };
  const stateBase = {
    from: version,
    to: version,
    forced: { type: "boolean" },
    startedAt: { type: "integer", minimum: 0, maximum: 9007199254740991 },
  };
  const state = (stage: string, extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties: { stage: { type: "string", const: stage }, ...extra, ...stateBase },
    required: ["stage", ...Object.keys(extra), "from", "to", "forced", "startedAt"],
    additionalProperties: false,
  });

  it("keeps the input and the answer the shapes every daemon version accepts, because it is a frozen call", () => {
    expect(z.toJSONSchema(OPERATIONS["daemon.update"].input, { io: "input" })).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        version: exactVersion,
        force: { type: "boolean" },
        query: { type: "boolean" },
      },
    });
    expect(z.toJSONSchema(OPERATIONS["daemon.update"].output)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        started: { type: "boolean" },
        upToDate: { type: "boolean" },
        resolved: { anyOf: [exactVersion, { type: "null" }] },
        version,
        health: { type: "string", enum: ["starting", "running", "failed"] },
        update: {
          anyOf: [
            {
              oneOf: [
                state("waiting", {
                  leases: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                }),
                state("installing"),
                state("restarting"),
              ],
            },
            { type: "null" },
          ],
        },
        lastUpdateFailure: {
          anyOf: [
            {
              type: "object",
              properties: {
                stage: { type: "string", enum: ["installing", "restarting"] },
                from: version,
                to: version,
                message: { type: "string", maxLength: 2000 },
                at: { type: "integer", minimum: 0, maximum: 9007199254740991 },
              },
              required: ["stage", "from", "to", "message", "at"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        latestVersion: { anyOf: [version, { type: "null" }] },
      },
      required: [
        "started",
        "upToDate",
        "resolved",
        "version",
        "health",
        "update",
        "lastUpdateFailure",
        "latestVersion",
      ],
      additionalProperties: false,
    });
  });
});
