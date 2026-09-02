import type { Context } from "hono";

import {
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  RuntimeMissingError,
  UnknownLeaseError,
  UnknownModelError,
} from "../core/index.js";

/** Every status this gateway ever answers with; keeps `mapError` exhaustive by construction. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;

/**
 * Uniform `{status, code}` pair a route or middleware raises directly (auth, ownership,
 * validation, not-found on gateway-owned resources like lease requests). Thrown core errors
 * are mapped separately by `mapError` -- this class is for facts only the HTTP layer knows.
 */
export class HttpApiError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpApiError";
  }
}

export function unauthenticated(message: string): HttpApiError {
  return new HttpApiError(401, "UNAUTHENTICATED", message);
}

export function forbidden(message: string): HttpApiError {
  return new HttpApiError(403, "FORBIDDEN", message);
}

export function badRequest(message: string): HttpApiError {
  return new HttpApiError(400, "BAD_REQUEST", message);
}

export function unknownRequest(id: string): HttpApiError {
  return new HttpApiError(404, "UNKNOWN_REQUEST", `Unknown lease request: ${id}`);
}

export function unknownLease(id: string): HttpApiError {
  return new HttpApiError(404, "UNKNOWN_LEASE", `Unknown lease: ${id}`);
}

export function requestNotCancellable(
  message: string,
  extra?: Record<string, unknown>,
): HttpApiError {
  return new HttpApiError(409, "REQUEST_NOT_CANCELLABLE", message, extra);
}

/** No core signal carries a better estimate; a fixed value is honest about that. */
export const NO_CAPACITY_RETRY_AFTER_SECONDS = 5;

export interface MappedError {
  readonly status: HttpStatus;
  readonly code: string;
  readonly message: string;
  readonly extra?: Record<string, unknown>;
}

/**
 * Maps a thrown error to the response shape the issue's error table specifies. Never echoes
 * a stack trace; an error this function doesn't recognize collapses to 500 `INTERNAL` with a
 * generic message rather than leaking implementation detail into the response body.
 */
// fallow-ignore-next-line complexity -- one exhaustive table beats scattering this mapping across routes.
export function mapError(error: unknown): MappedError {
  if (error instanceof HttpApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.extra === undefined ? {} : { extra: error.extra }),
    };
  }
  if (error instanceof RequesterAlreadyLeasedError) {
    return {
      status: 409,
      code: "REQUESTER_ALREADY_LEASED",
      message: error.message,
      ...(error.existingLeaseId === undefined
        ? {}
        : { extra: { existingLeaseId: error.existingLeaseId } }),
    };
  }
  if (error instanceof NoCapacityError) {
    return { status: 503, code: "NO_CAPACITY", message: error.message };
  }
  if (error instanceof UnknownModelError) {
    return { status: 422, code: "UNKNOWN_MODEL", message: error.message };
  }
  if (error instanceof RuntimeMissingError) {
    return { status: 422, code: "RUNTIME_MISSING", message: error.message };
  }
  if (error instanceof NoDriverError) {
    return { status: 422, code: "NO_DRIVER", message: error.message };
  }
  if (error instanceof UnknownLeaseError) {
    return { status: 404, code: "UNKNOWN_LEASE", message: error.message };
  }
  // Neither of these is expected to reach a route handler as a live rejection -- the tracker
  // consumes both internally and turns them into a terminal request state -- but map them
  // rather than falling through to INTERNAL if that invariant is ever wrong.
  if (error instanceof QueueTimeoutError) {
    return { status: 500, code: "QUEUE_TIMEOUT", message: error.message };
  }
  if (error instanceof RequestCancelledError) {
    return { status: 500, code: "REQUEST_CANCELLED", message: error.message };
  }
  return { status: 500, code: "INTERNAL", message: "Internal error" };
}

/** Writes `mapError`'s result as the standard `{"error":{...}}` body, plus `Retry-After` for NO_CAPACITY. */
export function errorResponse(c: Context, error: unknown): Response {
  const mapped = mapError(error);
  const response = c.json(
    { error: { code: mapped.code, message: mapped.message, ...mapped.extra } },
    mapped.status,
  );
  if (mapped.code === "NO_CAPACITY") {
    response.headers.set("Retry-After", String(NO_CAPACITY_RETRY_AFTER_SECONDS));
  }
  return response;
}
