import type { DeviceClass, Platform } from "./schemas.js";

const DEVICE_NOT_ENROLLABLE_REASONS = [
  "not-connected",
  "network-only",
  "untrusted",
  "developer-mode-off",
  "os-too-old",
  "unsupported-kind",
  "locked",
  "unreadable",
  "virtual-device",
  "enrolled-on-other-platform",
] as const;

export type DeviceNotEnrollableReason = (typeof DEVICE_NOT_ENROLLABLE_REASONS)[number];

export type ErrorKind = "transport" | "protocol" | "domain";

export interface ErrorDetailsMap {
  BAD_FRAME: Record<string, never>;
  HANDSHAKE_REQUIRED: Record<string, never>;
  BAD_REQUEST: Record<string, never>;
  UNKNOWN_REQUEST: Record<string, never>;
  PROTOCOL_VERSION_UNSUPPORTED: {
    readonly client: { readonly min: number; readonly max: number };
    readonly daemon: { readonly min: number; readonly max: number };
    readonly daemonVersion: string;
  };
  ADMIN_AUTHENTICATION_FAILED: Record<string, never>;
  FORBIDDEN: Record<string, never>;

  DAEMON_STOPPING: Record<string, never>;
  DAEMON_STARTUP_FAILED: Record<string, never>;
  DAEMON_CONNECTION_LOST: Record<string, never>;

  NO_CAPACITY: {
    readonly capacityReason?:
      | "device-limit"
      | "ram-budget"
      | "global-running-limit"
      | "platform-running-limit";
  };
  QUEUE_TIMEOUT: { readonly requestId: string };
  PROVISION_FAILED: Record<string, never>;
  REQUESTER_ALREADY_LEASED: { readonly requesterId: string; readonly existingLeaseId?: string };
  /** `lease.request` repeated an `idempotencyKey` its requester already used for a different
   * device or a different `leaseId` (a missing one on either side counts as different). The
   * stored request is untouched; a new request needs a new key. */
  IDEMPOTENCY_CONFLICT: Record<string, never>;
  /** `lease.request` named a `leaseId` an active lease or a waiting request already holds
   * (ADR 0020). The daemon stores nothing for it; a gateway can also meet it after storing the
   * request, when a worker's grant carries an ID the gateway already routes elsewhere. */
  LEASE_ID_TAKEN: { readonly leaseId: string };
  NO_DRIVER: { readonly platform: Platform };
  CAPABILITY_MISSING: { readonly capabilities: readonly string[] };
  RELAY_TARGET_MISSING: { readonly target: string };
  RUNTIME_MISSING: {
    readonly platform: Platform;
    readonly osVersion: string;
    readonly downloadable: boolean;
  };
  UNKNOWN_MODEL: {
    readonly platform: Platform;
    readonly model?: string;
    readonly class?: DeviceClass;
  };
  INSUFFICIENT_DISK_SPACE: {
    readonly platform: Platform;
    readonly requiredBytes: number;
    readonly availableBytes: number;
  };
  LICENSE_NOT_ACCEPTED: { readonly platform: Platform; readonly componentName: string };
  /**
   * A component install ran out of `downloads.timeoutMs`, counted from the moment the call
   * arrived: time spent waiting behind another download on the same platform counts too.
   */
  DOWNLOAD_TIMEOUT: {
    readonly platform: Platform;
    readonly component: string;
    readonly timeoutMs: number;
  };
  /**
   * ADR 0010 §4: an explicit component install under `downloads.policy: "never"`. No role and
   * no operation overrides that policy, so the install never starts.
   */
  DOWNLOADS_DISABLED: { readonly policy: "never" };
  COMPONENT_NOT_OWNED: Record<string, never>;
  COMPONENT_IN_USE: { readonly devices: number; readonly foreignDevices: number };
  COMPONENT_BUSY: Record<string, never>;
  UNKNOWN_LEASE: { readonly leaseId: string };
  DEVICE_NOT_ENROLLABLE: {
    readonly platform: Platform;
    readonly id: string;
    readonly reason: DeviceNotEnrollableReason;
    readonly canonicalId?: string;
  };
  DEVICE_BUSY: { readonly id: string; readonly reason: "leased" | "reclaiming" | "busy" };
  UNKNOWN_DEVICE: { readonly id: string };
  PASSTHROUGH_REFUSED: { readonly tool: string };
  UNKNOWN_PASSTHROUGH_TOOL: { readonly tool: string };
  EXEC_TIMEOUT: Record<string, never>;
  DOCTOR_UNAVAILABLE: Record<string, never>;
  HISTORY_NOT_KEPT: { readonly oldestTs: number };
  HISTORY_UNAVAILABLE: Record<string, never>;
  NUKE_UNAVAILABLE: Record<string, never>;
  DAEMON_UPDATING: Record<string, never>;
  UPDATE_UNSUPPORTED_INSTALL: Record<string, never>;
  UPDATE_RESOLVE_FAILED: Record<string, never>;
  UPDATE_SHARED_INSTALL: Record<string, never>;
  INTERNAL: Record<string, never>;
  GATEWAY_NOT_PRESENT: Record<string, never>;
  SERVICE_FAILED: Record<string, never>;
  UNSUPPORTED_IN_GATEWAY_MODE: { readonly operation: string };
  /**
   * ADR 0012 §2: the mirror of `UNSUPPORTED_IN_GATEWAY_MODE`. The operation exists, this daemon
   * is a worker, and the operation only applies to a gateway's workers: `worker.drain`,
   * `worker.undrain`, `worker.remove` and `worker.install-component`. Not `UNKNOWN_REQUEST`: the
   * operation is known, it just does not apply to a single host.
   */
  UNSUPPORTED_IN_WORKER_MODE: { readonly operation: string };
  /** ADR 0005 §8: `worker.remove` on a worker whose uplink is currently open. Carries the id
   * so a caller can say which one without re-parsing the message. */
  WORKER_CONNECTED: { readonly workerId: string };
  /** `worker.drain`/`worker.undrain` naming a worker the gateway has no view of. (`worker.remove`
   * answers `{removed: false}` instead: forgetting something already forgotten is done, not an
   * error.) */
  UNKNOWN_WORKER: { readonly workerId: string };
  // why: ADR 0042 §2: `worker.update` names a worker the gateway knows but has no open uplink to.
  WORKER_NOT_CONNECTED: { readonly workerId: string };
  /**
   * ADR 0005 §28: the worker that owns this lease (or would serve this request) has no open
   * uplink. `kind: "transport"`, because it says the same thing `DAEMON_CONNECTION_LOST` says
   * one hop further out -- the operation did not fail on its merits, the machine that would
   * decide is unreachable. Declared here now, with the rest of the closed set; #118 is what
   * throws it, once there is a lease to forward.
   */
  WORKER_UNREACHABLE: { readonly workerId: string };

