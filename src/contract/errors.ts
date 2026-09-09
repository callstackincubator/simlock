/**
 * One error class, a closed set of codes, typed details (ADR 0003 §7).
 *
 * `kind` is `transport` (unavailable, connection lost, startup timeout), `protocol` (version,
 * handshake, bad request, forbidden, authentication), or `domain` (capacity, unknown lease,
 * runtime missing, ...). `cliExitCode`/`httpStatus` are columns of the same table, per the
 * ADR's explicit instruction -- not a second mapping a CLI or HTTP frontend maintains on its
 * own. Nothing in this repo consumes those two columns yet; they land in later PRs (the CLI
 * still has its own `DAEMON_ERROR_EXIT_CODES` map and HTTP its own `mapError`, both untouched
 * by this PR -- wiring them to this table is follow-up work called out in the PR description).
 */
import type { Platform } from "./schemas.js";

export type ErrorKind = "transport" | "protocol" | "domain";

/** Per-code `details` shapes. `Record<string, never>` means "no details, an empty object". */
export interface ErrorDetailsMap {
  // -- protocol --
  BAD_FRAME: Record<string, never>;
  HANDSHAKE_REQUIRED: Record<string, never>;
  BAD_REQUEST: Record<string, never>;
  UNKNOWN_REQUEST: Record<string, never>;
  /** ADR §6. Reported by the daemon on a failed `hello` range negotiation, and constructed by
   * a client mapping a legacy protocol-2 daemon's exact-match mismatch onto this shape. */
  PROTOCOL_VERSION_UNSUPPORTED: {
    readonly client: { readonly min: number; readonly max: number };
    readonly daemon: { readonly min: number; readonly max: number };
    readonly daemonVersion: string;
  };
  /** ADR §5. Not yet thrown anywhere in this PR -- the credential handshake is PR 2 -- but
   * part of the closed set from the start, per the ADR's explicit instruction. */
  ADMIN_AUTHENTICATION_FAILED: Record<string, never>;
  /** ADR §2 (dispatcher role check). Not yet thrown -- PR 2 -- declared for the same reason. */
  FORBIDDEN: Record<string, never>;

  // -- transport --
  DAEMON_STOPPING: Record<string, never>;
  DAEMON_STARTUP_FAILED: Record<string, never>;
  DAEMON_CONNECTION_LOST: Record<string, never>;

  // -- domain --
  NO_CAPACITY: Record<string, never>;
  QUEUE_TIMEOUT: { readonly requestId: string };
  REQUESTER_ALREADY_LEASED: { readonly requesterId: string; readonly existingLeaseId?: string };
  NO_DRIVER: { readonly platform: Platform };
  RUNTIME_MISSING: {
    readonly platform: Platform;
    readonly osVersion: string;
    readonly downloadable: boolean;
  };
  UNKNOWN_MODEL: { readonly platform: Platform; readonly model: string };
  INSUFFICIENT_DISK_SPACE: {
    readonly platform: Platform;
    readonly requiredBytes: number;
    readonly availableBytes: number;
  };
  LICENSE_NOT_ACCEPTED: { readonly platform: Platform; readonly componentName: string };
  UNKNOWN_LEASE: { readonly leaseId: string };
  /** A `simlock <tool>` verb the owning driver will not proxy (ADR 0001, decision 7). Carries
   * the tool so a caller can say which wrapper refused without re-parsing the message. */
  PASSTHROUGH_REFUSED: { readonly tool: string };
  /** No registered driver answers to that `simlock <tool>` wrapper -- either the name is wrong
   * or the platform's driver refused to start. */
  UNKNOWN_PASSTHROUGH_TOOL: { readonly tool: string };
  /**
   * ADR 0005 §19e: a `device.exec` command outran `exec.timeoutMs` and was killed. No details:
   * the timeout that applied is already in the message, and a client that wants the
   * configured value reads `config.get`. `domain`, not `transport` -- nothing about the
   * connection failed; the command did.
   */
  EXEC_TIMEOUT: Record<string, never>;
  DOCTOR_UNAVAILABLE: Record<string, never>;
  NUKE_UNAVAILABLE: Record<string, never>;
  INTERNAL: Record<string, never>;

  /** ADR §7's forward-compatibility escape hatch: a code the client does not know (a newer
   * daemon) wraps as this instead of throwing a parse failure. Never sent by a daemon this
   * version of the contract can produce -- purely a client-side wrapping target. */
  UNKNOWN_DAEMON_ERROR: { readonly code: string; readonly message: string };

