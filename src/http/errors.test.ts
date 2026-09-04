import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  InsufficientDiskSpaceError,
  LicenseNotAcceptedError,
  NoCapacityError,
  NoDriverError,
  RequesterAlreadyLeasedError,
  RuntimeMissingError,
  UnknownLeaseError,
  UnknownModelError,
} from "../core/index.js";
import { classifyError, StartupFailedError } from "../daemon/error-code.js";
import { DoctorUnavailableError, NukeUnavailableError } from "../daemon/dispatcher.js";
import { ERROR_TABLE } from "../contract/index.js";
import {
  errorResponse,
  HttpApiError,
  mapError,
  NO_CAPACITY_RETRY_AFTER_SECONDS,
} from "./errors.js";

describe("mapError", () => {
  it("passes an HttpApiError's own status/code/extra through unchanged", () => {
    const error = new HttpApiError(403, "FORBIDDEN", "nope", { requesterId: "req-1" });
    expect(mapError(error)).toEqual({
      code: "FORBIDDEN",
      extra: { requesterId: "req-1" },
      message: "nope",
      status: 403,
    });
  });

  it("maps RequesterAlreadyLeasedError to 409, naming the existing lease when there is one", () => {
    const withLease = mapError(new RequesterAlreadyLeasedError("agent-1", "lse_1"));
    expect(withLease.status).toBe(409);
    expect(withLease.code).toBe("REQUESTER_ALREADY_LEASED");
    expect(withLease.extra).toEqual({ existingLeaseId: "lse_1" });

    const withoutLease = mapError(new RequesterAlreadyLeasedError("agent-1"));
    expect(withoutLease.extra).toBeUndefined();
  });

  it("maps NoCapacityError to 503", () => {
    expect(mapError(new NoCapacityError())).toMatchObject({ code: "NO_CAPACITY", status: 503 });
  });

  it("maps UnknownModelError, RuntimeMissingError, NoDriverError to 422", () => {
    expect(mapError(new UnknownModelError("ios", "iPhone 3G"))).toMatchObject({
      code: "UNKNOWN_MODEL",
      status: 422,
    });
    expect(mapError(new RuntimeMissingError("ios", "9.0"))).toMatchObject({
      code: "RUNTIME_MISSING",
      status: 422,
    });
    expect(mapError(new NoDriverError("android"))).toMatchObject({
      code: "NO_DRIVER",
      status: 422,
    });
  });

  it("maps UnknownLeaseError to 404", () => {
    expect(mapError(new UnknownLeaseError("lse_missing"))).toMatchObject({
      code: "UNKNOWN_LEASE",
      status: 404,
    });
  });

  // Review finding B5: these four previously fell through `mapError`'s own hand-written
  // `instanceof` chain (which didn't have branches for them) to 500 INTERNAL, while the socket
  // transport's `errorCode` (now `classifyError`, shared by both) reported the real code. Each
  // assertion below is checked against `ERROR_TABLE` directly -- the single source both
  // transports now read -- rather than a hardcoded status, so this test would fail if the table
  // and `mapError` ever drifted again.
  it("agrees with the socket transport's classifyError for every core error it recognizes, reading ERROR_TABLE for the HTTP status", () => {
    const cases: readonly [unknown, string][] = [
      [new InsufficientDiskSpaceError("ios", 8 * 1024 ** 3, 0), "INSUFFICIENT_DISK_SPACE"],
      [
        new LicenseNotAcceptedError("android", "system-images;android-35;google_apis"),
        "LICENSE_NOT_ACCEPTED",
      ],
      [new StartupFailedError(), "DAEMON_STARTUP_FAILED"],
      [new DoctorUnavailableError(), "DOCTOR_UNAVAILABLE"],
      [new NukeUnavailableError(), "NUKE_UNAVAILABLE"],
    ];
    for (const [error, expectedCode] of cases) {
      expect(classifyError(error)).toBe(expectedCode);
      const mapped = mapError(error);
      expect(mapped.code).toBe(expectedCode);
      expect(mapped.status).toBe(ERROR_TABLE[expectedCode as keyof typeof ERROR_TABLE].httpStatus);
      expect(mapped.status).not.toBe(500);
    }
  });

  it("collapses an unrecognized error to 500 INTERNAL without leaking its message", () => {
    const mapped = mapError(new Error("some internal implementation detail, e.g. a stack frame"));
    expect(mapped).toEqual({ code: "INTERNAL", message: "Internal error", status: 500 });
  });

  it("collapses a non-Error thrown value the same way", () => {
    expect(mapError("boom")).toEqual({ code: "INTERNAL", message: "Internal error", status: 500 });
  });
});

describe("errorResponse", () => {
  function appWithError(error: unknown) {
    const app = new Hono();
    app.get("/boom", (c) => errorResponse(c, error));
    return app;
  }

  it("writes the standard {error:{code,message}} body", async () => {
    const response = await appWithError(new UnknownLeaseError("lse_1")).request("/boom");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "UNKNOWN_LEASE", message: "Unknown lease: lse_1" },
    });
  });

  it("includes extra fields (e.g. existingLeaseId) alongside code/message", async () => {
    const response = await appWithError(
      new RequesterAlreadyLeasedError("agent-1", "lse_9"),
    ).request("/boom");
    expect(await response.json()).toEqual({
      error: {
        code: "REQUESTER_ALREADY_LEASED",
        existingLeaseId: "lse_9",
        message: expect.any(String),
      },
    });
  });

  it("sets Retry-After on a NO_CAPACITY response", async () => {
    const response = await appWithError(new NoCapacityError()).request("/boom");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(String(NO_CAPACITY_RETRY_AFTER_SECONDS));
  });

  it("never includes a stack trace for an unrecognized error", async () => {
    const response = await appWithError(new Error("leaked?")).request("/boom");
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("leaked?");
  });
});