  /** why: `alerts.test` naming a destination the gateway's config does not list, or a gateway with none. */
  UNKNOWN_ALERT_DESTINATION: { readonly destination: string };

  /**
   * why: `alerts.test`: the receiver did not take the sample. `status` is a non-2xx answer; `error` is
   * `timeout`, a network code such as `ECONNREFUSED`, or `network-error`. Never the error's own
   * message, which can hold the destination's URL.
   */
  ALERT_SEND_FAILED: {
    readonly destination: string;
    readonly status?: number;
    readonly error?: string;
  };

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

/** The subset of `SimlockErrorCode` whose `ErrorDetailsMap` entry actually declares a field --
 * i.e. every code above except the `Record<string, never>` ("no details") ones. Structural
 * assignability to `Record<string, never>`, not `keyof`: an index-signature-only type's `keyof`
 * is `string`, not `never`, so a `keyof ... extends never` test would (wrongly) call every code
 * "declared" -- only a shape whose every property-value-type is itself assignable to `never`
 * (i.e. `Record<string, never>` itself) is actually empty. */
type CodeWithDeclaredDetails = {
  [Code in SimlockErrorCode]: ErrorDetailsMap[Code] extends Record<string, never> ? never : Code;
}[SimlockErrorCode];

const CODES_WITH_DECLARED_DETAILS_BY_CODE: Record<CodeWithDeclaredDetails, true> = {
  PROTOCOL_VERSION_UNSUPPORTED: true,
  QUEUE_TIMEOUT: true,
  NO_CAPACITY: true,
  REQUESTER_ALREADY_LEASED: true,
  LEASE_ID_TAKEN: true,
  NO_DRIVER: true,
  CAPABILITY_MISSING: true,
  RELAY_TARGET_MISSING: true,
  RUNTIME_MISSING: true,
  UNKNOWN_MODEL: true,
  HISTORY_NOT_KEPT: true,
  INSUFFICIENT_DISK_SPACE: true,
  LICENSE_NOT_ACCEPTED: true,
  DOWNLOAD_TIMEOUT: true,
  DOWNLOADS_DISABLED: true,
  COMPONENT_IN_USE: true,
  UNKNOWN_LEASE: true,
  DEVICE_NOT_ENROLLABLE: true,
  DEVICE_BUSY: true,
  UNKNOWN_DEVICE: true,
  PASSTHROUGH_REFUSED: true,
  UNKNOWN_PASSTHROUGH_TOOL: true,
  UNSUPPORTED_IN_GATEWAY_MODE: true,
  UNSUPPORTED_IN_WORKER_MODE: true,
  WORKER_CONNECTED: true,
  UNKNOWN_WORKER: true,
  WORKER_NOT_CONNECTED: true,
  WORKER_UNREACHABLE: true,
  ALERT_SEND_FAILED: true,
  UNKNOWN_ALERT_DESTINATION: true,
  UNKNOWN_DAEMON_ERROR: true,
};

export const CODES_WITH_DECLARED_DETAILS: ReadonlySet<SimlockErrorCode> = new Set(
  Object.keys(CODES_WITH_DECLARED_DETAILS_BY_CODE) as CodeWithDeclaredDetails[],
);

export interface ErrorTableEntry<Code extends SimlockErrorCode = SimlockErrorCode> {
  readonly code: Code;
  readonly kind: ErrorKind;
  readonly cliExitCode: number;
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
  PROVISION_FAILED: { code: "PROVISION_FAILED", kind: "domain", cliExitCode: 1, httpStatus: 500 },
  REQUESTER_ALREADY_LEASED: {
    code: "REQUESTER_ALREADY_LEASED",
    kind: "domain",
    cliExitCode: 13,
    httpStatus: 409,
  },
  // 409 like `REQUESTER_ALREADY_LEASED`, its neighbour: the request contradicts one already
  // stored. Exit 2, the "you asked the wrong thing" class -- retrying the same call never helps.
  IDEMPOTENCY_CONFLICT: {
    code: "IDEMPOTENCY_CONFLICT",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 409,
  },
  // 409 and exit 13 like `REQUESTER_ALREADY_LEASED`, its neighbour: the request clashes with a
  // lease or request that is already there.
  LEASE_ID_TAKEN: {
    code: "LEASE_ID_TAKEN",
    kind: "domain",
    cliExitCode: 13,
    httpStatus: 409,
  },
  NO_DRIVER: { code: "NO_DRIVER", kind: "domain", cliExitCode: 12, httpStatus: 422 },
  CAPABILITY_MISSING: {
    code: "CAPABILITY_MISSING",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 422,
  },
  RELAY_TARGET_MISSING: {
    code: "RELAY_TARGET_MISSING",
    kind: "domain",
    cliExitCode: 1,
    httpStatus: 503,
  },
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
  // A device that cannot be enrolled is a fact about the device, as `RUNTIME_MISSING` is about
  // the host: 422 and 12. A busy device passes once what holds it ends, as `NO_CAPACITY` does:
  // 409 and 11. An unknown device is the "what you named does not exist" class: 404 and 12.
  DEVICE_NOT_ENROLLABLE: {
    code: "DEVICE_NOT_ENROLLABLE",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 422,
  },
  DEVICE_BUSY: { code: "DEVICE_BUSY", kind: "domain", cliExitCode: 11, httpStatus: 409 },
  UNKNOWN_DEVICE: { code: "UNKNOWN_DEVICE", kind: "domain", cliExitCode: 12, httpStatus: 404 },
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
  DOWNLOAD_TIMEOUT: {
    code: "DOWNLOAD_TIMEOUT",
    kind: "domain",
    cliExitCode: 10,
    httpStatus: 504,
  },
  // Configuration, not the caller, refuses the download: 403, and 12 with the other "this
  // machine cannot provide that component" outcomes (`RUNTIME_MISSING`, `INSUFFICIENT_DISK_SPACE`).
  DOWNLOADS_DISABLED: {
    code: "DOWNLOADS_DISABLED",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 403,
  },
  // A refused removal: 409, the component is not in a state that allows it. 12 for the two that
  // a retry does not change on its own (not Simlock's; in use until its devices are deleted),
  // 11 for the one that passes once the platform's install or removal ends, like `NO_CAPACITY`.
  COMPONENT_NOT_OWNED: {
    code: "COMPONENT_NOT_OWNED",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 409,
  },
  COMPONENT_IN_USE: {
    code: "COMPONENT_IN_USE",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 409,
  },
  COMPONENT_BUSY: { code: "COMPONENT_BUSY", kind: "domain", cliExitCode: 11, httpStatus: 409 },
  DOCTOR_UNAVAILABLE: {
    code: "DOCTOR_UNAVAILABLE",
    kind: "domain",
    cliExitCode: 1,
    httpStatus: 503,
  },
  NUKE_UNAVAILABLE: { code: "NUKE_UNAVAILABLE", kind: "domain", cliExitCode: 1, httpStatus: 503 },
  DAEMON_UPDATING: { code: "DAEMON_UPDATING", kind: "domain", cliExitCode: 1, httpStatus: 503 },
  UPDATE_UNSUPPORTED_INSTALL: {
    code: "UPDATE_UNSUPPORTED_INSTALL",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 409,
  },
  UPDATE_RESOLVE_FAILED: {
    code: "UPDATE_RESOLVE_FAILED",
    kind: "domain",
    cliExitCode: 1,
    httpStatus: 502,
  },
  UPDATE_SHARED_INSTALL: {
    code: "UPDATE_SHARED_INSTALL",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 409,
  },
  HISTORY_NOT_KEPT: { code: "HISTORY_NOT_KEPT", kind: "domain", cliExitCode: 12, httpStatus: 422 },
  HISTORY_UNAVAILABLE: {
    code: "HISTORY_UNAVAILABLE",
    kind: "domain",
    cliExitCode: 1,
    httpStatus: 503,
  },
  INTERNAL: { code: "INTERNAL", kind: "domain", cliExitCode: 1, httpStatus: 500 },
  // why: never sent over HTTP (the CLI and MCP raise it before they connect); the table needs a value.
  GATEWAY_NOT_PRESENT: {
    code: "GATEWAY_NOT_PRESENT",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 404,
  },
  // why: never sent over HTTP (the CLI raises it when a service manager call fails); the table needs a value.
  SERVICE_FAILED: { code: "SERVICE_FAILED", kind: "domain", cliExitCode: 1, httpStatus: 500 },
  // 501, not 400/503: the request was well-formed and the daemon is healthy -- this endpoint
  // simply does not implement that operation, which is exactly what "Not Implemented" says.
  // `cliExitCode: 2` puts it with the other "you asked the wrong thing" outcomes.
  UNSUPPORTED_IN_GATEWAY_MODE: {
    code: "UNSUPPORTED_IN_GATEWAY_MODE",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 501,
  },
  // The same 501 and exit 2 as `UNSUPPORTED_IN_GATEWAY_MODE`, for the same reason: a
  // well-formed request this daemon's mode does not implement.
  UNSUPPORTED_IN_WORKER_MODE: {
    code: "UNSUPPORTED_IN_WORKER_MODE",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 501,
  },
  // 409, like every other "the resource is not in a state that allows this": the worker is
  // there, connected, and removing it is a contradiction rather than a missing thing. Exit 2
  // for the same reason `UNSUPPORTED_IN_GATEWAY_MODE` takes it -- the caller asked for
  // something that cannot apply, rather than hitting a state of the fleet.
  WORKER_CONNECTED: { code: "WORKER_CONNECTED", kind: "domain", cliExitCode: 2, httpStatus: 409 },
  // Exit 12, beside `UNKNOWN_MODEL`: the "what you named does not exist" class, which a script
  // branches on differently from "the fleet is busy" or "that cannot apply here".
  UNKNOWN_WORKER: { code: "UNKNOWN_WORKER", kind: "domain", cliExitCode: 12, httpStatus: 404 },
  WORKER_NOT_CONNECTED: {
    code: "WORKER_NOT_CONNECTED",
    kind: "domain",
    cliExitCode: 2,
    httpStatus: 409,
  },
  WORKER_UNREACHABLE: {
    code: "WORKER_UNREACHABLE",
    kind: "transport",
    cliExitCode: 1,
    httpStatus: 503,
  },
  // why: exit 12 beside `UNKNOWN_WORKER`: what you named does not exist.
  UNKNOWN_ALERT_DESTINATION: {
    code: "UNKNOWN_ALERT_DESTINATION",
    kind: "domain",
    cliExitCode: 12,
    httpStatus: 404,
  },
  // why: 502, the gateway worked and the receiver it called did not take the sample.
  ALERT_SEND_FAILED: {
    code: "ALERT_SEND_FAILED",
    kind: "transport",
    cliExitCode: 1,
    httpStatus: 502,
  },
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

/** why: the CLI and MCP raise this one error from two places, so the wording lives once. */
export function gatewayNotPresentError(): SimlockError<"GATEWAY_NOT_PRESENT"> {
  return new SimlockError(
    "GATEWAY_NOT_PRESENT",
    "domain",
    "No gateway on this machine. Start one with: simlock --gateway daemon start",
    {},
  );
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
