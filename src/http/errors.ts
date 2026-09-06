import type { Context } from "hono";

import { RequestCancelledError, RequesterAlreadyLeasedError } from "../core/index.js";
import { classifyError } from "../daemon/error-code.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { ERROR_TABLE, type SimlockErrorCode } from "../contract/index.js";

/** Every status this gateway ever answers with; keeps `mapError` exhaustive by construction.
 * 504 is `EXEC_TIMEOUT`'s (ADR 0005 §19e): a `device.exec` command the daemon killed for
 * outrunning `exec.timeoutMs` is the one case where what this gateway was waiting on never
 * finished, which is exactly what a gateway timeout says. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503 | 504;

/**
 * Uniform `{status, code}` pair a route or middleware raises directly (auth, ownership,
 * validation, not-found on gateway-owned resources like lease requests). Thrown core errors
 * are mapped separately by `mapError` -- this class is for facts only the HTTP layer knows.
 *
 * `UNAUTHENTICATED`, `UNKNOWN_LEASE_REQUEST`, `REQUEST_NOT_CANCELLABLE`, and
 * `REQUEST_CANCELLED` (below) are gateway-local codes with no row in the contract's closed
 * `SimlockErrorCode` union (`src/contract/errors.ts`) -- ADR §7's "a code the client does not
 * know wraps as `UNKNOWN_DAEMON_ERROR`" applies here: a typed client built against the contract
 * cannot narrow on any of these four today, only on the raw string inside
 * `UNKNOWN_DAEMON_ERROR`'s `details`. See `docs/known-pitfalls.md` ("HTTP error codes outside
 * the closed contract union") for the exact rows this needs.
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

/** Gateway-local code for "no such lease-*request* resource" (`POST /v1/lease-requests`, ADR
 * §11's HTTP-only envelope kept until #72). Deliberately **not** `UNKNOWN_REQUEST` -- that code
 * is the contract's (`src/contract/errors.ts`), meaning "unknown operation name" at 400
 * (`DispatchError` in `dispatcher.ts`, thrown for a request naming an operation the dispatcher
 * has no handler for). Reusing it here for a different resource at a different status (404)
 * meant a client branching on `error.code` alone could not tell "no such request id" from "no
 * such operation" -- ADR §7 makes codes contract, not message text (S8). `UNKNOWN_LEASE_REQUEST`
 * is outside the contract's closed union like `UNAUTHENTICATED`/`REQUEST_NOT_CANCELLABLE`/
 * `REQUEST_CANCELLED` below; see `docs/known-pitfalls.md` for what a closed-union fix would
 * need. */
export function unknownRequest(id: string): HttpApiError {
  return new HttpApiError(404, "UNKNOWN_LEASE_REQUEST", `Unknown lease request: ${id}`);
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

/** Looks a code up in `ERROR_TABLE`, defensively -- every code `classifyError` returns is a
 * real key by construction, except `DispatchError`'s (a runtime-supplied string, trusted but
 * not verified -- see `dispatcher.ts`); this is the one guard against that ever indexing to
 * `undefined` and throwing instead of degrading to `INTERNAL`. */
function tableEntry(code: SimlockErrorCode): (typeof ERROR_TABLE)[SimlockErrorCode] {
  return (
    (ERROR_TABLE as Record<string, (typeof ERROR_TABLE)[SimlockErrorCode]>)[code] ??
    ERROR_TABLE.INTERNAL
  );
}

/**
 * Maps a thrown error to the response shape the issue's error table specifies. Never echoes
 * a stack trace; an error this function doesn't recognize collapses to 500 `INTERNAL` with a
 * generic message rather than leaking implementation detail into the response body.
 *
 * ADR 0003 §7: "CLI exit codes and HTTP status codes are columns of the same error table, not
 * second mappings." `classifyError` (shared with the socket transport's `errorCode` in
 * `daemon/server.ts`) is the one place that turns a thrown error into a `SimlockErrorCode`; this
 * function's own job is only to read `ERROR_TABLE`'s `httpStatus` column for whatever code comes
 * back -- never a second, HTTP-only guess. Review finding B5: before `classifyError` existed,
 * this function had its own hand-written `instanceof` chain for the core domain errors, and it
 * silently drifted from the socket transport's -- `InsufficientDiskSpaceError`,
 * `LicenseNotAcceptedError`, a startup-convergence failure, and doctor/nuke unavailability all
 * fell through to `INTERNAL` here while the socket reported the real code.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof HttpApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.extra === undefined ? {} : { extra: error.extra }),
    };
  }
  // Never sent over the wire (see `wait-queue.ts`) and has no `ERROR_TABLE` row of its own --
  // the tracker consumes it internally and turns it into a terminal request state, so this is
  // purely defensive: map it rather than falling through to a generic `INTERNAL` if that
  // invariant is ever wrong.
  if (error instanceof RequestCancelledError) {
    return { status: 500, code: "REQUEST_CANCELLED", message: error.message };
  }
  const code = classifyError(error) ?? "INTERNAL";
  const recognized = code !== "INTERNAL" || error instanceof DispatchError;
  const entry = tableEntry(code);
  const extra =
    error instanceof RequesterAlreadyLeasedError && error.existingLeaseId !== undefined
      ? { existingLeaseId: error.existingLeaseId }
      : undefined;
  return {
    status: entry.httpStatus as HttpStatus,
    code: entry.code,
    message: recognized && error instanceof Error ? error.message : "Internal error",
    ...(extra === undefined ? {} : { extra }),
  };
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