  /** ADR §10: the outcome `requestLease`'s `AbortSignal` surfaces for all four abort paths.
   * Never sent by the daemon over the wire -- purely a client-side construction, the same way
   * `UNKNOWN_DAEMON_ERROR` is. Kept in the closed set (rather than a separate ad hoc class) so
   * callers can `isSimlockError(e) && e.code === "CANCELLED"` exactly like any other outcome. */
  CANCELLED: Record<string, never>;
}

export type SimlockErrorCode = keyof ErrorDetailsMap;

export interface ErrorTableEntry<Code extends SimlockErrorCode = SimlockErrorCode> {
  readonly code: Code;
  readonly kind: ErrorKind;
  /** Guessed/placeholder for codes that have no existing CLI mapping today -- see the module
   * comment. Existing values (e.g. `NO_CAPACITY: 11`) are taken verbatim from
   * `src/cli/index.ts`'s `DAEMON_ERROR_EXIT_CODES`. */
  readonly cliExitCode: number;
  /** Same caveat as `cliExitCode` -- existing values taken from `src/http/errors.ts`'s
   * `mapError`. */
  readonly httpStatus: number;
}

// fallow-ignore-next-line complexity -- one exhaustive table is the point (ADR §7: "columns of
// the same error table, not second mappings").
export const ERROR_TABLE: { readonly [Code in SimlockErrorCode]: ErrorTableEntry<Code> } = {
  BAD_FRAME: { code: "BAD_FRAME", kind: "protocol", cliExitCode: 2, httpStatus: 400 },
  HANDSHAKE_REQUIRED: {
    code: "HANDSHAKE_REQUIRED",
    kind: "protocol",
    cliExitCode: 1,
    httpStatus: 400,
  },
  BAD_REQUEST: { code: "BAD_REQUEST", kind: "protocol", cliExitCode: 2, httpStatus: 400 },
  UNKNOWN_REQUEST: { code: "UNKNOWN_REQUEST", kind: "protocol", cliExitCode: 2, httpStatus: 400 },
  PROTOCOL_VERSION_UNSUPPORTED: {
    code: "PROTOCOL_VERSION_UNSUPPORTED",
    kind: "protocol",
    cliExitCode: 1,
    httpStatus: 400,
  },
  ADMIN_AUTHENTICATION_FAILED: {
    code: "ADMIN_AUTHENTICATION_FAILED",
    kind: "protocol",
    cliExitCode: 1,
    httpStatus: 401,
  },
  FORBIDDEN: { code: "FORBIDDEN", kind: "protocol", cliExitCode: 1, httpStatus: 403 },
  DAEMON_STOPPING: { code: "DAEMON_STOPPING", kind: "transport", cliExitCode: 1, httpStatus: 503 },
  DAEMON_STARTUP_FAILED: {
    code: "DAEMON_STARTUP_FAILED",
    kind: "transport",
    cliExitCode: 1,
    httpStatus: 503,
  },
  DAEMON_CONNECTION_LOST: {
    code: "DAEMON_CONNECTION_LOST",
    kind: "transport",
    cliExitCode: 1,
    httpStatus: 503,
  },
  NO_CAPACITY: { code: "NO_CAPACITY", kind: "domain", cliExitCode: 11, httpStatus: 503 },
  QUEUE_TIMEOUT: { code: "QUEUE_TIMEOUT", kind: "domain", cliExitCode: 10, httpStatus: 500 },
  REQUESTER_ALREADY_LEASED: {
    code: "REQUESTER_ALREADY_LEASED",
    kind: "domain",
    cliExitCode: 13,
    httpStatus: 409,
  },
  NO_DRIVER: { code: "NO_DRIVER", kind: "domain", cliExitCode: 12, httpStatus: 422 },
  RUNTIME_MISSING: { code: "RUNTIME_MISSING", kind: "domain", cliExitCode: 12, httpStatus: 422 },
  UNKNOWN_MODEL: { code: "UNKNOWN_MODEL", kind: "domain", cliExitCode: 12, httpStatus: 422 },
  INSUFFICIENT_DISK_SPACE: {
    code: "INSUFFICIENT_DISK_SPACE",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 422,
  },
  LICENSE_NOT_ACCEPTED: {
    code: "LICENSE_NOT_ACCEPTED",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 422,
  },
  UNKNOWN_LEASE: { code: "UNKNOWN_LEASE", kind: "domain", cliExitCode: 1, httpStatus: 404 },
  // Both are caller errors -- a refused verb and an unknown wrapper are things the request got
  // wrong, not states of the host -- so they take the usage exit code and a 4xx.
  PASSTHROUGH_REFUSED: {
    code: "PASSTHROUGH_REFUSED",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 422,
  },
  UNKNOWN_PASSTHROUGH_TOOL: {
    code: "UNKNOWN_PASSTHROUGH_TOOL",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 422,
  },
  // The command ran, and ran too long: a 504 for the same reason a proxy uses one (the thing
  // this daemon was waiting on never finished), and 10 -- the exit code the other "you ran
  // out of time" outcome (`QUEUE_TIMEOUT`) already uses -- so a script branching on "timed
  // out" does not need a second number for the second kind of wait.
  EXEC_TIMEOUT: { code: "EXEC_TIMEOUT", kind: "domain", cliExitCode: 10, httpStatus: 504 },
  DOCTOR_UNAVAILABLE: {
    code: "DOCTOR_UNAVAILABLE",
    kind: "domain",
    cliExitCode: 1,
    httpStatus: 503,
  },
  NUKE_UNAVAILABLE: { code: "NUKE_UNAVAILABLE", kind: "domain", cliExitCode: 1, httpStatus: 503 },
  INTERNAL: { code: "INTERNAL", kind: "domain", cliExitCode: 1, httpStatus: 500 },
  UNKNOWN_DAEMON_ERROR: {
    code: "UNKNOWN_DAEMON_ERROR",
    kind: "protocol",
    cliExitCode: 1,
    httpStatus: 500,
  },
  // Never sent over the wire (see the field comment on `ErrorDetailsMap.CANCELLED`); the
  // `httpStatus` follows the conventional "client closed request" code even though HTTP never
  // actually produces this error today.
  CANCELLED: { code: "CANCELLED", kind: "domain", cliExitCode: 1, httpStatus: 499 },
};

