import { describe, expect, it } from "vitest";

import {
  helloRequestSchema,
  LEGACY_DAEMON_PROTOCOL_VERSION,
  mapLegacyProtocolMismatch,
  negotiateProtocolVersion,
  normalizeProtocolVersion,
  PROTOCOL_VERSION_RANGE,
} from "./protocol.js";

describe("negotiateProtocolVersion", () => {
  it("picks the highest version present in both ranges", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
    expect(negotiateProtocolVersion({ min: 3, max: 3 }, { min: 3, max: 3 })).toBe(3);
  });

  it("returns undefined when the ranges do not overlap", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 3, max: 4 })).toBeUndefined();
  });
});

describe("normalizeProtocolVersion", () => {
  it("treats a bare number as {n, n}", () => {
    expect(normalizeProtocolVersion(2)).toEqual({ min: 2, max: 2 });
  });

  it("passes a range through unchanged", () => {
    expect(normalizeProtocolVersion({ min: 1, max: 3 })).toEqual({ min: 1, max: 3 });
  });
});

describe("mapLegacyProtocolMismatch", () => {
  it("reports the daemon range as {2, 2} and an unknown daemon version", () => {
    const error = mapLegacyProtocolMismatch(
      PROTOCOL_VERSION_RANGE,
      "Protocol version 3 is not supported",
    );
    expect(error.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    expect(error.details).toEqual({
      client: PROTOCOL_VERSION_RANGE,
      daemon: { min: LEGACY_DAEMON_PROTOCOL_VERSION, max: LEGACY_DAEMON_PROTOCOL_VERSION },
      daemonVersion: "unknown",
    });
  });
});

describe("helloRequestSchema", () => {
  it("accepts a bare legacy protocolVersion with no range", () => {
    expect(() =>
      helloRequestSchema.parse({ clientVersion: "1.0.0", protocolVersion: 3 }),
    ).not.toThrow();
  });

  it("accepts a range with no legacy protocolVersion", () => {
    expect(() =>
      helloRequestSchema.parse({ clientVersion: "1.0.0", protocolRange: { min: 3, max: 3 } }),
    ).not.toThrow();
  });

  it("rejects hello with neither protocolVersion nor protocolRange", () => {
    expect(() => helloRequestSchema.parse({ clientVersion: "1.0.0" })).toThrow();
  });
});
