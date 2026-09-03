import { describe, expect, it } from "vitest";

import { ERROR_TABLE, fromWireError, isSimlockError, SimlockError } from "./errors.js";

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

  it("maps every known code to its table entry's kind", () => {
    const error = fromWireError("NO_CAPACITY", "no capacity");
    expect(error.kind).toBe("domain");
  });

  it("isSimlockError rejects a plain Error", () => {
    expect(isSimlockError(new Error("boom"))).toBe(false);
  });

  it("every table entry's code matches its own key", () => {
    for (const [key, entry] of Object.entries(ERROR_TABLE)) {
      expect(entry.code).toBe(key);
    }
  });

  it("constructs directly with typed details", () => {
    const error = new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", {
      leaseId: "lease_9",
    });
    expect(error.details.leaseId).toBe("lease_9");
  });
});