/**
 * Renders a schema validation failure as the one-line `path: message; path: message` string
 * every transport puts in a `BAD_REQUEST`'s message.
 *
 * One function rather than the four identical copies that used to sit in `Dispatcher`,
 * `DaemonServer`, the typed client, and the HTTP app: each threw its own error class around
 * the same rendering, so the rendering is what they actually shared -- and a caller reading
 * `path: message` off a socket, an HTTP body, or a client rejection is entitled to the same
 * string in all three. Structurally typed over the issue list rather than importing zod's
 * `ZodIssue`, so this stays a formatting utility with no opinion about which schema library
 * produced the issues.
 */
export function describeSchemaIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * `SimlockError<Code>` carries `details` typed exactly for its own `Code`. A bare
 * `SimlockError` (the default `Code = SimlockErrorCode`) does NOT narrow on `.code ===` checks
 * -- a generic class's fields are not a discriminated union to the type checker. Use
 * `AnySimlockError` (below) for that; `isSimlockError` produces one from an `unknown` catch
 * value.
 */
export class SimlockError<Code extends SimlockErrorCode = SimlockErrorCode> extends Error {
  constructor(
    readonly code: Code,
    readonly kind: ErrorKind,
    message: string,
    readonly details: ErrorDetailsMap[Code],
  ) {
    super(message);
    this.name = "SimlockError";
  }
}

/**
 * The same class, expressed as a discriminated union over every code -- this is the type that
 * actually narrows: `if (isSimlockError(e) && e.code === "REQUESTER_ALREADY_LEASED")` narrows
 * `e.details` to `{requesterId, existingLeaseId?}` because each union member's `code` and
 * `details` share one type parameter.
 */
export type AnySimlockError = { [Code in SimlockErrorCode]: SimlockError<Code> }[SimlockErrorCode];

export function isSimlockError(error: unknown): error is AnySimlockError {
  return error instanceof SimlockError;
}

/**
 * Builds a typed `SimlockError` from a raw wire `{code, message}` (and optional already-parsed
 * `details`), the client-side half of ADR §7's forward-compatibility rule: a `code` this
 * contract does not recognize wraps as `UNKNOWN_DAEMON_ERROR` with the raw code and message
 * preserved, rather than throwing a parse failure. This is deliberately permissive about
 * `details` -- it trusts the caller's parsed value rather than re-validating per-code detail
 * shapes against `ErrorDetailsMap`, since the wire's `error.details` has no schema of its own
 * yet (today's daemon does not even send one for most codes -- see `DaemonServer#respondError`
 * in this PR, which now accepts but does not populate `details` for most cases). Tightening
 * this with real per-code detail schemas is left as follow-up.
 */
export function fromWireError(code: string, message: string, details?: unknown): AnySimlockError {
  const entry = (ERROR_TABLE as Record<string, ErrorTableEntry>)[code];
  if (entry === undefined) {
    return new SimlockError("UNKNOWN_DAEMON_ERROR", "protocol", message, {
      code,
      message,
    }) as AnySimlockError;
  }
  return new SimlockError(
    entry.code,
    entry.kind,
    message,
    (details ?? {}) as never,
  ) as AnySimlockError;
}
