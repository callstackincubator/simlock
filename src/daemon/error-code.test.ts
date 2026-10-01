import { describe, expect, it } from "vitest";

import { NoCapacityError, ReplayedLeaseRequestError } from "../core/index.js";
import { classifyError, describeLeaseRequestFailure } from "./error-code.js";

describe("describeLeaseRequestFailure", () => {
  it("stores a classified failure with its code and its own message", () => {
    expect(describeLeaseRequestFailure(new NoCapacityError())).toEqual({
      code: "NO_CAPACITY",
      message: "No device capacity is currently available",
    });
  });

  it("stores an unclassified failure as INTERNAL without its own message", () => {
    expect(describeLeaseRequestFailure(new Error("/Users/someone/secret/path exploded"))).toEqual({
      code: "INTERNAL",
      message: "Internal error",
    });
  });
});

describe("classifyError on a replayed lease request", () => {
  it("answers with the stored code when the contract knows it", () => {
    expect(classifyError(new ReplayedLeaseRequestError("NO_CAPACITY", "full"))).toBe("NO_CAPACITY");
  });

  it("answers INTERNAL for a stored code the contract does not know", () => {
    expect(classifyError(new ReplayedLeaseRequestError("NOT_A_CODE", "edited by hand"))).toBe(
      "INTERNAL",
    );
  });
});
