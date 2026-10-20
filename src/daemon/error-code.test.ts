import { describe, expect, it } from "vitest";

import { AdminAuthenticationFailedError } from "../auth/index.js";
import { ComponentInstallerClosedError, UnsupportedRequestOptionError } from "../core/index.js";
import {
  LeaseIdTakenError,
  NoCapacityError,
  ProvisionFailedError,
  ReplayedLeaseRequestError,
} from "../leasing/index.js";
import { classifyError, describeLeaseRequestFailure } from "./error-code.js";

describe("describeLeaseRequestFailure", () => {
  it("stores a classified failure with its code and its own message", () => {
    expect(describeLeaseRequestFailure(new NoCapacityError())).toEqual({
      code: "NO_CAPACITY",
      message: "No device capacity is currently available",
    });
  });

  it("stores a twice-failed provision as PROVISION_FAILED with the driver's message", () => {
    expect(
      describeLeaseRequestFailure(new ProvisionFailedError(new Error("simulator exited"))),
    ).toEqual({ code: "PROVISION_FAILED", message: "simulator exited" });
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

describe("classifyError on a component install", () => {
  it("answers DAEMON_STOPPING for an install the daemon's stop ended", () => {
    expect(classifyError(new ComponentInstallerClosedError())).toBe("DAEMON_STOPPING");
  });
});

describe("classifyError on a request option the driver does not have", () => {
  it("answers BAD_REQUEST for UnsupportedRequestOptionError, and stores it with its own message", () => {
    const error = new UnsupportedRequestOptionError("ios", "imageTag");

    expect(classifyError(error)).toBe("BAD_REQUEST");
    expect(describeLeaseRequestFailure(error)).toEqual({
      code: "BAD_REQUEST",
      message: "ios lease requests do not take imageTag",
    });
  });
});

describe("classifyError on a lease ID that is in use", () => {
  it("answers LEASE_ID_TAKEN for LeaseIdTakenError", () => {
    expect(classifyError(new LeaseIdTakenError("ad-7f3a"))).toBe("LEASE_ID_TAKEN");
  });
});

describe("classifyError on a rejected admin credential", () => {
  it("answers ADMIN_AUTHENTICATION_FAILED for the error src/auth throws", () => {
    expect(classifyError(new AdminAuthenticationFailedError())).toBe("ADMIN_AUTHENTICATION_FAILED");
  });
});
