import { describe, expect, it } from "vitest";

import {
  CODES_WITH_DECLARED_DETAILS,
  ERROR_TABLE,
  fromWireError,
  isSimlockError,
} from "./errors.js";

describe("SimlockError", () => {
  it("narrows details by code", () => {
    const error = fromWireError("REQUESTER_ALREADY_LEASED", "already leased", {
      requesterId: "agent-1",
      existingLeaseId: "lease_1",
    });
    expect(isSimlockError(error)).toBe(true);
    if (isSimlockError(error) && error.code === "REQUESTER_ALREADY_LEASED") {
      // Type-level assertion: this line only compiles if `details` narrowed.
      expect(error.details.existingLeaseId).toBe("lease_1");
      expect(error.details.requesterId).toBe("agent-1");
    } else {
      throw new Error("expected REQUESTER_ALREADY_LEASED");
    }
  });

  it("wraps an unrecognized code as UNKNOWN_DAEMON_ERROR instead of throwing", () => {
    const error = fromWireError("SOME_FUTURE_CODE", "a newer daemon said so");
    expect(isSimlockError(error)).toBe(true);
    expect(error.code).toBe("UNKNOWN_DAEMON_ERROR");
    if (error.code === "UNKNOWN_DAEMON_ERROR") {
      expect(error.details).toEqual({
        code: "SOME_FUTURE_CODE",
        message: "a newer daemon said so",
      });
    }
  });

  it.each(Object.values(ERROR_TABLE).map((entry) => [entry.code, entry.kind] as const))(
    "maps known code %s to its table entry's kind, %s",
    (code, kind) => {
      const error = fromWireError(code, "from the wire");
      expect({ code: error.code, kind: error.kind }).toEqual({ code, kind });
    },
  );

  it("narrows LEASE_ID_TAKEN's details to the ID, and answers it with exit 13 and HTTP 409 as a domain error", () => {
    const error = fromWireError("LEASE_ID_TAKEN", "lease ID ad-7f3a is already in use", {
      leaseId: "ad-7f3a",
    });
    if (error.code !== "LEASE_ID_TAKEN") throw new Error("expected LEASE_ID_TAKEN");

    expect(error.details.leaseId).toBe("ad-7f3a");
    expect(ERROR_TABLE.LEASE_ID_TAKEN).toEqual({
      cliExitCode: 13,
      code: "LEASE_ID_TAKEN",
      httpStatus: 409,
      kind: "domain",
    });
  });

  it("isSimlockError rejects a plain Error", () => {
    expect(isSimlockError(new Error("boom"))).toBe(false);
  });

  it("answers the three enrollment codes as domain errors: not enrollable 12 and 422, busy 11 and 409, unknown 12 and 404, each with declared details", () => {
    expect(ERROR_TABLE.DEVICE_NOT_ENROLLABLE).toEqual({
      cliExitCode: 12,
      code: "DEVICE_NOT_ENROLLABLE",
      httpStatus: 422,
      kind: "domain",
    });
    expect(ERROR_TABLE.DEVICE_BUSY).toEqual({
      cliExitCode: 11,
      code: "DEVICE_BUSY",
      httpStatus: 409,
      kind: "domain",
    });
    expect(ERROR_TABLE.UNKNOWN_DEVICE).toEqual({
      cliExitCode: 12,
      code: "UNKNOWN_DEVICE",
      httpStatus: 404,
      kind: "domain",
    });
    for (const code of ["DEVICE_NOT_ENROLLABLE", "DEVICE_BUSY", "UNKNOWN_DEVICE"] as const) {
      expect(CODES_WITH_DECLARED_DETAILS.has(code)).toBe(true);
    }
  });
});

describe("CAPABILITY_MISSING", () => {
  it("maps CAPABILITY_MISSING to HTTP 422 and CLI exit 12 as a domain error whose details name the capabilities", () => {
    const table: Record<string, unknown> = ERROR_TABLE;
    const error = fromWireError("CAPABILITY_MISSING", "This worker cannot serve agent-device", {
      capabilities: ["agent-device"],
    });

    expect(table["CAPABILITY_MISSING"]).toEqual({
      cliExitCode: 12,
      code: "CAPABILITY_MISSING",
      httpStatus: 422,
      kind: "domain",
    });
    expect(error).toMatchObject({
      code: "CAPABILITY_MISSING",
      details: { capabilities: ["agent-device"] },
      kind: "domain",
    });
  });
});
