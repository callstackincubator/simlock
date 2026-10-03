import { describe, expect, it } from "vitest";

import { ERROR_TABLE, fromWireError, isSimlockError } from "./errors.js";

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

  it("isSimlockError rejects a plain Error", () => {
    expect(isSimlockError(new Error("boom"))).toBe(false);
  });
});
