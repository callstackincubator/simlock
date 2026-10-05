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

  it("HISTORY_NOT_KEPT is a domain error with exit code 12, HTTP status 422, and the oldest held time in its details", () => {
    expect(ERROR_TABLE.HISTORY_NOT_KEPT).toEqual({
      cliExitCode: 12,
      code: "HISTORY_NOT_KEPT",
      httpStatus: 422,
      kind: "domain",
    });

    const error = fromWireError("HISTORY_NOT_KEPT", "not kept", { oldestTs: 42 });

    expect(error.code).toBe("HISTORY_NOT_KEPT");
    if (error.code === "HISTORY_NOT_KEPT") expect(error.details.oldestTs).toBe(42);
    else throw new Error("expected HISTORY_NOT_KEPT");
    expect(CODES_WITH_DECLARED_DETAILS.has("HISTORY_NOT_KEPT")).toBe(true);
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

  it("isSimlockError rejects a plain Error", () => {
    expect(isSimlockError(new Error("boom"))).toBe(false);
  });
});
